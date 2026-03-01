#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np
import torch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.c3d_paper import C3DPaper
from ml.mil_ranking import MilRankingConfig, MilRankingHead, mil_ranking_loss, save_mil_head
from ml.videoio import find_videos


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a MIL ranking head on top of C3D features (UCF-Crime/CHAD-style weak labels)."
    )
    parser.add_argument("--normal-dir", required=True, help="Directory with normal videos (recursive).")
    parser.add_argument("--abnormal-dir", required=True, help="Directory with abnormal videos (recursive).")
    parser.add_argument("--feature-checkpoint", required=True, help="C3D checkpoint (.pt) used as feature extractor.")
    parser.add_argument("--out-dir", default=str(PROJECT_ROOT / "models" / "mil_ranking"))
    parser.add_argument("--cache-dir", default=str(PROJECT_ROOT / "artifacts" / "mil_cache"))

    parser.add_argument("--device", default="cpu")
    parser.add_argument("--clip-len", type=int, default=16)
    parser.add_argument("--max-clips-per-video", type=int, default=32)
    parser.add_argument("--max-videos-normal", type=int, default=50)
    parser.add_argument("--max-videos-abnormal", type=int, default=50)

    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--steps-per-epoch", type=int, default=250)
    parser.add_argument("--bag-size", type=int, default=32, help="Clips sampled per video per step (0=all).")
    parser.add_argument("--seed", type=int, default=42)

    parser.add_argument("--hidden-dim", type=int, default=256)
    parser.add_argument("--dropout", type=float, default=0.6)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-5)

    parser.add_argument("--margin", type=float, default=1.0)
    parser.add_argument("--topk-ratio", type=float, default=0.1)
    parser.add_argument("--lambda-sparsity", type=float, default=8e-5)
    parser.add_argument("--lambda-smoothness", type=float, default=8e-5)
    return parser.parse_args()


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def _center_crop_clip(clip_thwc: np.ndarray, crop_h: int = 112, crop_w: int = 112) -> np.ndarray:
    h = clip_thwc.shape[1]
    w = clip_thwc.shape[2]
    y0 = max(0, (h - crop_h) // 2)
    x0 = max(0, (w - crop_w) // 2)
    return clip_thwc[:, y0 : y0 + crop_h, x0 : x0 + crop_w, :]


def _clip_to_tensor(frames_bgr: List[np.ndarray]) -> torch.Tensor:
    resized = [cv2.resize(f, (171, 128), interpolation=cv2.INTER_AREA) for f in frames_bgr]
    rgb = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in resized]
    clip = np.stack(rgb, axis=0)  # [T,H,W,C]
    clip = _center_crop_clip(clip, crop_h=112, crop_w=112)
    clip = clip.astype(np.float32) / 255.0
    return torch.from_numpy(clip).permute(3, 0, 1, 2).unsqueeze(0).contiguous()


def _iter_video_clips(video_path: Path, clip_len: int):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return

    frames: List[np.ndarray] = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
        if len(frames) == clip_len:
            yield frames
            frames = []
    cap.release()


def _cache_path(cache_dir: Path, video_path: Path) -> Path:
    h = hashlib.sha1(str(video_path).encode("utf-8")).hexdigest()[:12]
    return cache_dir / f"{video_path.stem}_{h}.npz"


def extract_features_for_video(
    *,
    video_path: Path,
    model: C3DPaper,
    device: torch.device,
    clip_len: int,
    max_clips: int,
    cache_dir: Path,
) -> np.ndarray:
    cache_path = _cache_path(cache_dir, video_path)
    if cache_path.exists():
        data = np.load(cache_path)
        feats = data.get("feats")
        if isinstance(feats, np.ndarray) and feats.ndim == 2:
            return feats.astype(np.float32, copy=False)

    feats_list: List[np.ndarray] = []
    with torch.no_grad():
        for clip_i, frames in enumerate(_iter_video_clips(video_path, clip_len=clip_len)):
            if max_clips > 0 and clip_i >= max_clips:
                break
            clip_tensor = _clip_to_tensor(frames).to(device)
            feats = model.extract_features(clip_tensor).detach().cpu().numpy()  # [1,4096]
            feats_list.append(feats[0].astype(np.float32, copy=False))

    out = np.stack(feats_list, axis=0) if feats_list else np.empty((0, 4096), dtype=np.float32)
    cache_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, feats=out)
    return out


def _sample_bag(feats: np.ndarray, bag_size: int, rng: random.Random) -> np.ndarray:
    if feats.shape[0] == 0:
        return feats
    if bag_size <= 0 or feats.shape[0] <= bag_size:
        return feats
    start = rng.randrange(0, feats.shape[0] - bag_size + 1)
    return feats[start : start + bag_size]


def _load_c3d_feature_extractor(checkpoint_path: Path, device: torch.device) -> C3DPaper:
    ckpt = torch.load(checkpoint_path, map_location=device)
    class_to_idx = ckpt.get("class_to_idx")
    if not isinstance(class_to_idx, dict) or not class_to_idx:
        raise RuntimeError("Checkpoint missing class_to_idx")
    temporal_depth = int(ckpt.get("temporal_depth", 3))
    model = C3DPaper(num_classes=len(class_to_idx), temporal_depth=temporal_depth)
    model.load_state_dict(ckpt["model_state"])
    model.to(device)
    model.eval()
    return model


def main() -> None:
    args = parse_args()
    set_seed(args.seed)
    rng = random.Random(args.seed)

    device = torch.device(args.device)
    cache_dir = Path(args.cache_dir)

    normal_videos = find_videos(args.normal_dir)
    abnormal_videos = find_videos(args.abnormal_dir)

    if args.max_videos_normal > 0:
        normal_videos = normal_videos[: int(args.max_videos_normal)]
    if args.max_videos_abnormal > 0:
        abnormal_videos = abnormal_videos[: int(args.max_videos_abnormal)]

    if not normal_videos:
        raise RuntimeError(f"No videos found under normal-dir: {args.normal_dir}")
    if not abnormal_videos:
        raise RuntimeError(f"No videos found under abnormal-dir: {args.abnormal_dir}")

    feature_model = _load_c3d_feature_extractor(Path(args.feature_checkpoint), device=device)

    print(
        json.dumps(
            {
                "stage": "extract_features",
                "normal_videos": len(normal_videos),
                "abnormal_videos": len(abnormal_videos),
                "max_clips_per_video": int(args.max_clips_per_video),
                "clip_len": int(args.clip_len),
                "cache_dir": str(cache_dir),
            }
        ),
        flush=True,
    )

    normal_feats: List[np.ndarray] = []
    abnormal_feats: List[np.ndarray] = []
    for p in normal_videos:
        f = extract_features_for_video(
            video_path=p,
            model=feature_model,
            device=device,
            clip_len=int(args.clip_len),
            max_clips=int(args.max_clips_per_video),
            cache_dir=cache_dir,
        )
        if f.shape[0] > 0:
            normal_feats.append(f)
    for p in abnormal_videos:
        f = extract_features_for_video(
            video_path=p,
            model=feature_model,
            device=device,
            clip_len=int(args.clip_len),
            max_clips=int(args.max_clips_per_video),
            cache_dir=cache_dir,
        )
        if f.shape[0] > 0:
            abnormal_feats.append(f)

    if not normal_feats or not abnormal_feats:
        raise RuntimeError("Feature extraction produced empty bags. Check videos/codecs and retry.")

    head = MilRankingHead(in_dim=4096, hidden_dim=int(args.hidden_dim), dropout=float(args.dropout))
    head.to(device)
    head.train(True)

    optimizer = torch.optim.AdamW(
        head.parameters(),
        lr=float(args.lr),
        weight_decay=float(args.weight_decay),
    )

    cfg = MilRankingConfig(
        margin=float(args.margin),
        topk_ratio=float(args.topk_ratio),
        lambda_sparsity=float(args.lambda_sparsity),
        lambda_smoothness=float(args.lambda_smoothness),
    )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    latest_path = out_dir / "mil_head_latest.pt"

    for epoch in range(1, int(args.epochs) + 1):
        head.train(True)
        running = {"loss_total": 0.0, "loss_ranking": 0.0, "loss_sparsity": 0.0, "loss_smoothness": 0.0}

        steps = max(1, int(args.steps_per_epoch))
        for step in range(1, steps + 1):
            abn = rng.choice(abnormal_feats)
            nor = rng.choice(normal_feats)

            abn_bag = _sample_bag(abn, int(args.bag_size), rng)
            nor_bag = _sample_bag(nor, int(args.bag_size), rng)

            abn_t = torch.from_numpy(abn_bag).to(device)
            nor_t = torch.from_numpy(nor_bag).to(device)

            optimizer.zero_grad(set_to_none=True)
            scores_abn = head(abn_t)
            scores_nor = head(nor_t)
            loss, metrics = mil_ranking_loss(scores_abn, scores_nor, cfg=cfg)
            loss.backward()
            optimizer.step()

            for k in running:
                running[k] += float(metrics.get(k, 0.0))

            if step % 25 == 0 or step == steps:
                log = {
                    "epoch": int(epoch),
                    "step": int(step),
                    "steps": int(steps),
                    **{k: running[k] / float(step) for k in running},
                    "abn_topk": float(metrics["abn_topk"]),
                    "nor_topk": float(metrics["nor_topk"]),
                }
                print(json.dumps(log), flush=True)

        save_mil_head(
            latest_path,
            head=head,
            meta={
                "normal_dir": str(args.normal_dir),
                "abnormal_dir": str(args.abnormal_dir),
                "feature_checkpoint": str(args.feature_checkpoint),
                "clip_len": int(args.clip_len),
                "max_clips_per_video": int(args.max_clips_per_video),
                "max_videos_normal": int(args.max_videos_normal),
                "max_videos_abnormal": int(args.max_videos_abnormal),
                "epochs": int(args.epochs),
                "steps_per_epoch": int(args.steps_per_epoch),
                "bag_size": int(args.bag_size),
                "cfg": cfg.__dict__,
                "seed": int(args.seed),
            },
        )

    print(f"Saved MIL head: {latest_path}")


if __name__ == "__main__":
    main()

