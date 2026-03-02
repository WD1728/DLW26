#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import joblib
import numpy as np
import torch
from sklearn.metrics import accuracy_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from torch.utils.data import DataLoader

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.c3d_data import Crowd11ClipDataset
from ml.c3d_paper import C3DPaper


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train paper-style Multi-SVM on C3D features.")
    parser.add_argument("--data-root", required=True, help="Dataset root containing train/test splits")
    parser.add_argument("--train-split", default="train")
    parser.add_argument("--eval-split", default="test")
    parser.add_argument("--checkpoint", required=True, help="Path to trained C3D checkpoint (.pt)")
    parser.add_argument("--out-dir", default=str(PROJECT_ROOT / "models" / "paper_c3d"))

    parser.add_argument("--clip-len", type=int, default=16)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--max-clips-per-video", type=int, default=0)
    parser.add_argument("--num-video-clips", type=int, default=10, help="Random clips per video for video-level metric")
    parser.add_argument("--svm-strategy", choices=["ovo", "ovr"], default="ovo")
    parser.add_argument("--svm-c", type=float, default=1.0)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def _load_c3d(checkpoint_path: Path, device: torch.device) -> Tuple[C3DPaper, Dict[str, int], int]:
    ckpt = torch.load(checkpoint_path, map_location=device)
    class_to_idx = ckpt.get("class_to_idx")
    if not isinstance(class_to_idx, dict) or not class_to_idx:
        raise RuntimeError("Checkpoint missing class_to_idx")
    temporal_depth = int(ckpt.get("temporal_depth", 3))

    model = C3DPaper(num_classes=len(class_to_idx), temporal_depth=temporal_depth)
    model.load_state_dict(ckpt["model_state"])
    model.to(device)
    model.eval()
    return model, class_to_idx, temporal_depth


def _extract_features(
    model: C3DPaper,
    dataset: Crowd11ClipDataset,
    batch_size: int,
    num_workers: int,
    device: torch.device,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        pin_memory=False,
    )

    feat_list: List[np.ndarray] = []
    y_list: List[np.ndarray] = []
    idx_list: List[np.ndarray] = []

    with torch.no_grad():
        for clips, labels, indices in loader:
            clips = clips.to(device)
            feats = model.extract_features(clips).cpu().numpy()
            feat_list.append(feats)
            y_list.append(labels.numpy())
            idx_list.append(indices.numpy())

    X = np.concatenate(feat_list, axis=0) if feat_list else np.empty((0, 4096), dtype=np.float32)
    y = np.concatenate(y_list, axis=0) if y_list else np.empty((0,), dtype=np.int64)
    idx = np.concatenate(idx_list, axis=0) if idx_list else np.empty((0,), dtype=np.int64)
    return X, y, idx


def _video_level_accuracy(
    probs: np.ndarray,
    labels: np.ndarray,
    sample_indices: np.ndarray,
    dataset: Crowd11ClipDataset,
    num_video_clips: int,
    seed: int,
) -> float:
    rng = random.Random(seed)
    by_video: Dict[str, List[int]] = defaultdict(list)
    for row_i, sample_idx in enumerate(sample_indices.tolist()):
        ref = dataset.clips[int(sample_idx)]
        by_video[str(ref.video_path)].append(row_i)

    pred_video = []
    true_video = []
    for _, rows in by_video.items():
        if not rows:
            continue
        chosen = rows
        if num_video_clips > 0 and len(rows) > num_video_clips:
            chosen = rng.sample(rows, num_video_clips)
        mean_prob = np.mean(probs[chosen], axis=0)
        pred = int(np.argmax(mean_prob))
        true = int(labels[chosen[0]])
        pred_video.append(pred)
        true_video.append(true)

    if not pred_video:
        return 0.0
    return float(accuracy_score(true_video, pred_video))


def main() -> None:
    args = parse_args()
    set_seed(args.seed)

    device = torch.device(args.device)
    checkpoint = Path(args.checkpoint)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    model, class_to_idx, temporal_depth = _load_c3d(checkpoint, device)

    data_root = Path(args.data_root)
    train_ds = Crowd11ClipDataset(
        split_dir=data_root / args.train_split,
        class_to_idx=class_to_idx,
        clip_len=args.clip_len,
        train=False,
        max_clips_per_video=args.max_clips_per_video,
        seed=args.seed,
        return_index=True,
    )
    eval_ds = Crowd11ClipDataset(
        split_dir=data_root / args.eval_split,
        class_to_idx=class_to_idx,
        clip_len=args.clip_len,
        train=False,
        max_clips_per_video=args.max_clips_per_video,
        seed=args.seed,
        return_index=True,
    )

    X_train, y_train, _idx_train = _extract_features(
        model=model,
        dataset=train_ds,
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        device=device,
    )
    X_eval, y_eval, idx_eval = _extract_features(
        model=model,
        dataset=eval_ds,
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        device=device,
    )

    svm = Pipeline(
        steps=[
            ("scaler", StandardScaler(with_mean=True, with_std=True)),
            (
                "svm",
                SVC(
                    kernel="linear",
                    C=float(args.svm_c),
                    decision_function_shape=args.svm_strategy,
                    probability=True,
                    random_state=args.seed,
                ),
            ),
        ]
    )
    svm.fit(X_train, y_train)

    pred_clip = svm.predict(X_eval)
    clip_acc = float(accuracy_score(y_eval, pred_clip)) if len(y_eval) else 0.0

    probs = svm.predict_proba(X_eval) if len(y_eval) else np.empty((0, len(class_to_idx)), dtype=np.float32)
    video_acc = _video_level_accuracy(
        probs=probs,
        labels=y_eval,
        sample_indices=idx_eval,
        dataset=eval_ds,
        num_video_clips=args.num_video_clips,
        seed=args.seed,
    )

    svm_path = out_dir / "paper_multi_svm.joblib"
    joblib.dump(svm, svm_path)

    idx_to_class = {int(v): str(k) for k, v in class_to_idx.items()}
    meta = {
        "checkpoint": str(checkpoint),
        "temporal_depth": temporal_depth,
        "clip_len": args.clip_len,
        "train_split": args.train_split,
        "eval_split": args.eval_split,
        "num_train_clips": int(len(train_ds)),
        "num_eval_clips": int(len(eval_ds)),
        "clip_accuracy": clip_acc,
        "video_accuracy": video_acc,
        "num_video_clips": int(args.num_video_clips),
        "svm_strategy": args.svm_strategy,
        "svm_c": float(args.svm_c),
        "class_to_idx": class_to_idx,
        "idx_to_class": idx_to_class,
    }
    with (out_dir / "paper_multi_svm_meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(meta, indent=2))
    print(f"Saved SVM model: {svm_path}")


if __name__ == "__main__":
    main()
