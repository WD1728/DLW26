from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

from .videoio import SUPPORTED_VIDEO_EXTS, find_videos


@dataclass(frozen=True)
class ClipRef:
    video_path: Path
    start_frame: int
    label: int


def _scan_class_dirs(split_dir: Path) -> Tuple[List[str], Dict[str, int]]:
    classes = sorted([p.name for p in split_dir.iterdir() if p.is_dir()])
    if not classes:
        raise RuntimeError(
            f"No class folders found under {split_dir}. "
            "Expected structure: split/<class_name>/*.mp4|*.avi"
        )
    class_to_idx = {name: i for i, name in enumerate(classes)}
    return classes, class_to_idx


def _video_frame_count(path: Path) -> int:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 0
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return max(0, count)


def _safe_crop(
    clip_thwc: np.ndarray,
    crop_h: int,
    crop_w: int,
    train: bool,
    rng: random.Random,
) -> np.ndarray:
    # clip: [T, H, W, C]
    h = clip_thwc.shape[1]
    w = clip_thwc.shape[2]

    if h < crop_h or w < crop_w:
        pad_h = max(0, crop_h - h)
        pad_w = max(0, crop_w - w)
        clip_thwc = np.pad(
            clip_thwc,
            pad_width=((0, 0), (0, pad_h), (0, pad_w), (0, 0)),
            mode="edge",
        )
        h = clip_thwc.shape[1]
        w = clip_thwc.shape[2]

    if train:
        y0 = rng.randint(0, h - crop_h)
        x0 = rng.randint(0, w - crop_w)
    else:
        y0 = (h - crop_h) // 2
        x0 = (w - crop_w) // 2

    return clip_thwc[:, y0 : y0 + crop_h, x0 : x0 + crop_w, :]


def _read_clip(path: Path, start_frame: int, clip_len: int) -> List[np.ndarray]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return []
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(start_frame))

    frames: List[np.ndarray] = []
    for _ in range(int(clip_len)):
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()

    if not frames:
        return []
    while len(frames) < clip_len:
        frames.append(frames[-1].copy())
    return frames


class Crowd11ClipDataset(Dataset):
    """
    Paper-style video clip dataset:
    - frame resize: 128 x 171
    - clip length: 16 non-overlapping frames
    - random crop for training: 112 x 112 (center crop for eval)
    """

    def __init__(
        self,
        split_dir: str | Path,
        class_to_idx: Optional[Dict[str, int]] = None,
        clip_len: int = 16,
        resize_hw: Tuple[int, int] = (128, 171),
        crop_hw: Tuple[int, int] = (112, 112),
        train: bool = True,
        max_clips_per_video: int = 0,
        seed: int = 42,
        return_index: bool = False,
    ) -> None:
        super().__init__()
        self.split_dir = Path(split_dir)
        if not self.split_dir.exists():
            raise FileNotFoundError(f"Split directory not found: {self.split_dir}")

        self.clip_len = int(clip_len)
        self.resize_h = int(resize_hw[0])
        self.resize_w = int(resize_hw[1])
        self.crop_h = int(crop_hw[0])
        self.crop_w = int(crop_hw[1])
        self.train = bool(train)
        self.return_index = bool(return_index)
        self.rng = random.Random(int(seed))

        if class_to_idx is None:
            classes, class_to_idx = _scan_class_dirs(self.split_dir)
            self.classes = classes
        else:
            self.classes = sorted(class_to_idx.keys(), key=lambda x: class_to_idx[x])
        self.class_to_idx = dict(class_to_idx)

        self.clips: List[ClipRef] = []
        class_dirs = [p for p in self.split_dir.iterdir() if p.is_dir()]
        for class_dir in sorted(class_dirs):
            class_name = class_dir.name
            if class_name not in self.class_to_idx:
                continue
            label = int(self.class_to_idx[class_name])
            videos = find_videos(class_dir)
            for video in videos:
                frame_count = _video_frame_count(video)
                if frame_count < self.clip_len:
                    continue

                clip_count = frame_count // self.clip_len
                if max_clips_per_video > 0:
                    clip_count = min(clip_count, int(max_clips_per_video))
                for c in range(clip_count):
                    start = c * self.clip_len
                    self.clips.append(ClipRef(video_path=video, start_frame=start, label=label))

        if not self.clips:
            raise RuntimeError(f"No valid clips found under {self.split_dir}")

    def __len__(self) -> int:
        return len(self.clips)

    def __getitem__(self, index: int):
        ref = self.clips[index]
        frames = _read_clip(ref.video_path, ref.start_frame, self.clip_len)
        if not frames:
            clip = np.zeros((self.clip_len, self.crop_h, self.crop_w, 3), dtype=np.float32)
            tensor = torch.from_numpy(clip).permute(3, 0, 1, 2).contiguous()
            if self.return_index:
                return tensor, ref.label, index
            return tensor, ref.label

        resized = [
            cv2.resize(f, (self.resize_w, self.resize_h), interpolation=cv2.INTER_AREA)
            for f in frames
        ]
        rgb = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in resized]
        clip = np.stack(rgb, axis=0)  # [T,H,W,C]
        clip = _safe_crop(clip, self.crop_h, self.crop_w, self.train, self.rng)
        clip = clip.astype(np.float32) / 255.0

        # [T,H,W,C] -> [C,T,H,W]
        tensor = torch.from_numpy(clip).permute(3, 0, 1, 2).contiguous()
        if self.return_index:
            return tensor, ref.label, index
        return tensor, ref.label
