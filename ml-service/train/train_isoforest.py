#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List

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
    parser.add_argument("--n-estimators", type=int, default=300)
    parser.add_argument("--random-state", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    frames: List[pd.DataFrame] = []
    for path_str in args.features:
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

    if not frames:
        raise RuntimeError("No input feature files provided")

    full = pd.concat(frames, ignore_index=True)

    balanced = []
    for dataset_name, group in full.groupby("dataset"):
        if len(group) > args.max_rows_per_dataset:
            group = group.sample(args.max_rows_per_dataset, random_state=args.random_state)
        balanced.append(group)

    train_df = pd.concat(balanced, ignore_index=True)
    X = train_df[FEATURE_COLUMNS].astype(np.float32).to_numpy()

    scaler, model = fit_scaler_isoforest(
        X,
        n_estimators=args.n_estimators,
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
        "n_estimators": int(args.n_estimators),
        "random_state": int(args.random_state),
    }
    with (models_dir / "train_meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
