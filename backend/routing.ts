/**
 * routing.ts — A* Routing + Least-Routes Evacuation Planner
 *
 * This module does two things:
 *
 * 1. A* ROUTING: Find shortest safe path between any two nodes on the graph,
 *    with edge costs dynamically adjusted by zone risk.
 *
 * 2. EVACUATION PLANNER: Given a stampede alert, compute the LEAST number of
 *    routes needed to evacuate all affected groups to their nearest safe exits.
 *
 *    "Least routes" means:
 *    - Group people by the zone they're in (people in same zone = same group)
 *    - Each group gets ONE route to the nearest reachable exit
 *    - Dangerous zones are avoided (high risk = high edge cost or blocked)
 *    - If two groups share the same best exit AND same path, merge them
 *    - Result: minimum distinct routes that cover everyone
 *
 * INPUT:  Graph (from graph.json) + RiskMap (from risk.ts) + StampedeAlerts
 * OUTPUT: EvacuationPlan with the minimal set of routes
 */

import type { RiskMap, RoutingZoneRisk, ID, EpochMs, Severity } from "./risk";

// ─── Graph types (from graph.json / schema) ───

interface Coord2D {
  x: number;
  y: number;
}

interface GraphNode {
  id: ID;
  pos: Coord2D;
  label?: string;
  kind?: "junction" | "exit" | "stairs" | "elevator" | "poi";
}

interface GraphEdge {
  id: ID;
  from: ID;
  to: ID;
  length: number;
  routingZoneId: ID;
}

interface MapGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Route output types (matching schema) ───

interface RoutePlan {
  userId: ID; // for evacuation: "GROUP_Z1", "GROUP_Z2", etc.
  ts: EpochMs;
  mapId: ID;
  pathNodeIds: ID[];
  pathEdgeIds: ID[];
  reason: "risk_reroute" | "hazard_reroute";
  avoidedRoutingZoneIds: ID[];
  est: { distance: number; timeSec?: number };
}

/** Evacuation plan = the minimal set of routes */
export interface EvacuationPlan {
  ts: EpochMs;
  mapId: ID;
  /** The danger zones that triggered this evacuation */
  dangerZoneIds: ID[];
  /** The minimal set of distinct evacuation routes */
  routes: EvacuationRoute[];
  /** Total number of groups covered */
  groupsCovered: number;
  /** Summary message for staff dashboard */
  summary: string;
}

/** One evacuation route for a group of people */
export interface EvacuationRoute {
  /** Which routing zone(s) this route serves */
  fromRoutingZoneIds: ID[];
  /** Starting node (junction in/near the zone) */
  fromNodeId: ID;
  /** Destination exit node */
  toExitId: ID;
  /** Ordered path of node IDs */
  pathNodeIds: ID[];
  /** Ordered path of edge IDs */
  pathEdgeIds: ID[];
  /** Total cost (distance + risk penalty) */
  totalCost: number;
  /** Raw distance (without risk penalty) */
  distance: number;
  /** Which dangerous zones are avoided */
  avoidedZoneIds: ID[];
  /** Human-readable instruction */
  instruction: string;
}

// ─── Configuration ───

export interface RoutingConfig {
  /** How much zone risk multiplies edge cost. Higher = more avoidance */
  riskPenaltyMultiplier: number;
  /** Risk threshold above which edges are considered BLOCKED (not just expensive) */
  blockingRiskThreshold: number;
  /** Walking speed estimate in map units per second (for time estimates) */
  walkingSpeed: number;
  mapId: string;
}

const DEFAULT_CONFIG: RoutingConfig = {
  riskPenaltyMultiplier: 500, // a zone at risk=1.0 adds 500 to edge cost
  blockingRiskThreshold: 0.90, // risk >= 0.90 = completely blocked
  walkingSpeed: 30, // ~30 map units per second (~1.2 m/s walking)
  mapId: "mall_demo_v1",
};

// ─── A* Implementation ───

/** Internal: adjacency list entry */
interface AdjEntry {
  neighborId: ID;
  edgeId: ID;
  baseCost: number;
  routingZoneId: ID;
}

/** Priority queue node for A* */
interface PQNode {
  nodeId: ID;
  fScore: number;
}

export class EvacuationRouter {
  private config: RoutingConfig;
  private nodes: Map<ID, GraphNode> = new Map();
  private adjacency: Map<ID, AdjEntry[]> = new Map();
  private exitNodeIds: ID[] = [];
  /** Maps routing zone → list of junction node IDs inside/near it */
  private zoneToNodes: Map<ID, ID[]> = new Map();

  constructor(config?: Partial<RoutingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load the graph. Call once at startup.
   */
  loadGraph(graph: MapGraph, exitNodeIds: ID[]): void {
    this.nodes.clear();
    this.adjacency.clear();

    for (const node of graph.nodes) {
      this.nodes.set(node.id, node);
      this.adjacency.set(node.id, []);
    }

    // Build bidirectional adjacency list
    for (const edge of graph.edges) {
      this.adjacency.get(edge.from)?.push({
        neighborId: edge.to,
        edgeId: edge.id,
        baseCost: edge.length,
        routingZoneId: edge.routingZoneId,
      });
      this.adjacency.get(edge.to)?.push({
        neighborId: edge.from,
        edgeId: edge.id,
        baseCost: edge.length,
        routingZoneId: edge.routingZoneId,
      });
    }

    this.exitNodeIds = exitNodeIds;

    // Map routing zones → nearby junction nodes
    this.zoneToNodes.clear();
    for (const edge of graph.edges) {
      const zId = edge.routingZoneId;
      if (!this.zoneToNodes.has(zId)) {
        this.zoneToNodes.set(zId, []);
      }
      const list = this.zoneToNodes.get(zId)!;
      if (!list.includes(edge.from)) list.push(edge.from);
      if (!list.includes(edge.to)) list.push(edge.to);
    }
  }

  /**
   * MAIN FUNCTION: Given a risk map and list of danger zones,
   * compute the LEAST number of evacuation routes.
   *
   * Algorithm:
   * 1. For each populated non-danger routing zone, find the nearest safe exit via A*
   * 2. Group zones that share the same exit AND same path → merge into one route
   * 3. Return the minimal set of distinct routes
   */
  computeEvacuationPlan(
    riskMap: RiskMap,
    dangerAnalysisZoneIds: ID[],
    populatedRoutingZoneIds?: ID[]
  ): EvacuationPlan {
    const ts = Date.now();

    // Build risk lookup: routingZoneId → risk value
    const riskByZone = new Map<ID, number>();
    const dangerRoutingZones = new Set<ID>();

    for (const rzr of riskMap.routingZones ?? []) {
      riskByZone.set(rzr.routingZoneId, rzr.risk);
    }

    // Mark danger routing zones (children of danger analysis zones)
    for (const rzr of riskMap.routingZones ?? []) {
      if (dangerAnalysisZoneIds.includes(rzr.parentAnalysisZoneId)) {
        dangerRoutingZones.add(rzr.routingZoneId);
      }
    }

    // Which zones have people that need evacuating?
    // If populatedRoutingZoneIds not provided, assume ALL non-exit zones
    const zonesToEvacuate = populatedRoutingZoneIds
      ?? Array.from(this.zoneToNodes.keys());

    // For each zone, compute the best route to nearest safe exit
    const rawRoutes: {
      zoneId: ID;
      fromNodeId: ID;
      toExitId: ID;
      path: ID[];
      edges: ID[];
      cost: number;
      distance: number;
    }[] = [];

    for (const zoneId of zonesToEvacuate) {
      const nodesInZone = this.zoneToNodes.get(zoneId);
      if (!nodesInZone || nodesInZone.length === 0) continue;

      // Pick the best starting node in this zone (try each, keep best result)
      let bestResult: {
        fromNodeId: ID;
        toExitId: ID;
        path: ID[];
        edges: ID[];
        cost: number;
        distance: number;
      } | null = null;

      for (const startNodeId of nodesInZone) {
        // Skip if start node is itself an exit
        if (this.exitNodeIds.includes(startNodeId)) continue;

        // Try each exit, find the cheapest
        for (const exitId of this.exitNodeIds) {
          const result = this.astar(startNodeId, exitId, riskByZone);
          if (!result) continue;

          if (!bestResult || result.cost < bestResult.cost) {
            bestResult = {
              fromNodeId: startNodeId,
              toExitId: exitId,
              path: result.path,
              edges: result.edges,
              cost: result.cost,
              distance: result.distance,
            };
          }
        }
      }

      if (bestResult) {
        rawRoutes.push({ zoneId, ...bestResult });
      }
    }

    // ── DEDUPLICATE: merge zones that share the same path ──
    // Key = "pathNodeIds joined" → merge zones
    const routeGroups = new Map<
      string,
      {
        zoneIds: ID[];
        fromNodeId: ID;
        toExitId: ID;
        path: ID[];
        edges: ID[];
        cost: number;
        distance: number;
      }
    >();

    for (const r of rawRoutes) {
      const pathKey = r.path.join("→");
      const existing = routeGroups.get(pathKey);
      if (existing) {
        if (!existing.zoneIds.includes(r.zoneId)) {
          existing.zoneIds.push(r.zoneId);
        }
      } else {
        routeGroups.set(pathKey, {
          zoneIds: [r.zoneId],
          fromNodeId: r.fromNodeId,
          toExitId: r.toExitId,
          path: r.path,
          edges: r.edges,
          cost: r.cost,
          distance: r.distance,
        });
      }
    }

    // Build the final evacuation routes
    const dangerZoneIdsList = Array.from(dangerRoutingZones);
    const routes: EvacuationRoute[] = [];

    for (const [, group] of routeGroups) {
      const exitNode = this.nodes.get(group.toExitId);
      const exitLabel = exitNode?.label ?? group.toExitId;

      routes.push({
        fromRoutingZoneIds: group.zoneIds,
        fromNodeId: group.fromNodeId,
        toExitId: group.toExitId,
        pathNodeIds: group.path,
        pathEdgeIds: group.edges,
        totalCost: Math.round(group.cost),
        distance: Math.round(group.distance),
        avoidedZoneIds: dangerZoneIdsList,
        instruction: `Evacuate zones [${group.zoneIds.join(", ")}] → ${exitLabel}. ` +
          `Path: ${group.path.join(" → ")} (${Math.round(group.distance)} units, ` +
          `~${Math.ceil(group.distance / this.config.walkingSpeed)}s walk)`,
      });
    }

    // Sort: most zones covered first (most impactful routes first)
    routes.sort((a, b) => b.fromRoutingZoneIds.length - a.fromRoutingZoneIds.length);

    const summary =
      `Evacuation plan: ${routes.length} routes covering ${zonesToEvacuate.length} zones. ` +
      `Avoiding danger zones: [${dangerZoneIdsList.join(", ")}]. ` +
      `Exits used: [${[...new Set(routes.map((r) => r.toExitId))].join(", ")}].`;

    return {
      ts,
      mapId: this.config.mapId,
      dangerZoneIds: dangerZoneIdsList,
      routes,
      groupsCovered: zonesToEvacuate.length,
      summary,
    };
  }

  /**
   * Convert an EvacuationRoute to a schema-compatible RoutePlan.
   * Useful for sending over WebSocket as a route_update.
   */
  toRoutePlan(route: EvacuationRoute, groupLabel?: string): RoutePlan {
    return {
      userId: groupLabel ?? `GROUP_${route.fromRoutingZoneIds.join("_")}`,
      ts: Date.now(),
      mapId: this.config.mapId,
      pathNodeIds: route.pathNodeIds,
      pathEdgeIds: route.pathEdgeIds,
      reason: "risk_reroute",
      avoidedRoutingZoneIds: route.avoidedZoneIds,
      est: {
        distance: route.distance,
        timeSec: Math.ceil(route.distance / this.config.walkingSpeed),
      },
    };
  }

  // ─── A* core ───

  /**
   * A* pathfinding with risk-adjusted edge costs.
   *
   * Edge cost = baseCost + riskPenaltyMultiplier * zoneRisk
   * If zoneRisk >= blockingThreshold, edge is BLOCKED (not traversable).
   */
  private astar(
    startId: ID,
    goalId: ID,
    riskByZone: Map<ID, number>
  ): { path: ID[]; edges: ID[]; cost: number; distance: number } | null {
    const startNode = this.nodes.get(startId);
    const goalNode = this.nodes.get(goalId);
    if (!startNode || !goalNode) return null;

    // g[node] = cost from start to node
    const gScore = new Map<ID, number>();
    gScore.set(startId, 0);

    // f[node] = g[node] + heuristic(node, goal)
    const fScore = new Map<ID, number>();
    fScore.set(startId, this.heuristic(startNode, goalNode));

    // Track path: cameFrom[node] = { prevNode, edgeId, edgeCost, edgeDistance }
    const cameFrom = new Map<
      ID,
      { prevId: ID; edgeId: ID; edgeCost: number; edgeDistance: number }
    >();

    // Simple priority queue (array sorted by fScore — fine for small graphs)
    const openSet: PQNode[] = [{ nodeId: startId, fScore: fScore.get(startId)! }];
    const closedSet = new Set<ID>();

    while (openSet.length > 0) {
      // Get node with lowest fScore
      openSet.sort((a, b) => a.fScore - b.fScore);
      const current = openSet.shift()!;

      if (current.nodeId === goalId) {
        // Reconstruct path
        return this.reconstructPath(startId, goalId, cameFrom);
      }

      closedSet.add(current.nodeId);

      const neighbors = this.adjacency.get(current.nodeId) ?? [];
      for (const adj of neighbors) {
        if (closedSet.has(adj.neighborId)) continue;

        // Calculate risk-adjusted edge cost
        const zoneRisk = riskByZone.get(adj.routingZoneId) ?? 0;

        // Block edge if zone risk is too high
        if (zoneRisk >= this.config.blockingRiskThreshold) continue;

        const edgeCost =
          adj.baseCost + this.config.riskPenaltyMultiplier * zoneRisk;

        const tentativeG = (gScore.get(current.nodeId) ?? Infinity) + edgeCost;

        if (tentativeG < (gScore.get(adj.neighborId) ?? Infinity)) {
          gScore.set(adj.neighborId, tentativeG);
          cameFrom.set(adj.neighborId, {
            prevId: current.nodeId,
            edgeId: adj.edgeId,
            edgeCost,
            edgeDistance: adj.baseCost,
          });

          const neighborNode = this.nodes.get(adj.neighborId);
          const h = neighborNode ? this.heuristic(neighborNode, goalNode) : 0;
          const f = tentativeG + h;
          fScore.set(adj.neighborId, f);

          // Add to open set if not already there
          if (!openSet.find((n) => n.nodeId === adj.neighborId)) {
            openSet.push({ nodeId: adj.neighborId, fScore: f });
          }
        }
      }
    }

    // No path found
    return null;
  }

  /**
   * Euclidean distance heuristic for A*.
   */
  private heuristic(a: GraphNode, b: GraphNode): number {
    const dx = a.pos.x - b.pos.x;
    const dy = a.pos.y - b.pos.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Reconstruct the path from A* results.
   */
  private reconstructPath(
    startId: ID,
    goalId: ID,
    cameFrom: Map<ID, { prevId: ID; edgeId: ID; edgeCost: number; edgeDistance: number }>
  ): { path: ID[]; edges: ID[]; cost: number; distance: number } {
    const path: ID[] = [goalId];
    const edges: ID[] = [];
    let totalCost = 0;
    let totalDistance = 0;
    let current = goalId;

    while (current !== startId) {
      const prev = cameFrom.get(current);
      if (!prev) break; // shouldn't happen if A* succeeded
      path.unshift(prev.prevId);
      edges.unshift(prev.edgeId);
      totalCost += prev.edgeCost;
      totalDistance += prev.edgeDistance;
      current = prev.prevId;
    }

    return { path, edges, cost: totalCost, distance: totalDistance };
  }
}

export type { RoutePlan, GraphNode, GraphEdge, MapGraph };
