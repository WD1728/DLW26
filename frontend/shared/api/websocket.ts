import {
  SOCKET_EVENTS,
  type SocketLocationUpdatePayload,
  type SocketRegisterPayload,
} from "../backend-contract";
import { getWsBaseUrl } from "./config";

type WebSocketClientOptions = {
  url?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
};

export class WebSocketClient {
  private ws: WebSocket;
  private eventHandlers: Record<string, ((event: unknown) => void)[]> = {};
  private pendingMessages: Array<{ event: string; payload: unknown }> = [];
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options?: WebSocketClientOptions) {
    const base = (options?.url || getWsBaseUrl()).replace(/\/+$/, "");
    const socketIoUrl = `${base}/socket.io/?EIO=4&transport=websocket`;

    this.ws = new WebSocket(socketIoUrl);

    this.ws.onopen = () => {
      this.startPingLoop();
    };

    this.ws.onclose = () => {
      this.stopPingLoop();
      options?.onClose?.();
    };

    this.ws.onerror = (event) => {
      options?.onError?.(event);
    };

    this.ws.onmessage = (event) => {
      try {
        this.handleSocketIoPacket(String(event.data), options);
      } catch {
        // Ignore malformed payloads to keep ws client alive.
      }
    };
  }

  public on(type: string, handler: (event: unknown) => void) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler);
  }

  private emit(type: string, event: unknown) {
    const handlers = this.eventHandlers[type];
    if (handlers) {
      handlers.forEach(handler => handler(event));
    }
  }

  public register(payload: SocketRegisterPayload) {
    this.sendEvent(SOCKET_EVENTS.register, payload);
  }

  public sendLocationUpdate(payload: SocketLocationUpdatePayload) {
    this.sendEvent(SOCKET_EVENTS.locationUpdate, payload);
  }

  public send(event: { type: string; payload: unknown }) {
    this.sendEvent(event.type, event.payload);
  }

  public sendEvent(event: string, payload: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(`42${JSON.stringify([event, payload])}`);
      return;
    }

    this.pendingMessages.push({ event, payload });
  }

  public close() {
    this.stopPingLoop();
    this.ws.close();
  }

  private handleSocketIoPacket(
    packet: string,
    options?: WebSocketClientOptions
  ) {
    if (packet === "2") {
      this.ws.send("3");
      return;
    }

    if (packet.startsWith("0")) {
      this.ws.send("40");
      return;
    }

    if (packet === "40") {
      this.flushPendingMessages();
      options?.onOpen?.();
      return;
    }

    if (!packet.startsWith("42")) {
      return;
    }

    const data = JSON.parse(packet.slice(2)) as [string, unknown];
    if (!Array.isArray(data) || data.length < 1) {
      return;
    }

    const [eventName, payload] = data;
    this.emit(String(eventName), {
      type: String(eventName),
      payload
    });
  }

  private flushPendingMessages() {
    for (const msg of this.pendingMessages) {
      this.ws.send(`42${JSON.stringify([msg.event, msg.payload])}`);
    }
    this.pendingMessages = [];
  }

  private startPingLoop() {
    this.stopPingLoop();

    this.pingIntervalId = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("2");
      }
    }, 25000);
  }

  private stopPingLoop() {
    if (!this.pingIntervalId) {
      return;
    }

    clearInterval(this.pingIntervalId);
    this.pingIntervalId = null;
  }
}
