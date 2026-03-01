from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import cv2
import numpy as np


@dataclass(frozen=True)
class AnalysisZone:
    zone_id: str
    polygon: np.ndarray
    capacity: float
    mask: np.ndarray


def _ensure_polygon(points: Iterable[Iterable[float]]) -> np.ndarray:
    poly = np.asarray(points, dtype=np.int32)
    if poly.ndim != 2 or poly.shape[1] != 2 or poly.shape[0] < 3:
        raise ValueError("Each zone polygon must be an array-like with shape [N>=3, 2]")
    return poly


def load_zones(zones_path: str | Path) -> Tuple[int, int, List[AnalysisZone]]:
    """Load analysis-zone configuration and precompute binary masks."""
    zones_path = Path(zones_path)
    with zones_path.open("r", encoding="utf-8") as f:
        config = json.load(f)

    width = int(config.get("width", 320))
    height = int(config.get("height", 240))
    default_capacity = float(config.get("defaultCapacity", 25))

    zone_items = config.get("zones")
    if not zone_items:
        raise ValueError(f"No zones found in {zones_path}")

    zones: List[AnalysisZone] = []
    for raw in zone_items:
        zone_id = raw.get("zoneId") or raw.get("id")
        if not zone_id:
            raise ValueError("Each zone entry must include zoneId (e.g., AZ1)")

        polygon = _ensure_polygon(raw.get("polygon", []))
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.fillPoly(mask, [polygon], 1)

        capacity = float(raw.get("capacity", default_capacity))
        zones.append(
            AnalysisZone(
                zone_id=zone_id,
                polygon=polygon,
                capacity=capacity,
                mask=mask.astype(bool),
            )
        )

    return width, height, zones


def zone_ids(zones: Iterable[AnalysisZone]) -> List[str]:
    return [z.zone_id for z in zones]


def locate_zone_for_point(x: float, y: float, zones: Iterable[AnalysisZone]) -> Optional[str]:
    """Return first zone containing the point center; None if outside all zones."""
    xi = int(round(x))
    yi = int(round(y))

    for zone in zones:
        h, w = zone.mask.shape
        if 0 <= yi < h and 0 <= xi < w and zone.mask[yi, xi]:
            return zone.zone_id
    return None
