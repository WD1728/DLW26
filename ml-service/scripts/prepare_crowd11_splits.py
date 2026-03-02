#!/usr/bin/env python3
from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path
from typing import List

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".m4v"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare Crowd-11 style train/val/test splits from class folders."
    )
    parser.add_argument("--src", required=True, help="Source root with class subfolders")
    parser.add_argument("--dst", required=True, help="Destination root for train/val/test")
    parser.add_argument("--train-ratio", type=float, default=0.8)
    parser.add_argument("--val-ratio", type=float, default=0.1)
    parser.add_argument("--test-ratio", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--mode",
        choices=["symlink", "copy"],
        default="symlink",
        help="Use symlink (default) to avoid duplicating video files.",
    )
    return parser.parse_args()


def _videos_in_dir(path: Path) -> List[Path]:
    return sorted([p for p in path.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTS])


def _link_or_copy(src: Path, dst: Path, mode: str) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return
    if mode == "copy":
        shutil.copy2(src, dst)
        return
    try:
        dst.symlink_to(src.resolve())
    except Exception:
        shutil.copy2(src, dst)


def main() -> None:
    args = parse_args()
    src_root = Path(args.src)
    dst_root = Path(args.dst)
    if not src_root.exists():
        raise FileNotFoundError(f"Source root not found: {src_root}")

    ratios_sum = float(args.train_ratio + args.val_ratio + args.test_ratio)
    if abs(ratios_sum - 1.0) > 1e-6:
        raise ValueError("train-ratio + val-ratio + test-ratio must sum to 1.0")

    classes = sorted([p for p in src_root.iterdir() if p.is_dir()])
    if not classes:
        raise RuntimeError(
            f"No class directories found in {src_root}. "
            "Expected: <src>/<class_name>/*.mp4"
        )

    rng = random.Random(args.seed)
    for split in ["train", "val", "test"]:
        (dst_root / split).mkdir(parents=True, exist_ok=True)

    total_written = 0
    for class_dir in classes:
        videos = _videos_in_dir(class_dir)
        if not videos:
            print(f"[skip] {class_dir.name}: no videos")
            continue
        rng.shuffle(videos)

        n = len(videos)
        n_train = int(round(n * args.train_ratio))
        n_val = int(round(n * args.val_ratio))
        if n_train + n_val > n:
            n_val = max(0, n - n_train)
        n_test = n - n_train - n_val

        train_v = videos[:n_train]
        val_v = videos[n_train : n_train + n_val]
        test_v = videos[n_train + n_val :]

        for split, split_videos in [("train", train_v), ("val", val_v), ("test", test_v)]:
            for src_vid in split_videos:
                rel_name = src_vid.name
                dst_vid = dst_root / split / class_dir.name / rel_name
                _link_or_copy(src_vid, dst_vid, mode=args.mode)
                total_written += 1

        print(
            f"[class] {class_dir.name}: total={n} "
            f"train={len(train_v)} val={len(val_v)} test={len(test_v)}"
        )

    print(f"[done] wrote {total_written} files into {dst_root}")


if __name__ == "__main__":
    main()
