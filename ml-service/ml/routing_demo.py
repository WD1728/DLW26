from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .anomaly import clamp01
from .zones import AnalysisZone


@dataclass(frozen=True)
class ZoneGraph:
    centroids: Dict[str, Tuple[float, float]]
    neighbors: Dict[str, List[str]]
    base_edge_cost: Dict[Tuple[str, str], float]


def zone_centroid(zone: AnalysisZone) -> Tuple[float, float]:
    pts = zone.polygon.astype(float)
    return float(pts[:, 0].mean()), float(pts[:, 1].mean())


def _bbox(zone: AnalysisZone) -> Tuple[int, int, int, int]:
    pts = zone.polygon
    x0 = int(pts[:, 0].min())
    x1 = int(pts[:, 0].max())
    y0 = int(pts[:, 1].min())
    y1 = int(pts[:, 1].max())
    return x0, y0, x1, y1


def _overlap_1d(a0: int, a1: int, b0: int, b1: int) -> int:
    return max(0, min(a1, b1) - max(a0, b0))


def build_zone_graph(zones: List[AnalysisZone], touch_tol: int = 0) -> ZoneGraph:
    """
    Build a simple adjacency graph from analysis zones by "touching bbox edge" heuristic.
    Works well for grid-like zone layouts (like zones_analysis.json).
    """
    centroids: Dict[str, Tuple[float, float]] = {z.zone_id: zone_centroid(z) for z in zones}
    bboxes: Dict[str, Tuple[int, int, int, int]] = {z.zone_id: _bbox(z) for z in zones}

    neighbors: Dict[str, List[str]] = {z.zone_id: [] for z in zones}

    zone_ids = [z.zone_id for z in zones]
    for i, a in enumerate(zone_ids):
        ax0, ay0, ax1, ay1 = bboxes[a]
        for j in range(i + 1, len(zone_ids)):
            b = zone_ids[j]
            bx0, by0, bx1, by1 = bboxes[b]

            # vertical touch (a right edge to b left edge, or vice versa)
            touch_v = abs(ax1 - bx0) <= touch_tol or abs(bx1 - ax0) <= touch_tol
            ov_y = _overlap_1d(ay0, ay1, by0, by1)

            # horizontal touch (a bottom edge to b top edge, or vice versa)
            touch_h = abs(ay1 - by0) <= touch_tol or abs(by1 - ay0) <= touch_tol
            ov_x = _overlap_1d(ax0, ax1, bx0, bx1)

            adjacent = (touch_v and ov_y > 0) or (touch_h and ov_x > 0)
            if not adjacent:
                continue

            neighbors[a].append(b)
            neighbors[b].append(a)

    base_edge_cost: Dict[Tuple[str, str], float] = {}
    for a, ns in neighbors.items():
        ax, ay = centroids[a]
        for b in ns:
            bx, by = centroids[b]
            base = math.hypot(ax - bx, ay - by)
            if base <= 0:
                base = 1.0
            base_edge_cost[(a, b)] = float(base)

    return ZoneGraph(centroids=centroids, neighbors=neighbors, base_edge_cost=base_edge_cost)


def _dijkstra(
    graph: ZoneGraph,
    start: str,
    goal: str,
    cost_fn,
) -> Optional[List[str]]:
    if start not in graph.neighbors or goal not in graph.neighbors:
        return None

    pq: List[Tuple[float, str]] = [(0.0, start)]
    dist: Dict[str, float] = {start: 0.0}
    prev: Dict[str, str] = {}

    while pq:
        d, u = heapq.heappop(pq)
        if u == goal:
            break
        if d != dist.get(u, float("inf")):
            continue

        for v in graph.neighbors.get(u, []):
            nd = d + float(cost_fn(u, v))
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))

    if goal not in dist:
        return None

    # reconstruct
    path = [goal]
    cur = goal
    while cur != start:
        cur = prev.get(cur)
        if cur is None:
            return None
        path.append(cur)
    path.reverse()
    return path


def find_low_risk_path(
    *,
    graph: ZoneGraph,
    start_zone_id: str,
    goal_zone_id: str,
    risk_by_zone: Dict[str, float],
    density_by_zone: Dict[str, float] | None = None,
    risk_weight: float = 3.0,
    density_weight: float = 1.5,
    block_threshold: float = 0.92,
    block_penalty: float = 1000.0,
) -> List[str]:
    """
    Compute a path over zones that minimizes:
      base_edge_cost * (1 + risk_weight*avg_risk + density_weight*avg_density)

    Zones with risk >= block_threshold are treated as quasi-blocked via a large penalty.
    """
    density_by_zone = density_by_zone or {}

    def edge_cost(u: str, v: str) -> float:
        base = float(graph.base_edge_cost.get((u, v), 1.0))
        ru = float(clamp01(float(risk_by_zone.get(u, 0.0))))
        rv = float(clamp01(float(risk_by_zone.get(v, 0.0))))
        du = float(clamp01(float(density_by_zone.get(u, 0.0))))
        dv = float(clamp01(float(density_by_zone.get(v, 0.0))))

        avg_r = 0.5 * (ru + rv)
        avg_d = 0.5 * (du + dv)
        cost = base * (1.0 + float(risk_weight) * avg_r + float(density_weight) * avg_d)

        if rv >= float(block_threshold):
            cost += float(block_penalty) * base
        return float(cost)

    path = _dijkstra(graph, start_zone_id, goal_zone_id, edge_cost)
    return path or []

