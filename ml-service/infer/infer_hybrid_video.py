#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, Generator, List, Tuple

import cv2
import joblib
import numpy as np
import torch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.anomaly import ZoneAnomalyScorer, clamp01
from ml.c3d_paper import C3DPaper
from ml.detector import YoloV8PersonDetector
from ml.features import (
    aggregate_detections_by_zone,
    build_feature_rows,
    density_conf_counts_per_zone,
    zone_motion_features,
)
from ml.flow import compute_farneback_flow
from ml.fusion import HybridFusionConfig, activity_weights_from_rows, fuse_zone_anomalies
from ml.paper_behavior import expected_risk_from_probs
from ml.preprocess import preprocess_frame
from ml.zones import load_zones


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Hybrid inference: baseline per-zone anomaly + paper global regime risk fused into per-zone JSONL."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))

    parser.add_argument("--checkpoint", required=True, help="Trained C3D checkpoint (.pt)")
    parser.add_argument("--svm-model", required=True, help="Trained Multi-SVM model (.joblib)")
    parser.add_argument("--out", required=True, help="Output JSONL with required SafeFlow schema")
    parser.add_argument("--out-behavior", default="", help="Optional output JSONL with behavior labels/probabilities")

    parser.add_argument("--clip-len", type=int, default=16)
    parser.add_argument("--detect-every-clips", type=int, default=1)
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-clips", type=int, default=0)

    parser.add_argument("--paper-weight", type=float, default=0.65)
    parser.add_argument("--fusion-alpha-prev", type=float, default=0.7)

    parser.add_argument("--cctv-sim", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=40)

    parser.add_argument("--yolo-model", default="yolov8n.pt")
    parser.add_argument("--yolo-conf-threshold", type=float, default=0.25)
    return parser.parse_args()


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
    clip = np.stack(rgb, axis=0)  # [T,H,W,C]
    clip = _center_crop_clip(clip, crop_h=112, crop_w=112)
    clip = clip.astype(np.float32) / 255.0
    return torch.from_numpy(clip).permute(3, 0, 1, 2).unsqueeze(0).contiguous()


def run_hybrid_inference_records(
    *,
    video_path: str | Path,
    zones_path: str | Path,
    models_dir: str | Path,
    checkpoint: str | Path,
    svm_model: str | Path,
    device: str,
    clip_len: int = 16,
    detect_every_clips: int = 1,
    start_ts_ms: int | None = None,
    max_clips: int = 0,
    yolo_model: str = "yolov8n.pt",
    yolo_conf_threshold: float = 0.25,
    cctv_sim: bool = False,
    jpeg_quality: int = 40,
    fusion_cfg: HybridFusionConfig | None = None,
) -> Generator[Tuple[Dict[str, object], Dict[str, object]], None, None]:
    """
    Yields:
    - schema_record: {"ts":..., "zones":[...]}
    - behavior_record: clip-level debug info (safe to ignore)
    """
    fusion_cfg = fusion_cfg or HybridFusionConfig()
    torch_device = torch.device(device)
    model, idx_to_class = _load_c3d(Path(checkpoint), device=torch_device)
    svm = joblib.load(str(svm_model))

    width, height, zones = load_zones(zones_path)
    detector = YoloV8PersonDetector(model_name=yolo_model, conf_threshold=yolo_conf_threshold)
    scorer = ZoneAnomalyScorer(models_dir=models_dir)

    prev_gray = None
    prev_state: Dict[str, Dict[str, float]] = {}
    prev_fused_ewma: Dict[str, float] = {}
    last_detections: List[Dict[str, float | List[float]]] = []

    base_ts = int(start_ts_ms if start_ts_ms is not None else int(time.time() * 1000))

    for clip_idx, (frames, frame_ts_ms) in enumerate(_iter_video_clips(Path(video_path), int(clip_len))):
        if max_clips > 0 and clip_idx >= max_clips:
            break

        center_i = len(frames) // 2
        rep_frame = frames[center_i]
        rep_elapsed_ms = int(frame_ts_ms[center_i])
        ts = int(base_ts + rep_elapsed_ms)

        # Paper path: behavior distribution + expected risk.
        clip_tensor = _clip_to_tensor(frames).to(torch_device)
        with torch.no_grad():
            feats = model.extract_features(clip_tensor).cpu().numpy()
        probs = svm.predict_proba(feats)[0]
        pred_idx = int(np.argmax(probs))
        pred_label = idx_to_class.get(pred_idx, f"class_{pred_idx}")
        pred_conf = float(probs[pred_idx])
        exp_risk = float(clamp01(expected_risk_from_probs(probs.tolist(), idx_to_class)))

        # Baseline path: per-zone features/anomaly on representative frames.
        resized_bgr, gray = preprocess_frame(
            rep_frame,
            width=width,
            height=height,
            cctv_sim=cctv_sim,
            jpeg_quality=jpeg_quality,
        )

        if detector.available and (clip_idx % max(1, int(detect_every_clips)) == 0):
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
        rows, prev_state = build_feature_rows(
            ts_ms=ts,
            zones=zones,
            density_by_zone=density_by_zone,
            conf_by_zone=conf_by_zone,
            people_count_by_zone=people_by_zone,
            motion_by_zone=motion,
            prev_state=prev_state,
        )

        anomaly_by_zone = scorer.score(rows)
        zone_ids = [str(r["zoneId"]) for r in rows]
        baseline_vals = np.asarray([float(anomaly_by_zone.get(zid, 0.0)) for zid in zone_ids], dtype=np.float32)

        activity_w = activity_weights_from_rows(rows, fusion_cfg)
        fused_vals, prev_fused_ewma = fuse_zone_anomalies(
            zone_ids=zone_ids,
            baseline=baseline_vals,
            paper_expected_risk=exp_risk,
            paper_conf=pred_conf,
            activity_weights=activity_w,
            cfg=fusion_cfg,
            prev_fused_ewma=prev_fused_ewma,
        )

        zones_payload: List[Dict[str, object]] = []
        for i, row in enumerate(rows):
            zid = str(row["zoneId"])
            zones_payload.append(
                {
                    "zoneId": zid,
                    "density": float(clamp01(float(row["density"]))),
                    "anomaly": float(clamp01(float(fused_vals[i]))),
                    "conf": float(
                        clamp01(
                            float(
                                conf_by_zone.get(zid, pred_conf if not detector.available else float(row.get("conf", 0.6)))
                            )
                        )
                    ),
                    "peopleCount": int(row["peopleCount"]),
                }
            )

        schema_record = {"ts": ts, "zones": zones_payload}
        behavior_record = {
            "ts": ts,
            "clipIndex": int(clip_idx),
            "predLabel": pred_label,
            "predClassId": pred_idx,
            "predConf": pred_conf,
            "expectedRisk": exp_risk,
            "probs": {idx_to_class.get(i, str(i)): float(p) for i, p in enumerate(probs.tolist())},
        }
        yield schema_record, behavior_record

        prev_gray = gray


def main() -> None:
    args = parse_args()

    cfg = HybridFusionConfig(
        paper_weight=float(args.paper_weight),
        fusion_alpha_prev=float(args.fusion_alpha_prev),
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    behavior_f = None
    if args.out_behavior:
        out_behavior_path = Path(args.out_behavior)
        out_behavior_path.parent.mkdir(parents=True, exist_ok=True)
        behavior_f = out_behavior_path.open("w", encoding="utf-8")

    rows = 0
    with out_path.open("w", encoding="utf-8") as out_f:
        for schema_record, behavior_record in run_hybrid_inference_records(
            video_path=args.video,
            zones_path=args.zones,
            models_dir=args.models_dir,
            checkpoint=args.checkpoint,
            svm_model=args.svm_model,
            device=args.device,
            clip_len=int(args.clip_len),
            detect_every_clips=int(args.detect_every_clips),
            start_ts_ms=args.start_ts,
            max_clips=int(args.max_clips),
            yolo_model=args.yolo_model,
            yolo_conf_threshold=float(args.yolo_conf_threshold),
            cctv_sim=bool(args.cctv_sim),
            jpeg_quality=int(args.jpeg_quality),
            fusion_cfg=cfg,
        ):
            out_f.write(json.dumps(schema_record, separators=(",", ":")) + "\n")
            rows += 1
            if behavior_f is not None:
                behavior_f.write(json.dumps(behavior_record, separators=(",", ":")) + "\n")

    if behavior_f is not None:
        behavior_f.close()

    print(f"Wrote {rows} timesteps to {out_path}")
    if args.out_behavior:
        print(f"Wrote behavior predictions to {args.out_behavior}")


if __name__ == "__main__":
    main()

