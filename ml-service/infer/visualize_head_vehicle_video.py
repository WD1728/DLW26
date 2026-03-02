#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.detector import YoloV8HeadVehicleDetector, YoloV8SplitHeadVehicleDetector
from ml.features import aggregate_detections_by_zone
from ml.preprocess import preprocess_frame
from ml.roi_density import DensityConfig, ROIDensityEstimator, parse_roi_string
from ml.videoio import iter_sampled_video_frames
from ml.zones import AnalysisZone, load_zones, locate_zone_for_point


def _zone_centroid(zone: AnalysisZone) -> Tuple[int, int]:
    pts = zone.polygon.astype(np.float32)
    return int(np.mean(pts[:, 0])), int(np.mean(pts[:, 1]))


def _draw_zone_overlay(
    frame: np.ndarray,
    zones: List[AnalysisZone],
    people_by_zone: Dict[str, int],
    vehicles_by_zone: Dict[str, int],
    heads_by_zone: Dict[str, int],
) -> np.ndarray:
    overlay = frame.copy()
    out = frame.copy()

    for zone in zones:
        zid = zone.zone_id
        p = int(people_by_zone.get(zid, 0))
        v = int(vehicles_by_zone.get(zid, 0))
        h = int(heads_by_zone.get(zid, 0))

        # Stronger tint for higher combined activity.
        intensity = max(0.0, min(1.0, (p + v) / max(zone.capacity, 1.0)))
        color = (0, int(120 + 100 * intensity), int(40 + 180 * intensity))
        cv2.fillPoly(overlay, [zone.polygon.astype(np.int32)], color)
        cv2.polylines(out, [zone.polygon.astype(np.int32)], isClosed=True, color=color, thickness=2)

        cx, cy = _zone_centroid(zone)
        label = f"{zid} P:{p} H:{h} V:{v}"
        cv2.putText(
            out,
            label,
            (max(4, cx - 55), max(16, cy)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            out,
            label,
            (max(4, cx - 55), max(16, cy)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (20, 20, 20),
            1,
            cv2.LINE_AA,
        )

    cv2.addWeighted(overlay, 0.20, out, 0.80, 0.0, out)
    return out


def _det_color(label: str) -> Tuple[int, int, int]:
    if label == "person":
        return (90, 220, 255)  # orange-ish
    if label == "head":
        return (255, 255, 255)
    if label == "vehicle":
        return (90, 255, 90)
    return (200, 200, 200)


def _draw_detections(
    frame: np.ndarray,
    zones: List[AnalysisZone],
    detections: List[Dict[str, float | int | str | List[float]]],
) -> None:
    for det in detections:
        bbox = det.get("bbox")
        if not bbox or not isinstance(bbox, list) or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = [int(round(float(v))) for v in bbox]
        conf = float(det.get("conf", 0.0))
        label = str(det.get("label", "unknown"))
        class_name = str(det.get("className", label))
        cx = int(round(0.5 * (x1 + x2)))
        cy = int(round(0.5 * (y1 + y2)))
        zid = locate_zone_for_point(cx, cy, zones) or "OUT"
        color = _det_color(label)

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(
            frame,
            f"{class_name} {conf:.2f} {zid}",
            (x1, max(12, y1 - 4)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.40,
            color,
            1,
            cv2.LINE_AA,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Visualize person + head + vehicle detection by analysis zone."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--detect-every", type=int, default=3)
    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)
    parser.add_argument(
        "--yolo-model",
        default="",
        help="Legacy single-model mode. Leave empty to use split person/vehicle models.",
    )
    parser.add_argument("--yolo-conf-threshold", type=float, default=0.25)
    parser.add_argument("--person-model", default=str(PROJECT_ROOT / "models" / "yolov8n.pt"))
    parser.add_argument("--vehicle-model", default=str(PROJECT_ROOT / "models" / "vehicle_best.pt"))
    parser.add_argument("--person-conf-threshold", type=float, default=0.25)
    parser.add_argument("--vehicle-conf-threshold", type=float, default=0.25)
    parser.add_argument(
        "--device",
        default="auto",
        help="Inference device: auto|cpu|0. auto uses CUDA GPU when available.",
    )
    parser.add_argument("--window-name", default="Head + Vehicle Visualizer")
    parser.add_argument("--no-show", action="store_true")
    parser.add_argument("--out-jsonl", default="")
    parser.add_argument("--out-video", default="")
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument(
        "--roi",
        default="",
        help='ROI polygon in pixels, e.g. "30,20;290,20;300,220;20,220"',
    )
    parser.add_argument("--avg-height-m", type=float, default=1.70)
    parser.add_argument("--ema-alpha", type=float, default=0.20)
    parser.add_argument("--min-height-samples", type=int, default=3)
    parser.add_argument("--head-to-body-ratio", type=float, default=7.0)
    parser.add_argument("--head-spacing-to-body-ratio", type=float, default=2.8)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    width, height, zones = load_zones(args.zones)
    density_estimator: ROIDensityEstimator | None = None
    if args.roi:
        density_cfg = DensityConfig(
            roi=parse_roi_string(args.roi),
            avg_height_m=float(args.avg_height_m),
            ema_alpha=float(args.ema_alpha),
            min_samples=max(1, int(args.min_height_samples)),
            head_to_body_ratio=float(args.head_to_body_ratio),
            head_spacing_to_body_ratio=float(args.head_spacing_to_body_ratio),
        )
        density_estimator = ROIDensityEstimator(density_cfg)
    if args.yolo_model:
        detector = YoloV8HeadVehicleDetector(
            model_name=args.yolo_model,
            conf_threshold=args.yolo_conf_threshold,
            include_person=True,
            include_vehicle=True,
            include_head_proxy=True,
            device=args.device,
        )
    else:
        detector = YoloV8SplitHeadVehicleDetector(
            person_model_name=args.person_model,
            vehicle_model_name=args.vehicle_model,
            person_conf_threshold=args.person_conf_threshold,
            vehicle_conf_threshold=args.vehicle_conf_threshold,
            include_head_proxy=True,
            device=args.device,
        )
    if not args.no_show:
        cv2.namedWindow(args.window_name, cv2.WINDOW_NORMAL)

    out_jsonl_f = None
    if args.out_jsonl:
        out_jsonl_path = Path(args.out_jsonl)
        out_jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        out_jsonl_f = out_jsonl_path.open("w", encoding="utf-8")

    out_video_writer = None
    if args.out_video:
        out_video_path = Path(args.out_video)
        out_video_path.parent.mkdir(parents=True, exist_ok=True)
        out_video_writer = cv2.VideoWriter(
            str(out_video_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            float(max(args.fps, 1.0)),
            (width, height),
        )

    base_ts = int(args.start_ts if args.start_ts is not None else int(time.time() * 1000))
    last_detections: List[Dict[str, float | int | str | List[float]]] = []
    num_frames = 0
    try:
        for _src_idx, proc_idx, elapsed_ms, frame in iter_sampled_video_frames(args.video, args.fps):
            resized_bgr, _gray = preprocess_frame(
                frame,
                width=width,
                height=height,
                cctv_sim=args.cctv_sim,
                jpeg_quality=args.jpeg_quality,
            )
            if detector.available and (proc_idx % max(1, args.detect_every) == 0):
                last_detections = detector.detect(resized_bgr)  # type: ignore[assignment]
            detections = last_detections if detector.available else []

            person_counts, _, _ = aggregate_detections_by_zone(
                detections, zones, include_labels={"person"}
            )
            vehicle_counts, _, _ = aggregate_detections_by_zone(
                detections, zones, include_labels={"vehicle"}
            )
            head_counts, _, _ = aggregate_detections_by_zone(
                detections, zones, include_labels={"head"}
            )

            vis = _draw_zone_overlay(
                resized_bgr,
                zones=zones,
                people_by_zone=person_counts,
                vehicles_by_zone=vehicle_counts,
                heads_by_zone=head_counts,
            )
            _draw_detections(vis, zones, detections)

            density_metrics = None
            if density_estimator is not None:
                head_dets = []
                person_boxes = []
                for det in detections:
                    bbox = det.get("bbox")
                    if not isinstance(bbox, list) or len(bbox) != 4:
                        continue
                    label = str(det.get("label", ""))
                    if label == "head":
                        head_dets.append({"bbox": bbox})
                    elif label == "person":
                        person_boxes.append({"bbox": bbox})
                density_metrics = density_estimator.compute_density(
                    frame=vis,
                    head_dets=head_dets,
                    person_bboxes=person_boxes,
                    draw=True,
                )

            total_people = sum(int(v) for v in person_counts.values())
            total_vehicles = sum(int(v) for v in vehicle_counts.values())
            total_heads = sum(int(v) for v in head_counts.values())
            ts = int(base_ts + elapsed_ms)

            top = (
                f"ts:{ts} frame:{proc_idx} people:{total_people} "
                f"heads:{total_heads} vehicles:{total_vehicles}"
            )
            cv2.rectangle(vis, (0, 0), (vis.shape[1], 22), (0, 0, 0), -1)
            cv2.putText(vis, top, (6, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            if out_jsonl_f is not None:
                payload_zones = []
                for zone in zones:
                    zid = zone.zone_id
                    payload_zones.append(
                        {
                            "zoneId": zid,
                            "peopleCount": int(person_counts.get(zid, 0)),
                            "headCount": int(head_counts.get(zid, 0)),
                            "vehicleCount": int(vehicle_counts.get(zid, 0)),
                        }
                    )
                row = {"ts": ts, "zones": payload_zones}
                if density_metrics is not None:
                    row["roiDensity"] = density_metrics
                out_jsonl_f.write(json.dumps(row, separators=(",", ":")) + "\n")

            if out_video_writer is not None:
                out_video_writer.write(vis)

            if not args.no_show:
                cv2.imshow(args.window_name, vis)
                delay_ms = int(max(1, round(1000.0 / max(args.fps, 0.001))))
                key = cv2.waitKey(delay_ms) & 0xFF
                if key in (27, ord("q")):
                    break

            num_frames += 1
            if args.max_frames > 0 and num_frames >= args.max_frames:
                break
    finally:
        if out_jsonl_f is not None:
            out_jsonl_f.close()
        if out_video_writer is not None:
            out_video_writer.release()
        if not args.no_show:
            cv2.destroyAllWindows()

    print(f"Visualized {num_frames} timesteps from {args.video}")
    if out_jsonl_f is not None:
        print(f"Wrote JSONL -> {args.out_jsonl}")
    if out_video_writer is not None:
        print(f"Wrote annotated video -> {args.out_video}")
    if detector.available is False and detector.reason:
        print(f"YOLO disabled: {detector.reason}")


if __name__ == "__main__":
    main()
