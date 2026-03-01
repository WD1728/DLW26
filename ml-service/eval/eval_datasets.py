#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from infer.infer_video import run_inference_records
from ml.videoio import find_videos, resolve_dataset_split_dir


NORMAL_SPLITS = [
    ("ucsd", "train"),
    ("avenue", "train"),
    ("pets2009", "normal"),
    ("rwf2000", "normal"),
    ("ucfcrime", "normal"),
    ("shanghaitech", "normal"),
    ("mall", "normal"),
]

ABNORMAL_SPLITS = [
    ("ucsd", "test"),
    ("avenue", "test"),
    ("rwf2000", "fight"),
    ("ucfcrime", "crime"),
    ("mall", "crowded"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate anomaly summaries across configured datasets/splits.")
    parser.add_argument("--zones", default=str(PROJECT_ROOT / "zones_analysis.json"))
    parser.add_argument("--data-root", default=str(PROJECT_ROOT / "data"))
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--detect-every", type=int, default=3)
    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)
    parser.add_argument("--yolo-model", default="yolov8n.pt")
    parser.add_argument("--max-videos-per-split", type=int, default=3)
    parser.add_argument("--example-jsonl-per-split", type=int, default=1)
    parser.add_argument("--out-dir", default=str(PROJECT_ROOT / "eval" / "outputs"))
    return parser.parse_args()


def summarize_video(
    video_path: Path,
    args: argparse.Namespace,
    write_jsonl: Path | None = None,
) -> Tuple[List[float], int]:
    anomalies: List[float] = []
    row_count = 0

    writer = write_jsonl.open("w", encoding="utf-8") if write_jsonl else None
    try:
        for record in run_inference_records(
            video_path=video_path,
            zones_path=args.zones,
            models_dir=args.models_dir,
            fps=args.fps,
            detect_every=args.detect_every,
            cctv_sim=args.cctv_sim,
            jpeg_quality=args.jpeg_quality,
            yolo_model=args.yolo_model,
        ):
            row_count += 1
            if writer:
                writer.write(json.dumps(record, separators=(",", ":")) + "\n")

            for zone in record.get("zones", []):
                anomalies.append(float(zone.get("anomaly", 0.0)))
    finally:
        if writer:
            writer.close()

    return anomalies, row_count


def print_summary_table(rows: List[Dict[str, object]]) -> None:
    print("dataset, split, mean_anomaly, p95_anomaly")
    for row in rows:
        print(
            f"{row['dataset']}, {row['split']}, "
            f"{row['mean_anomaly']:.4f}, {row['p95_anomaly']:.4f}"
        )


def main() -> None:
    args = parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary_rows: List[Dict[str, object]] = []

    eval_plan = [("normal", d, s) for d, s in NORMAL_SPLITS] + [
        ("abnormal", d, s) for d, s in ABNORMAL_SPLITS
    ]

    for _kind, dataset, split in eval_plan:
        split_dir = resolve_dataset_split_dir(args.data_root, dataset, split)
        if split_dir is None or not split_dir.exists():
            continue

        videos = find_videos(split_dir)
        if not videos:
            continue

        if args.max_videos_per_split > 0:
            videos = videos[: args.max_videos_per_split]

        split_anomalies: List[float] = []
        examples_written = 0

        for video in videos:
            example_path = None
            if examples_written < args.example_jsonl_per_split:
                safe_name = f"{dataset}_{split}_{video.stem}.jsonl".replace(" ", "_")
                example_path = out_dir / safe_name
                examples_written += 1

            anomalies, _row_count = summarize_video(video, args, write_jsonl=example_path)
            split_anomalies.extend(anomalies)

        if not split_anomalies:
            continue

        arr = np.asarray(split_anomalies, dtype=np.float32)
        summary_rows.append(
            {
                "dataset": dataset,
                "split": split,
                "mean_anomaly": float(np.mean(arr)),
                "p95_anomaly": float(np.percentile(arr, 95)),
            }
        )

    print_summary_table(summary_rows)


if __name__ == "__main__":
    main()
