import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import * as Speech from "expo-speech";

import { reportIncident, requestRoute, sendPerceptionFrame, WebSocketClient } from "./backend-client";
import type { Incident, RiskMap, RoutePlan, SafetySignalType } from "./contracts";

type WsStatus = "connecting" | "connected" | "disconnected";
type EmergencySource = "manual_button" | "fall_need_help" | "fall_auto_timeout";

type SafeFlowContextValue = {
  wsStatus: WsStatus;
  lastRiskMap: RiskMap | null;
  incidents: Incident[];
  activityLog: string[];
  emergencyMode: boolean;
  emergencyRoute: RoutePlan | null;
  emergencyZoneId: string | null;
  sensorAvailable: boolean;
  fallPromptVisible: boolean;
  fallPromptSecondsLeft: number;
  connectWs: () => void;
  disconnectWs: () => void;
  sendPerceptionSample: () => Promise<void>;
  triggerEmergencyMode: (source: EmergencySource) => Promise<void>;
  simulateFallDetection: () => Promise<void>;
  resolveFallAsSafe: () => void;
  requestHelpFromFallPrompt: () => Promise<void>;
};

const SafeFlowContext = createContext<SafeFlowContextValue | null>(null);

const FREEFALL_THRESHOLD_G = 0.45;
const IMPACT_THRESHOLD_G = 2.2;
const NO_MOVEMENT_WINDOW_MS = 10_000;
const FALL_PROMPT_TIMEOUT_SEC = 15;
const DEFAULT_USER_ID = "U_DEMO_1";
const DEFAULT_MAP_ID = "mall_demo_v3";
const DEFAULT_START_NODE = "N1";
const DEFAULT_EXIT_NODE = "EXIT_N";

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

function getMostRiskyZoneId(riskMap: RiskMap | null): string {
  const first = (riskMap?.routingZones || []).slice().sort((a, b) => b.risk - a.risk)[0];
  return first?.routingZoneId || "Z_ATRIUM";
}

export function SafeFlowProvider({ children }: { children: React.ReactNode }) {
  const wsRef = useRef<WebSocketClient | null>(null);
  const sensorSubRef = useRef<{ remove: () => void } | null>(null);

  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [sensorAvailable, setSensorAvailable] = useState(false);
  const [lastRiskMap, setLastRiskMap] = useState<RiskMap | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);

  const [emergencyMode, setEmergencyMode] = useState(false);
  const [emergencyRoute, setEmergencyRoute] = useState<RoutePlan | null>(null);
  const [emergencyZoneId, setEmergencyZoneId] = useState<string | null>(null);

  const [fallPromptVisible, setFallPromptVisible] = useState(false);
  const [fallPromptSecondsLeft, setFallPromptSecondsLeft] = useState(0);

  const pushLog = useCallback((line: string) => {
    setActivityLog((prev) => [`${new Date().toLocaleTimeString()} ${line}`, ...prev].slice(0, 100));
  }, []);

  const sendSafetySignal = useCallback(
    (input: { userId: string; mapId: string; zoneId: string; type: SafetySignalType; note: string }) => {
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
      pushLog(`[ws] safety signal sent: ${input.type}`);
    },
    [pushLog]
  );

  const triggerEmergencyMode = useCallback(
    async (source: EmergencySource) => {
      const zoneId = getMostRiskyZoneId(lastRiskMap);
      setEmergencyMode(true);
      setEmergencyZoneId(zoneId);

      const signalType: SafetySignalType =
        source === "manual_button" ? "manual_help_request" : source === "fall_auto_timeout" ? "guardian_no_response" : "manual_help_request";

      sendSafetySignal({
        userId: DEFAULT_USER_ID,
        mapId: DEFAULT_MAP_ID,
        zoneId,
        type: signalType,
        note: `Emergency mode triggered via ${source}.`,
      });

      const incidentType = source === "manual_button" ? "distress_triggered" : "fall_detected";

      try {
        Speech.stop();
        Speech.speak("Emergency alert triggered. Assistance requested.", {
          language: "en-US",
          pitch: 1,
          rate: 0.95,
        });
      } catch {
        // Keep silent if speech is unavailable on device.
      }

      const incident: Incident = {
        incidentId: createId("INC"),
        ts: Date.now(),
        mapId: DEFAULT_MAP_ID,
        type: incidentType,
        severity: "critical",
        loc: { zoneId },
        routingImpact: {
          hazardPenalty: 0.35,
          affectedRoutingZoneIds: [zoneId],
          isBlocking: false,
        },
        status: "open",
      };

      try {
        await reportIncident(incident);
        pushLog("[http] emergency incident reported");
      } catch (error) {
        pushLog(`[http] emergency incident failed: ${String(error)}`);
      }

      try {
        const route = await requestRoute({
          userId: DEFAULT_USER_ID,
          fromNodeId: DEFAULT_START_NODE,
          toNodeId: DEFAULT_EXIT_NODE,
        });
        setEmergencyRoute(route);
        pushLog(`[http] emergency route ready (${route.pathNodeIds.length} nodes)`);
      } catch (error) {
        setEmergencyRoute(null);
        pushLog(`[http] emergency route failed: ${String(error)}`);
      }
    },
    [lastRiskMap, pushLog, sendSafetySignal]
  );

  const triggerFallPrompt = useCallback(async () => {
    if (fallPromptVisible || emergencyMode) return;
    setFallPromptVisible(true);
    setFallPromptSecondsLeft(FALL_PROMPT_TIMEOUT_SEC);
    pushLog("[fall] possible fall detected");
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // keep silent if haptics not available
    }
  }, [emergencyMode, fallPromptVisible, pushLog]);

  const resolveFallAsSafe = useCallback(() => {
    setFallPromptVisible(false);
    setFallPromptSecondsLeft(0);
    pushLog("[fall] user marked as safe");
  }, [pushLog]);

  const requestHelpFromFallPrompt = useCallback(async () => {
    setFallPromptVisible(false);
    setFallPromptSecondsLeft(0);
    pushLog("[fall] user requested help");
    await triggerEmergencyMode("fall_need_help");
  }, [pushLog, triggerEmergencyMode]);

  const simulateFallDetection = useCallback(async () => {
    await triggerFallPrompt();
  }, [triggerFallPrompt]);

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
      pushLog(`[risk] update: ${event.payload.routingZones?.length || 0} routing zones`);
    });

    ws.on("incident", (event) => {
      if (event.type !== "incident") return;
      setIncidents((prev) => [event.payload, ...prev].slice(0, 60));
      pushLog(`[incident] ${event.payload.type} in ${event.payload.loc.zoneId}`);
    });

    ws.on("route_update", (event) => {
      if (event.type !== "route_update") return;
      if (event.payload.userId === DEFAULT_USER_ID) {
        setEmergencyRoute(event.payload);
      }
      pushLog(`[route] update for ${event.payload.userId}`);
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
        { zoneId: "AZ_N", density: 0.28, anomaly: 0.11, conf: 0.9 },
        { zoneId: "AZ_S", density: 0.82, anomaly: 0.26, conf: 0.88 },
        { zoneId: "AZ_C", density: 0.55, anomaly: 0.18, conf: 0.9 },
      ],
    });
    pushLog("[http] /perception sent");
  }, [pushLog]);

  useEffect(() => {
    connectWs();
    return () => disconnectWs();
  }, [connectWs, disconnectWs]);

  useEffect(() => {
    let isMounted = true;
    const detector = {
      phase: "idle" as "idle" | "freefall" | "postImpact",
      freefallTs: 0,
      impactTs: 0,
      lastMovementTs: Date.now(),
      lastMagnitude: 1,
    };

    const setup = async () => {
      const available = await Accelerometer.isAvailableAsync();
      if (!isMounted) return;
      setSensorAvailable(available);
      if (!available) {
        pushLog("[sensor] accelerometer unavailable");
        return;
      }

      Accelerometer.setUpdateInterval(150);
      sensorSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
        if (fallPromptVisible || emergencyMode) return;

        const now = Date.now();
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        const movementDelta = Math.abs(magnitude - detector.lastMagnitude);
        detector.lastMagnitude = magnitude;

        if (movementDelta > 0.16 || Math.abs(magnitude - 1) > 0.16) {
          detector.lastMovementTs = now;
        }

        if (detector.phase === "idle") {
          if (magnitude < FREEFALL_THRESHOLD_G) {
            detector.phase = "freefall";
            detector.freefallTs = now;
          }
          return;
        }

        if (detector.phase === "freefall") {
          if (now - detector.freefallTs > 2200) {
            detector.phase = "idle";
            return;
          }

          if (magnitude > IMPACT_THRESHOLD_G) {
            detector.phase = "postImpact";
            detector.impactTs = now;
            detector.lastMovementTs = now;
          }
          return;
        }

        if (detector.phase === "postImpact") {
          const immobileFor = now - detector.lastMovementTs;
          const afterImpactFor = now - detector.impactTs;

          if (afterImpactFor >= NO_MOVEMENT_WINDOW_MS && immobileFor >= NO_MOVEMENT_WINDOW_MS) {
            detector.phase = "idle";
            void triggerFallPrompt();
            return;
          }

          if (afterImpactFor > NO_MOVEMENT_WINDOW_MS + 6000) {
            detector.phase = "idle";
          }
        }
      });

      pushLog("[sensor] accelerometer monitoring started");
    };

    void setup();

    return () => {
      isMounted = false;
      sensorSubRef.current?.remove();
      sensorSubRef.current = null;
    };
  }, [emergencyMode, fallPromptVisible, pushLog, triggerFallPrompt]);

  useEffect(() => {
    if (!fallPromptVisible) return;

    const timer = setInterval(() => {
      setFallPromptSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          void triggerEmergencyMode("fall_auto_timeout");
          setFallPromptVisible(false);
          pushLog("[fall] no response in 15s -> emergency mode");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [fallPromptVisible, pushLog, triggerEmergencyMode]);

  const value = useMemo<SafeFlowContextValue>(
    () => ({
      wsStatus,
      lastRiskMap,
      incidents,
      activityLog,
      emergencyMode,
      emergencyRoute,
      emergencyZoneId,
      sensorAvailable,
      fallPromptVisible,
      fallPromptSecondsLeft,
      connectWs,
      disconnectWs,
      sendPerceptionSample,
      triggerEmergencyMode,
      simulateFallDetection,
      resolveFallAsSafe,
      requestHelpFromFallPrompt,
    }),
    [
      wsStatus,
      lastRiskMap,
      incidents,
      activityLog,
      emergencyMode,
      emergencyRoute,
      emergencyZoneId,
      sensorAvailable,
      fallPromptVisible,
      fallPromptSecondsLeft,
      connectWs,
      disconnectWs,
      sendPerceptionSample,
      triggerEmergencyMode,
      simulateFallDetection,
      resolveFallAsSafe,
      requestHelpFromFallPrompt,
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
