import type { MapData, RoutePlan } from "../../schema";
import CONFIG from "../src/config";

type GlobalMode = "normal" | "alert" | "evacuation";

export class RoutingEngine {

  constructor(private map: MapData) {}

  /* =========================================================
     Public API
  ========================================================= */

  public computeRoute(
    routingRisk: Record<string, number>,
    localDeltas: Record<string, number>,
    zoneLoadRatio: Record<string, number>,
    globalMode: GlobalMode,
    fromNodeId: string,
    toNodeId: string,
    userId: string,
    reason: RoutePlan["reason"] = "manual_request"
  ): RoutePlan {

    const adjacency = this.buildAdjacency(
      routingRisk,
      localDeltas,
      zoneLoadRatio,
      globalMode
    );

    const result = this.aStar(
      adjacency,
      fromNodeId,
      toNodeId
    );

    if (!result) {
      throw new Error("No route found");
    }

    const edgeMap = Object.fromEntries(
      this.map.graph.edges.map(e => [e.id, e])
    );

    const zonePath = result.edges.map(edgeId =>
      edgeMap[edgeId]?.routingZoneId ?? "UNKNOWN"
    );

    return {
      userId,
      ts: Date.now(),
      mapId: this.map.mapId,
      pathNodeIds: result.path,
      pathEdgeIds: result.edges,
      zonePath,
      reason,
      est: {
        distance: result.distance
      }
    };
  }

  public getExitNodes(): { id: string }[] {
    return (this.map.exits ?? []).map(id => ({ id }));
  }

  /* =========================================================
     Internal — Graph Construction
  ========================================================= */

  private buildAdjacency(
    routingRisk: Record<string, number>,
    localDeltas: Record<string, number>,
    zoneLoadRatio: Record<string, number>,
    globalMode: GlobalMode
  ) {

    const adj: Record<
      string,
      { to: string; edgeId: string; cost: number }[]
    > = {};

    const modeMultiplier =
      CONFIG.MODE_MULTIPLIER[globalMode] ?? 1;

    for (const edge of this.map.graph.edges) {

      const zoneId = edge.routingZoneId;

      const risk = routingRisk[zoneId] ?? 0;
      const delta = localDeltas[zoneId] ?? 0;
      const loadRatio = zoneLoadRatio[zoneId] ?? 1;

      const isBlocked =
        (edge.meta as any)?.isBlocking === true ||
        delta >= 9999;

      if (isBlocked) continue;

      const congestionMultiplier =
        1 + CONFIG.CONGESTION_SCALE *
        Math.max(0, loadRatio - 1);

      const baseCost =
        edge.length *
        modeMultiplier *
        congestionMultiplier;

      const riskPenalty =
        CONFIG.RISK_PENALTY_SCALE * risk;

      const cost =
        baseCost + riskPenalty + delta;

      (adj[edge.from] ??= []).push({
        to: edge.to,
        edgeId: edge.id,
        cost
      });

      if (!edge.meta?.isOneWay) {
        (adj[edge.to] ??= []).push({
          to: edge.from,
          edgeId: edge.id,
          cost
        });
      }
    }

    return adj;
  }

  /* =========================================================
     A* Search
  ========================================================= */

  private aStar(
    adj: Record<string, { to: string; edgeId: string; cost: number }[]>,
    start: string,
    goal: string
  ) {

    const open = new Set<string>([start]);

    const cameFrom:
      Record<string, { prev: string; edge: string } | undefined> = {};

    const gScore: Record<string, number> = {
      [start]: 0
    };

    const fScore: Record<string, number> = {
      [start]: this.heuristic(start, goal)
    };

    while (open.size > 0) {

      const current = this.lowestFScore(open, fScore);

      if (current === goal) {
        return this.reconstruct(cameFrom, current, gScore[current]);
      }

      open.delete(current);

      for (const neighbor of adj[current] ?? []) {

        const tentative =
          (gScore[current] ?? Infinity) + neighbor.cost;

        if (tentative < (gScore[neighbor.to] ?? Infinity)) {

          cameFrom[neighbor.to] = {
            prev: current,
            edge: neighbor.edgeId
          };

          gScore[neighbor.to] = tentative;

          fScore[neighbor.to] =
            tentative +
            this.heuristic(neighbor.to, goal);

          open.add(neighbor.to);
        }
      }
    }

    return null;
  }

  /* =========================================================
     Utilities
  ========================================================= */

  private heuristic(a: string, b: string) {

    const nodeMap = Object.fromEntries(
      this.map.graph.nodes.map(n => [n.id, n.pos])
    );

    const pa = nodeMap[a];
    const pb = nodeMap[b];

    if (!pa || !pb) return 0;

    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;

    return Math.sqrt(dx * dx + dy * dy) * 0.01;
  }

  private lowestFScore(
    open: Set<string>,
    fScore: Record<string, number>
  ) {

    let best = "";
    let bestVal = Infinity;

    for (const node of open) {
      const val = fScore[node] ?? Infinity;
      if (val < bestVal) {
        bestVal = val;
        best = node;
      }
    }

    return best;
  }

  private reconstruct(
    cameFrom:
      Record<string, { prev: string; edge: string } | undefined>,
    current: string,
    distance: number
  ) {

    const path = [current];
    const edges: string[] = [];

    let cur = current;

    while (cameFrom[cur]) {
      const step = cameFrom[cur]!;
      edges.push(step.edge);
      cur = step.prev;
      path.push(cur);
    }

    path.reverse();
    edges.reverse();

    return {
      path,
      edges,
      distance
    };
  }
}
