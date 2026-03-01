#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.detector import YoloV8PersonDetector
from ml.features import (
    FEATURE_COLUMNS,
    aggregate_detections_by_zone,
    build_feature_rows,
    density_conf_counts_per_zone,
    zone_motion_features,
)
from ml.flow import compute_farneback_flow
from ml.preprocess import preprocess_frame
from ml.videoio import find_videos, iter_sampled_video_frames, resolve_dataset_split_dir
from ml.zones import load_zones


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract per-analysis-zone feature vectors.")
    parser.add_argument(
        "--dataset",
        required=True,
        choices=[
            "ucsd",
            "avenue",
            "mall",
            "pets2009",
            "rwf2000",
            "ucfcrime",
            "shanghaitech",
        ],
    )
    parser.add_argument(
        "--split",
        required=True,
        choices=["train", "test", "normal", "fight", "crime", "crowded"],
    )
    parser.add_argument("--zones", required=True)
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--out", required=True)

    parser.add_argument("--data-root", default=str(PROJECT_ROOT / "data"))
    parser.add_argument("--detect-every", type=int, default=3)
    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)
    parser.add_argument("--max-videos", type=int, default=0)
    parser.add_argument("--yolo-model", default="yolov8n.pt")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    width, height, zones = load_zones(args.zones)

    split_dir = resolve_dataset_split_dir(args.data_root, args.dataset, args.split)
    if split_dir is None or not split_dir.exists():
        raise FileNotFoundError(
            f"Dataset path not found for dataset={args.dataset}, split={args.split}. "
            f"Expected under {args.data_root}."
        )

    videos = find_videos(split_dir)
    if args.max_videos > 0:
        videos = videos[: args.max_videos]

    if not videos:
        raise RuntimeError(f"No .mp4/.avi videos found under: {split_dir}")

    detector = YoloV8PersonDetector(model_name=args.yolo_model)

    all_rows: List[Dict[str, float | int | str]] = []

    for video_path in videos:
        prev_gray = None
        prev_state: Dict[str, Dict[str, float]] = {}
        last_detections: List[Dict[str, float | List[float]]] = []

        for src_idx, proc_idx, elapsed_ms, frame in iter_sampled_video_frames(video_path, args.fps):
            resized_bgr, gray = preprocess_frame(
                frame,
                width=width,
                height=height,
                cctv_sim=args.cctv_sim,
                jpeg_quality=args.jpeg_quality,
            )

            if detector.available and (proc_idx % max(args.detect_every, 1) == 0):
                last_detections = detector.detect(resized_bgr)

            detections = last_detections if detector.available else []
            counts, conf_sums, conf_counts = aggregate_detections_by_zone(detections, zones)

            density_by_zone, conf_by_zone, people_count_by_zone = density_conf_counts_per_zone(
                zones=zones,
                counts=counts,
                conf_sums=conf_sums,
                conf_counts=conf_counts,
                detector_available=detector.available,
            )

            flow = None
            if prev_gray is not None:
                flow = compute_farneback_flow(prev_gray, gray)

            motion = zone_motion_features(flow, zones)
            rows, prev_state = build_feature_rows(
                ts_ms=int(elapsed_ms),
                zones=zones,
                density_by_zone=density_by_zone,
                conf_by_zone=conf_by_zone,
                people_count_by_zone=people_count_by_zone,
                motion_by_zone=motion,
                prev_state=prev_state,
            )

            for row in rows:
                row["dataset"] = args.dataset
                row["split"] = args.split
                row["video"] = video_path.name
                row["sourceFrameIndex"] = int(src_idx)
                row["processedFrameIndex"] = int(proc_idx)

            all_rows.extend(rows)
            prev_gray = gray

    df = pd.DataFrame(all_rows)

    required_columns = {
        "ts",
        "zoneId",
        "conf",
        "peopleCount",
        "dataset",
        "split",
        "video",
        "sourceFrameIndex",
        "processedFrameIndex",
        *FEATURE_COLUMNS,
    }
    missing = sorted(required_columns - set(df.columns))
    if missing:
        raise RuntimeError(f"Missing required feature columns: {missing}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        df.to_parquet(out_path, index=False)
    except Exception as exc:
        raise RuntimeError(
            "Failed to write parquet. Install pyarrow (pip install pyarrow) and retry."
        ) from exc

    print(
        f"Wrote {len(df)} rows, {len(videos)} videos -> {out_path} "
        f"(detector_available={detector.available})"
    )
    if not detector.available and detector.reason:
        print(f"YOLO disabled: {detector.reason}")


if __name__ == "__main__":
    main()
