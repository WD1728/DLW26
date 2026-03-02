#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import joblib
import numpy as np
import torch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.anomaly import ZoneAnomalyScorer, apply_ewma, clamp01
from ml.c3d_paper import C3DPaper
from ml.detector import YoloV8PersonDetector
from ml.features import (
    aggregate_detections_by_zone,
    build_feature_rows,
    density_conf_counts_per_zone,
    zone_motion_occupancy,
    zone_motion_features,
)
from ml.flow import compute_farneback_flow
from ml.fusion import HybridFusionConfig, activity_weights_from_rows, spatialize_global_risk
from ml.mil_ranking import load_mil_head
from ml.paper_behavior import expected_risk_from_probs
from ml.preprocess import preprocess_frame
from ml.routing_demo import build_zone_graph, find_low_risk_path
from ml.zones import AnalysisZone, load_zones, locate_zone_for_point


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Visualize ensemble: baseline per-zone + paper behavior risk + optional MIL anomaly head."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))

    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--svm-model", required=True)
    parser.add_argument("--mil-head", default="")

    parser.add_argument("--out", required=True, help="Required schema JSONL output")
    parser.add_argument("--out-debug", default="", help="Optional debug JSONL output")
    parser.add_argument("--out-video", default="", help="Optional annotated video output")
    parser.add_argument("--window-name", default="SafeFlow Ensemble Visualizer")
    parser.add_argument("--no-show", action="store_true")

    parser.add_argument("--clip-len", type=int, default=16)
    parser.add_argument("--detect-every-clips", type=int, default=1)
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-clips", type=int, default=0)

    parser.add_argument("--paper-weight", type=float, default=0.55)
    parser.add_argument("--mil-weight", type=float, default=0.25)
    parser.add_argument("--fusion-alpha-prev", type=float, default=0.7)

    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)

    parser.add_argument("--yolo-model", default="yolov8n.pt")
    parser.add_argument("--yolo-conf-threshold", type=float, default=0.25)

    parser.add_argument("--route-from", default="", help="Optional analysis zone id (AZ*) to route from")
    parser.add_argument("--route-to", default="", help="Optional analysis zone id (AZ*) to route to")
    parser.add_argument("--route-risk-weight", type=float, default=3.0)
    parser.add_argument("--route-density-weight", type=float, default=1.5)
    parser.add_argument("--route-block-threshold", type=float, default=0.92)
    parser.add_argument(
        "--route-motion-density-scale",
        type=float,
        default=1.5,
        help="If >0, route density uses max(yolo_density, scale*motion_occupancy).",
    )
    parser.add_argument("--route-out", default="", help="Optional route JSONL output (analysis-zone ids path)")
    return parser.parse_args()


def _risk_color(value: float) -> Tuple[int, int, int]:
    v = float(clamp01(value))
    if v < 0.5:
        t = v / 0.5
        return (0, 255, int(255 * t))
    t = (v - 0.5) / 0.5
    return (0, int(255 * (1.0 - t)), 255)


def _zone_centroid(zone: AnalysisZone) -> Tuple[int, int]:
    pts = zone.polygon.astype(np.float32)
    return int(np.mean(pts[:, 0])), int(np.mean(pts[:, 1]))


def _draw_overlay(
    frame: np.ndarray,
    zones: List[AnalysisZone],
    density_by_zone: Dict[str, float],
    people_by_zone: Dict[str, int],
    anomaly_by_zone: Dict[str, float],
) -> np.ndarray:
    overlay = frame.copy()
    out = frame.copy()
    for z in zones:
        zid = z.zone_id
        a = float(anomaly_by_zone.get(zid, 0.0))
        d = float(density_by_zone.get(zid, 0.0))
        p = int(people_by_zone.get(zid, 0))
        c = _risk_color(a)
        cv2.fillPoly(overlay, [z.polygon.astype(np.int32)], c)
        cv2.polylines(out, [z.polygon.astype(np.int32)], True, c, 2)
        cx, cy = _zone_centroid(z)
        txt = f"{zid} A:{a:.2f} D:{d:.2f} P:{p}"
        cv2.putText(out, txt, (max(4, cx - 70), max(16, cy)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(out, txt, (max(4, cx - 70), max(16, cy)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (10, 10, 10), 1, cv2.LINE_AA)
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
        cv2.putText(frame, f"{zid} {conf:.2f}", (x1, max(14, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)


def _center_crop_clip(clip_thwc: np.ndarray, crop_h: int = 112, crop_w: int = 112) -> np.ndarray:
    h = clip_thwc.shape[1]
    w = clip_thwc.shape[2]
    y0 = max(0, (h - crop_h) // 2)
    x0 = max(0, (w - crop_w) // 2)
    return clip_thwc[:, y0 : y0 + crop_h, x0 : x0 + crop_w, :]


def _load_c3d(checkpoint_path: Path, device: torch.device) -> Tuple[C3DPaper, Dict[int, str]]:
    ckpt = torch.load(checkpoint_path, map_location=device)
    class_to_idx = ckpt.get("class_to_idx")
    if not isinstance(class_to_idx, dict) or not class_to_idx:
        raise RuntimeError("Checkpoint missing class_to_idx")
    temporal_depth = int(ckpt.get("temporal_depth", 3))
    model = C3DPaper(num_classes=len(class_to_idx), temporal_depth=temporal_depth)
    model.load_state_dict(ckpt["model_state"])
    model.to(device)
    model.eval()
    idx_to_class = {int(v): str(k) for k, v in class_to_idx.items()}
    return model, idx_to_class


def _iter_video_clips(video_path: Path, clip_len: int):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")
    frames: List[np.ndarray] = []
    ts_ms: List[int] = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
        ts_ms.append(int(cap.get(cv2.CAP_PROP_POS_MSEC)))
        if len(frames) == clip_len:
            yield frames, ts_ms
            frames = []
            ts_ms = []
    cap.release()


def _clip_to_tensor(frames_bgr: List[np.ndarray]) -> torch.Tensor:
    resized = [cv2.resize(f, (171, 128), interpolation=cv2.INTER_AREA) for f in frames_bgr]
    rgb = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in resized]
    clip = np.stack(rgb, axis=0)
    clip = _center_crop_clip(clip, 112, 112)
    clip = clip.astype(np.float32) / 255.0
    return torch.from_numpy(clip).permute(3, 0, 1, 2).unsqueeze(0).contiguous()


def main() -> None:
    args = parse_args()
    device = torch.device(args.device)

    fusion_cfg = HybridFusionConfig(
        paper_weight=float(args.paper_weight),
        fusion_alpha_prev=float(args.fusion_alpha_prev),
    )
    mil_weight = float(clamp01(float(args.mil_weight)))

    model, idx_to_class = _load_c3d(Path(args.checkpoint), device)
    svm = joblib.load(args.svm_model)

    mil = None
    mil_meta: Dict[str, object] = {}
    if args.mil_head:
        mil, mil_meta = load_mil_head(args.mil_head, device=device)

    width, height, zones = load_zones(args.zones)
    zone_graph = build_zone_graph(zones)
    detector = YoloV8PersonDetector(args.yolo_model, conf_threshold=args.yolo_conf_threshold)
    scorer = ZoneAnomalyScorer(models_dir=args.models_dir)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_f = out_path.open("w", encoding="utf-8")

    debug_f = None
    if args.out_debug:
        out_debug_path = Path(args.out_debug)
        out_debug_path.parent.mkdir(parents=True, exist_ok=True)
        debug_f = out_debug_path.open("w", encoding="utf-8")

    route_f = None
    if args.route_out:
        out_route_path = Path(args.route_out)
        out_route_path.parent.mkdir(parents=True, exist_ok=True)
        route_f = out_route_path.open("w", encoding="utf-8")

    writer = None
    if args.out_video:
        out_video_path = Path(args.out_video)
        out_video_path.parent.mkdir(parents=True, exist_ok=True)
        writer = cv2.VideoWriter(str(out_video_path), cv2.VideoWriter_fourcc(*"mp4v"), 6.0, (width, height))

    if not args.no_show:
        cv2.namedWindow(args.window_name, cv2.WINDOW_NORMAL)

    prev_gray = None
    prev_state: Dict[str, Dict[str, float]] = {}
    fused_ewma: Dict[str, float] = {}
    last_detections: List[Dict[str, float | List[float]]] = []
    base_ts = int(args.start_ts if args.start_ts is not None else int(time.time() * 1000))

    rows = 0
    try:
        for clip_idx, (frames, frame_ts_ms) in enumerate(_iter_video_clips(Path(args.video), int(args.clip_len))):
            if args.max_clips > 0 and clip_idx >= args.max_clips:
                break

            center_i = len(frames) // 2
            rep = frames[center_i]
            rep_elapsed_ms = int(frame_ts_ms[center_i])
            ts = int(base_ts + rep_elapsed_ms)

            clip_tensor = _clip_to_tensor(frames).to(device)
            with torch.no_grad():
                feats_t = model.extract_features(clip_tensor)
                feats = feats_t.detach().cpu().numpy()

            probs = svm.predict_proba(feats)[0]
            pred_idx = int(np.argmax(probs))
            pred_label = idx_to_class.get(pred_idx, f"class_{pred_idx}")
            pred_conf = float(probs[pred_idx])
            exp_risk = float(clamp01(expected_risk_from_probs(probs.tolist(), idx_to_class)))

            mil_score = 0.0
            if mil is not None:
                with torch.no_grad():
                    mil_score = float(mil(feats_t).detach().cpu().item())

            resized_bgr, gray = preprocess_frame(
                rep,
                width=width,
                height=height,
                cctv_sim=args.cctv_sim,
                jpeg_quality=args.jpeg_quality,
            )

            if detector.available and (clip_idx % max(1, args.detect_every_clips) == 0):
                last_detections = detector.detect(resized_bgr)
            detections = last_detections if detector.available else []

            counts, conf_sums, conf_counts = aggregate_detections_by_zone(detections, zones)
            density_by_zone, conf_by_zone, people_by_zone = density_conf_counts_per_zone(
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
            motion_occ = zone_motion_occupancy(flow, zones)

            feature_rows, prev_state = build_feature_rows(
                ts_ms=ts,
                zones=zones,
                density_by_zone=density_by_zone,
                conf_by_zone=conf_by_zone,
                people_count_by_zone=people_by_zone,
                motion_by_zone=motion,
                prev_state=prev_state,
            )
            zone_ids = [z.zone_id for z in zones]

            base_by_zone = scorer.score(feature_rows)
            base_vals = np.asarray([float(base_by_zone.get(zid, 0.0)) for zid in zone_ids], dtype=np.float32)

            activity_w = activity_weights_from_rows(feature_rows, fusion_cfg)
            paper_zone = spatialize_global_risk(exp_risk, activity_w)
            mil_zone = spatialize_global_risk(mil_score, activity_w) if mil is not None else np.zeros_like(base_vals)

            paper_mix = float(clamp01(float(fusion_cfg.paper_weight) * float(pred_conf)))
            mil_mix = mil_weight
            base_mix = max(0.0, 1.0 - paper_mix - mil_mix)
            denom = base_mix + paper_mix + mil_mix
            if denom <= 1e-6:
                denom = 1.0

            fused = (
                (base_mix / denom) * base_vals
                + (paper_mix / denom) * paper_zone.astype(np.float32)
                + (mil_mix / denom) * mil_zone.astype(np.float32)
            )
            fused = np.asarray(np.clip(fused, 0.0, 1.0), dtype=np.float32)
            smoothed, fused_ewma = apply_ewma(zone_ids, fused, fused_ewma, alpha_prev=float(fusion_cfg.fusion_alpha_prev))
            fused_by_zone = {zone_ids[i]: float(smoothed[i]) for i in range(len(zone_ids))}

            route_path: List[str] = []
            if args.route_from and args.route_to:
                routing_density = dict(density_by_zone)
                scale = float(args.route_motion_density_scale)
                if scale > 0:
                    for zid in routing_density:
                        occ = float(motion_occ.get(zid, 0.0))
                        routing_density[zid] = float(clamp01(max(float(routing_density.get(zid, 0.0)), scale * occ)))

                route_path = find_low_risk_path(
                    graph=zone_graph,
                    start_zone_id=str(args.route_from),
                    goal_zone_id=str(args.route_to),
                    risk_by_zone=fused_by_zone,
                    density_by_zone=routing_density,
                    risk_weight=float(args.route_risk_weight),
                    density_weight=float(args.route_density_weight),
                    block_threshold=float(args.route_block_threshold),
                )
                if route_f is not None:
                    route_f.write(
                        json.dumps(
                            {
                                "ts": ts,
                                "fromZoneId": str(args.route_from),
                                "toZoneId": str(args.route_to),
                                "pathZoneIds": route_path,
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    )

            zones_payload = []
            for z in zones:
                zones_payload.append(
                    {
                        "zoneId": z.zone_id,
                        "density": float(clamp01(float(density_by_zone.get(z.zone_id, 0.0)))),
                        "anomaly": float(clamp01(float(fused_by_zone.get(z.zone_id, 0.0)))),
                        "conf": float(clamp01(float(conf_by_zone.get(z.zone_id, 0.6)))),
                        "peopleCount": int(people_by_zone.get(z.zone_id, 0)),
                    }
                )

            out_f.write(json.dumps({"ts": ts, "zones": zones_payload}, separators=(",", ":")) + "\n")
            rows += 1

            if debug_f is not None:
                debug_f.write(
                    json.dumps(
                        {
                            "ts": ts,
                            "clipIndex": int(clip_idx),
                            "behaviorLabel": pred_label,
                            "behaviorConf": pred_conf,
                            "expectedRisk": exp_risk,
                            "milScore": float(mil_score),
                            "paperMix": float(paper_mix),
                            "milMix": float(mil_mix),
                            "baseMix": float(base_mix),
                            "probs": {idx_to_class.get(i, str(i)): float(p) for i, p in enumerate(probs.tolist())},
                            "milMeta": mil_meta,
                        },
                        separators=(",", ":"),
                    )
                    + "\n"
                )

            vis = _draw_overlay(
                resized_bgr,
                zones=zones,
                density_by_zone=density_by_zone,
                people_by_zone=people_by_zone,
                anomaly_by_zone=fused_by_zone,
            )
            _draw_detections(vis, zones, detections)

            if route_path:
                # Draw routing polyline across zone centroids.
                pts = [zone_graph.centroids[zid] for zid in route_path if zid in zone_graph.centroids]
                for i in range(1, len(pts)):
                    x1, y1 = [int(round(v)) for v in pts[i - 1]]
                    x2, y2 = [int(round(v)) for v in pts[i]]
                    cv2.line(vis, (x1, y1), (x2, y2), (255, 160, 40), 4)
                    cv2.circle(vis, (x1, y1), 5, (0, 0, 0), -1)
                    cv2.circle(vis, (x1, y1), 4, (255, 160, 40), -1)
                if pts:
                    xg, yg = [int(round(v)) for v in pts[-1]]
                    cv2.circle(vis, (xg, yg), 6, (0, 0, 0), -1)
                    cv2.circle(vis, (xg, yg), 5, (40, 255, 40), -1)

            top = (
                f"clip:{clip_idx} beh:{pred_label} p:{pred_conf:.2f} E[r]:{exp_risk:.2f} "
                f"MIL:{mil_score:.2f} (wP:{args.paper_weight:.2f} wM:{args.mil_weight:.2f})"
            )
            cv2.rectangle(vis, (0, 0), (vis.shape[1], 22), (0, 0, 0), -1)
            cv2.putText(vis, top, (6, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            if writer is not None:
                writer.write(vis)
            if not args.no_show:
                cv2.imshow(args.window_name, vis)
                key = cv2.waitKey(120) & 0xFF
                if key in (27, ord("q")):
                    break

            prev_gray = gray
    finally:
        out_f.close()
        if debug_f is not None:
            debug_f.close()
        if route_f is not None:
            route_f.close()
        if writer is not None:
            writer.release()
        if not args.no_show:
            cv2.destroyAllWindows()

    print(f"Visualized {rows} timesteps")
    print(f"Wrote schema JSONL -> {args.out}")
    if args.out_debug:
        print(f"Wrote debug JSONL -> {args.out_debug}")
    if args.out_video:
        print(f"Wrote annotated video -> {args.out_video}")
    if args.route_out:
        print(f"Wrote route JSONL -> {args.route_out}")
    if (not detector.available) and detector.reason:
        print(f"YOLO disabled: {detector.reason}")


if __name__ == "__main__":
    main()
