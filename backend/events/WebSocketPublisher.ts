export class WebSocketPublisher {
  constructor(private wss: any) {}

  emitRouteUpdate(userId: string, route: any) {
    this.wss.to(userId).emit("route_update", route);
  }

  emitGuidance(userId: string, guidance: any) {
    this.wss.to(userId).emit("guidance", guidance);
  }
}
