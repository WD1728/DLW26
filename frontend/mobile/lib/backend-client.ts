import type {
  Incident,
  PerceptionFrameResult,
  RoutePlan,
  WsClientEvent,
  WsServerEvent,
} from "./contracts";

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
    throw new Error(`Request failed ${path}: ${response.status}`);
  }

  return response.json();
}

export function sendPerceptionFrame(frame: PerceptionFrameResult): Promise<{ ok: true }> {
  return postJson("/perception", frame);
}

export function reportIncident(incident: Incident): Promise<{ ok: true }> {
  return postJson("/incident", incident);
}

export type BackendRouteRequest = {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
};

export function requestRoute(input: BackendRouteRequest): Promise<RoutePlan> {
  return postJson("/route", input);
}

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

    this.ws.onclose = () => options?.onClose?.();
    this.ws.onerror = (event) => options?.onError?.(event);

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsServerEvent;
        this.emit(data.type, data);
      } catch {
        // Ignore malformed payloads.
      }
    };
  }

  public on(type: string, handler: (event: WsServerEvent) => void) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler);
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

  private emit(type: string, event: WsServerEvent) {
    const handlers = this.eventHandlers[type];
    if (handlers) {
      handlers.forEach((handler) => handler(event));
    }
  }
}

