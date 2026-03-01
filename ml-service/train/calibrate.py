#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.anomaly import calibration_from_raw_scores, load_model_artifacts, save_calibration
from ml.features import FEATURE_COLUMNS


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Calibrate IsolationForest raw scores using normal validation data.")
    parser.add_argument("--features", required=True, help="Validation-normal parquet feature file")
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    df = pd.read_parquet(args.features)
    missing = [c for c in FEATURE_COLUMNS if c not in df.columns]
    if missing:
        raise RuntimeError(f"Missing feature columns: {missing}")

    scaler, model = load_model_artifacts(args.models_dir)
    if scaler is None or model is None:
        raise RuntimeError(
            f"Missing model artifacts in {args.models_dir}. Expected scaler.joblib and isoforest.joblib"
        )

    X = df[FEATURE_COLUMNS].astype(np.float32).to_numpy()
    raw = model.score_samples(scaler.transform(X))
    calib = calibration_from_raw_scores(raw)
    save_calibration(args.models_dir, calib)

    print(json.dumps(calib, indent=2))


if __name__ == "__main__":
    main()
