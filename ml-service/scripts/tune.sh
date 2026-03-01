#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-${ROOT_DIR}/.venv/bin/python}"

FEATURE_DIR="${ROOT_DIR}/artifacts/features"
RUNS_DIR="${ROOT_DIR}/artifacts/tuning"
DATA_ROOT="${ROOT_DIR}/data"
ZONES_PATH="${ROOT_DIR}/zones_analysis.json"

MAX_ROWS_PER_DATASET=120000
MAX_TOTAL_ROWS=350000
N_ESTIMATORS=400

CAL_MAX_ROWS_PER_DATASET=100000
CAL_MAX_TOTAL_ROWS=200000
CAL_EXCLUDE_DATASETS="shanghaitech"

FPS=2
DETECT_EVERY=6
YOLO_CONF_THRESHOLD=0.25
MAX_VIDEOS_PER_SPLIT=1

CONTAMINATIONS="auto,0.02,0.05"

usage() {
  cat <<'USAGE'
Usage: bash scripts/tune.sh [options]

Options:
  --python PATH                      Python executable (default: .venv/bin/python)
  --feature-dir PATH                 Feature parquet directory (default: artifacts/features)
  --runs-dir PATH                    Output tuning directory (default: artifacts/tuning)
  --data-root PATH                   Dataset root (default: data)
  --zones PATH                       Zones JSON path (default: zones_analysis.json)
  --contaminations LIST              Comma list, e.g. "auto,0.02,0.05"
  --max-rows-per-dataset N           Train cap per dataset (default: 120000)
  --max-total-rows N                 Train global cap (default: 350000)
  --n-estimators N                   IsolationForest estimators (default: 400)
  --cal-max-rows-per-dataset N       Calibration cap per dataset (default: 100000)
  --cal-max-total-rows N             Calibration global cap (default: 200000)
  --cal-exclude-datasets LIST        Comma list to exclude in calibration (default: shanghaitech)
  --fps N                            Eval fps (default: 2)
  --detect-every N                   Eval detector stride (default: 6)
  --yolo-conf-threshold N            YOLO confidence threshold (default: 0.25)
  --max-videos-per-split N           Eval max videos per split (default: 1)
  -h, --help                         Show help

Example:
  bash scripts/tune.sh --contaminations "auto,0.01,0.03,0.05"
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --feature-dir) FEATURE_DIR="$2"; shift 2 ;;
    --runs-dir) RUNS_DIR="$2"; shift 2 ;;
    --data-root) DATA_ROOT="$2"; shift 2 ;;
    --zones) ZONES_PATH="$2"; shift 2 ;;
    --contaminations) CONTAMINATIONS="$2"; shift 2 ;;
    --max-rows-per-dataset) MAX_ROWS_PER_DATASET="$2"; shift 2 ;;
    --max-total-rows) MAX_TOTAL_ROWS="$2"; shift 2 ;;
    --n-estimators) N_ESTIMATORS="$2"; shift 2 ;;
    --cal-max-rows-per-dataset) CAL_MAX_ROWS_PER_DATASET="$2"; shift 2 ;;
    --cal-max-total-rows) CAL_MAX_TOTAL_ROWS="$2"; shift 2 ;;
    --cal-exclude-datasets) CAL_EXCLUDE_DATASETS="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --detect-every) DETECT_EVERY="$2"; shift 2 ;;
    --yolo-conf-threshold) YOLO_CONF_THRESHOLD="$2"; shift 2 ;;
    --max-videos-per-split) MAX_VIDEOS_PER_SPLIT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python executable not found or not executable: $PYTHON_BIN" >&2
  exit 1
fi

if [[ ! -f "$ZONES_PATH" ]]; then
  echo "Zones file not found: $ZONES_PATH" >&2
  exit 1
fi

FEATURE_FILES=()
for f in \
  ucsd_train.parquet \
  avenue_train.parquet \
  pets2009_normal.parquet \
  rwf2000_normal.parquet \
  ucfcrime_normal.parquet \
  shanghaitech_normal.parquet \
  mall_normal.parquet; do
  if [[ -f "${FEATURE_DIR}/${f}" ]]; then
    FEATURE_FILES+=("${FEATURE_DIR}/${f}")
  fi
done

if [[ "${#FEATURE_FILES[@]}" -eq 0 ]]; then
  echo "No feature files found in ${FEATURE_DIR}" >&2
  exit 1
fi

mkdir -p "$RUNS_DIR"
IFS=',' read -r -a CONTAMINATION_VALUES <<< "$CONTAMINATIONS"
IFS=',' read -r -a CAL_EXCLUDE_VALUES <<< "$CAL_EXCLUDE_DATASETS"

echo "[tune] python: ${PYTHON_BIN}"
echo "[tune] features: ${#FEATURE_FILES[@]} files"
echo "[tune] contaminations: ${CONTAMINATION_VALUES[*]}"
echo "[tune] output: ${RUNS_DIR}"

for contam in "${CONTAMINATION_VALUES[@]}"; do
  run_tag="${contam//./p}"
  run_tag="${run_tag//-/_}"
  run_dir="${RUNS_DIR}/contamination_${run_tag}"
  models_dir="${run_dir}/models"
  eval_dir="${run_dir}/eval_outputs"

  mkdir -p "$run_dir" "$models_dir" "$eval_dir"
  echo "[tune] ===== run ${run_tag} (contamination=${contam}) ====="

  train_cmd=(
    "$PYTHON_BIN" "${ROOT_DIR}/train/train_isoforest.py"
    --features "${FEATURE_FILES[@]}"
    --models-dir "$models_dir"
    --max-rows-per-dataset "$MAX_ROWS_PER_DATASET"
    --max-total-rows "$MAX_TOTAL_ROWS"
    --n-estimators "$N_ESTIMATORS"
    --contamination "$contam"
  )

  cal_cmd=(
    "$PYTHON_BIN" "${ROOT_DIR}/train/calibrate.py"
    --features "${FEATURE_FILES[@]}"
    --models-dir "$models_dir"
    --max-rows-per-dataset "$CAL_MAX_ROWS_PER_DATASET"
    --max-total-rows "$CAL_MAX_TOTAL_ROWS"
  )
  if [[ "${#CAL_EXCLUDE_VALUES[@]}" -gt 0 && -n "${CAL_EXCLUDE_VALUES[0]}" ]]; then
    cal_cmd+=(--exclude-datasets "${CAL_EXCLUDE_VALUES[@]}")
  fi

  eval_cmd=(
    "$PYTHON_BIN" "${ROOT_DIR}/eval/eval_datasets.py"
    --zones "$ZONES_PATH"
    --data-root "$DATA_ROOT"
    --models-dir "$models_dir"
    --fps "$FPS"
    --detect-every "$DETECT_EVERY"
    --yolo-conf-threshold "$YOLO_CONF_THRESHOLD"
    --max-videos-per-split "$MAX_VIDEOS_PER_SPLIT"
    --out-dir "$eval_dir"
  )

  "${train_cmd[@]}" 2>&1 | tee "${run_dir}/train.log"
  "${cal_cmd[@]}" 2>&1 | tee "${run_dir}/calibrate.log"
  "${eval_cmd[@]}" 2>&1 | tee "${run_dir}/eval.log"
done

summary_csv="${RUNS_DIR}/summary_ranked.csv"

"$PYTHON_BIN" - "$RUNS_DIR" "$summary_csv" <<'PY'
import csv
import sys
from pathlib import Path

runs_dir = Path(sys.argv[1])
summary_csv = Path(sys.argv[2])

pairs = {
    "ucsd": ("train", "test"),
    "avenue": ("train", "test"),
    "rwf2000": ("normal", "fight"),
    "ucfcrime": ("normal", "crime"),
    "mall": ("normal", "crowded"),
}

def load_eval_table(eval_log: Path):
    rows = {}
    if not eval_log.exists():
        return rows
    for line in eval_log.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("dataset, split, mean_anomaly, p95_anomaly"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 4:
            continue
        ds, split, mean_s, p95_s = parts
        try:
            rows[(ds, split)] = (float(mean_s), float(p95_s))
        except ValueError:
            continue
    return rows

results = []
for run_dir in sorted(runs_dir.glob("contamination_*")):
    table = load_eval_table(run_dir / "eval.log")
    score_terms = []
    compared = 0
    for ds, (normal_split, abnormal_split) in pairs.items():
        n = table.get((ds, normal_split))
        a = table.get((ds, abnormal_split))
        if n is None or a is None:
            continue
        compared += 1
        delta_mean = a[0] - n[0]
        delta_p95 = a[1] - n[1]
        score_terms.append(delta_mean + 0.5 * delta_p95)
    if compared == 0:
        score = -999.0
    else:
        score = sum(score_terms) / compared
    results.append((run_dir.name, score, compared))

results.sort(key=lambda x: x[1], reverse=True)

summary_csv.parent.mkdir(parents=True, exist_ok=True)
with summary_csv.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["rank", "run", "score", "compared_pairs"])
    for i, (run, score, compared) in enumerate(results, start=1):
        w.writerow([i, run, f"{score:.6f}", compared])

print("[tune] Ranking:")
for i, (run, score, compared) in enumerate(results, start=1):
    print(f"{i:>2}. {run:<28} score={score:.6f} pairs={compared}")
if results:
    print(f"[tune] Best run: {results[0][0]}")
print(f"[tune] Summary CSV: {summary_csv}")
PY

echo "[tune] done."
