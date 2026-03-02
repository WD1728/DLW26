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

DATA_ROOT="${ROOT_DIR}/data/crowd11"
DEVICE="mps"
BATCH_SIZE="6"
NUM_WORKERS="0"
FULL_EPOCHS="14"
WARMUP_EPOCHS="2"
SEARCH_EPOCHS="2"
LOG_EVERY="100"
OUT_ROOT="${ROOT_DIR}/models/paper_c3d_runs"
LOG_DIR="${ROOT_DIR}/artifacts/logs"
MAX_CLIPS_SEARCH="1"
MAX_CLIPS_FULL="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-root)
      DATA_ROOT="$2"
      shift 2
      ;;
    --device)
      DEVICE="$2"
      shift 2
      ;;
    --batch-size)
      BATCH_SIZE="$2"
      shift 2
      ;;
    --num-workers)
      NUM_WORKERS="$2"
      shift 2
      ;;
    --full-epochs)
      FULL_EPOCHS="$2"
      shift 2
      ;;
    --log-every)
      LOG_EVERY="$2"
      shift 2
      ;;
    --out-root)
      OUT_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUT_ROOT" "$LOG_DIR"

run_train() {
  local depth="$1"
  local epochs="$2"
  local max_clips="$3"
  local out_dir="$4"
  local log_file="$5"

  if [[ -f "${out_dir}/c3d_depth${depth}_best.pt" ]]; then
    echo "[skip] existing checkpoint: ${out_dir}/c3d_depth${depth}_best.pt"
    return
  fi

  PYTORCH_ENABLE_MPS_FALLBACK=1 PYTHONUNBUFFERED=1 \
  "$PYTHON_BIN" train/train_c3d_paper.py \
    --data-root "$DATA_ROOT" \
    --train-split train \
    --val-split val \
    --temporal-depth "$depth" \
    --epochs "$epochs" \
    --batch-size "$BATCH_SIZE" \
    --num-workers "$NUM_WORKERS" \
    --max-clips-per-video "$max_clips" \
    --out-dir "$out_dir" \
    --device "$DEVICE" \
    --log-every "$LOG_EVERY" | tee "$log_file"
}

echo "[stage] warmup depth=3"
WARMUP_DIR="${OUT_ROOT}/warmup_depth3"
run_train 3 "$WARMUP_EPOCHS" "$MAX_CLIPS_SEARCH" "$WARMUP_DIR" "${LOG_DIR}/paper_warmup_depth3.log"

echo "[stage] depth search (1,3,5,7)"
for d in 1 3 5 7; do
  SEARCH_DIR="${OUT_ROOT}/search_depth${d}"
  run_train "$d" "$SEARCH_EPOCHS" "$MAX_CLIPS_SEARCH" "$SEARCH_DIR" "${LOG_DIR}/paper_search_depth${d}.log"
done

echo "[stage] selecting best depth from search runs"
BEST_DEPTH="$(OUT_ROOT_ENV="$OUT_ROOT" "$PYTHON_BIN" - <<'PY'
from pathlib import Path
import json
import os

root = Path(os.environ["OUT_ROOT_ENV"])
best_depth = None
best_acc = -1.0
for d in [1, 3, 5, 7]:
    meta = root / f"search_depth{d}" / "train_meta.json"
    if not meta.exists():
        continue
    data = json.loads(meta.read_text(encoding="utf-8"))
    acc = float(data.get("best_val_acc", -1.0))
    if acc > best_acc:
        best_acc = acc
        best_depth = d
if best_depth is None:
    raise SystemExit("3")
print(best_depth)
PY
)"
echo "[info] best depth=${BEST_DEPTH}"

echo "[stage] full train depth=${BEST_DEPTH}"
FULL_DIR="${OUT_ROOT}/full_depth${BEST_DEPTH}"
run_train "$BEST_DEPTH" "$FULL_EPOCHS" "$MAX_CLIPS_FULL" "$FULL_DIR" "${LOG_DIR}/paper_full_depth${BEST_DEPTH}.log"

echo "[stage] train paper Multi-SVM"
if [[ ! -f "${FULL_DIR}/paper_multi_svm.joblib" ]]; then
  PYTORCH_ENABLE_MPS_FALLBACK=1 PYTHONUNBUFFERED=1 \
  "$PYTHON_BIN" train/train_multisvm_paper.py \
    --data-root "$DATA_ROOT" \
    --train-split train \
    --eval-split test \
    --checkpoint "${FULL_DIR}/c3d_depth${BEST_DEPTH}_best.pt" \
    --out-dir "$FULL_DIR" \
    --clip-len 16 \
    --batch-size "$BATCH_SIZE" \
    --max-clips-per-video 0 \
    --num-video-clips 10 \
    --device "$DEVICE" | tee "${LOG_DIR}/paper_multisvm_depth${BEST_DEPTH}.log"
else
  echo "[skip] existing SVM: ${FULL_DIR}/paper_multi_svm.joblib"
fi

echo "[done] pipeline complete"
echo "[done] best depth=${BEST_DEPTH}"
echo "[done] full model dir=${FULL_DIR}"
