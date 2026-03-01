export class WebSocketPublisher {
  constructor(private wss: any, private rawEmit?: (userId: string, type: string, payload: any) => void) {}

  emitRouteUpdate(userId: string, route: any) {
    this.wss.to(userId).emit("route_update", route);
    this.rawEmit?.(userId, "route_update", route);
  }

  emitGuidance(userId: string, guidance: any) {
    this.wss.to(userId).emit("guidance", guidance);
    this.rawEmit?.(userId, "guidance", guidance);
  }
}
