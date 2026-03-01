/* shared/schema.ts
 *
 * SafeFlow integration contract with TWO-LAYER ZONES:
 * - Analysis Zones (AZ*): coarse zones used by ML for stable perception on low-res CCTV
 * - Routing Zones (Z*): finer zones used for routing, UI, and targeted notifications
 *
 * Conventions:
 * - Coordinates are in the SAME coordinate space as rendered map (e.g., SVG pixels).
 * - Routing zones MUST belong to exactly one analysis zone via parentAnalysisZoneId.
 * - Graph edges reference routingZoneId (Z*), NOT analysis zone ids.
 * - Timestamps are epoch milliseconds (Date.now()).
 */

//////////////////////////////
// Common / Utility Types
//////////////////////////////

export type EpochMs = number;
export type ID = string;

export type Coord2D = { x: number; y: number };

export type Confidence = number; // 0..1
export type Severity = "info" | "warn" | "critical";
export type UserRole = "user" | "staff" | "ally" | "admin";

/** Indoor: zone-level location is acceptable */
export type ZoneLocation = {
  /** Usually a routingZoneId ("Z*"). Can also be analysisZoneId ("AZ*") for debugging. */
  zoneId: ID;
  pos?: Coord2D;
};

//////////////////////////////
// Two-Layer Zones
//////////////////////////////

/** Coarse zones used by ML perception for stability */
export type AnalysisZone = {
  id: ID; // e.g., "AZ1"
  name: string;
  polygon: Coord2D[]; // >= 3 points
  safePoints?: Coord2D[];
};

/** Fine zones used by routing + UI */
export type RoutingZone = {
  id: ID; // e.g., "Z1"
  name: string;
  polygon: Coord2D[]; // >= 3 points
  /** Required mapping to a parent analysis zone */
  parentAnalysisZoneId: ID; // e.g., "AZ1"
  safePoints?: Coord2D[];
};

export type ZoneMapping = {
  routingZoneId: ID; // "Z*"
  parentAnalysisZoneId: ID; // "AZ*"
};

//////////////////////////////
// Map / Graph
//////////////////////////////

export type GraphNode = {
  id: ID;
  pos: Coord2D;
  label?: string;
  kind?: "junction" | "exit" | "stairs" | "elevator" | "poi";
};

export type GraphEdge = {
  id: ID;
  from: ID; // nodeId
  to: ID; // nodeId
  length: number;
  /** IMPORTANT: edges map to ROUTING zones (Z*), not analysis zones */
  routingZoneId: ID; // "Z*"
  meta?: {
    width?: number;
    isAccessible?: boolean;
    isOneWay?: boolean;
  };
};

export type MapData = {
  mapId: ID; // e.g., "mall_demo_v1"
  mapImageUrl?: string;

  /** Two-layer zones */
  analysisZones: AnalysisZone[];
  routingZones: RoutingZone[];

  /** Convenience mapping table (backend can also compute from routingZones) */
  zoneMapping?: ZoneMapping[];

  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };

  exits: ID[]; // nodeIds
};

//////////////////////////////
// ML Perception Contracts (Analysis Zones ONLY)
//////////////////////////////

/**
 * ML Perception returns signals per ANALYSIS zone (AZ*).
 * Backend expands to routing zones (Z*) for routing/UI.
 */
export type ZonePerception = {
  zoneId: ID; // MUST be an AnalysisZone id, e.g. "AZ3"
  density: number; // 0..1
  anomaly: number; // 0..1
  conf?: Confidence; // 0..1
  peopleCount?: number;
};

export type PerceptionFrameResult = {
  ts: EpochMs;
  frameId?: ID;
  zones: ZonePerception[];
};

/** Suggested ML service REST */
export type MlInferFrameRequest =
  | {
      kind: "image_base64";
      ts: EpochMs;
      imageBase64: string; // "data:image/jpeg;base64,..."
    }
  | {
      kind: "video_ref";
      ts: EpochMs;
      videoId: ID;
      frameIndex: number;
    };

export type MlInferFrameResponse = PerceptionFrameResult;

//////////////////////////////
// Backend Risk Fusion Output
//////////////////////////////

/** Fused risk per ANALYSIS zone (from ML + smoothing + thresholds) */
export type AnalysisZoneRisk = {
  analysisZoneId: ID; // "AZ*"
  risk: number; // 0..1
  density?: number;
  anomaly?: number;
  trend?: number;
  severity: Severity;
  conf?: Confidence;
};

/** Expanded risk per ROUTING zone (used for guidance/routing) */
export type RoutingZoneRisk = {
  routingZoneId: ID; // "Z*"
  /** Base inherited from parent analysis zone */
  parentAnalysisZoneId: ID; // "AZ*"
  risk: number; // 0..1
  severity: Severity;
  /** Optional: local modifiers applied on top (incidents, blocked corridor) */
  localDelta?: number; // can be negative or positive
  conf?: Confidence;
};

export type RiskMap = {
  ts: EpochMs;
  mapId: ID;

  /** Always include analysis risk (debuggable, stable) */
  analysisZones: AnalysisZoneRisk[];

  /** Optionally include expanded routing risk for UI; recommended for frontends */
  routingZones?: RoutingZoneRisk[];
};

//////////////////////////////
// Users & Routing
//////////////////////////////

export type UserState = {
  userId: ID;
  role: UserRole;
  /** Usually routing zone location for the user UI */
  loc: ZoneLocation; // loc.zoneId should be "Z*"
  destinationNodeId?: ID;
  groupId?: ID;
  safety?: {
    guardianMode?: boolean;
    silentMode?: boolean;
    trustedContacts?: ID[];
  };
};

export type RoutePlan = {
  userId: ID;
  ts: EpochMs;
  mapId: ID;
  pathNodeIds: ID[];
  pathEdgeIds?: ID[];
  reason:
    | "initial"
    | "risk_reroute"
    | "hazard_reroute"
    | "destination_changed"
    | "manual_request";
  avoidedRoutingZoneIds?: ID[]; // "Z*"
  est?: { distance: number; timeSec?: number };
};

export type RouteRequest = {
  userId: ID;
  mapId: ID;
  fromNodeId?: ID;
  toNodeId: ID;
  preferAccessible?: boolean;
};

//////////////////////////////
// Incidents & Assist Workflow
//////////////////////////////

export type IncidentType =
  | "overcrowding"
  | "panic_motion"
  | "blocked_corridor"
  | "fall_detected"
  | "distress_triggered"
  | "harassment_report";

export type Incident = {
  incidentId: ID;
  ts: EpochMs;
  mapId: ID;
  type: IncidentType;
  severity: Severity;

  /** For operations + routing: use ROUTING zone where incident is located */
  loc: ZoneLocation; // loc.zoneId should be "Z*"
  description?: string;
  reporterUserId?: ID;
  conf?: Confidence;

  routingImpact?: {
    radius?: number;
    hazardPenalty?: number;
    isBlocking?: boolean;
    /**
     * Optional: explicitly list affected routing zones
     * (useful if you don't have geometry for radius)
     */
    affectedRoutingZoneIds?: ID[];
  };

  status?: "open" | "acknowledged" | "resolved";
  acknowledgedBy?: ID;
  resolvedBy?: ID;
};

export type AssistRequest = {
  requestId: ID;
  ts: EpochMs;
  mapId: ID;
  incidentId: ID;
  targetRole: "staff" | "ally";
  loc: ZoneLocation; // "Z*"
  severity: Severity;
  message: string;
  distanceEstimate?: number;
  exclusive?: boolean;
};

export type AssistResponse = {
  requestId: ID;
  ts: EpochMs;
  responderUserId: ID;
  action: "accept" | "decline";
};

//////////////////////////////
// Women-Safety Signals
//////////////////////////////

export type SafetySignalType =
  | "silent_trigger"
  | "coded_text_trigger"
  | "guardian_no_response"
  | "manual_help_request";

export type SafetySignal = {
  signalId: ID;
  ts: EpochMs;
  userId: ID;
  mapId: ID;
  type: SafetySignalType;
  loc: ZoneLocation; // "Z*"
  note?: string;
  conf?: Confidence;
};

//////////////////////////////
// WebSocket Events
//////////////////////////////

export type WsServerEvent =
  | { type: "risk_update"; payload: RiskMap }
  | { type: "incident"; payload: Incident }
  | { type: "route_update"; payload: RoutePlan }
  | { type: "assist_request"; payload: AssistRequest }
  | { type: "user_update"; payload: UserState }
  | {
      type: "system_status";
      payload: { ts: EpochMs; mlMode: "fake" | "real"; fps?: number; note?: string };
    };

export type WsClientEvent =
  | { type: "route_request"; payload: RouteRequest }
  | { type: "assist_response"; payload: AssistResponse }
  | { type: "safety_signal"; payload: SafetySignal }
  | { type: "user_presence"; payload: { userId: ID; ts: EpochMs; loc: ZoneLocation } };

//////////////////////////////
// Backend Helper Functions (optional but recommended)
//////////////////////////////

/**
 * Expand analysis-zone risks to routing-zone risks using zone mapping.
 * - analysisRiskById: Map<"AZ*", AnalysisZoneRisk>
 * - routingZones: list of routing zones with parentAnalysisZoneId
 * - localDeltasByRoutingZoneId: optional local modifiers from incidents, etc.
 */
export function expandRiskToRoutingZones(
  analysisRisks: AnalysisZoneRisk[],
  routingZones: RoutingZone[],
  localDeltasByRoutingZoneId?: Record<string, number>
): RoutingZoneRisk[] {
  const byAZ: Record<string, AnalysisZoneRisk> = Object.fromEntries(
    analysisRisks.map((r) => [r.analysisZoneId, r])
  );

  return routingZones.map((rz) => {
    const parent = byAZ[rz.parentAnalysisZoneId];
    const baseRisk = parent?.risk ?? 0;
    const delta = localDeltasByRoutingZoneId?.[rz.id] ?? 0;
    const risk = clamp01(baseRisk + delta);

    const severity: Severity =
      risk >= 0.8 ? "critical" : risk >= 0.5 ? "warn" : "info";

    return {
      routingZoneId: rz.id,
      parentAnalysisZoneId: rz.parentAnalysisZoneId,
      risk,
      severity,
      localDelta: delta || undefined,
      conf: parent?.conf,
    };
  });
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

//////////////////////////////
// Example Payloads (for testing)
//////////////////////////////

export const EXAMPLE_RISK_UPDATE: WsServerEvent = {
  type: "risk_update",
  payload: {
    ts: Date.now(),
    mapId: "mall_demo_v1",
    analysisZones: [
      { analysisZoneId: "AZ1", risk: 0.12, density: 0.2, anomaly: 0.05, severity: "info" },
      { analysisZoneId: "AZ2", risk: 0.86, density: 0.92, anomaly: 0.55, severity: "critical" },
    ],
    routingZones: [
      { routingZoneId: "Z1", parentAnalysisZoneId: "AZ1", risk: 0.12, severity: "info" },
      { routingZoneId: "Z7", parentAnalysisZoneId: "AZ2", risk: 0.86, severity: "critical" },
    ],
  },
};

export const EXAMPLE_INCIDENT_FALL: WsServerEvent = {
  type: "incident",
  payload: {
    incidentId: "INC_001",
    ts: Date.now(),
    mapId: "mall_demo_v1",
    type: "fall_detected",
    severity: "warn",
    loc: { zoneId: "Z4", pos: { x: 512, y: 310 } },
    conf: 0.85,
    routingImpact: { radius: 40, hazardPenalty: 30, isBlocking: false },
    status: "open",
  },
};

export const EXAMPLE_ROUTE_UPDATE: WsServerEvent = {
  type: "route_update",
  payload: {
    userId: "U_42",
    ts: Date.now(),
    mapId: "mall_demo_v1",
    pathNodeIds: ["N1", "N5", "N9", "N12", "EXIT_A"],
    reason: "risk_reroute",
    avoidedRoutingZoneIds: ["Z7"],
    est: { distance: 220, timeSec: 180 },
  },
};

export const EXAMPLE_ASSIST_REQUEST: WsServerEvent = {
  type: "assist_request",
  payload: {
    requestId: "AR_001",
    ts: Date.now(),
    mapId: "mall_demo_v1",
    incidentId: "INC_001",
    targetRole: "staff",
    loc: { zoneId: "Z4" },
    severity: "warn",
    message: "Possible fall detected nearby (Zone Z4). Tap to assist.",
    distanceEstimate: 28,
    exclusive: true,
  },
};
