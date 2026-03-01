from __future__ import annotations

from typing import Dict

import cv2
import numpy as np


def compute_farneback_flow(prev_gray: np.ndarray, curr_gray: np.ndarray) -> np.ndarray:
    """Compute dense optical flow using Farneback on grayscale frames."""
    return cv2.calcOpticalFlowFarneback(
        prev_gray,
        curr_gray,
        None,
        pyr_scale=0.5,
        levels=3,
        winsize=15,
        iterations=3,
        poly_n=5,
        poly_sigma=1.2,
        flags=0,
    )


def flow_maps(flow: np.ndarray) -> Dict[str, np.ndarray]:
    """
    Build derived maps needed by the per-zone features.

    Returns:
    - magnitude
    - direction (radians in [0, 2pi))
    - divergence (du/dx + dv/dy)
    - turbulence (|∇u| + |∇v|)
    """
    u = flow[..., 0]
    v = flow[..., 1]

    magnitude, direction = cv2.cartToPolar(u, v, angleInDegrees=False)

    du_dx = cv2.Sobel(u, cv2.CV_32F, 1, 0, ksize=3)
    du_dy = cv2.Sobel(u, cv2.CV_32F, 0, 1, ksize=3)
    dv_dx = cv2.Sobel(v, cv2.CV_32F, 1, 0, ksize=3)
    dv_dy = cv2.Sobel(v, cv2.CV_32F, 0, 1, ksize=3)

    divergence = du_dx + dv_dy
    grad_u = np.sqrt(du_dx * du_dx + du_dy * du_dy)
    grad_v = np.sqrt(dv_dx * dv_dx + dv_dy * dv_dy)
    turbulence = grad_u + grad_v

    return {
        "magnitude": magnitude,
        "direction": direction,
        "divergence": divergence,
        "turbulence": turbulence,
    }
