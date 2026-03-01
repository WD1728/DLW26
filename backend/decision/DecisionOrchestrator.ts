import { RouteEvaluator } from "./RouteEvaluator";
import { AutoReroutePolicy } from "./AutoReroutePolicy";
import { ExitSelector } from "./ExitSelector";
import { GuidanceGenerator } from "./GuidanceGenerator";
import type { RoutePlan } from "../../schema";

type ComputeRoute = (input: {
  fromNodeId: string;
  toNodeId: string;
  userId: string;
  reason: RoutePlan["reason"];
}) => RoutePlan;

export class DecisionOrchestrator {
  constructor(
    private evaluator: RouteEvaluator,
    private policy: AutoReroutePolicy,
    private exitSelector: ExitSelector,
    private computeRoute: ComputeRoute,
    private publisher: { emitRouteUpdate: (userId: string, route: RoutePlan) => void; emitGuidance: (userId: string, guidance: any) => void },
    private getGlobalMode: () => string
  ) {}

  evaluateUser(user: any) {
    if (!user.activeRoute) return;

    const assessment = this.evaluator.evaluate(user.activeRoute.zonePath);

    const action = this.policy.decide(
      assessment,
      this.getGlobalMode(),
      user.lastRerouteAt || 0
    );

    if (action.type === "NOOP") return;

    let target = user.destinationNodeId;

    if (this.getGlobalMode() === "evacuation") {
      target = this.exitSelector.selectBestExit(user.currentNodeId);
    }

    if (!target) return;

    const reason: RoutePlan["reason"] =
      action.reason === "ROUTE_BLOCKED_BY_INCIDENT"
        ? "hazard_reroute"
        : action.reason === "ROUTE_ENTERING_HIGH_RISK" || action.reason === "CONGESTION_OVER_CAPACITY"
          ? "risk_reroute"
          : "destination_changed";

    const newRoute = this.computeRoute({
      fromNodeId: user.currentNodeId,
      toNodeId: target,
      userId: user.userId,
      reason,
    });

    user.activeRoute = newRoute;
    user.lastRerouteAt = Date.now();

    const guidance = new GuidanceGenerator().generate(
      action.reason,
      target
    );

    this.publisher.emitRouteUpdate(user.userId, newRoute);
    this.publisher.emitGuidance(user.userId, guidance);
  }
}
