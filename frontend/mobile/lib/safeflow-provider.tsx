import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { reportIncident, requestRoute, sendPerceptionFrame, WebSocketClient } from "./backend-client";
import type { AssistRequest, Incident, RiskMap, RoutePlan, SafetySignalType } from "./contracts";

type WsStatus = "connecting" | "connected" | "disconnected";

type AssistQueueItem = {
  request: AssistRequest;
  status: "pending" | "accepted" | "declined";
};

type SafeFlowContextValue = {
  wsStatus: WsStatus;
  lastRiskMap: RiskMap | null;
  incidents: Incident[];
  routesByUser: Record<string, RoutePlan>;
  assistQueue: AssistQueueItem[];
  activityLog: string[];
  connectWs: () => void;
  disconnectWs: () => void;
  sendPerceptionSample: () => Promise<void>;
  triggerFallIncident: () => Promise<void>;
  requestSaferRoute: (input: { userId: string; fromNodeId: string; toNodeId: string }) => Promise<void>;
  sendSafetySignal: (input: {
    userId: string;
    mapId: string;
    zoneId: string;
    type: SafetySignalType;
    note?: string;
  }) => void;
  acceptAssist: (requestId: string) => void;
  declineAssist: (requestId: string) => void;
  acknowledgeIncident: (incidentId: string) => void;
};

const SafeFlowContext = createContext<SafeFlowContextValue | null>(null);

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

function shouldCreateAssistRequest(incident: Incident): boolean {
  return (
    incident.type === "fall_detected" ||
    incident.type === "distress_triggered" ||
    incident.type === "harassment_report" ||
    incident.severity === "critical"
  );
}

export function SafeFlowProvider({ children }: { children: React.ReactNode }) {
  const wsRef = useRef<WebSocketClient | null>(null);

  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [lastRiskMap, setLastRiskMap] = useState<RiskMap | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [routesByUser, setRoutesByUser] = useState<Record<string, RoutePlan>>({});
  const [assistQueue, setAssistQueue] = useState<AssistQueueItem[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);

  const pushLog = useCallback((line: string) => {
    setActivityLog((prev) => [`${new Date().toLocaleTimeString()} ${line}`, ...prev].slice(0, 80));
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setWsStatus("connecting");

    const ws = new WebSocketClient({
      onOpen: () => {
        setWsStatus("connected");
        pushLog("[ws] connected");
      },
      onClose: () => {
        setWsStatus("disconnected");
        pushLog("[ws] disconnected");
      },
      onError: () => {
        pushLog("[ws] error");
      },
    });

    ws.on("risk_update", (event) => {
      if (event.type !== "risk_update") return;
      setLastRiskMap(event.payload);
      pushLog(`[risk] update: ${event.payload.analysisZones.length} analysis zones`);
    });

    ws.on("incident", (event) => {
      if (event.type !== "incident") return;
      setIncidents((prev) => [event.payload, ...prev].slice(0, 50));
      pushLog(`[incident] ${event.payload.type} in ${event.payload.loc.zoneId}`);

      if (shouldCreateAssistRequest(event.payload)) {
        const request: AssistRequest = {
          requestId: createId("AR"),
          ts: Date.now(),
          mapId: event.payload.mapId,
          incidentId: event.payload.incidentId,
          targetRole: "staff",
          loc: event.payload.loc,
          severity: event.payload.severity,
          message: `Possible ${event.payload.type} near ${event.payload.loc.zoneId}.`,
          exclusive: false,
        };
        setAssistQueue((prev) => [{ request, status: "pending" as const }, ...prev].slice(0, 50));
      }
    });

    ws.on("route_update", (event) => {
      if (event.type !== "route_update") return;
      setRoutesByUser((prev) => ({ ...prev, [event.payload.userId]: event.payload }));
      pushLog(`[route] updated for ${event.payload.userId}`);
    });

    ws.on("assist_request", (event) => {
      if (event.type !== "assist_request") return;
      setAssistQueue((prev) =>
        [{ request: event.payload, status: "pending" as const }, ...prev].slice(0, 50)
      );
      pushLog(`[assist] request ${event.payload.requestId}`);
    });

    wsRef.current = ws;
  }, [pushLog]);

  const disconnectWs = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setWsStatus("disconnected");
  }, []);

  const sendPerceptionSample = useCallback(async () => {
    await sendPerceptionFrame({
      ts: Date.now(),
      frameId: createId("frame"),
      zones: [
        { zoneId: "AZ1", density: 0.32, anomaly: 0.1, conf: 0.9 },
        { zoneId: "AZ2", density: 0.73, anomaly: 0.2, conf: 0.88 },
      ],
    });
    pushLog("[http] /perception sent");
  }, [pushLog]);

  const triggerFallIncident = useCallback(async () => {
    const incident: Incident = {
      incidentId: createId("INC"),
      ts: Date.now(),
      mapId: "mall_demo_v1",
      type: "fall_detected",
      severity: "warn",
      loc: { zoneId: "Z2" },
      routingImpact: { hazardPenalty: 0.2, affectedRoutingZoneIds: ["Z2"] },
      status: "open",
    };
    await reportIncident(incident);
    pushLog("[http] /incident sent");
  }, [pushLog]);

  const requestSaferRoute = useCallback(
    async (input: { userId: string; fromNodeId: string; toNodeId: string }) => {
      const plan = await requestRoute(input);
      setRoutesByUser((prev) => ({ ...prev, [input.userId]: plan }));
      pushLog(`[http] /route requested for ${input.userId}`);
    },
    [pushLog]
  );

  const sendSafetySignal = useCallback(
    (input: { userId: string; mapId: string; zoneId: string; type: SafetySignalType; note?: string }) => {
      wsRef.current?.send({
        type: "safety_signal",
        payload: {
          signalId: createId("SIG"),
          ts: Date.now(),
          userId: input.userId,
          mapId: input.mapId,
          type: input.type,
          loc: { zoneId: input.zoneId },
          note: input.note,
        },
      });
      pushLog(`[ws] safety_signal sent: ${input.type}`);
    },
    [pushLog]
  );

  const acceptAssist = useCallback((requestId: string) => {
    setAssistQueue((prev) =>
      prev.map((item) =>
        item.request.requestId === requestId ? { ...item, status: "accepted" } : item
      )
    );
    pushLog(`[assist] accepted ${requestId}`);
  }, [pushLog]);

  const declineAssist = useCallback((requestId: string) => {
    setAssistQueue((prev) =>
      prev.map((item) =>
        item.request.requestId === requestId ? { ...item, status: "declined" } : item
      )
    );
    pushLog(`[assist] declined ${requestId}`);
  }, [pushLog]);

  const acknowledgeIncident = useCallback((incidentId: string) => {
    setIncidents((prev) => prev.filter((inc) => inc.incidentId !== incidentId));
    pushLog(`[incident] acknowledged ${incidentId}`);
  }, [pushLog]);

  useEffect(() => {
    connectWs();
    return () => disconnectWs();
  }, [connectWs, disconnectWs]);

  const value = useMemo<SafeFlowContextValue>(
    () => ({
      wsStatus,
      lastRiskMap,
      incidents,
      routesByUser,
      assistQueue,
      activityLog,
      connectWs,
      disconnectWs,
      sendPerceptionSample,
      triggerFallIncident,
      requestSaferRoute,
      sendSafetySignal,
      acceptAssist,
      declineAssist,
      acknowledgeIncident,
    }),
    [
      wsStatus,
      lastRiskMap,
      incidents,
      routesByUser,
      assistQueue,
      activityLog,
      connectWs,
      disconnectWs,
      sendPerceptionSample,
      triggerFallIncident,
      requestSaferRoute,
      sendSafetySignal,
      acceptAssist,
      declineAssist,
      acknowledgeIncident,
    ]
  );

  return <SafeFlowContext.Provider value={value}>{children}</SafeFlowContext.Provider>;
}

export function useSafeFlow() {
  const context = useContext(SafeFlowContext);
  if (!context) {
    throw new Error("useSafeFlow must be used inside SafeFlowProvider");
  }
  return context;
}
