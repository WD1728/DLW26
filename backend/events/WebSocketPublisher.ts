import { WebSocket, WebSocketServer } from "ws";

export class WebSocketPublisher {
  constructor(private wss: WebSocketServer) {}

  private broadcast(payload: unknown) {
    const message = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  emitRouteUpdate(userId: string, route: any) {
    void userId;
    this.broadcast({ type: "route_update", payload: route });
  }

  emitGuidance(userId: string, guidance: any) {
    void userId;
    this.broadcast({ type: "guidance", payload: guidance });
  }
}
