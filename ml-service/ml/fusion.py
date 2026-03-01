from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np

from .anomaly import apply_ewma, clamp01


@dataclass(frozen=True)
class HybridFusionConfig:
    """
    Hackathon-oriented fusion between:
    - baseline per-zone anomaly (IsolationForest / fallback physics)
    - paper global behavior risk (C3D + Multi-SVM)

    Goal: keep outputs stable + interpretable, and spatialize a global regime score
    into zones using local "activity" (density + motion).
    """

    paper_weight: float = 0.65
    fusion_alpha_prev: float = 0.7

    activity_density_weight: float = 0.60
    activity_motion_weight: float = 0.40

    motion_speed_weight: float = 0.40
    motion_turbulence_weight: float = 0.40
    motion_entropy_weight: float = 0.20


def _robust_normalize(values: np.ndarray, lo_q: float = 5.0, hi_q: float = 95.0) -> np.ndarray:
    if values.size == 0:
        return values.astype(np.float32)

    lo = float(np.percentile(values, lo_q))
    hi = float(np.percentile(values, hi_q))
    if hi <= lo:
        return np.zeros_like(values, dtype=np.float32)

    out = (values - lo) / (hi - lo)
    return np.asarray(np.clip(out, 0.0, 1.0), dtype=np.float32)


def activity_weights_from_rows(rows: List[Dict[str, float | int | str]], cfg: HybridFusionConfig) -> np.ndarray:
    """
    Convert per-zone feature rows into non-negative weights that sum to 1.

    Heuristic:
    - activity ~ density + (speed + turbulence + direction entropy)
    - speed/turbulence are robust-normalized across zones per timestep
    """
    if not rows:
        return np.empty((0,), dtype=np.float32)

    density = np.asarray([float(r.get("density", 0.0)) for r in rows], dtype=np.float32)
    speed_mean = np.asarray([float(r.get("speed_mean", 0.0)) for r in rows], dtype=np.float32)
    turbulence = np.asarray([float(r.get("turbulence", 0.0)) for r in rows], dtype=np.float32)
    dir_entropy = np.asarray([float(r.get("dir_entropy", 0.0)) for r in rows], dtype=np.float32)

    speed_n = _robust_normalize(speed_mean)
    turb_n = _robust_normalize(turbulence)

    motion = (
        float(cfg.motion_speed_weight) * speed_n
        + float(cfg.motion_turbulence_weight) * turb_n
        + float(cfg.motion_entropy_weight) * np.clip(dir_entropy, 0.0, 1.0)
    )
    motion = np.asarray(np.clip(motion, 0.0, 1.0), dtype=np.float32)

    activity = float(cfg.activity_density_weight) * np.clip(density, 0.0, 1.0) + float(cfg.activity_motion_weight) * motion
    activity = np.asarray(np.clip(activity, 0.0, 1.0), dtype=np.float32)

    total = float(activity.sum())
    if total <= 1e-6:
        return np.full((len(rows),), 1.0 / max(1, len(rows)), dtype=np.float32)

    return np.asarray(activity / total, dtype=np.float32)


def spatialize_global_risk(expected_risk: float, weights: np.ndarray) -> np.ndarray:
    """
    Convert a global risk scalar into a per-zone vector.

    We scale by N so that mean(zone_risk) ~= global_risk, while still concentrating
    risk into high-activity zones.
    """
    if weights.size == 0:
        return np.empty((0,), dtype=np.float32)

    g = float(clamp01(float(expected_risk)))
    zone = g * weights * float(weights.size)
    return np.asarray(np.clip(zone, 0.0, 1.0), dtype=np.float32)


def fuse_zone_anomalies(
    *,
    zone_ids: List[str],
    baseline: np.ndarray,
    paper_expected_risk: float,
    paper_conf: float,
    activity_weights: np.ndarray,
    cfg: HybridFusionConfig,
    prev_fused_ewma: Dict[str, float],
) -> Tuple[np.ndarray, Dict[str, float]]:
    """
    Fuse baseline per-zone anomaly with paper per-zone spatialized risk and apply EWMA.
    """
    if baseline.size == 0:
        return baseline.astype(np.float32), dict(prev_fused_ewma)

    if activity_weights.size != baseline.size:
        raise ValueError("activity_weights must match baseline length")

    paper_zone = spatialize_global_risk(paper_expected_risk, activity_weights)
    mix = float(clamp01(float(cfg.paper_weight) * float(clamp01(float(paper_conf)))))
    fused = (1.0 - mix) * baseline.astype(np.float32) + mix * paper_zone.astype(np.float32)
    fused = np.asarray(np.clip(fused, 0.0, 1.0), dtype=np.float32)

    smoothed, next_state = apply_ewma(
        zone_ids=zone_ids,
        values=fused,
        prev_state=prev_fused_ewma,
        alpha_prev=float(cfg.fusion_alpha_prev),
    )
    return smoothed, next_state

