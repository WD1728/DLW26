import { DecisionAction, DecisionReason, RouteAssessment } from "./types";

export class AutoReroutePolicy {
  decide(
    assessment: RouteAssessment,
    globalMode: string,
    lastRerouteAt: number
  ): DecisionAction {
    const now = Date.now();

    // stability guard
    if (now - lastRerouteAt < 3000) {
      return { type: "NOOP" };
    }

    if (assessment.hasIncidentBlock) {
      return { type: "REROUTE", reason: "ROUTE_BLOCKED_BY_INCIDENT" };
    }

    if (globalMode === "evacuation") {
      return { type: "REROUTE", reason: "GLOBAL_MODE_ESCALATION" };
    }

    if (assessment.entersHighRiskSoon) {
      return { type: "REROUTE", reason: "ROUTE_ENTERING_HIGH_RISK" };
    }

    if (assessment.congestionViolationSoon) {
      return { type: "REROUTE", reason: "CONGESTION_OVER_CAPACITY" };
    }

    return { type: "NOOP" };
  }
}