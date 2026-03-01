import { WsServerEvent, WsClientEvent } from '@/shared/schema';

export class WebSocketClient {
  private ws: WebSocket;
  private eventHandlers: Record<string, ((event: WsServerEvent) => void)[]> = {};

  constructor() {
    this.ws = new WebSocket('ws://localhost:8080');
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as WsServerEvent;
      this.emit(data.type, data);
    };
  }

  public on(type: string, handler: (event: WsServerEvent) => void) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler);
  }

  private emit(type: string, event: WsServerEvent) {
    const handlers = this.eventHandlers[type];
    if (handlers) {
      handlers.forEach(handler => handler(event));
    }
  }

  public send(event: WsClientEvent) {
    this.ws.send(JSON.stringify(event));
  }
}