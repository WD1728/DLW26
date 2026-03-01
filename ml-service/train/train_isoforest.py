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

from ml.anomaly import fit_scaler_isoforest, save_model_artifacts
from ml.features import FEATURE_COLUMNS


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train RobustScaler + IsolationForest on normal features.")
    parser.add_argument("--features", nargs="+", required=True, help="Normal-only parquet feature files")
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))
    parser.add_argument("--max-rows-per-dataset", type=int, default=200000)
    parser.add_argument("--max-total-rows", type=int, default=0, help="Optional global cap after balancing (0=disabled)")
    parser.add_argument(
        "--include-datasets",
        nargs="*",
        default=[],
        help="Optional dataset names to include (uses 'dataset' column or parquet stem)",
    )
    parser.add_argument(
        "--exclude-datasets",
        nargs="*",
        default=[],
        help="Optional dataset names to exclude (applied after include filter)",
    )
    parser.add_argument("--n-estimators", type=int, default=300)
    parser.add_argument(
        "--contamination",
        default="auto",
        help="IsolationForest contamination: 'auto' or float in (0, 0.5]",
    )
    parser.add_argument("--random-state", type=int, default=42)
    return parser.parse_args()


def _normalize_names(values: Sequence[str]) -> set[str]:
    return {v.strip().lower() for v in values if v and v.strip()}


def _parse_contamination(value: str) -> str | float:
    if value == "auto":
        return "auto"
    parsed = float(value)
    if parsed <= 0.0 or parsed > 0.5:
        raise ValueError("contamination must be 'auto' or a float in (0, 0.5]")
    return parsed


def _load_feature_frames(paths: Sequence[str]) -> List[pd.DataFrame]:
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


def _filter_datasets(
    frames: Sequence[pd.DataFrame],
    include_datasets: set[str],
    exclude_datasets: set[str],
) -> List[pd.DataFrame]:
    filtered: List[pd.DataFrame] = []
    for df in frames:
        dataset_values = sorted({str(v).strip().lower() for v in df["dataset"].unique() if str(v).strip()})
        if not dataset_values:
            continue

        keep = True
        if include_datasets and not any(name in include_datasets for name in dataset_values):
            keep = False
        if exclude_datasets and any(name in exclude_datasets for name in dataset_values):
            keep = False

        if keep:
            filtered.append(df)
    return filtered


def main() -> None:
    args = parse_args()
    contamination = _parse_contamination(args.contamination)
    include_datasets = _normalize_names(args.include_datasets)
    exclude_datasets = _normalize_names(args.exclude_datasets)

    frames = _load_feature_frames(args.features)
    frames = _filter_datasets(frames, include_datasets, exclude_datasets)

    if not frames:
        raise RuntimeError("No input feature files left after dataset filtering")

    full = pd.concat(frames, ignore_index=True)

    balanced = []
    for _dataset_name, group in full.groupby("dataset"):
        if len(group) > args.max_rows_per_dataset:
            group = group.sample(args.max_rows_per_dataset, random_state=args.random_state)
        balanced.append(group)

    train_df = pd.concat(balanced, ignore_index=True)
    if args.max_total_rows > 0 and len(train_df) > args.max_total_rows:
        train_df = train_df.sample(args.max_total_rows, random_state=args.random_state)

    X = train_df[FEATURE_COLUMNS].astype(np.float32).to_numpy()

    scaler, model = fit_scaler_isoforest(
        X,
        n_estimators=args.n_estimators,
        contamination=contamination,
        random_state=args.random_state,
    )

    models_dir = Path(args.models_dir)
    save_model_artifacts(models_dir, scaler, model)

    meta = {
        "num_rows": int(len(train_df)),
        "num_datasets": int(train_df["dataset"].nunique()),
        "datasets": {k: int(v) for k, v in train_df["dataset"].value_counts().to_dict().items()},
        "feature_columns": FEATURE_COLUMNS,
        "max_rows_per_dataset": int(args.max_rows_per_dataset),
        "max_total_rows": int(args.max_total_rows),
        "n_estimators": int(args.n_estimators),
        "contamination": contamination,
        "include_datasets": sorted(include_datasets),
        "exclude_datasets": sorted(exclude_datasets),
        "random_state": int(args.random_state),
    }
    with (models_dir / "train_meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
