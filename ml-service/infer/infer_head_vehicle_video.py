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

from ml.detector import YoloV8HeadVehicleDetector
from ml.features import aggregate_detections_by_zone, density_conf_counts_per_zone
from ml.preprocess import preprocess_frame
from ml.videoio import iter_sampled_video_frames
from ml.zones import load_zones


def run_head_vehicle_records(
    video_path: str | Path,
    zones_path: str | Path,
    fps: float = 3.0,
    start_ts_ms: int | None = None,
    detect_every: int = 3,
    cctv_sim: bool = False,
    jpeg_quality: int = 40,
    yolo_model: str = "yolov8n.pt",
    yolo_conf_threshold: float = 0.25,
) -> Generator[Dict[str, object], None, None]:
    _width, _height, zones = load_zones(zones_path)
    detector = YoloV8HeadVehicleDetector(
        model_name=yolo_model,
        conf_threshold=yolo_conf_threshold,
        include_person=True,
        include_vehicle=True,
        include_head_proxy=True,
    )
    last_detections: List[Dict[str, float | int | str | List[float]]] = []
    base_ts = int(start_ts_ms if start_ts_ms is not None else int(time.time() * 1000))

    for _src_idx, proc_idx, elapsed_ms, frame in iter_sampled_video_frames(video_path, fps):
        resized_bgr, _gray = preprocess_frame(
            frame,
            width=_width,
            height=_height,
            cctv_sim=cctv_sim,
            jpeg_quality=jpeg_quality,
        )

        if detector.available and (proc_idx % max(1, detect_every) == 0):
            last_detections = detector.detect(resized_bgr)  # type: ignore[assignment]
        detections = last_detections if detector.available else []

        person_counts, person_conf_sums, person_conf_counts = aggregate_detections_by_zone(
            detections, zones, include_labels={"person"}
        )
        vehicle_counts, vehicle_conf_sums, vehicle_conf_counts = aggregate_detections_by_zone(
            detections, zones, include_labels={"vehicle"}
        )
        head_counts, head_conf_sums, head_conf_counts = aggregate_detections_by_zone(
            detections, zones, include_labels={"head"}
        )

        person_density, person_conf, people_by_zone = density_conf_counts_per_zone(
            zones=zones,
            counts=person_counts,
            conf_sums=person_conf_sums,
            conf_counts=person_conf_counts,
            detector_available=detector.available,
        )
        vehicle_density, vehicle_conf, vehicle_by_zone = density_conf_counts_per_zone(
            zones=zones,
            counts=vehicle_counts,
            conf_sums=vehicle_conf_sums,
            conf_counts=vehicle_conf_counts,
            detector_available=detector.available,
        )
        head_density, head_conf, head_by_zone = density_conf_counts_per_zone(
            zones=zones,
            counts=head_counts,
            conf_sums=head_conf_sums,
            conf_counts=head_conf_counts,
            detector_available=detector.available,
        )

        ts = int(base_ts + elapsed_ms)
        payload_zones: List[Dict[str, object]] = []
        for zone in zones:
            zid = zone.zone_id
            payload_zones.append(
                {
                    "zoneId": zid,
                    "peopleCount": int(people_by_zone.get(zid, 0)),
                    "vehicleCount": int(vehicle_by_zone.get(zid, 0)),
                    "headCount": int(head_by_zone.get(zid, 0)),
                    "peopleDensity": float(person_density.get(zid, 0.0)),
                    "vehicleDensity": float(vehicle_density.get(zid, 0.0)),
                    "headDensity": float(head_density.get(zid, 0.0)),
                    "peopleConf": float(person_conf.get(zid, 0.0)),
                    "vehicleConf": float(vehicle_conf.get(zid, 0.0)),
                    "headConf": float(head_conf.get(zid, 0.0)),
                }
            )

        yield {
            "ts": ts,
            "zones": payload_zones,
            "detectorAvailable": bool(detector.available),
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run head + vehicle + person detection by analysis zone and emit JSONL."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--detect-every", type=int, default=3)
    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)
    parser.add_argument("--yolo-model", default="yolov8n.pt")
    parser.add_argument("--yolo-conf-threshold", type=float, default=0.25)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    num_rows = 0
    with out_path.open("w", encoding="utf-8") as f:
        for record in run_head_vehicle_records(
            video_path=args.video,
            zones_path=args.zones,
            fps=args.fps,
            start_ts_ms=args.start_ts,
            detect_every=args.detect_every,
            cctv_sim=args.cctv_sim,
            jpeg_quality=args.jpeg_quality,
            yolo_model=args.yolo_model,
            yolo_conf_threshold=args.yolo_conf_threshold,
        ):
            f.write(json.dumps(record, separators=(",", ":")) + "\n")
            num_rows += 1

    print(f"Wrote {num_rows} timesteps to {out_path}")


if __name__ == "__main__":
    main()
