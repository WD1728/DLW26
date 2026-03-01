import type {
  Incident,
  PerceptionFrameResult,
  RiskMap,
  RoutePlan,
} from "../../../schema";

export const HTTP_ENDPOINTS = {
  health: "/health",
  route: "/route",
  mode: "/mode",
  perception: "/perception",
  incident: "/incident",
  mockRisk: "/mock-risk",
  mockIncident: "/mock-incident",
} as const;

export type GlobalMode = "normal" | "alert" | "evacuation";

export type HealthResponse = {
  status: "ok";
};

export type RouteRequest = {
  userId: string;
  currentNodeId: string;
  destinationNodeId: string;
};

export type LegacyRouteRequest = {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
};

export type RouteResponse = RoutePlan;

export type ModeRequest = {
  mode: GlobalMode;
};

export type MockRiskRequest = {
  zoneId: string;
  risk: number;
};

export type IncidentRequest = Incident;
export type PerceptionRequest = PerceptionFrameResult;

export const SOCKET_EVENTS = {
  register: "register",
  locationUpdate: "location_update",
  routeUpdate: "route_update",
  guidance: "guidance",
  riskUpdate: "risk_update",
  incident: "incident",
} as const;

export type SocketRegisterPayload = {
  userId: string;
};

export type SocketLocationUpdatePayload = {
  userId: string;
  currentNodeId: string;
  destinationNodeId?: string;
};

export type SocketRouteUpdatePayload = RoutePlan;

export type SocketGuidancePayload = {
  title: string;
  message: string;
  severity: "info" | "medium" | "high" | "critical";
};

export type SocketRiskUpdatePayload = RiskMap;
export type SocketIncidentPayload = Incident;

export function toRouteRequest(
  request: RouteRequest | LegacyRouteRequest
): RouteRequest {
  if ("currentNodeId" in request) {
    return request;
  }

  return {
    userId: request.userId,
    currentNodeId: request.fromNodeId,
    destinationNodeId: request.toNodeId,
  };
}

