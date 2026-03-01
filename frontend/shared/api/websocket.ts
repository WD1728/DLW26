import { WsServerEvent, WsClientEvent } from "../../../schema";
import { getWsBaseUrl } from "./config";

type WebSocketClientOptions = {
  url?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
};

export class WebSocketClient {
  private ws: WebSocket;
  private eventHandlers: Record<string, ((event: WsServerEvent) => void)[]> = {};
  private pendingMessages: WsClientEvent[] = [];

  constructor(options?: WebSocketClientOptions) {
    this.ws = new WebSocket(options?.url || getWsBaseUrl());
    this.ws.onopen = () => {
      for (const msg of this.pendingMessages) {
        this.ws.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
      options?.onOpen?.();
    };

    this.ws.onclose = () => {
      options?.onClose?.();
    };

    this.ws.onerror = (event) => {
      options?.onError?.(event);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsServerEvent;
        this.emit(data.type, data);
      } catch {
        // Ignore malformed payloads to keep ws client alive.
      }
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
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return;
    }
    this.pendingMessages.push(event);
  }

  public close() {
    this.ws.close();
  }
}
