from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

from .features import feature_matrix


def clamp01(x: float | np.ndarray) -> float | np.ndarray:
    return np.clip(x, 0.0, 1.0)


def fit_scaler_isoforest(
    X: np.ndarray,
    n_estimators: int = 300,
    contamination: str | float = "auto",
    random_state: int = 42,
) -> Tuple[RobustScaler, IsolationForest]:
    scaler = RobustScaler()
    Xs = scaler.fit_transform(X)

    model = IsolationForest(
        n_estimators=n_estimators,
        contamination=contamination,
        random_state=random_state,
        n_jobs=-1,
    )
    model.fit(Xs)
    return scaler, model


def save_model_artifacts(
    models_dir: str | Path,
    scaler: RobustScaler,
    model: IsolationForest,
) -> None:
    models_path = Path(models_dir)
    models_path.mkdir(parents=True, exist_ok=True)
    joblib.dump(scaler, models_path / "scaler.joblib")
    joblib.dump(model, models_path / "isoforest.joblib")


def load_model_artifacts(
    models_dir: str | Path,
) -> Tuple[Optional[RobustScaler], Optional[IsolationForest]]:
    models_path = Path(models_dir)
    scaler_path = models_path / "scaler.joblib"
    model_path = models_path / "isoforest.joblib"

    if not scaler_path.exists() or not model_path.exists():
        return None, None

    scaler = joblib.load(scaler_path)
    model = joblib.load(model_path)
    return scaler, model


def calibration_from_raw_scores(raw_scores: np.ndarray) -> Dict[str, float]:
    return {
        "p1": float(np.percentile(raw_scores, 1)),
        "p50": float(np.percentile(raw_scores, 50)),
        "p99": float(np.percentile(raw_scores, 99)),
    }


def save_calibration(models_dir: str | Path, calib: Dict[str, float]) -> None:
    models_path = Path(models_dir)
    models_path.mkdir(parents=True, exist_ok=True)
    with (models_path / "calib.json").open("w", encoding="utf-8") as f:
        json.dump(calib, f, indent=2)


def load_calibration(models_dir: str | Path) -> Optional[Dict[str, float]]:
    calib_path = Path(models_dir) / "calib.json"
    if not calib_path.exists():
        return None
    with calib_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def calibrated_anomaly(raw_scores: np.ndarray, calib: Dict[str, float]) -> np.ndarray:
    p1 = float(calib.get("p1", 0.0))
    p50 = float(calib.get("p50", 0.0))

    denom = p50 - p1
    if abs(denom) < 1e-8:
        # Guard divide-by-zero while preserving required formula shape.
        denom = 1e-8

    anomaly = (p50 - raw_scores) / denom
    return np.asarray(clamp01(anomaly), dtype=np.float32)


def normalize_vector(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values

    lo = float(np.percentile(values, 5))
    hi = float(np.percentile(values, 95))
    if hi <= lo:
        return np.zeros_like(values, dtype=np.float32)

    out = (values - lo) / (hi - lo)
    return np.asarray(clamp01(out), dtype=np.float32)


def fallback_anomaly(rows: List[Dict[str, float | int | str]]) -> np.ndarray:
    if not rows:
        return np.empty((0,), dtype=np.float32)

    density = np.asarray([float(r["density"]) for r in rows], dtype=np.float32)
    speed_mean = np.asarray([float(r["speed_mean"]) for r in rows], dtype=np.float32)
    turbulence = np.asarray([float(r["turbulence"]) for r in rows], dtype=np.float32)
    dir_entropy = np.asarray([float(r["dir_entropy"]) for r in rows], dtype=np.float32)

    pressure = density * (speed_mean + 0.5 * turbulence)
    norm_turbulence = normalize_vector(turbulence)
    norm_pressure = normalize_vector(pressure)

    anomaly = 0.45 * dir_entropy + 0.35 * norm_turbulence + 0.20 * norm_pressure
    return np.asarray(clamp01(anomaly), dtype=np.float32)


def apply_ewma(
    zone_ids: List[str],
    values: np.ndarray,
    prev_state: Dict[str, float],
    alpha_prev: float = 0.7,
) -> Tuple[np.ndarray, Dict[str, float]]:
    out = np.zeros_like(values, dtype=np.float32)
    next_state = dict(prev_state)

    for i, zone_id in enumerate(zone_ids):
        prev = float(prev_state.get(zone_id, values[i]))
        smoothed = alpha_prev * prev + (1.0 - alpha_prev) * float(values[i])
        out[i] = smoothed
        next_state[zone_id] = float(smoothed)

    return out, next_state


class ZoneAnomalyScorer:
    """Model-based anomaly scoring with calibrated fallback."""

    def __init__(self, models_dir: str | Path):
        self.models_dir = Path(models_dir)
        self.scaler, self.model = load_model_artifacts(self.models_dir)
        self.calib = load_calibration(self.models_dir)
        self.prev_ewma: Dict[str, float] = {}

    @property
    def has_model(self) -> bool:
        return self.scaler is not None and self.model is not None and self.calib is not None

    def score(self, rows: List[Dict[str, float | int | str]]) -> Dict[str, float]:
        if not rows:
            return {}

        zone_ids = [str(r["zoneId"]) for r in rows]

        if self.has_model:
            X = feature_matrix(rows)
            Xs = self.scaler.transform(X)  # type: ignore[union-attr]
            raw = self.model.score_samples(Xs)  # type: ignore[union-attr]
            current = calibrated_anomaly(raw, self.calib or {})
        else:
            current = fallback_anomaly(rows)

        smoothed, self.prev_ewma = apply_ewma(zone_ids, current, self.prev_ewma, alpha_prev=0.7)
        return {zone_ids[i]: float(smoothed[i]) for i in range(len(zone_ids))}
