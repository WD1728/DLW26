from __future__ import annotations

from typing import Dict, Iterable, List, Tuple

import numpy as np

from .flow import flow_maps
from .zones import AnalysisZone, locate_zone_for_point

FEATURE_COLUMNS = [
    "density",
    "speed_mean",
    "speed_var",
    "dir_entropy",
    "divergence",
    "turbulence",
    "delta_speed_mean",
    "delta_dir_entropy",
    "delta_density",
]


def clamp01(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


def _normalized_entropy(direction_values: np.ndarray, bins: int = 8) -> float:
    if direction_values.size == 0:
        return 0.0

    hist, _ = np.histogram(direction_values, bins=bins, range=(0.0, 2.0 * np.pi))
    total = hist.sum()
    if total <= 0:
        return 0.0

    p = hist.astype(np.float64) / float(total)
    p = p[p > 0]
    entropy = -np.sum(p * np.log(p))
    max_entropy = np.log(bins)
    return float(entropy / max_entropy) if max_entropy > 0 else 0.0


def _active_motion_mask(
    zone_mask: np.ndarray,
    magnitude: np.ndarray,
    min_magnitude: float = 0.20,
    quantile: float = 75.0,
) -> np.ndarray:
    """
    Select pixels with meaningful motion inside the zone.
    Threshold is robust: max(min_magnitude, zone quantile).
    """
    zone_values = magnitude[zone_mask]
    if zone_values.size == 0:
        return np.zeros_like(zone_mask, dtype=bool)

    q = float(np.percentile(zone_values, quantile))
    threshold = max(float(min_magnitude), q)
    return zone_mask & (magnitude >= threshold)


def aggregate_detections_by_zone(
    detections: Iterable[Dict[str, float | List[float]]], zones: Iterable[AnalysisZone]
) -> Tuple[Dict[str, int], Dict[str, float], Dict[str, int]]:
    counts: Dict[str, int] = {z.zone_id: 0 for z in zones}
    conf_sums: Dict[str, float] = {z.zone_id: 0.0 for z in zones}
    conf_counts: Dict[str, int] = {z.zone_id: 0 for z in zones}

    zone_list = list(zones)
    for det in detections:
        bbox = det.get("bbox")  # type: ignore[assignment]
        if not bbox or len(bbox) != 4:
            continue

        x1, y1, x2, y2 = [float(v) for v in bbox]
        cx = 0.5 * (x1 + x2)
        cy = 0.5 * (y1 + y2)

        zone_id = locate_zone_for_point(cx, cy, zone_list)
        if zone_id is None:
            continue

        conf = float(det.get("conf", 0.0))
        counts[zone_id] += 1
        conf_sums[zone_id] += conf
        conf_counts[zone_id] += 1

    return counts, conf_sums, conf_counts


def density_conf_counts_per_zone(
    zones: Iterable[AnalysisZone],
    counts: Dict[str, int],
    conf_sums: Dict[str, float],
    conf_counts: Dict[str, int],
    detector_available: bool,
    fallback_conf: float = 0.6,
) -> Tuple[Dict[str, float], Dict[str, float], Dict[str, int]]:
    density: Dict[str, float] = {}
    conf: Dict[str, float] = {}
    people_count: Dict[str, int] = {}

    for zone in zones:
        zid = zone.zone_id
        if not detector_available:
            people_count[zid] = 0
            density[zid] = 0.0
            conf[zid] = float(fallback_conf)
            continue

        c = int(counts.get(zid, 0))
        people_count[zid] = c
        denom = max(zone.capacity, 1.0)
        density[zid] = clamp01(c / denom)

        if conf_counts.get(zid, 0) > 0:
            conf[zid] = float(conf_sums[zid] / conf_counts[zid])
        else:
            conf[zid] = float(fallback_conf)

    return density, conf, people_count


def zone_motion_features(
    flow: np.ndarray | None, zones: Iterable[AnalysisZone]
) -> Dict[str, Dict[str, float]]:
    zone_list = list(zones)
    if flow is None:
        return {
            z.zone_id: {
                "speed_mean": 0.0,
                "speed_var": 0.0,
                "dir_entropy": 0.0,
                "divergence": 0.0,
                "turbulence": 0.0,
            }
            for z in zone_list
        }

    maps = flow_maps(flow, remove_global_motion=True, blur_kernel=5)
    mag = maps["magnitude"]
    direction = maps["direction"]
    divergence_map = maps["divergence"]
    turbulence_map = maps["turbulence"]

    out: Dict[str, Dict[str, float]] = {}
    for zone in zone_list:
        mask = zone.mask
        if mask is None or mask.sum() == 0:
            out[zone.zone_id] = {
                "speed_mean": 0.0,
                "speed_var": 0.0,
                "dir_entropy": 0.0,
                "divergence": 0.0,
                "turbulence": 0.0,
            }
            continue

        active = _active_motion_mask(mask, mag, min_magnitude=0.20, quantile=75.0)
        active_count = int(active.sum())
        if active_count < 16:
            # Too little true motion: avoid deriving unstable "physics" from near-static noise.
            active = mask & (mag >= 0.20)

        speed_vals = mag[active]
        dir_vals = direction[active]
        div_vals = divergence_map[active]
        turb_vals = turbulence_map[active]

        out[zone.zone_id] = {
            "speed_mean": float(np.mean(speed_vals)) if speed_vals.size else 0.0,
            "speed_var": float(np.var(speed_vals)) if speed_vals.size else 0.0,
            "dir_entropy": _normalized_entropy(dir_vals, bins=8),
            "divergence": float(np.mean(div_vals)) if div_vals.size else 0.0,
            "turbulence": float(np.mean(turb_vals)) if turb_vals.size else 0.0,
        }

    return out


def zone_motion_occupancy(
    flow: np.ndarray | None,
    zones: Iterable[AnalysisZone],
    *,
    min_magnitude: float = 0.20,
    quantile: float = 75.0,
) -> Dict[str, float]:
    """
    Estimate the fraction of pixels within each zone that have meaningful motion.

    This is useful as a dense-crowd proxy when person detection undercounts due to occlusion.
    """
    zone_list = list(zones)
    if flow is None:
        return {z.zone_id: 0.0 for z in zone_list}

    maps = flow_maps(flow, remove_global_motion=True, blur_kernel=5)
    mag = maps["magnitude"]

    out: Dict[str, float] = {}
    for zone in zone_list:
        mask = zone.mask
        if mask is None:
            out[zone.zone_id] = 0.0
            continue
        total = int(mask.sum())
        if total <= 0:
            out[zone.zone_id] = 0.0
            continue

        active = _active_motion_mask(mask, mag, min_magnitude=float(min_magnitude), quantile=float(quantile))
        active_count = int(active.sum())
        if active_count < 16:
            active = mask & (mag >= float(min_magnitude))
            active_count = int(active.sum())

        out[zone.zone_id] = float(clamp01(active_count / float(total)))

    return out


def build_feature_rows(
    ts_ms: int,
    zones: Iterable[AnalysisZone],
    density_by_zone: Dict[str, float],
    conf_by_zone: Dict[str, float],
    people_count_by_zone: Dict[str, int],
    motion_by_zone: Dict[str, Dict[str, float]],
    prev_state: Dict[str, Dict[str, float]],
) -> Tuple[List[Dict[str, float | int | str]], Dict[str, Dict[str, float]]]:
    rows: List[Dict[str, float | int | str]] = []
    next_state: Dict[str, Dict[str, float]] = dict(prev_state)

    for zone in zones:
        zid = zone.zone_id
        motion = motion_by_zone.get(zid, {})

        density = float(density_by_zone.get(zid, 0.0))
        speed_mean = float(motion.get("speed_mean", 0.0))
        speed_var = float(motion.get("speed_var", 0.0))
        dir_entropy = float(motion.get("dir_entropy", 0.0))
        divergence = float(motion.get("divergence", 0.0))
        turbulence = float(motion.get("turbulence", 0.0))

        prev = prev_state.get(zid, {})
        delta_speed_mean = speed_mean - float(prev.get("speed_mean", 0.0))
        delta_dir_entropy = dir_entropy - float(prev.get("dir_entropy", 0.0))
        delta_density = density - float(prev.get("density", 0.0))

        rows.append(
            {
                "ts": int(ts_ms),
                "zoneId": zid,
                "density": density,
                "speed_mean": speed_mean,
                "speed_var": speed_var,
                "dir_entropy": dir_entropy,
                "divergence": divergence,
                "turbulence": turbulence,
                "delta_speed_mean": delta_speed_mean,
                "delta_dir_entropy": delta_dir_entropy,
                "delta_density": delta_density,
                "conf": float(conf_by_zone.get(zid, 0.6)),
                "peopleCount": int(people_count_by_zone.get(zid, 0)),
            }
        )

        next_state[zid] = {
            "density": density,
            "speed_mean": speed_mean,
            "dir_entropy": dir_entropy,
        }

    return rows, next_state


def feature_matrix(rows: List[Dict[str, float | int | str]]) -> np.ndarray:
    if not rows:
        return np.empty((0, len(FEATURE_COLUMNS)), dtype=np.float32)
    matrix = np.asarray(
        [[float(row[col]) for col in FEATURE_COLUMNS] for row in rows], dtype=np.float32
    )
    return matrix
