from __future__ import annotations

from pathlib import Path
from typing import Generator, List, Optional, Tuple

import cv2
import numpy as np

SUPPORTED_VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".m4v"}


def find_videos(root: str | Path) -> List[Path]:
    root_path = Path(root)
    if not root_path.exists():
        return []
    files = [p for p in root_path.rglob("*") if p.suffix.lower() in SUPPORTED_VIDEO_EXTS]
    return sorted(files)


def resolve_dataset_split_dir(data_root: str | Path, dataset: str, split: str) -> Optional[Path]:
    root = Path(data_root)
    dataset_root = root / dataset
    if not dataset_root.exists():
        return None

    direct = dataset_root / split
    if direct.exists():
        return direct

    aliases = {
        "train": ["train", "training", "Train"],
        "test": ["test", "testing", "Test", "abnormal"],
        "normal": ["normal", "Normal", "train", "training"],
        "crowded": ["crowded", "abnormal", "anomaly"],
        "fight": ["fight", "violence", "abnormal"],
        "crime": ["crime", "anomaly", "abnormal"],
    }

    for alias in aliases.get(split, [split]):
        candidate = dataset_root / alias
        if candidate.exists():
            return candidate

    split_lower = split.lower()
    candidates = [
        p
        for p in dataset_root.rglob("*")
        if p.is_dir() and split_lower in p.name.lower() and "." not in p.name
    ]
    if candidates:
        return sorted(candidates, key=lambda x: len(str(x)))[0]

    return None


def iter_sampled_video_frames(
    video_path: str | Path,
    target_fps: float,
) -> Generator[Tuple[int, int, int, np.ndarray], None, None]:
    """
    Yield sampled video frames.

    Yields tuples:
    - source_frame_idx
    - processed_frame_idx
    - video_elapsed_ms
    - frame_bgr
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    video_fps = float(cap.get(cv2.CAP_PROP_FPS))
    if video_fps <= 0:
        video_fps = float(target_fps if target_fps > 0 else 3.0)

    desired_fps = float(target_fps if target_fps > 0 else video_fps)
    stride = max(1, int(round(video_fps / desired_fps)))

    source_idx = -1
    processed_idx = -1

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        source_idx += 1
        if source_idx % stride != 0:
            continue

        processed_idx += 1
        elapsed_ms = int(cap.get(cv2.CAP_PROP_POS_MSEC))
        yield source_idx, processed_idx, elapsed_ms, frame

    cap.release()
