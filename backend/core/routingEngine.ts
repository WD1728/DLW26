import { MapData, RoutePlan } from "@schema";
import CONFIG from "../src/config";

/**
 * Compute route using A*
 */
export function computeRoute(
  map: MapData,
  routingRisk: Record<string, number>,
  localDeltas: Record<string, number>,
  fromNodeId: string,
  toNodeId: string,
  userId: string
): RoutePlan {

  const adjacency = buildAdjacency(map, routingRisk, localDeltas);

  const result = aStar(
    adjacency,
    map,
    fromNodeId,
    toNodeId
  );

  if (!result) {
    throw new Error("No route found");
  }

  const avoidedRoutingZoneIds = Object.entries(routingRisk)
    .filter(([_, r]) => r >= 0.8)
    .map(([z]) => z);

  return {
    userId,
    ts: Date.now(),
    mapId: map.mapId,
    pathNodeIds: result.path,
    pathEdgeIds: result.edges,
    reason: "manual_request",
    avoidedRoutingZoneIds: avoidedRoutingZoneIds.length
      ? avoidedRoutingZoneIds
      : undefined,
    est: {
      distance: result.distance
    }
  };
}

/**
 * Build adjacency list with risk-aware edge cost
 */
function buildAdjacency(
  map: MapData,
  routingRisk: Record<string, number>,
  localDeltas: Record<string, number>
) {
  const adj: Record<
    string,
    { to: string; edgeId: string; cost: number }[]
  > = {};

  for (const edge of map.graph.edges) {

    const risk = routingRisk[edge.routingZoneId] ?? 0;
    const delta = localDeltas[edge.routingZoneId] ?? 0;

    const isBlocked =
      (edge.meta as any)?.isBlocking === true ||
      delta >= 9999;

    if (isBlocked) continue;

    const cost =
      edge.length +
      CONFIG.RISK_PENALTY_SCALE * risk +
      delta;

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

/**
 * A* implementation
 */
function aStar(
  adj: Record<string, { to: string; edgeId: string; cost: number }[]>,
  map: MapData,
  start: string,
  goal: string
) {

  const open = new Set<string>([start]);
  const cameFrom: Record<string, { prev: string; edge: string } | undefined> = {};

  const gScore: Record<string, number> = { [start]: 0 };
  const fScore: Record<string, number> = {
    [start]: heuristic(map, start, goal)
  };

  while (open.size > 0) {

    const current = lowestFScore(open, fScore);

    if (current === goal) {
      return reconstructPath(cameFrom, current, gScore[current]);
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
          tentative + heuristic(map, neighbor.to, goal);

        open.add(neighbor.to);
      }
    }
  }

  return null;
}

/**
 * Straight-line heuristic
 */
function heuristic(
  map: MapData,
  a: string,
  b: string
) {
  const nodes = Object.fromEntries(
    map.graph.nodes.map(n => [n.id, n.pos])
  );

  const pa = nodes[a];
  const pb = nodes[b];

  if (!pa || !pb) return 0;

  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;

  return Math.sqrt(dx * dx + dy * dy) * 0.01;
}

/**
 * Select node with lowest fScore
 */
function lowestFScore(
  open: Set<string>,
  fScore: Record<string, number>
) {
  let best = "";
  let bestVal = Infinity;

  for (const n of open) {
    const val = fScore[n] ?? Infinity;
    if (val < bestVal) {
      bestVal = val;
      best = n;
    }
  }

  return best;
}

/**
 * Reconstruct final path
 */
function reconstructPath(
  cameFrom: Record<string, { prev: string; edge: string } | undefined>,
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