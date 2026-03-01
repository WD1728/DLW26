export type DecisionReason =
  | "ROUTE_ENTERING_HIGH_RISK"
  | "ROUTE_BLOCKED_BY_INCIDENT"
  | "GLOBAL_MODE_ESCALATION"
  | "CONGESTION_OVER_CAPACITY"
  | "BETTER_EXIT_AVAILABLE"
  | "USER_OFF_ROUTE"
  | "DESTINATION_CHANGED"
  | "PERIODIC_REFRESH";

export interface RouteAssessment {
  hasIncidentBlock: boolean;
  entersHighRiskSoon: boolean;
  congestionViolationSoon: boolean;
  violatingZones: string[];
  maxRisk: number;
}

export type DecisionAction =
  | { type: "NOOP" }
  | { type: "GUIDE_ONLY"; reason: DecisionReason }
  | { type: "REROUTE"; reason: DecisionReason };