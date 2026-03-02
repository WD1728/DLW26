import { RouteEvaluator } from "./RouteEvaluator";
import { AutoReroutePolicy } from "./AutoReroutePolicy";
import { ExitSelector } from "./ExitSelector";
import { GuidanceGenerator } from "./GuidanceGenerator";

export class DecisionOrchestrator {
  constructor(
    private evaluator: RouteEvaluator,
    private policy: AutoReroutePolicy,
    private exitSelector: ExitSelector,
    private router: any,
    private publisher: any,
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

    const newRoute = this.router.computeRoute(
      user.currentNodeId,
      target
    );

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
