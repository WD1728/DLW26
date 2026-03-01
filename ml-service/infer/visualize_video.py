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
from ml.zones import AnalysisZone, load_zones, locate_zone_for_point


def _risk_color(value: float) -> Tuple[int, int, int]:
    """Map [0,1] -> BGR color (green->yellow->red)."""
    v = float(clamp01(value))
    if v < 0.5:
        t = v / 0.5
        b = 0
        g = 255
        r = int(255 * t)
    else:
        t = (v - 0.5) / 0.5
        b = 0
        g = int(255 * (1.0 - t))
        r = 255
    return (b, g, r)


def _zone_centroid(zone: AnalysisZone) -> Tuple[int, int]:
    pts = zone.polygon.astype(np.float32)
    cx = int(np.mean(pts[:, 0]))
    cy = int(np.mean(pts[:, 1]))
    return cx, cy


def _draw_zone_overlay(
    frame: np.ndarray,
    zones: List[AnalysisZone],
    density_by_zone: Dict[str, float],
    people_by_zone: Dict[str, int],
    anomaly_by_zone: Dict[str, float],
) -> np.ndarray:
    overlay = frame.copy()
    out = frame.copy()

    for zone in zones:
        zid = zone.zone_id
        anomaly = float(anomaly_by_zone.get(zid, 0.0))
        density = float(density_by_zone.get(zid, 0.0))
        people = int(people_by_zone.get(zid, 0))
        color = _risk_color(anomaly)

        cv2.fillPoly(overlay, [zone.polygon.astype(np.int32)], color)
        cv2.polylines(out, [zone.polygon.astype(np.int32)], isClosed=True, color=color, thickness=2)

        cx, cy = _zone_centroid(zone)
        label = f"{zid} A:{anomaly:.2f} D:{density:.2f} P:{people}"
        cv2.putText(
            out,
            label,
            (max(4, cx - 70), max(16, cy)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            out,
            label,
            (max(4, cx - 70), max(16, cy)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (10, 10, 10),
            1,
            cv2.LINE_AA,
        )

    cv2.addWeighted(overlay, 0.22, out, 0.78, 0.0, out)
    return out


def _draw_detections(frame: np.ndarray, zones: List[AnalysisZone], detections: List[Dict[str, float | List[float]]]) -> None:
    for det in detections:
        bbox = det.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = [int(round(float(v))) for v in bbox]
        conf = float(det.get("conf", 0.0))
        cx = int(round(0.5 * (x1 + x2)))
        cy = int(round(0.5 * (y1 + y2)))
        zid = locate_zone_for_point(cx, cy, zones) or "OUT"
        color = (255, 200, 40) if zid == "OUT" else (255, 255, 255)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.circle(frame, (cx, cy), 2, (0, 0, 0), -1)
        cv2.putText(
            frame,
            f"{zid} {conf:.2f}",
            (x1, max(14, y1 - 4)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            color,
            1,
            cv2.LINE_AA,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visualize SafeFlow inference with boxes + per-zone anomaly overlays.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--detect-every", type=int, default=3)
    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)
    parser.add_argument("--yolo-model", default="yolov8n.pt")
    parser.add_argument("--yolo-conf-threshold", type=float, default=0.25)
    parser.add_argument("--window-name", default="SafeFlow ML Visualizer")
    parser.add_argument("--no-show", action="store_true", help="Disable popup window; useful for headless runs.")
    parser.add_argument("--out-jsonl", default="", help="Optional path to write required JSONL inference output.")
    parser.add_argument("--out-video", default="", help="Optional path to write annotated video.")
    parser.add_argument("--max-frames", type=int, default=0, help="Optional max processed frames (0=all).")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    width, height, zones = load_zones(args.zones)

    detector = YoloV8PersonDetector(
        model_name=args.yolo_model,
        conf_threshold=args.yolo_conf_threshold,
    )
    scorer = ZoneAnomalyScorer(models_dir=args.models_dir)

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

    prev_gray = None
    prev_state: Dict[str, Dict[str, float]] = {}
    last_detections: List[Dict[str, float | List[float]]] = []
    base_ts = int(args.start_ts if args.start_ts is not None else int(time.time() * 1000))

    num_frames = 0
    try:
        for _src_idx, proc_idx, elapsed_ms, frame in iter_sampled_video_frames(args.video, args.fps):
            resized_bgr, gray = preprocess_frame(
                frame,
                width=width,
                height=height,
                cctv_sim=args.cctv_sim,
                jpeg_quality=args.jpeg_quality,
            )

            if detector.available and (proc_idx % max(1, args.detect_every) == 0):
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

            record = {"ts": ts, "zones": payload_zones}
            if out_jsonl_f is not None:
                out_jsonl_f.write(json.dumps(record, separators=(",", ":")) + "\n")

            vis = _draw_zone_overlay(
                resized_bgr,
                zones=zones,
                density_by_zone=density_by_zone,
                people_by_zone=people_count_by_zone,
                anomaly_by_zone=anomaly_by_zone,
            )
            _draw_detections(vis, zones, detections)

            mean_anomaly = 0.0
            if payload_zones:
                mean_anomaly = float(
                    np.mean([float(zone["anomaly"]) for zone in payload_zones])  # type: ignore[arg-type]
                )
            top_text = (
                f"ts:{ts} frame:{proc_idx} meanAnom:{mean_anomaly:.3f} "
                f"dets:{len(detections)} model:{'on' if scorer.has_model else 'fallback'}"
            )
            cv2.rectangle(vis, (0, 0), (vis.shape[1], 22), (0, 0, 0), -1)
            cv2.putText(vis, top_text, (6, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            if out_video_writer is not None:
                out_video_writer.write(vis)

            if not args.no_show:
                cv2.imshow(args.window_name, vis)
                delay_ms = int(max(1, round(1000.0 / max(args.fps, 0.001))))
                key = cv2.waitKey(delay_ms) & 0xFF
                if key in (27, ord("q")):
                    break
                if key == ord(" "):
                    while True:
                        pause_key = cv2.waitKey(0) & 0xFF
                        if pause_key in (27, ord("q")):
                            key = pause_key
                            break
                        if pause_key == ord(" "):
                            break
                    if key in (27, ord("q")):
                        break

            prev_gray = gray
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
