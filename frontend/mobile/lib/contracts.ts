export type Severity = "info" | "warn" | "critical";
export type GlobalMode = "normal" | "alert" | "evacuation";
export type NavigationState =
  | "idle"
  | "navigating"
  | "rerouting"
  | "blocked"
  | "evacuation_override";

export type SafetySignalType =
  | "silent_trigger"
  | "coded_text_trigger"
  | "guardian_no_response"
  | "manual_help_request";

export type ZoneLocation = {
  zoneId: string;
  pos?: { x: number; y: number };
};

export type ZonePerception = {
  zoneId: string;
  density: number;
  anomaly: number;
  conf?: number;
};

export type PerceptionFrameResult = {
  ts: number;
  frameId?: string;
  zones: ZonePerception[];
};

export type AnalysisZoneRisk = {
  analysisZoneId: string;
  risk: number;
  density?: number;
  anomaly?: number;
  severity: Severity;
  conf?: number;
};

export type RoutingZoneRisk = {
  routingZoneId: string;
  parentAnalysisZoneId: string;
  risk: number;
  severity: Severity;
  localDelta?: number;
  conf?: number;
};

export type RiskMap = {
  ts: number;
  mapId: string;
  analysisZones: AnalysisZoneRisk[];
  routingZones?: RoutingZoneRisk[];
};

export type IncidentType =
  | "overcrowding"
  | "panic_motion"
  | "blocked_corridor"
  | "fall_detected"
  | "distress_triggered"
  | "harassment_report";

export type Incident = {
  incidentId: string;
  ts: number;
  mapId: string;
  type: IncidentType;
  severity: Severity;
  loc: ZoneLocation;
  conf?: number;
  routingImpact?: {
    radius?: number;
    hazardPenalty?: number;
    isBlocking?: boolean;
    affectedRoutingZoneIds?: string[];
  };
  status?: "open" | "acknowledged" | "resolved";
};

export type RoutePlan = {
  userId: string;
  ts: number;
  mapId: string;
  pathNodeIds: string[];
  pathEdgeIds?: string[];
  reason:
    | "initial"
    | "risk_reroute"
    | "hazard_reroute"
    | "destination_changed"
    | "manual_request";
  avoidedRoutingZoneIds?: string[];
  est?: { distance: number; timeSec?: number };
};

export type AssistRequest = {
  requestId: string;
  ts: number;
  mapId: string;
  incidentId: string;
  targetRole: "staff" | "ally";
  loc: ZoneLocation;
  severity: Severity;
  message: string;
  distanceEstimate?: number;
  exclusive?: boolean;
};

export type SafetySignal = {
  signalId: string;
  ts: number;
  userId: string;
  mapId: string;
  type: SafetySignalType;
  loc: ZoneLocation;
  note?: string;
};

export type WsServerEvent =
  | { type: "risk_update"; payload: RiskMap }
  | { type: "incident"; payload: Incident }
  | { type: "route_update"; payload: RoutePlan }
  | { type: "assist_request"; payload: AssistRequest }
  | {
      type: "guidance";
      payload: {
        title: string;
        message: string;
        severity: "info" | "medium" | "high" | "critical";
      };
    }
  | {
      type: "system_status";
      payload: {
        ts: number;
        mlMode: "fake" | "real";
        fps?: number;
        note?: string;
      };
    };

export type WsClientEvent = { type: "safety_signal"; payload: SafetySignal };
