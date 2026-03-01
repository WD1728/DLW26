#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUNS_ROOT="${ROOT_DIR}/models/paper_c3d_runs"
VIDEO_PATH=""
ZONES_PATH="${ROOT_DIR}/zones_analysis.json"
BASE_MODELS_DIR="${ROOT_DIR}/models"
OUT_DIR="${ROOT_DIR}/artifacts/compare_full"
DEVICE="mps"
FPS="3"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --video)
      VIDEO_PATH="$2"
      shift 2
      ;;
    --runs-root)
      RUNS_ROOT="$2"
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
    --out-dir)
      OUT_DIR="$2"
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
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$VIDEO_PATH" ]]; then
  echo "Usage: bash scripts/compare_models_from_runs.sh --video <path-to-video>" >&2
  exit 1
fi

svm_files=()
while IFS= read -r line; do
  svm_files+=("$line")
done < <(find "$RUNS_ROOT" -type f -name 'paper_multi_svm.joblib' | sort)

if [[ ${#svm_files[@]} -eq 0 ]]; then
  echo "No trained paper SVM found under: $RUNS_ROOT" >&2
  echo "Wait for scripts/run_paper_pipeline.sh to finish." >&2
  exit 2
fi

SVM_MODEL="${svm_files[${#svm_files[@]}-1]}"
FULL_DIR="$(dirname "$SVM_MODEL")"
ckpt_files=()
while IFS= read -r line; do
  ckpt_files+=("$line")
done < <(find "$FULL_DIR" -maxdepth 1 -type f -name 'c3d_depth*_best.pt' | sort)

if [[ ${#ckpt_files[@]} -eq 0 ]]; then
  echo "No paper checkpoint found in: $FULL_DIR" >&2
  exit 3
fi
PAPER_CHECKPOINT="${ckpt_files[${#ckpt_files[@]}-1]}"

echo "[info] using paper checkpoint: $PAPER_CHECKPOINT"
echo "[info] using paper svm: $SVM_MODEL"

bash scripts/compare_models.sh \
  --video "$VIDEO_PATH" \
  --zones "$ZONES_PATH" \
  --base-models-dir "$BASE_MODELS_DIR" \
  --paper-checkpoint "$PAPER_CHECKPOINT" \
  --paper-svm "$SVM_MODEL" \
  --out-dir "$OUT_DIR" \
  --device "$DEVICE" \
  --fps "$FPS"
