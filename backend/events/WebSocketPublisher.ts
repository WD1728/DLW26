export class WebSocketPublisher {
  constructor(
    private wss: any,
    private rawEmit?: (userId: string, type: string, payload: any) => void,
    private rawBroadcast?: (type: string, payload: any) => void,
    private rawRoleEmit?: (role: "staff" | "ally", type: string, payload: any) => void
  ) {}

  emitRouteUpdate(userId: string, route: any) {
    this.wss.to(userId).emit("route_update", route);
    this.rawEmit?.(userId, "route_update", route);
  }

  emitGuidance(userId: string, guidance: any) {
    this.wss.to(userId).emit("guidance", guidance);
    this.rawEmit?.(userId, "guidance", guidance);
  }

  emitRiskUpdate(riskUpdate: any) {
    this.wss.emit("risk_update", riskUpdate);
    this.rawBroadcast?.("risk_update", riskUpdate);
  }

  emitIncident(incident: any) {
    this.wss.emit("incident", incident);
    this.rawBroadcast?.("incident", incident);
  }

  emitAssistRequest(role: "staff" | "ally", assistRequest: any) {
    this.wss.to(role).emit("assist_request", assistRequest);
    this.rawRoleEmit?.(role, "assist_request", assistRequest);
  }
}
