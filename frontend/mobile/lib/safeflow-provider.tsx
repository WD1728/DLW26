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

import {
  injectMockIncident,
  injectMockRisk,
  reportIncident,
  requestRoute,
  sendPerceptionFrame,
  setGlobalMode,
  WebSocketClient,
} from "./backend-client";
import type {
  GlobalMode,
  Incident,
  NavigationState,
  RiskMap,
  RoutePlan,
  SafetySignalType,
} from "./contracts";

type WsStatus = "connecting" | "connected" | "disconnected";
type EmergencySource = "manual_button" | "fall_need_help" | "fall_auto_timeout";
type GuidanceBanner = {
  title: string;
  message: string;
  severity: "info" | "medium" | "high" | "critical";
};
type SystemStatus = {
  ts: number;
  mlMode: "fake" | "real";
  fps?: number;
  note?: string;
};

type SafeFlowContextValue = {
  wsStatus: WsStatus;
  globalMode: GlobalMode;
  navigationState: NavigationState;
  lastRiskMap: RiskMap | null;
  incidents: Incident[];
  activityLog: string[];
  guidance: GuidanceBanner | null;
  systemStatus: SystemStatus | null;
  emergencyMode: boolean;
  emergencyRoute: RoutePlan | null;
  previousRoute: RoutePlan | null;
  currentNodeId: string;
  destinationNodeId: string;
  activeExitNodeId: string;
  blockedReason: string | null;
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
  switchMode: (mode: GlobalMode) => Promise<void>;
  injectZoneRisk: (zoneId: string, risk: number) => Promise<void>;
  injectBlockedIncident: (zoneId: string) => Promise<void>;
  clearLocalIncidents: () => void;
  resetLocalSystem: () => Promise<void>;
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
  const [globalMode, setGlobalModeState] = useState<GlobalMode>("normal");
  const [navigationState, setNavigationState] = useState<NavigationState>("idle");
  const [sensorAvailable, setSensorAvailable] = useState(false);
  const [lastRiskMap, setLastRiskMap] = useState<RiskMap | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [guidance, setGuidance] = useState<GuidanceBanner | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  const [emergencyMode, setEmergencyMode] = useState(false);
  const [emergencyRoute, setEmergencyRoute] = useState<RoutePlan | null>(null);
  const [previousRoute, setPreviousRoute] = useState<RoutePlan | null>(null);
  const [currentNodeId, setCurrentNodeId] = useState(DEFAULT_START_NODE);
  const [destinationNodeId, setDestinationNodeId] = useState(DEFAULT_EXIT_NODE);
  const [activeExitNodeId, setActiveExitNodeId] = useState(DEFAULT_EXIT_NODE);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [emergencyZoneId, setEmergencyZoneId] = useState<string | null>(null);

  const [fallPromptVisible, setFallPromptVisible] = useState(false);
  const [fallPromptSecondsLeft, setFallPromptSecondsLeft] = useState(0);
  const routeCursorRef = useRef(0);

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
      setNavigationState("evacuation_override");
      setDestinationNodeId(DEFAULT_EXIT_NODE);
      setActiveExitNodeId(DEFAULT_EXIT_NODE);
      setBlockedReason(null);

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
        await setGlobalMode("evacuation");
        setGlobalModeState("evacuation");
      } catch {
        pushLog("[http] failed to sync evacuation mode");
      }

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
          fromNodeId: currentNodeId || DEFAULT_START_NODE,
          toNodeId: DEFAULT_EXIT_NODE,
        });
        setPreviousRoute(emergencyRoute);
        setEmergencyRoute(route);
        setNavigationState("navigating");
        setActiveExitNodeId(route.pathNodeIds[route.pathNodeIds.length - 1] || DEFAULT_EXIT_NODE);
        setBlockedReason(null);
        pushLog(`[http] emergency route ready (${route.pathNodeIds.length} nodes)`);
      } catch (error) {
        setEmergencyRoute(null);
        setNavigationState("blocked");
        const message = String(error);
        setBlockedReason(
          message.includes("NO_ROUTE_AVAILABLE") || message.includes("No route found")
            ? "NO_ROUTE_AVAILABLE"
            : message
        );
        pushLog(`[http] emergency route failed: ${message}`);
      }
    },
    [currentNodeId, emergencyRoute, lastRiskMap, pushLog, sendSafetySignal]
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
        setNavigationState((prev) => (prev === "blocked" ? prev : "idle"));
        ws.sendEvent("register", { userId: DEFAULT_USER_ID });
        ws.sendEvent("location_update", {
          userId: DEFAULT_USER_ID,
          currentNodeId,
          destinationNodeId,
        });
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
        setPreviousRoute(emergencyRoute);
        setEmergencyRoute(event.payload);
        setNavigationState("rerouting");
        setTimeout(() => {
          setNavigationState((prev) => (prev === "blocked" ? "blocked" : "navigating"));
        }, 900);

        const nextExit = event.payload.pathNodeIds[event.payload.pathNodeIds.length - 1] || DEFAULT_EXIT_NODE;
        if (activeExitNodeId && activeExitNodeId !== nextExit) {
          setGuidance({
            title: "Exit Updated",
            message: `Destination changed from ${activeExitNodeId} to ${nextExit}.`,
            severity: "high",
          });
        }
        setActiveExitNodeId(nextExit);
        setDestinationNodeId(nextExit);
        setBlockedReason(null);
      }
      pushLog(`[route] update for ${event.payload.userId}`);
    });

    ws.on("guidance", (event) => {
      if (event.type !== "guidance") return;
      setGuidance(event.payload);
      pushLog(`[guidance] ${event.payload.title}`);

      if (event.payload.severity === "critical") {
        setGlobalModeState("evacuation");
        setNavigationState("evacuation_override");
      } else if (event.payload.severity === "high") {
        setGlobalModeState("alert");
      }
    });

    ws.on("system_status", (event) => {
      if (event.type !== "system_status") return;
      setSystemStatus(event.payload);
      pushLog(`[system] mode=${event.payload.mlMode} fps=${event.payload.fps ?? "-"}`);
    });

    wsRef.current = ws;
  }, [activeExitNodeId, currentNodeId, destinationNodeId, emergencyRoute, pushLog]);

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
    pushLog("[http] mock risk batch sent");
  }, [pushLog]);

  const switchMode = useCallback(
    async (mode: GlobalMode) => {
      await setGlobalMode(mode);
      setGlobalModeState(mode);
      if (mode === "evacuation") {
        setNavigationState("evacuation_override");
      } else if (navigationState !== "blocked") {
        setNavigationState("idle");
      }
      pushLog(`[mode] switched to ${mode}`);
    },
    [navigationState, pushLog]
  );

  const injectZoneRisk = useCallback(
    async (zoneId: string, risk: number) => {
      await injectMockRisk({ zoneId, risk });
      pushLog(`[mock] risk ${zoneId}=${risk.toFixed(2)}`);
    },
    [pushLog]
  );

  const injectBlockedIncident = useCallback(
    async (zoneId: string) => {
      const incident: Incident = {
        incidentId: createId("INC"),
        ts: Date.now(),
        mapId: DEFAULT_MAP_ID,
        type: "blocked_corridor",
        severity: "critical",
        loc: { zoneId },
        routingImpact: {
          hazardPenalty: 9999,
          isBlocking: true,
          affectedRoutingZoneIds: [zoneId],
        },
        status: "open",
      };

      await injectMockIncident(incident);
      setIncidents((prev) => [incident, ...prev].slice(0, 60));
      pushLog(`[mock] blocked incident at ${zoneId}`);
    },
    [pushLog]
  );

  const clearLocalIncidents = useCallback(() => {
    setIncidents([]);
    pushLog("[local] incidents cleared in UI");
  }, [pushLog]);

  const resetLocalSystem = useCallback(async () => {
    setGuidance(null);
    setBlockedReason(null);
    setEmergencyMode(false);
    setEmergencyZoneId(null);
    setNavigationState("idle");
    setPreviousRoute(null);
    setEmergencyRoute(null);
    setCurrentNodeId(DEFAULT_START_NODE);
    setDestinationNodeId(DEFAULT_EXIT_NODE);
    setActiveExitNodeId(DEFAULT_EXIT_NODE);
    setIncidents([]);

    try {
      await switchMode("normal");
    } catch {
      pushLog("[http] mode reset failed");
    }

    const zones = lastRiskMap?.routingZones ?? [];
    for (const z of zones) {
      try {
        await injectMockRisk({ zoneId: z.routingZoneId, risk: 0 });
      } catch {
        // continue best-effort reset
      }
    }

    pushLog("[reset] local system reset complete");
  }, [lastRiskMap, pushLog, switchMode]);

  useEffect(() => {
    connectWs();
    return () => disconnectWs();
  }, [connectWs, disconnectWs]);

  useEffect(() => {
    if (!guidance) return;
    const timeoutMs = guidance.severity === "critical" ? 8000 : 4500;
    const timer = setTimeout(() => setGuidance(null), timeoutMs);
    return () => clearTimeout(timer);
  }, [guidance]);

  useEffect(() => {
    const route = emergencyRoute?.pathNodeIds ?? [];
    if (route.length === 0) return;
    routeCursorRef.current = 0;
    setCurrentNodeId(route[0]);
  }, [emergencyRoute]);

  useEffect(() => {
    const route = emergencyRoute?.pathNodeIds ?? [];
    if (route.length === 0 || !wsRef.current) return;

    const timer = setInterval(() => {
      const next = Math.min(routeCursorRef.current + 1, route.length - 1);
      routeCursorRef.current = next;
      const nodeId = route[next];
      setCurrentNodeId(nodeId);
      wsRef.current?.sendEvent("location_update", {
        userId: DEFAULT_USER_ID,
        currentNodeId: nodeId,
        destinationNodeId,
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [destinationNodeId, emergencyRoute]);

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
      globalMode,
      navigationState,
      lastRiskMap,
      incidents,
      activityLog,
      guidance,
      systemStatus,
      emergencyMode,
      emergencyRoute,
      previousRoute,
      currentNodeId,
      destinationNodeId,
      activeExitNodeId,
      blockedReason,
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
      switchMode,
      injectZoneRisk,
      injectBlockedIncident,
      clearLocalIncidents,
      resetLocalSystem,
    }),
    [
      wsStatus,
      globalMode,
      navigationState,
      lastRiskMap,
      incidents,
      activityLog,
      guidance,
      systemStatus,
      emergencyMode,
      emergencyRoute,
      previousRoute,
      currentNodeId,
      destinationNodeId,
      activeExitNodeId,
      blockedReason,
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
      switchMode,
      injectZoneRisk,
      injectBlockedIncident,
      clearLocalIncidents,
      resetLocalSystem,
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
