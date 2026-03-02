from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np


Point = Tuple[float, float]


@dataclass
class DensityConfig:
    # ROI polygon in pixel coordinates [(x1, y1), ...]
    roi: Sequence[Point]
    avg_height_m: float = 1.70
    ema_alpha: float = 0.20
    min_samples: int = 3
    min_h_px: float = 35.0
    max_h_px: float = 520.0
    # Fallback when head bbox is available:
    # body_height_px ~= head_box_height_px * head_to_body_ratio
    head_to_body_ratio: float = 7.0
    # Fallback when only head points are available:
    # body_height_px ~= nearest_head_spacing_px * head_spacing_to_body_ratio
    head_spacing_to_body_ratio: float = 2.8
    # Optional initial scale (px/m). If None, waits for first valid frame.
    init_scale_px_per_m: Optional[float] = None


@dataclass
class DensityState:
    s_smooth_px_per_m: Optional[float] = None
    last_area_m2_est: Optional[float] = None
    last_density_ppm2: float = 0.0
    last_count: int = 0
    last_risk_level: str = "unknown"


def parse_roi_string(roi_text: str) -> List[Point]:
    """
    Parse "x1,y1;x2,y2;x3,y3;x4,y4" -> [(x1,y1), ...]
    """
    text = str(roi_text or "").strip()
    if not text:
        raise ValueError("ROI string is empty")
    pts: List[Point] = []
    for token in text.split(";"):
        pair = token.strip()
        if not pair:
            continue
        xy = pair.split(",")
        if len(xy) != 2:
            raise ValueError(f"Invalid ROI point: {pair}")
        x, y = float(xy[0].strip()), float(xy[1].strip())
        pts.append((x, y))
    if len(pts) < 4:
        raise ValueError("ROI must have at least 4 points")
    return pts


def _as_polygon(roi: Sequence[Point]) -> np.ndarray:
    poly = np.asarray(roi, dtype=np.float32)
    if poly.ndim != 2 or poly.shape[1] != 2 or poly.shape[0] < 4:
        raise ValueError("ROI must be [N>=4,2]")
    return poly


def _point_in_roi(point_xy: Point, roi_poly: np.ndarray) -> bool:
    return cv2.pointPolygonTest(roi_poly, (float(point_xy[0]), float(point_xy[1])), False) >= 0


def roi_area_px(roi: Sequence[Point]) -> float:
    poly = _as_polygon(roi)
    area = float(cv2.contourArea(poly))
    return max(0.0, area)


def _det_center_from_bbox(bbox: Sequence[float]) -> Point:
    x1, y1, x2, y2 = [float(v) for v in bbox]
    return (0.5 * (x1 + x2), 0.5 * (y1 + y2))


def _extract_head_points_and_body_hpx(
    head_dets: Iterable[Dict[str, object]],
    roi_poly: np.ndarray,
    cfg: DensityConfig,
) -> Tuple[List[Point], List[float]]:
    head_points_roi: List[Point] = []
    body_hpx_from_head_bbox: List[float] = []

    for det in head_dets:
        if not isinstance(det, dict):
            continue
        center: Optional[Point] = None
        head_h_px: Optional[float] = None

        bbox = det.get("bbox")
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            x1, y1, x2, y2 = [float(v) for v in bbox]
            center = _det_center_from_bbox((x1, y1, x2, y2))
            head_h_px = max(0.0, y2 - y1)
        else:
            if "x" in det and "y" in det:
                center = (float(det["x"]), float(det["y"]))
            if "head_h_px" in det:
                head_h_px = float(det["head_h_px"])
            elif "h" in det:
                head_h_px = float(det["h"])

        if center is None:
            continue
        if not _point_in_roi(center, roi_poly):
            continue

        head_points_roi.append(center)
        if head_h_px is not None and head_h_px > 0:
            body_hpx_from_head_bbox.append(float(head_h_px) * float(cfg.head_to_body_ratio))

    return head_points_roi, body_hpx_from_head_bbox


def _extract_body_hpx_from_person_boxes(
    person_bboxes: Optional[Iterable[Dict[str, object] | Sequence[float]]],
    roi_poly: np.ndarray,
) -> List[float]:
    out: List[float] = []
    if person_bboxes is None:
        return out
    for item in person_bboxes:
        bbox: Optional[Sequence[float]] = None
        if isinstance(item, dict):
            raw = item.get("bbox")
            if isinstance(raw, (list, tuple)) and len(raw) == 4:
                bbox = [float(v) for v in raw]
        elif isinstance(item, (list, tuple)) and len(item) == 4:
            bbox = [float(v) for v in item]
        if bbox is None:
            continue
        center = _det_center_from_bbox(bbox)
        if not _point_in_roi(center, roi_poly):
            continue
        h_px = float(bbox[3]) - float(bbox[1])
        if h_px > 0:
            out.append(h_px)
    return out


def _fallback_body_hpx_from_head_spacing(
    head_points_roi: Sequence[Point], cfg: DensityConfig
) -> List[float]:
    if len(head_points_roi) < 2:
        return []
    pts = np.asarray(head_points_roi, dtype=np.float32)
    out: List[float] = []
    for i in range(len(pts)):
        p = pts[i]
        diff = pts - p
        dist = np.sqrt(np.sum(diff * diff, axis=1))
        dist[i] = np.inf
        nn = float(np.min(dist))
        if np.isfinite(nn) and nn > 0:
            out.append(nn * float(cfg.head_spacing_to_body_ratio))
    return out


def _risk_level_by_density(density_ppm2: float) -> str:
    d = float(density_ppm2)
    if d > 6.0:
        return "extreme"
    if d > 4.0:
        return "high_risk"
    if d >= 2.0:
        return "crowded"
    return "safe"


class ROIDensityEstimator:
    def __init__(self, config: DensityConfig):
        self.config = config
        self.roi_poly = _as_polygon(config.roi)
        self.area_px = roi_area_px(config.roi)
        self.state = DensityState(s_smooth_px_per_m=config.init_scale_px_per_m)

    def compute_density(
        self,
        frame: np.ndarray,
        head_dets: Iterable[Dict[str, object]],
        person_bboxes: Optional[Iterable[Dict[str, object] | Sequence[float]]] = None,
        *,
        draw: bool = True,
    ) -> Dict[str, object]:
        cfg = self.config
        roi_poly = self.roi_poly

        head_points_roi, body_hpx_from_head_bbox = _extract_head_points_and_body_hpx(
            head_dets=head_dets, roi_poly=roi_poly, cfg=cfg
        )
        count = int(len(head_points_roi))

        body_hpx_candidates = _extract_body_hpx_from_person_boxes(
            person_bboxes=person_bboxes, roi_poly=roi_poly
        )
        # Fallback A: head bbox -> body height.
        if not body_hpx_candidates:
            body_hpx_candidates = list(body_hpx_from_head_bbox)
        # Fallback B: only head points -> nearest-head spacing proxy.
        if not body_hpx_candidates:
            body_hpx_candidates = _fallback_body_hpx_from_head_spacing(head_points_roi, cfg)

        valid_h = [
            float(h)
            for h in body_hpx_candidates
            if np.isfinite(h) and cfg.min_h_px <= float(h) <= cfg.max_h_px
        ]

        scale_update_used = False
        h_med: Optional[float] = None
        s_raw: Optional[float] = None
        if len(valid_h) >= int(cfg.min_samples):
            h_med = float(np.median(np.asarray(valid_h, dtype=np.float32)))
            if cfg.min_h_px <= h_med <= cfg.max_h_px and cfg.avg_height_m > 0:
                s_raw = float(h_med / float(cfg.avg_height_m))
                if s_raw > 1e-6:
                    if self.state.s_smooth_px_per_m is None:
                        self.state.s_smooth_px_per_m = s_raw
                    else:
                        a = float(cfg.ema_alpha)
                        self.state.s_smooth_px_per_m = a * s_raw + (1.0 - a) * float(self.state.s_smooth_px_per_m)
                    scale_update_used = True

        s_smooth = self.state.s_smooth_px_per_m
        if s_smooth is None or s_smooth <= 1e-6:
            area_m2_est = 0.0
            density_ppm2 = 0.0
            risk = "unknown"
        else:
            area_m2_est = float(self.area_px / (float(s_smooth) * float(s_smooth)))
            area_m2_est = max(area_m2_est, 1e-6)
            density_ppm2 = float(count / area_m2_est)
            risk = _risk_level_by_density(density_ppm2)

        self.state.last_area_m2_est = area_m2_est
        self.state.last_density_ppm2 = density_ppm2
        self.state.last_count = count
        self.state.last_risk_level = risk

        if draw:
            self.draw_overlay(
                frame=frame,
                count=count,
                area_m2_est=area_m2_est,
                density_ppm2=density_ppm2,
                risk_level=risk,
            )

        return {
            "count": int(count),
            "area_m2_est": float(area_m2_est),
            "density_ppm2": float(density_ppm2),
            "risk_level": str(risk),
            "area_px": float(self.area_px),
            "scale_px_per_m": float(s_smooth) if s_smooth is not None else None,
            "scale_raw_px_per_m": float(s_raw) if s_raw is not None else None,
            "h_med_px": float(h_med) if h_med is not None else None,
            "h_sample_count": int(len(valid_h)),
            "scale_update_used": bool(scale_update_used),
        }

    def draw_overlay(
        self,
        frame: np.ndarray,
        *,
        count: int,
        area_m2_est: float,
        density_ppm2: float,
        risk_level: str,
    ) -> None:
        poly_i = self.roi_poly.astype(np.int32)
        cv2.polylines(frame, [poly_i], isClosed=True, color=(0, 255, 255), thickness=2)

        lines = [
            f"count: {int(count)}",
            f"area_m2_est: {float(area_m2_est):.2f}",
            f"density_ppm2: {float(density_ppm2):.2f}",
            f"risk_level: {risk_level}",
        ]
        x0, y0 = 8, 20
        box_w, box_h = 300, 22 + 20 * len(lines)
        cv2.rectangle(frame, (x0 - 4, y0 - 16), (x0 - 4 + box_w, y0 - 16 + box_h), (0, 0, 0), -1)
        for i, line in enumerate(lines):
            y = y0 + i * 20
            cv2.putText(
                frame,
                line,
                (x0, y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.56,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )


# Default singleton for quick integration with existing pipelines.
_DEFAULT_ESTIMATOR: Optional[ROIDensityEstimator] = None


def configure_default_estimator(config: DensityConfig) -> ROIDensityEstimator:
    global _DEFAULT_ESTIMATOR
    _DEFAULT_ESTIMATOR = ROIDensityEstimator(config)
    return _DEFAULT_ESTIMATOR


def compute_density(
    frame: np.ndarray,
    head_dets: Iterable[Dict[str, object]],
    person_bboxes: Optional[Iterable[Dict[str, object] | Sequence[float]]] = None,
) -> Dict[str, object]:
    """
    Required integration function.

    head_dets format:
    - {"x": cx, "y": cy} OR
    - {"bbox": [x1, y1, x2, y2]} OR
    - {"bbox": [...], "head_h_px": h}

    person_bboxes format:
    - [{"bbox": [x1, y1, x2, y2]}, ...] OR
    - [[x1, y1, x2, y2], ...]
    """
    if _DEFAULT_ESTIMATOR is None:
        raise RuntimeError("Density estimator is not configured. Call configure_default_estimator(...) first.")
    return _DEFAULT_ESTIMATOR.compute_density(
        frame=frame, head_dets=head_dets, person_bboxes=person_bboxes, draw=True
    )
