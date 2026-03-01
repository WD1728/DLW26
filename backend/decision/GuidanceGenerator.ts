import { DecisionReason } from "./types";

export class GuidanceGenerator {
  generate(reason: DecisionReason, target?: string) {
    switch (reason) {
      case "ROUTE_BLOCKED_BY_INCIDENT":
        return {
          title: "Route Blocked",
          message: "An incident was detected ahead. You are being redirected.",
          severity: "critical",
        };

      case "GLOBAL_MODE_ESCALATION":
        return {
          title: "Evacuation Mode",
          message: `Please proceed immediately to Exit ${target}.`,
          severity: "critical",
        };

      case "ROUTE_ENTERING_HIGH_RISK":
        return {
          title: "High Risk Ahead",
          message: "High crowd density detected ahead. Route adjusted.",
          severity: "high",
        };

      case "CONGESTION_OVER_CAPACITY":
        return {
          title: "Congestion Detected",
          message: "Heavy congestion ahead. Alternative path selected.",
          severity: "medium",
        };

      default:
        return {
          title: "Route Update",
          message: "Your route has been updated.",
          severity: "info",
        };
    }
  }
}