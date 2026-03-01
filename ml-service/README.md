# SafeFlow ML Pipeline (CPU, low-resolution CCTV)

This folder implements **ML perception + training + inference + evaluation** only.
It does **not** implement routing, websockets, UI, or app logic.

## Implemented deliverables

- `data/` dataset storage
- `scripts/download_datasets.sh`
- `ml/`
  - `zones.py`
  - `preprocess.py`
  - `flow.py`
  - `features.py`
  - `detector.py`
  - `anomaly.py`
- `train/`
  - `extract_features.py`
  - `train_isoforest.py`
  - `calibrate.py`
- `infer/`
  - `infer_video.py`
- `eval/`
  - `eval_datasets.py`
- `zones_analysis.json` (default 320x240 AZ grid)

## Output schema (inference JSONL)

Each processed timestep writes one JSON line in this exact structure:

```json
{
  "ts": 1710000000000,
  "zones": [
    {"zoneId": "AZ1", "density": 0.42, "anomaly": 0.18, "conf": 0.91, "peopleCount": 12},
    {"zoneId": "AZ2", "density": 0.87, "anomaly": 0.73, "conf": 0.84, "peopleCount": 26}
  ]
}
```

Only analysis zones (`AZ*`) are emitted.

## Install

```bash
cd /Users/ishi/Documents/Playground/DLW26/ml-service
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

## Datasets

Auto-attempt downloads and manual instructions:

```bash
bash scripts/download_datasets.sh
```

Expected folders after setup:

- `data/ucsd/train`, `data/ucsd/test`
- `data/avenue/train`, `data/avenue/test`
- `data/mall/normal`, `data/mall/crowded` (if available)
- `data/pets2009/normal`
- `data/rwf2000/normal`, `data/rwf2000/fight`
- `data/ucfcrime/normal`, `data/ucfcrime/crime`
- `data/shanghaitech/normal`

Supported video formats: `mp4`, `avi` (also `mov`, `mkv`, `m4v`).

## Step A/B/C feature extraction (required CLI)

CLI (required args):
- `--dataset (ucsd|avenue|mall|pets2009|rwf2000|ucfcrime|shanghaitech)`
- `--split (train|test|normal|fight|crime|crowded)`
- `--zones zones_analysis.json`
- `--fps 3`
- `--out output.parquet`

Example:

```bash
python train/extract_features.py \
  --dataset ucsd \
  --split train \
  --zones zones_analysis.json \
  --fps 3 \
  --out artifacts/features/ucsd_train.parquet
```

Notes:
- Frames are resized to zone resolution (`320x240` by default) and converted to grayscale.
- Optional CCTV simulation is available via `--cctv-sim` (JPEG quality 40 default).
- YOLOv8n runs on CPU every 3 processed frames and counts are reused in between.
- If YOLO is unavailable, density and peopleCount are set to 0 while motion anomaly still runs.

## Required training plan (normal-only fit)

Extract features for **normal** sources:

```bash
mkdir -p artifacts/features

python train/extract_features.py --dataset ucsd --split train --zones zones_analysis.json --fps 3 --out artifacts/features/ucsd_train.parquet
python train/extract_features.py --dataset avenue --split train --zones zones_analysis.json --fps 3 --out artifacts/features/avenue_train.parquet
python train/extract_features.py --dataset pets2009 --split normal --zones zones_analysis.json --fps 3 --out artifacts/features/pets2009_normal.parquet
python train/extract_features.py --dataset rwf2000 --split normal --zones zones_analysis.json --fps 3 --out artifacts/features/rwf2000_normal.parquet
python train/extract_features.py --dataset ucfcrime --split normal --zones zones_analysis.json --fps 3 --out artifacts/features/ucfcrime_normal.parquet
python train/extract_features.py --dataset shanghaitech --split normal --zones zones_analysis.json --fps 3 --out artifacts/features/shanghaitech_normal.parquet
python train/extract_features.py --dataset mall --split normal --zones zones_analysis.json --fps 3 --out artifacts/features/mall_normal.parquet
```

Train model (balanced cap per dataset):

```bash
python train/train_isoforest.py \
  --features \
    artifacts/features/ucsd_train.parquet \
    artifacts/features/avenue_train.parquet \
    artifacts/features/pets2009_normal.parquet \
    artifacts/features/rwf2000_normal.parquet \
    artifacts/features/ucfcrime_normal.parquet \
    artifacts/features/shanghaitech_normal.parquet \
    artifacts/features/mall_normal.parquet \
  --models-dir models \
  --max-rows-per-dataset 200000
```

Calibrate on normal validation features:

```bash
python train/calibrate.py \
  --features artifacts/features/ucsd_train.parquet \
  --models-dir models
```

Artifacts produced:
- `models/scaler.joblib`
- `models/isoforest.joblib`
- `models/calib.json`

## Inference (required JSON output)

```bash
python infer/infer_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --models-dir models \
  --fps 3 \
  --out artifacts/infer/video.jsonl
```

Fallback behavior if model artifacts are missing:
- Uses pressure/turbulence/entropy fallback scorer:
  - `pressure = density * (speed_mean + 0.5 * turbulence)`
  - `anomaly = clamp(0.45*dir_entropy + 0.35*normalize(turbulence) + 0.20*normalize(pressure), 0..1)`
- EWMA smoothing per zone: `0.7 * prev + 0.3 * current`

## Evaluation

Runs normal + abnormal summaries and writes example JSONL outputs.

```bash
python eval/eval_datasets.py \
  --zones zones_analysis.json \
  --data-root data \
  --models-dir models \
  --fps 3 \
  --out-dir eval/outputs
```

Printed table format:
- `dataset, split, mean_anomaly, p95_anomaly`

Evaluation splits used:
- Normal summaries: `ucsd/train`, `avenue/train`, `pets2009/normal`, `rwf2000/normal`, `ucfcrime/normal`, `shanghaitech/normal`, `mall/normal (if present)`
- Abnormal summaries: `ucsd/test`, `avenue/test`, `rwf2000/fight`, `ucfcrime/crime`, `mall/crowded (if present)`
