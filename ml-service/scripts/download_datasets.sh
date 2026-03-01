#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT_DIR}/data"
TMP_DIR="${DATA_DIR}/_downloads"
mkdir -p "${DATA_DIR}" "${TMP_DIR}"

log() {
  printf '[download] %s\n' "$1"
}

try_curl_download() {
  local name="$1"
  local url="$2"
  local out_file="$3"

  log "Attempting ${name}: ${url}"
  if curl -L --fail --retry 2 --connect-timeout 20 "$url" -o "$out_file"; then
    log "Downloaded ${name} -> ${out_file}"
    return 0
  fi

  log "Failed to download ${name} from ${url}"
  rm -f "$out_file"
  return 1
}

extract_archive() {
  local archive="$1"
  local out_dir="$2"
  mkdir -p "$out_dir"

  case "$archive" in
    *.tar.gz|*.tgz)
      tar -xzf "$archive" -C "$out_dir"
      ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -o "$archive" -d "$out_dir" >/dev/null
      else
        log "unzip not available; cannot extract ${archive}"
        return 1
      fi
      ;;
    *)
      log "Unknown archive format: ${archive}"
      return 1
      ;;
  esac
}

# Ensure expected dataset folders exist.
for d in ucsd avenue mall pets2009 rwf2000 ucfcrime shanghaitech; do
  mkdir -p "${DATA_DIR}/${d}"
done

# UCSD Pedestrian (public mirrors vary; try official link first)
UCSD_ARCHIVE="${TMP_DIR}/ucsd_ped.tar.gz"
if try_curl_download "UCSD Pedestrian" "http://www.svcl.ucsd.edu/projects/anomaly/UCSD_Anomaly_Dataset.tar.gz" "$UCSD_ARCHIVE"; then
  extract_archive "$UCSD_ARCHIVE" "${DATA_DIR}/ucsd" || true
fi

# Avenue dataset (often requires mirror/manual)
AVENUE_ARCHIVE="${TMP_DIR}/avenue.zip"
if try_curl_download "Avenue" "http://www.cse.cuhk.edu.hk/leojia/projects/detectabnormal/Avenue_Dataset.zip" "$AVENUE_ARCHIVE"; then
  extract_archive "$AVENUE_ARCHIVE" "${DATA_DIR}/avenue" || true
fi

# PETS2009 sample attempt (public benchmark mirrors may move)
PETS_ARCHIVE="${TMP_DIR}/pets2009.zip"
if try_curl_download "PETS2009" "https://www.cvg.reading.ac.uk/PETS2009/a.html" "$PETS_ARCHIVE"; then
  log "PETS2009 URL may be an HTML landing page; please verify extracted content."
fi

# Kaggle-assisted downloads if configured.
if command -v kaggle >/dev/null 2>&1; then
  log "Kaggle CLI detected; attempting Kaggle datasets where available."
  kaggle datasets download -d mohammadrizwankhan/rwf-2000-dataset -p "${DATA_DIR}/rwf2000" --unzip || true
  kaggle datasets download -d odins0n/ucf-crime-dataset -p "${DATA_DIR}/ucfcrime" --unzip || true
else
  log "Kaggle CLI not found; skipping Kaggle-based download attempts."
fi

cat <<'MANUAL'

Manual setup required for datasets that are gated or mirrored inconsistently:

1. UCSD Pedestrian
   - Source: http://www.svcl.ucsd.edu/projects/anomaly/dataset.htm
   - Place clips under: data/ucsd/train and data/ucsd/test

2. Avenue
   - Source: http://www.cse.cuhk.edu.hk/leojia/projects/detectabnormal/
   - Place clips under: data/avenue/train and data/avenue/test

3. Mall dataset
   - Source: search for "Mall Dataset crowd counting"
   - Place under: data/mall/normal and optionally data/mall/crowded

4. PETS2009
   - Source: https://www.cvg.reading.ac.uk/pets2009/data.html
   - Place normal-flow videos under: data/pets2009/normal

5. RWF-2000
   - Source: Kaggle or official mirror
   - Place under: data/rwf2000/normal and data/rwf2000/fight

6. UCF-Crime subset
   - Source: official UCF-Crime / curated subsets
   - Place under: data/ucfcrime/normal and data/ucfcrime/crime

7. ShanghaiTech
   - Source: official ShanghaiTech Campus dataset page
   - Place normal clips under: data/shanghaitech/normal

After arranging files, verify video discovery with:
  find data -type f \( -name '*.mp4' -o -name '*.avi' \)
MANUAL
