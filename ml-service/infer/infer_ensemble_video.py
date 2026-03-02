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

from ml.anomaly import ZoneAnomalyScorer, apply_ewma, clamp01
from ml.c3d_paper import C3DPaper
from ml.detector import YoloV8PersonDetector
from ml.features import (
    aggregate_detections_by_zone,
    build_feature_rows,
    density_conf_counts_per_zone,
    zone_motion_features,
)
from ml.flow import compute_farneback_flow
from ml.fusion import HybridFusionConfig, activity_weights_from_rows, spatialize_global_risk
from ml.mil_ranking import load_mil_head
from ml.paper_behavior import expected_risk_from_probs
from ml.preprocess import preprocess_frame
from ml.zones import load_zones


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Ensemble inference: baseline per-zone anomaly + paper behavior risk + Real-World MIL anomaly head."
        )
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--zones", required=True)
    parser.add_argument("--models-dir", default=str(PROJECT_ROOT / "models"))

    parser.add_argument("--checkpoint", required=True, help="C3D checkpoint (.pt) used for feature extraction")
    parser.add_argument("--svm-model", required=True, help="Paper Multi-SVM classifier (.joblib)")
    parser.add_argument("--mil-head", default="", help="Optional MIL ranking head checkpoint (.pt)")

    parser.add_argument("--out", required=True, help="Output JSONL with required SafeFlow schema")
    parser.add_argument("--out-debug", default="", help="Optional debug JSONL (behavior + MIL scores)")

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


def run_ensemble_inference_records(
    *,
    video_path: str | Path,
    zones_path: str | Path,
    models_dir: str | Path,
    checkpoint: str | Path,
    svm_model: str | Path,
    mil_head: str | Path | None,
    device: str,
    clip_len: int = 16,
    detect_every_clips: int = 1,
    start_ts_ms: int | None = None,
    max_clips: int = 0,
    yolo_model: str = "yolov8n.pt",
    yolo_conf_threshold: float = 0.25,
    cctv_sim: bool = False,
    jpeg_quality: int = 40,
    paper_weight: float = 0.55,
    mil_weight: float = 0.25,
    fusion_alpha_prev: float = 0.7,
) -> Generator[Tuple[Dict[str, object], Dict[str, object]], None, None]:
    torch_device = torch.device(device)
    model, idx_to_class = _load_c3d(Path(checkpoint), device=torch_device)
    svm = joblib.load(str(svm_model))

    mil = None
    mil_meta: Dict[str, object] = {}
    if mil_head:
        mil, mil_meta = load_mil_head(mil_head, device=torch_device)

    width, height, zones = load_zones(zones_path)
    detector = YoloV8PersonDetector(model_name=yolo_model, conf_threshold=yolo_conf_threshold)
    scorer = ZoneAnomalyScorer(models_dir=models_dir)

    fusion_cfg = HybridFusionConfig(
        paper_weight=float(paper_weight),
        fusion_alpha_prev=float(fusion_alpha_prev),
    )
    mil_weight = float(clamp01(float(mil_weight)))

    prev_gray = None
    prev_state: Dict[str, Dict[str, float]] = {}
    last_detections: List[Dict[str, float | List[float]]] = []
    fused_ewma: Dict[str, float] = {}

    base_ts = int(start_ts_ms if start_ts_ms is not None else int(time.time() * 1000))

    for clip_idx, (frames, frame_ts_ms) in enumerate(_iter_video_clips(Path(video_path), int(clip_len))):
        if max_clips > 0 and clip_idx >= max_clips:
            break

        center_i = len(frames) // 2
        rep_frame = frames[center_i]
        rep_elapsed_ms = int(frame_ts_ms[center_i])
        ts = int(base_ts + rep_elapsed_ms)

        clip_tensor = _clip_to_tensor(frames).to(torch_device)
        with torch.no_grad():
            feats_t = model.extract_features(clip_tensor)
            feats = feats_t.detach().cpu().numpy()  # [1,4096]

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
        zone_ids = [str(r["zoneId"]) for r in rows]

        base_by_zone = scorer.score(rows)
        base_vals = np.asarray([float(base_by_zone.get(zid, 0.0)) for zid in zone_ids], dtype=np.float32)

        activity_w = activity_weights_from_rows(rows, fusion_cfg)
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

        zones_payload: List[Dict[str, object]] = []
        for i, row in enumerate(rows):
            zid = str(row["zoneId"])
            zones_payload.append(
                {
                    "zoneId": zid,
                    "density": float(clamp01(float(row["density"]))),
                    "anomaly": float(clamp01(float(smoothed[i]))),
                    "conf": float(clamp01(float(conf_by_zone.get(zid, 0.6)))),
                    "peopleCount": int(row["peopleCount"]),
                }
            )

        schema_record = {"ts": ts, "zones": zones_payload}
        debug_record = {
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
        }
        yield schema_record, debug_record

        prev_gray = gray


def main() -> None:
    args = parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    debug_f = None
    if args.out_debug:
        out_debug_path = Path(args.out_debug)
        out_debug_path.parent.mkdir(parents=True, exist_ok=True)
        debug_f = out_debug_path.open("w", encoding="utf-8")

    rows = 0
    with out_path.open("w", encoding="utf-8") as out_f:
        for schema_record, debug_record in run_ensemble_inference_records(
            video_path=args.video,
            zones_path=args.zones,
            models_dir=args.models_dir,
            checkpoint=args.checkpoint,
            svm_model=args.svm_model,
            mil_head=Path(args.mil_head) if args.mil_head else None,
            device=args.device,
            clip_len=int(args.clip_len),
            detect_every_clips=int(args.detect_every_clips),
            start_ts_ms=args.start_ts,
            max_clips=int(args.max_clips),
            yolo_model=args.yolo_model,
            yolo_conf_threshold=float(args.yolo_conf_threshold),
            cctv_sim=bool(args.cctv_sim),
            jpeg_quality=int(args.jpeg_quality),
            paper_weight=float(args.paper_weight),
            mil_weight=float(args.mil_weight),
            fusion_alpha_prev=float(args.fusion_alpha_prev),
        ):
            out_f.write(json.dumps(schema_record, separators=(",", ":")) + "\n")
            rows += 1
            if debug_f is not None:
                debug_f.write(json.dumps(debug_record, separators=(",", ":")) + "\n")

    if debug_f is not None:
        debug_f.close()

    print(f"Wrote {rows} timesteps to {out_path}")
    if args.out_debug:
        print(f"Wrote debug JSONL to {args.out_debug}")


if __name__ == "__main__":
    main()

