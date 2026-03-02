#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    PYTHON_BIN="python"
  fi
fi

VIDEO_PATH=""
ZONES_PATH="${ROOT_DIR}/zones_analysis.json"
BASE_MODELS_DIR="${ROOT_DIR}/models"
PAPER_CHECKPOINT="${ROOT_DIR}/models/paper_c3d_depth3_tiny_mps/c3d_depth3_best.pt"
PAPER_SVM="${ROOT_DIR}/models/paper_c3d_depth3_tiny_mps/paper_multi_svm.joblib"
DEVICE="mps"
FPS="3"
OUT_DIR="${ROOT_DIR}/artifacts/compare"
MAX_FRAMES="0"
MAX_CLIPS="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --video)
      VIDEO_PATH="$2"
      shift 2
      ;;
    --zones)
      ZONES_PATH="$2"
      shift 2
      ;;
    --base-models-dir)
      BASE_MODELS_DIR="$2"
      shift 2
      ;;
    --paper-checkpoint)
      PAPER_CHECKPOINT="$2"
      shift 2
      ;;
    --paper-svm)
      PAPER_SVM="$2"
      shift 2
      ;;
    --device)
      DEVICE="$2"
      shift 2
      ;;
    --fps)
      FPS="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --max-frames)
      MAX_FRAMES="$2"
      shift 2
      ;;
    --max-clips)
      MAX_CLIPS="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$VIDEO_PATH" ]]; then
  echo "Usage: bash scripts/compare_models.sh --video <path-to-video> [--out-dir artifacts/compare] [--device mps|cpu] [--max-frames N] [--max-clips N]" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

BASE_JSONL="${OUT_DIR}/base.jsonl"
BASE_VIDEO="${OUT_DIR}/base.mp4"
PAPER_JSONL="${OUT_DIR}/paper.jsonl"
PAPER_BEHAVIOR_JSONL="${OUT_DIR}/paper_behavior.jsonl"
PAPER_VIDEO="${OUT_DIR}/paper.mp4"
HYBRID_JSONL="${OUT_DIR}/hybrid.jsonl"
HYBRID_BEHAVIOR_JSONL="${OUT_DIR}/hybrid_behavior.jsonl"
HYBRID_VIDEO="${OUT_DIR}/hybrid.mp4"
TRIPLE_VIDEO="${OUT_DIR}/triple.mp4"

echo "[1/4] Baseline model inference + visualization"
"$PYTHON_BIN" infer/visualize_video.py \
  --video "$VIDEO_PATH" \
  --zones "$ZONES_PATH" \
  --models-dir "$BASE_MODELS_DIR" \
  --fps "$FPS" \
  --out-jsonl "$BASE_JSONL" \
  --out-video "$BASE_VIDEO" \
  --no-show \
  --max-frames "$MAX_FRAMES"

echo "[2/4] Paper model inference + visualization"
"$PYTHON_BIN" infer/visualize_paper_video.py \
  --video "$VIDEO_PATH" \
  --zones "$ZONES_PATH" \
  --checkpoint "$PAPER_CHECKPOINT" \
  --svm-model "$PAPER_SVM" \
  --out "$PAPER_JSONL" \
  --out-behavior "$PAPER_BEHAVIOR_JSONL" \
  --out-video "$PAPER_VIDEO" \
  --device "$DEVICE" \
  --no-show \
  --max-clips "$MAX_CLIPS"

echo "[3/4] Hybrid model inference + visualization"
"$PYTHON_BIN" infer/visualize_hybrid_video.py \
  --video "$VIDEO_PATH" \
  --zones "$ZONES_PATH" \
  --models-dir "$BASE_MODELS_DIR" \
  --checkpoint "$PAPER_CHECKPOINT" \
  --svm-model "$PAPER_SVM" \
  --out "$HYBRID_JSONL" \
  --out-behavior "$HYBRID_BEHAVIOR_JSONL" \
  --out-video "$HYBRID_VIDEO" \
  --device "$DEVICE" \
  --no-show \
  --max-clips "$MAX_CLIPS"

echo "[4/4] Triple render"
ffmpeg -y -hide_banner -loglevel error \
  -i "$BASE_VIDEO" \
  -i "$PAPER_VIDEO" \
  -i "$HYBRID_VIDEO" \
  -filter_complex "[0:v]setpts=PTS-STARTPTS,scale=640:480[a];[1:v]setpts=PTS-STARTPTS,scale=640:480[b];[2:v]setpts=PTS-STARTPTS,scale=640:480[c];[a][b][c]hstack=inputs=3[v]" \
  -map "[v]" \
  -c:v libx264 \
  -crf 20 \
  -preset veryfast \
  "$TRIPLE_VIDEO"

echo
echo "Done."
echo "Baseline JSONL: $BASE_JSONL"
echo "Paper JSONL:    $PAPER_JSONL"
echo "Paper behavior: $PAPER_BEHAVIOR_JSONL"
echo "Hybrid JSONL:   $HYBRID_JSONL"
echo "Hybrid behavior:$HYBRID_BEHAVIOR_JSONL"
echo "Triple video:   $TRIPLE_VIDEO"
