#!/usr/bin/env python3
from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
import sys
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from crowd_counting.csrnet_wrapper import CSRNetCounter, DEFAULT_WEIGHTS_PATH, parse_roi


def _draw_roi(frame: np.ndarray, roi: List[Tuple[int, int]]) -> None:
    if len(roi) < 3:
        return
    pts = np.asarray(roi, dtype=np.int32)
    cv2.polylines(frame, [pts], isClosed=True, color=(0, 255, 255), thickness=2)


def _density_heatmap_overlay(frame_bgr: np.ndarray, density_map: np.ndarray, alpha: float = 0.35) -> np.ndarray:
    den = density_map.astype(np.float32)
    if den.size == 0:
        return frame_bgr
    d_min = float(np.min(den))
    d_max = float(np.max(den))
    if d_max <= d_min:
        norm = np.zeros_like(den, dtype=np.uint8)
    else:
        norm = np.clip((den - d_min) / (d_max - d_min) * 255.0, 0, 255).astype(np.uint8)
    heat = cv2.applyColorMap(norm, cv2.COLORMAP_JET)
    heat = cv2.resize(heat, (frame_bgr.shape[1], frame_bgr.shape[0]), interpolation=cv2.INTER_CUBIC)
    return cv2.addWeighted(frame_bgr, 1.0 - alpha, heat, alpha, 0.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CSRNet inference demo (image or camera).")
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS_PATH))
    parser.add_argument("--device", default="cuda", help="cuda|cpu|auto")
    parser.add_argument("--image", default="", help="Path to one image. If empty, use camera.")
    parser.add_argument("--camera", type=int, default=0, help="Camera index for live mode.")
    parser.add_argument("--roi", default="", help='ROI polygon, e.g. "120,100;600,100;650,500;90,500"')
    parser.add_argument("--show-heatmap", action="store_true")
    parser.add_argument("--save", default="", help="Save output image/video path")
    return parser.parse_args()


def run_image_mode(counter: CSRNetCounter, image_path: Path, roi: List[Tuple[int, int]], show_heatmap: bool, save_path: str) -> None:
    frame = cv2.imread(str(image_path))
    if frame is None:
        raise RuntimeError(f"Failed to load image: {image_path}")

    t0 = time.perf_counter()
    density = counter.predict_density(frame)
    count = float(density.sum())
    roi_count = counter.predict_count_from_density(density, frame.shape[:2], roi if roi else None)
    fps = 1.0 / max(1e-6, (time.perf_counter() - t0))

    vis = frame.copy()
    if show_heatmap:
        vis = _density_heatmap_overlay(vis, density, alpha=0.35)
    _draw_roi(vis, roi)

    lines = [f"count: {count:.2f}", f"roi_count: {roi_count:.2f}", f"fps: {fps:.2f}"]
    for i, txt in enumerate(lines):
        cv2.putText(vis, txt, (10, 24 + 24 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(vis, txt, (10, 24 + 24 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 1, cv2.LINE_AA)

    if save_path:
        out_path = Path(save_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), vis)
        print(f"saved: {out_path}")

    cv2.imshow("CSRNet Demo", vis)
    cv2.waitKey(0)
    cv2.destroyAllWindows()


def run_camera_mode(counter: CSRNetCounter, camera_idx: int, roi: List[Tuple[int, int]], show_heatmap: bool, save_path: str) -> None:
    cap = cv2.VideoCapture(camera_idx)
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open camera index {camera_idx}")

    writer = None
    if save_path:
        out_path = Path(save_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(str(out_path), fourcc, 20.0, (width, height))
        print(f"saving video: {out_path}")

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        t0 = time.perf_counter()
        density = counter.predict_density(frame)
        count = float(density.sum())
        roi_count = counter.predict_count_from_density(density, frame.shape[:2], roi if roi else None)
        fps = 1.0 / max(1e-6, (time.perf_counter() - t0))

        vis = frame.copy()
        if show_heatmap:
            vis = _density_heatmap_overlay(vis, density, alpha=0.35)
        _draw_roi(vis, roi)

        lines = [f"count: {count:.2f}", f"roi_count: {roi_count:.2f}", f"fps: {fps:.2f}"]
        for i, txt in enumerate(lines):
            cv2.putText(vis, txt, (10, 24 + 24 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(vis, txt, (10, 24 + 24 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 1, cv2.LINE_AA)

        cv2.imshow("CSRNet Demo", vis)
        if writer is not None:
            writer.write(vis)

        key = cv2.waitKey(1) & 0xFF
        if key in (27, ord("q")):
            break

    cap.release()
    if writer is not None:
        writer.release()
    cv2.destroyAllWindows()


def main() -> None:
    args = parse_args()
    roi = parse_roi(args.roi) if args.roi else []
    counter = CSRNetCounter(weights_path=args.weights, device=args.device)

    if args.image:
        run_image_mode(counter, Path(args.image), roi, args.show_heatmap, args.save)
    else:
        run_camera_mode(counter, args.camera, roi, args.show_heatmap, args.save)


if __name__ == "__main__":
    main()
