from __future__ import annotations

from typing import Tuple

import cv2
import numpy as np


def apply_cctv_simulation(frame_bgr: np.ndarray, jpeg_quality: int = 40) -> np.ndarray:
    """Simulate low-quality CCTV compression artifacts via JPEG recompression."""
    ok, encoded = cv2.imencode(
        ".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)]
    )
    if not ok:
        return frame_bgr
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    return decoded if decoded is not None else frame_bgr


def preprocess_frame(
    frame_bgr: np.ndarray,
    width: int,
    height: int,
    cctv_sim: bool = False,
    jpeg_quality: int = 40,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Step A preprocessing:
    - resize to target resolution
    - optional JPEG recompression simulation
    - grayscale conversion
    """
    resized = cv2.resize(frame_bgr, (width, height), interpolation=cv2.INTER_AREA)
    if cctv_sim:
        resized = apply_cctv_simulation(resized, jpeg_quality=jpeg_quality)
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    return resized, gray
