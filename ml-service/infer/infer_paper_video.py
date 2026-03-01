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

from ml.anomaly import apply_ewma, clamp01
from ml.c3d_paper import C3DPaper
from ml.detector import YoloV8PersonDetector
from ml.features import aggregate_detections_by_zone, density_conf_counts_per_zone
from ml.paper_behavior import risk_from_behavior_label
from ml.preprocess import preprocess_frame
from ml.zones import load_zones


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Paper-mode inference: C3D + Multi-SVM behavior classification to zone anomaly JSONL."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--checkpoint", required=True, help="Trained C3D checkpoint (.pt)")
    parser.add_argument("--svm-model", required=True, help="Trained Multi-SVM model (.joblib)")
    parser.add_argument("--out", required=True, help="Output JSONL with required SafeFlow schema")
    parser.add_argument("--out-behavior", default="", help="Optional output JSONL with behavior labels/probabilities")

    parser.add_argument("--clip-len", type=int, default=16)
    parser.add_argument("--detect-every-clips", type=int, default=1)
    parser.add_argument("--density-weight", type=float, default=0.3)
    parser.add_argument("--risk-weight", type=float, default=0.7)
    parser.add_argument("--start-ts", type=int, default=None)
    parser.add_argument("--device", default="cpu")

    parser.add_argument("--yolo-model", default="yolov8n.pt")
    parser.add_argument("--yolo-conf-threshold", type=float, default=0.25)
    parser.add_argument("--max-clips", type=int, default=0)
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
    clip = np.stack(rgb, axis=0)  # [T, H, W, C]
    clip = _center_crop_clip(clip, crop_h=112, crop_w=112)
    clip = clip.astype(np.float32) / 255.0
    # [T,H,W,C] -> [1,C,T,H,W]
    return torch.from_numpy(clip).permute(3, 0, 1, 2).unsqueeze(0).contiguous()


def main() -> None:
    args = parse_args()
    device = torch.device(args.device)

    model, idx_to_class = _load_c3d(Path(args.checkpoint), device=device)
    svm = joblib.load(args.svm_model)

    width, height, zones = load_zones(args.zones)
    detector = YoloV8PersonDetector(
        model_name=args.yolo_model,
        conf_threshold=args.yolo_conf_threshold,
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    behavior_f = None
    if args.out_behavior:
        out_behavior_path = Path(args.out_behavior)
        out_behavior_path.parent.mkdir(parents=True, exist_ok=True)
        behavior_f = out_behavior_path.open("w", encoding="utf-8")

    base_ts = int(args.start_ts if args.start_ts is not None else int(time.time() * 1000))
    ewma_state: Dict[str, float] = {}

    num_rows = 0
    with out_path.open("w", encoding="utf-8") as out_f:
        for clip_idx, (frames, frame_ts_ms) in enumerate(_iter_video_clips(Path(args.video), int(args.clip_len))):
            if args.max_clips > 0 and clip_idx >= args.max_clips:
                break

            center_i = len(frames) // 2
            rep_frame = frames[center_i]
            rep_elapsed_ms = int(frame_ts_ms[center_i])
            ts = int(base_ts + rep_elapsed_ms)

            # Paper path: behavior classification from 16-frame clip
            clip_tensor = _clip_to_tensor(frames).to(device)
            with torch.no_grad():
                feats = model.extract_features(clip_tensor).cpu().numpy()
            probs = svm.predict_proba(feats)[0]
            pred_idx = int(np.argmax(probs))
            pred_label = idx_to_class.get(pred_idx, f"class_{pred_idx}")
            pred_conf = float(probs[pred_idx])
            global_risk = float(clamp01(risk_from_behavior_label(pred_label, default=0.5)))

            # Per-zone density from current representative frame
            resized_bgr, _gray = preprocess_frame(rep_frame, width=width, height=height)
            detections: List[Dict[str, float | List[float]]] = []
            if detector.available and (clip_idx % max(1, args.detect_every_clips) == 0):
                detections = detector.detect(resized_bgr)

            counts, conf_sums, conf_counts = aggregate_detections_by_zone(detections, zones)
            density_by_zone, conf_by_zone, people_by_zone = density_conf_counts_per_zone(
                zones=zones,
                counts=counts,
                conf_sums=conf_sums,
                conf_counts=conf_counts,
                detector_available=detector.available,
            )

            # Blend paper risk with local density, then smooth per zone.
            zone_ids = [z.zone_id for z in zones]
            risk_vals = []
            for z in zones:
                d = float(density_by_zone.get(z.zone_id, 0.0))
                r = float(args.risk_weight) * global_risk + float(args.density_weight) * d
                risk_vals.append(float(clamp01(r)))

            smoothed, ewma_state = apply_ewma(zone_ids, np.asarray(risk_vals, dtype=np.float32), ewma_state, alpha_prev=0.7)

            zones_payload = []
            for i, z in enumerate(zones):
                zones_payload.append(
                    {
                        "zoneId": z.zone_id,
                        "density": float(clamp01(float(density_by_zone.get(z.zone_id, 0.0)))),
                        "anomaly": float(clamp01(float(smoothed[i]))),
                        "conf": float(clamp01(float(conf_by_zone.get(z.zone_id, pred_conf)))),
                        "peopleCount": int(people_by_zone.get(z.zone_id, 0)),
                    }
                )

            row = {"ts": ts, "zones": zones_payload}
            out_f.write(json.dumps(row, separators=(",", ":")) + "\n")
            num_rows += 1

            if behavior_f is not None:
                behavior_row = {
                    "ts": ts,
                    "clipIndex": int(clip_idx),
                    "predLabel": pred_label,
                    "predClassId": pred_idx,
                    "predConf": pred_conf,
                    "risk": global_risk,
                    "probs": {idx_to_class.get(i, str(i)): float(p) for i, p in enumerate(probs.tolist())},
                }
                behavior_f.write(json.dumps(behavior_row, separators=(",", ":")) + "\n")

    if behavior_f is not None:
        behavior_f.close()

    print(f"Wrote {num_rows} timesteps to {out_path}")
    if args.out_behavior:
        print(f"Wrote behavior predictions to {args.out_behavior}")
    if (not detector.available) and detector.reason:
        print(f"YOLO disabled: {detector.reason}")


if __name__ == "__main__":
    main()
