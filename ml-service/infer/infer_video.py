#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, Generator, List

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.anomaly import ZoneAnomalyScorer, clamp01
from ml.detector import YoloV8PersonDetector
from ml.features import (
    aggregate_detections_by_zone,
    build_feature_rows,
    density_conf_counts_per_zone,
    zone_motion_features,
)
from ml.flow import compute_farneback_flow
from ml.preprocess import preprocess_frame
from ml.videoio import iter_sampled_video_frames
from ml.zones import load_zones


def run_inference_records(
    video_path: str | Path,
    zones_path: str | Path,
    models_dir: str | Path,
    fps: float = 3.0,
    start_ts_ms: int | None = None,
    detect_every: int = 3,
    cctv_sim: bool = False,
    jpeg_quality: int = 40,
    yolo_model: str = "yolov8n.pt",
) -> Generator[Dict[str, object], None, None]:
    width, height, zones = load_zones(zones_path)

    detector = YoloV8PersonDetector(model_name=yolo_model)
    scorer = ZoneAnomalyScorer(models_dir=models_dir)

    prev_gray = None
    prev_state: Dict[str, Dict[str, float]] = {}
    last_detections: List[Dict[str, float | List[float]]] = []

    base_ts = int(start_ts_ms if start_ts_ms is not None else int(time.time() * 1000))

    for _src_idx, proc_idx, elapsed_ms, frame in iter_sampled_video_frames(video_path, fps):
        resized_bgr, gray = preprocess_frame(
            frame,
            width=width,
            height=height,
            cctv_sim=cctv_sim,
            jpeg_quality=jpeg_quality,
        )

        if detector.available and (proc_idx % max(1, detect_every) == 0):
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
        ts = int(base_ts + elapsed_ms)
        rows, prev_state = build_feature_rows(
            ts_ms=ts,
            zones=zones,
            density_by_zone=density_by_zone,
            conf_by_zone=conf_by_zone,
            people_count_by_zone=people_count_by_zone,
            motion_by_zone=motion,
            prev_state=prev_state,
        )

        anomaly_by_zone = scorer.score(rows)

        payload_zones: List[Dict[str, object]] = []
        for row in rows:
            zid = str(row["zoneId"])
            payload_zones.append(
                {
                    "zoneId": zid,
                    "density": float(clamp01(float(row["density"]))),
                    "anomaly": float(clamp01(float(anomaly_by_zone.get(zid, 0.0)))),
                    "conf": float(clamp01(float(row["conf"]))),
                    "peopleCount": int(row["peopleCount"]),
                }
            )

        yield {
            "ts": ts,
            "zones": payload_zones,
        }

        prev_gray = gray



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run SafeFlow ML inference on one video and emit JSONL.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--detect-every", type=int, default=3)
    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)
    parser.add_argument("--yolo-model", default="yolov8n.pt")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    num_rows = 0
    with out_path.open("w", encoding="utf-8") as f:
        for record in run_inference_records(
            video_path=args.video,
            zones_path=args.zones,
            models_dir=args.models_dir,
            fps=args.fps,
            start_ts_ms=args.start_ts,
            detect_every=args.detect_every,
            cctv_sim=args.cctv_sim,
            jpeg_quality=args.jpeg_quality,
            yolo_model=args.yolo_model,
        ):
            f.write(json.dumps(record, separators=(",", ":")) + "\n")
            num_rows += 1

    print(f"Wrote {num_rows} timesteps to {out_path}")


if __name__ == "__main__":
    main()
