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
MIL_HEAD=""
DEVICE="mps"
FPS="3"
OUT_DIR="${ROOT_DIR}/artifacts/compare_all"
MAX_FRAMES="0"
MAX_CLIPS="0"
ENSEMBLE_PAPER_WEIGHT="0.55"
ENSEMBLE_MIL_WEIGHT="0.25"
ROUTE_FROM=""
ROUTE_TO=""

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
    --mil-head)
      MIL_HEAD="$2"
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
    --ensemble-paper-weight)
      ENSEMBLE_PAPER_WEIGHT="$2"
      shift 2
      ;;
    --ensemble-mil-weight)
      ENSEMBLE_MIL_WEIGHT="$2"
      shift 2
      ;;
    --route-from)
      ROUTE_FROM="$2"
      shift 2
      ;;
    --route-to)
      ROUTE_TO="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$VIDEO_PATH" ]]; then
  echo "Usage: bash scripts/compare_all.sh --video <path-to-video> [--mil-head <mil_head.pt>] [--max-frames N] [--max-clips N]" >&2
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
ENSEMBLE_JSONL="${OUT_DIR}/ensemble.jsonl"
ENSEMBLE_DEBUG_JSONL="${OUT_DIR}/ensemble_debug.jsonl"
ENSEMBLE_VIDEO="${OUT_DIR}/ensemble.mp4"
GRID_VIDEO="${OUT_DIR}/grid_2x2.mp4"

echo "[1/5] Baseline model"
"$PYTHON_BIN" infer/visualize_video.py \
  --video "$VIDEO_PATH" \
  --zones "$ZONES_PATH" \
  --models-dir "$BASE_MODELS_DIR" \
  --fps "$FPS" \
  --out-jsonl "$BASE_JSONL" \
  --out-video "$BASE_VIDEO" \
  --no-show \
  --max-frames "$MAX_FRAMES"

echo "[2/5] Paper behavior model"
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

echo "[3/5] Hybrid fuse (baseline + paper)"
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

echo "[4/5] Ensemble (baseline + paper + optional MIL)"
ENSEMBLE_ARGS=()
if [[ -n "$MIL_HEAD" ]]; then
  ENSEMBLE_ARGS+=(--mil-head "$MIL_HEAD")
fi
if [[ -n "$ROUTE_FROM" && -n "$ROUTE_TO" ]]; then
  ENSEMBLE_ARGS+=(--route-from "$ROUTE_FROM" --route-to "$ROUTE_TO" --route-out "${OUT_DIR}/route.jsonl")
fi

"$PYTHON_BIN" infer/visualize_ensemble_video.py \
  --video "$VIDEO_PATH" \
  --zones "$ZONES_PATH" \
  --models-dir "$BASE_MODELS_DIR" \
  --checkpoint "$PAPER_CHECKPOINT" \
  --svm-model "$PAPER_SVM" \
  --out "$ENSEMBLE_JSONL" \
  --out-debug "$ENSEMBLE_DEBUG_JSONL" \
  --out-video "$ENSEMBLE_VIDEO" \
  --device "$DEVICE" \
  --paper-weight "$ENSEMBLE_PAPER_WEIGHT" \
  --mil-weight "$ENSEMBLE_MIL_WEIGHT" \
  --no-show \
  --max-clips "$MAX_CLIPS" \
  "${ENSEMBLE_ARGS[@]}"

echo "[5/5] 2x2 grid render"
ffmpeg -y -hide_banner -loglevel error \
  -i "$BASE_VIDEO" \
  -i "$PAPER_VIDEO" \
  -i "$HYBRID_VIDEO" \
  -i "$ENSEMBLE_VIDEO" \
  -filter_complex "\
    [0:v]setpts=PTS-STARTPTS,scale=640:480[a];\
    [1:v]setpts=PTS-STARTPTS,scale=640:480[b];\
    [2:v]setpts=PTS-STARTPTS,scale=640:480[c];\
    [3:v]setpts=PTS-STARTPTS,scale=640:480[d];\
    [a][b]hstack=inputs=2[top];\
    [c][d]hstack=inputs=2[bottom];\
    [top][bottom]vstack=inputs=2[v]" \
  -map "[v]" \
  -c:v libx264 \
  -crf 20 \
  -preset veryfast \
  "$GRID_VIDEO"

echo
echo "Done."
echo "Out dir:        $OUT_DIR"
echo "Grid 2x2:       $GRID_VIDEO"
echo "MIL head used:  ${MIL_HEAD:-<none>}"
