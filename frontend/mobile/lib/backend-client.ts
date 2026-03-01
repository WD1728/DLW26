import type {
  GlobalMode,
  Incident,
  PerceptionFrameResult,
  RoutePlan,
  WsServerEvent,
} from "./contracts";
import { HTTP_ENDPOINTS, toRouteRequest } from "../shared/backend-contract";

function getDefaultHost(): string {
  const maybeLocation = (globalThis as { location?: { hostname?: string } }).location;
  return maybeLocation?.hostname || "localhost";
}

function getDefaultHttpBaseUrl(): string {
  return `http://${getDefaultHost()}:8080`;
}

function getDefaultWsBaseUrl(): string {
  return `ws://${getDefaultHost()}:8080`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

function getApiBaseUrl(): string {
  const fromExpo = readEnv("EXPO_PUBLIC_API_BASE_URL");
  return normalizeBaseUrl(fromExpo || getDefaultHttpBaseUrl());
}

function getWsBaseUrl(): string {
  const fromExpo = readEnv("EXPO_PUBLIC_WS_BASE_URL");
  return normalizeBaseUrl(fromExpo || getDefaultWsBaseUrl());
}

async function postJson<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Request failed ${path}: ${response.status} ${errorText}`.trim());
  }

  return response.json();
}

export function sendPerceptionFrame(frame: PerceptionFrameResult): Promise<{ ok: true }> {
  const requests = frame.zones.map((zone) => {
    const risk = Math.max(0, Math.min(1, zone.density * 0.6 + zone.anomaly * 0.4));
    return postJson(HTTP_ENDPOINTS.mockRisk, { zoneId: zone.zoneId, risk });
  });

  return Promise.all(requests).then(() => ({ ok: true }));
}

export function reportIncident(incident: Incident): Promise<{ ok: true }> {
  return postJson(HTTP_ENDPOINTS.mockIncident, incident);
}

export type BackendRouteRequest = {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
};

export function requestRoute(input: BackendRouteRequest): Promise<RoutePlan> {
  return postJson(HTTP_ENDPOINTS.route, toRouteRequest(input));
}

export function setGlobalMode(mode: GlobalMode): Promise<{ ok: true }> {
  return postJson(HTTP_ENDPOINTS.mode, { mode });
}

export function injectMockRisk(input: { zoneId: string; risk: number }): Promise<{ ok: true }> {
  return postJson(HTTP_ENDPOINTS.mockRisk, input);
}

export function injectMockIncident(incident: Incident): Promise<{ ok: true }> {
  return postJson(HTTP_ENDPOINTS.mockIncident, incident);
}

type WebSocketClientOptions = {
  url?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
};

type ServerEventType = WsServerEvent["type"];
type EventByType<T extends ServerEventType> = Extract<WsServerEvent, { type: T }>;

export class WebSocketClient {
  private ws: WebSocket;
  private eventHandlers: Record<string, ((event: WsServerEvent) => void)[]> = {};
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
    this.ws.onerror = (event) => options?.onError?.(event);

    this.ws.onmessage = (event) => {
      try {
        this.handleSocketIoPacket(String(event.data), options);
      } catch {
        // Ignore malformed payloads.
      }
    };
  }

  public on<T extends ServerEventType>(type: T, handler: (event: EventByType<T>) => void) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler as (event: WsServerEvent) => void);
  }

  public send(event: { type: string; payload: unknown }) {
    this.sendEvent(event.type, event.payload);
  }

  public sendEvent(event: string, payload: unknown) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.pendingMessages.push({ event, payload });
      return;
    }

    this.ws.send(`42${JSON.stringify([event, payload])}`);
  }

  public close() {
    this.stopPingLoop();
    this.ws.close();
  }

  private emit(type: string, event: WsServerEvent) {
    const handlers = this.eventHandlers[type];
    if (handlers) {
      handlers.forEach((handler) => handler(event));
    }
  }

  private handleSocketIoPacket(packet: string, options?: WebSocketClientOptions) {
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
    } as WsServerEvent);
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
