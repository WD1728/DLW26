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
  - `c3d_paper.py`
  - `c3d_data.py`
  - `paper_behavior.py`
  - `fusion.py`
  - `mil_ranking.py`
  - `routing_demo.py`
- `train/`
  - `extract_features.py`
  - `train_isoforest.py`
  - `calibrate.py`
  - `train_c3d_paper.py`
  - `train_multisvm_paper.py`
  - `train_mil_ranking.py`
- `infer/`
  - `infer_video.py`
  - `visualize_video.py`
  - `infer_paper_video.py`
  - `visualize_paper_video.py`
  - `infer_hybrid_video.py`
  - `visualize_hybrid_video.py`
  - `infer_ensemble_video.py`
  - `visualize_ensemble_video.py`
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

## What Is Happening In This Pipeline

There are four separate stages:

1. `train/extract_features.py`
   - Reads videos.
   - Computes per-zone numeric features (density + motion stats + deltas).
   - Writes parquet feature tables.
   - This is **not model training**.

2. `train/train_isoforest.py`
   - Reads normal-only feature parquet files.
   - Fits `RobustScaler + IsolationForest`.
   - Writes `models/scaler.joblib` and `models/isoforest.joblib`.

3. `train/calibrate.py`
   - Reads normal feature parquet files.
   - Computes raw-score percentiles (`p1`, `p50`, `p99`) for anomaly scaling.
   - Writes `models/calib.json`.

4. `infer/infer_video.py`
   - Runs per-frame features on a video.
   - Applies trained model + calibration (or fallback scorer if missing artifacts).
   - Emits required JSONL output.

## Paper Implementation (3D ConvNet + Multi-SVM)

This repo now also includes the paper-style path from:
- *Analyzing Crowd Behavior in Highly Dense Crowd Videos Using 3D ConvNet and Multi-SVM* (Electronics 2024, 13, 4925)

Implemented details:
- Clip preprocessing: resize to `128x171`, non-overlapping `16` frames, crop to `112x112`
- C3D-style architecture with temporal depth `d` (`1|3|5|7`, default `3`)
- Multi-class SVM classifier on extracted C3D features
- Paper-mode inference that maps behavior class -> safety risk/anomaly and writes SafeFlow schema JSONL

Expected dataset structure for paper training:

```text
data/crowd11/
  train/
    laminar_flow/*.mp4
    turbulent_flow/*.mp4
    ...
  val/
    laminar_flow/*.mp4
    ...
  test/
    laminar_flow/*.mp4
    ...
```

Train paper C3D:

```bash
python train/train_c3d_paper.py \
  --data-root data/crowd11 \
  --train-split train \
  --val-split val \
  --temporal-depth 3 \
  --epochs 14 \
  --batch-size 30 \
  --out-dir models/paper_c3d_depth3
```

If your Crowd-11 videos are not already in `train/val/test` folders, prepare splits from raw class folders:

```bash
python scripts/prepare_crowd11_splits.py \
  --src data/crowd11_raw \
  --dst data/crowd11 \
  --train-ratio 0.8 \
  --val-ratio 0.1 \
  --test-ratio 0.1 \
  --mode symlink
```

Train Multi-SVM on extracted C3D features:

```bash
python train/train_multisvm_paper.py \
  --data-root data/crowd11 \
  --train-split train \
  --eval-split test \
  --checkpoint models/paper_c3d_depth3/c3d_depth3_best.pt \
  --out-dir models/paper_c3d_depth3
```

Run paper-mode inference (writes required SafeFlow schema JSONL):

```bash
python infer/infer_paper_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --checkpoint models/paper_c3d_depth3/c3d_depth3_best.pt \
  --svm-model models/paper_c3d_depth3/paper_multi_svm.joblib \
  --out artifacts/infer/paper_video.jsonl \
  --out-behavior artifacts/infer/paper_video_behavior.jsonl
```

Visualize paper-mode predictions:

```bash
python infer/visualize_paper_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --checkpoint models/paper_c3d_depth3/c3d_depth3_best.pt \
  --svm-model models/paper_c3d_depth3/paper_multi_svm.joblib \
  --out artifacts/infer/paper_visual.jsonl \
  --out-video artifacts/infer/paper_visual.mp4
```

## Hybrid Hackathon Mode (Recommended)

Hybrid = baseline per-zone anomaly (density + motion + IsolationForest/fallback) **fused** with
paper global regime risk (C3D + Multi-SVM).

Key idea:
- Paper model outputs a *global* crowd behavior regime (and probability distribution).
- We turn that into an **expected global risk** and spatialize it into zones using local activity
  (density + motion), then fuse with the baseline anomaly.

Run hybrid inference (JSONL only):

```bash
python infer/infer_hybrid_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --models-dir models \
  --checkpoint models/paper_c3d_depth3/c3d_depth3_best.pt \
  --svm-model models/paper_c3d_depth3/paper_multi_svm.joblib \
  --out artifacts/infer/hybrid_video.jsonl \
  --out-behavior artifacts/infer/hybrid_video_behavior.jsonl \
  --device mps
```

Visualize hybrid predictions:

```bash
python infer/visualize_hybrid_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --models-dir models \
  --checkpoint models/paper_c3d_depth3/c3d_depth3_best.pt \
  --svm-model models/paper_c3d_depth3/paper_multi_svm.joblib \
  --out artifacts/infer/hybrid_visual.jsonl \
  --out-behavior artifacts/infer/hybrid_visual_behavior.jsonl \
  --out-video artifacts/infer/hybrid_visual.mp4 \
  --device mps
```

Tune fusion (for demos):
- `--paper-weight`: how much to trust paper regime model (default `0.65`)
- `--fusion-alpha-prev`: smoothing (default `0.7`; higher = smoother/slower)

## One-Command Compare (Baseline vs Paper vs Hybrid)

This runs all 3 visualizers and renders a triple stacked mp4 via ffmpeg:

```bash
bash scripts/compare_models.sh --video /path/to/video.mp4 --device mps
```

Outputs under: `artifacts/compare/`
- `base.mp4`, `paper.mp4`, `hybrid.mp4`
- `triple.mp4`
- `base.jsonl`, `paper.jsonl`, `hybrid.jsonl`
- `paper_behavior.jsonl`, `hybrid_behavior.jsonl`

## Real-World / UCF-Crime Integration (MIL Ranking Head)

The UCF “Real-world anomaly detection” paper (CVPR 2018) trains a small network with a
**MIL ranking loss** on top of 3D CNN features.

This repo includes a lightweight reimplementation of that *head*:
- training: `train/train_mil_ranking.py`
- inference/visualization: `infer/*ensemble*` (optional `--mil-head`)

Train a MIL head (example: UCF-Crime normal vs crime):

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 python train/train_mil_ranking.py \
  --normal-dir data/ucfcrime/normal \
  --abnormal-dir data/ucfcrime/crime \
  --feature-checkpoint models/paper_c3d_depth3_tiny_mps/c3d_depth3_best.pt \
  --out-dir models/mil_ucfcrime \
  --device mps \
  --max-videos-normal 50 \
  --max-videos-abnormal 50 \
  --max-clips-per-video 32
```

Then run the ensemble (baseline + paper + MIL):

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 python infer/visualize_ensemble_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --models-dir models \
  --checkpoint models/paper_c3d_depth3_tiny_mps/c3d_depth3_best.pt \
  --svm-model models/paper_c3d_depth3_tiny_mps/paper_multi_svm.joblib \
  --mil-head models/mil_ucfcrime/mil_head_latest.pt \
  --out artifacts/infer/ensemble.jsonl \
  --out-debug artifacts/infer/ensemble_debug.jsonl \
  --out-video artifacts/infer/ensemble.mp4 \
  --device mps
```

## Compare All (2x2 Grid)

Creates a 2x2 grid: baseline, paper, hybrid, ensemble.

```bash
bash scripts/compare_all.sh \
  --video /path/to/video.mp4 \
  --mil-head models/mil_ucfcrime/mil_head_latest.pt \
  --device mps
```

Optional: draw a demo route between analysis zones (works best with grid-like `zones_analysis.json`):

```bash
bash scripts/compare_all.sh \
  --video /path/to/video.mp4 \
  --mil-head models/mil_ucfcrime/mil_head_latest.pt \
  --route-from AZ4 \
  --route-to AZ3 \
  --device mps
```

## Quick “Small Model” Test Clip

If you have the tiny paper weights in:
- `models/paper_c3d_depth3_tiny_mps/c3d_depth3_best.pt`
- `models/paper_c3d_depth3_tiny_mps/paper_multi_svm.joblib`

And the Crowd-11 tiny split at:
- `data/crowd11_tiny/test/crossing_flows/crossing_flows__489_1_039408586.mp4`

Then this is a fast sanity check:

```bash
python infer/infer_paper_video.py \
  --video data/crowd11_tiny/test/crossing_flows/crossing_flows__489_1_039408586.mp4 \
  --zones zones_analysis.json \
  --checkpoint models/paper_c3d_depth3_tiny_mps/c3d_depth3_best.pt \
  --svm-model models/paper_c3d_depth3_tiny_mps/paper_multi_svm.joblib \
  --out artifacts/infer/paper_tiny.jsonl \
  --out-behavior artifacts/infer/paper_tiny_behavior.jsonl \
  --device mps \
  --max-clips 40
```

Note: in this repo the `data/crowd11_tiny/...` clips are symlinks into `data/crowd11_raw/...`.

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
- YOLO sensitivity can be tuned with `--yolo-conf-threshold` (default `0.25`).
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
  --max-rows-per-dataset 200000 \
  --n-estimators 400 \
  --contamination auto
```

Calibrate on multiple normal feature files (recommended):

```bash
python train/calibrate.py \
  --features \
    artifacts/features/ucsd_train.parquet \
    artifacts/features/avenue_train.parquet \
    artifacts/features/pets2009_normal.parquet \
    artifacts/features/rwf2000_normal.parquet \
    artifacts/features/ucfcrime_normal.parquet \
    artifacts/features/shanghaitech_normal.parquet \
    artifacts/features/mall_normal.parquet \
  --max-rows-per-dataset 100000 \
  --max-total-rows 200000 \
  --models-dir models
```

Artifacts produced:
- `models/scaler.joblib`
- `models/isoforest.joblib`
- `models/calib.json`

## Model Improvement Presets

If normal splits are showing too-high anomaly, run one of these:

1. Broad calibration baseline:
```bash
python train/calibrate.py \
  --features \
    artifacts/features/ucsd_train.parquet \
    artifacts/features/avenue_train.parquet \
    artifacts/features/pets2009_normal.parquet \
    artifacts/features/rwf2000_normal.parquet \
    artifacts/features/ucfcrime_normal.parquet \
    artifacts/features/shanghaitech_normal.parquet \
    artifacts/features/mall_normal.parquet \
  --models-dir models \
  --max-rows-per-dataset 100000 \
  --max-total-rows 200000
```

2. Exclude noisy synthetic domain from calibration (example: shanghaitech):
```bash
python train/calibrate.py \
  --features \
    artifacts/features/ucsd_train.parquet \
    artifacts/features/avenue_train.parquet \
    artifacts/features/pets2009_normal.parquet \
    artifacts/features/rwf2000_normal.parquet \
    artifacts/features/ucfcrime_normal.parquet \
    artifacts/features/shanghaitech_normal.parquet \
    artifacts/features/mall_normal.parquet \
  --models-dir models \
  --exclude-datasets shanghaitech \
  --max-rows-per-dataset 100000 \
  --max-total-rows 200000
```

3. Retrain with stricter balance (reduce dominance of huge sets):
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
  --max-rows-per-dataset 120000 \
  --max-total-rows 350000 \
  --n-estimators 400
```

## One-Command Tuning

Run automatic tuning across multiple contamination values:

```bash
bash scripts/tune.sh
```

Outputs:
- Per-run logs and artifacts: `artifacts/tuning/contamination_*/`
- Ranked summary: `artifacts/tuning/summary_ranked.csv`

Useful overrides:

```bash
bash scripts/tune.sh \
  --contaminations "auto,0.01,0.03,0.05" \
  --fps 2 \
  --detect-every 6 \
  --max-videos-per-split 1 \
  --yolo-conf-threshold 0.25
```

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

## Visual Inference (popup + boxes + anomaly overlay)

Open an interactive window with:
- zone polygons color-coded by anomaly
- per-zone labels (`AZ*`, anomaly, density, people count)
- person bounding boxes + zone assignment labels

```bash
python infer/visualize_video.py \
  --video "data/avenue/Avenue Dataset/testing_videos/01.avi" \
  --zones zones_analysis.json \
  --models-dir models \
  --fps 3 \
  --out-jsonl artifacts/infer/avenue_test01_visual.jsonl \
  --out-video artifacts/infer/avenue_test01_annotated.mp4
```

Keyboard controls:
- `q` or `Esc`: quit
- `Space`: pause/resume

Headless mode (no popup, save annotated video only):

```bash
python infer/visualize_video.py \
  --video /path/to/video.mp4 \
  --zones zones_analysis.json \
  --models-dir models \
  --no-show \
  --out-video artifacts/infer/output_annotated.mp4
```

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
