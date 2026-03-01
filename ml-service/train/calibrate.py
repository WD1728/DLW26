#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Sequence

import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.anomaly import calibration_from_raw_scores, load_model_artifacts, save_calibration
from ml.features import FEATURE_COLUMNS


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Calibrate IsolationForest raw scores using normal validation data.")
    parser.add_argument("--features", nargs="+", required=True, help="Validation-normal parquet feature files")
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))
    parser.add_argument("--max-rows-per-dataset", type=int, default=100000)
    parser.add_argument("--max-total-rows", type=int, default=200000)
    parser.add_argument(
        "--include-datasets",
        nargs="*",
        default=[],
        help="Optional dataset names to include in calibration",
    )
    parser.add_argument(
        "--exclude-datasets",
        nargs="*",
        default=[],
        help="Optional dataset names to exclude from calibration",
    )
    parser.add_argument("--random-state", type=int, default=42)
    return parser.parse_args()


def _normalize_names(values: Sequence[str]) -> set[str]:
    return {v.strip().lower() for v in values if v and v.strip()}


def _load_frames(paths: Sequence[str]) -> List[pd.DataFrame]:
    frames: List[pd.DataFrame] = []
    for path_str in paths:
        path = Path(path_str)
        if not path.exists():
            raise FileNotFoundError(f"Feature file not found: {path}")
        df = pd.read_parquet(path)
        if "dataset" not in df.columns:
            df["dataset"] = path.stem
        missing = [c for c in FEATURE_COLUMNS if c not in df.columns]
        if missing:
            raise RuntimeError(f"{path} missing columns: {missing}")
        frames.append(df)
    return frames


def main() -> None:
    args = parse_args()
    include_datasets = _normalize_names(args.include_datasets)
    exclude_datasets = _normalize_names(args.exclude_datasets)

    frames = _load_frames(args.features)
    if not frames:
        raise RuntimeError("No feature files provided")

    full = pd.concat(frames, ignore_index=True)
    filtered = []
    for dataset_name, group in full.groupby("dataset"):
        name = str(dataset_name).strip().lower()
        if include_datasets and name not in include_datasets:
            continue
        if exclude_datasets and name in exclude_datasets:
            continue
        if len(group) > args.max_rows_per_dataset:
            group = group.sample(args.max_rows_per_dataset, random_state=args.random_state)
        filtered.append(group)

    if not filtered:
        raise RuntimeError("No rows left after calibration dataset filtering")

    df = pd.concat(filtered, ignore_index=True)
    if args.max_total_rows > 0 and len(df) > args.max_total_rows:
        df = df.sample(args.max_total_rows, random_state=args.random_state)

    scaler, model = load_model_artifacts(args.models_dir)
    if scaler is None or model is None:
        raise RuntimeError(
            f"Missing model artifacts in {args.models_dir}. Expected scaler.joblib and isoforest.joblib"
        )

    X = df[FEATURE_COLUMNS].astype(np.float32).to_numpy()
    raw = model.score_samples(scaler.transform(X))
    calib = calibration_from_raw_scores(raw)
    calib["num_rows"] = int(len(df))
    calib["datasets"] = {k: int(v) for k, v in df["dataset"].value_counts().to_dict().items()}
    calib["max_rows_per_dataset"] = int(args.max_rows_per_dataset)
    calib["max_total_rows"] = int(args.max_total_rows)
    calib["include_datasets"] = sorted(include_datasets)
    calib["exclude_datasets"] = sorted(exclude_datasets)
    save_calibration(args.models_dir, calib)

    print(json.dumps(calib, indent=2))


if __name__ == "__main__":
    main()
