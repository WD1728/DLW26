import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { SafeFlowPalette } from "@/constants/theme";
import { useSafeFlow } from "@/lib/safeflow-provider";

const HOLD_MS = 2000;
const PRE_SEND_COUNTDOWN_SEC = 5;

type NodePoint = { x: number; y: number };

function zoneColor(risk: number) {
  if (risk >= 0.7) return "#D92F2F";
  if (risk >= 0.3) return "#F0B62A";
  return "#34A853";
}

function modeColor(mode: "normal" | "alert" | "evacuation") {
  if (mode === "evacuation") return "#B81E2C";
  if (mode === "alert") return "#E8B018";
  return "#1F6CB0";
}

function navStateColor(state: string) {
  if (state === "blocked") return "#B81E2C";
  if (state === "rerouting") return "#E8B018";
  if (state === "evacuation_override") return "#C73A2C";
  if (state === "navigating") return "#1F6CB0";
  return "#566574";
}

function hashCode(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function makeNodePositions(
  activeRoute: string[],
  fallbackNodes: string[],
  width: number,
  height: number
): Record<string, NodePoint> {
  const positions: Record<string, NodePoint> = {};
  const marginX = 24;
  const drawWidth = Math.max(40, width - marginX * 2);
  const laneY = [58, 104, 148, 78];

  const route = activeRoute.length > 0 ? activeRoute : fallbackNodes.slice(0, 2);
  route.forEach((nodeId, idx) => {
    const step = route.length <= 1 ? 0 : idx / (route.length - 1);
    positions[nodeId] = {
      x: marginX + drawWidth * step,
      y: laneY[idx % laneY.length],
    };
  });

  fallbackNodes.forEach((nodeId) => {
    if (positions[nodeId]) return;
    const seed = hashCode(nodeId);
    positions[nodeId] = {
      x: marginX + (seed % Math.max(30, drawWidth - 10)),
      y: 40 + (seed % Math.max(40, height - 70)),
    };
  });

  return positions;
}

type SegmentProps = {
  from: NodePoint;
  to: NodePoint;
  color: string;
  width: number;
  opacity?: number;
};

function Segment({ from, to, color, width, opacity = 1 }: SegmentProps) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angle = `${(Math.atan2(dy, dx) * 180) / Math.PI}deg`;

  return (
    <View
      style={[
        styles.segment,
        {
          left: from.x,
          top: from.y,
          width: distance,
          height: width,
          backgroundColor: color,
          opacity,
          transform: [{ rotate: angle }],
        },
      ]}
    />
  );
}

export default function HomeScreen() {
  const {
    wsStatus,
    globalMode,
    navigationState,
    lastRiskMap,
    incidents,
    guidance,
    systemStatus,
    emergencyMode,
    emergencyRoute,
    previousRoute,
    currentNodeId,
    activeExitNodeId,
    blockedReason,
    emergencyZoneId,
    sensorAvailable,
    fallPromptVisible,
    fallPromptSecondsLeft,
    triggerEmergencyMode,
    simulateFallDetection,
    resolveFallAsSafe,
    requestHelpFromFallPrompt,
    switchMode,
    injectZoneRisk,
    injectBlockedIncident,
    clearLocalIncidents,
    resetLocalSystem,
  } = useSafeFlow();

  const [holdProgress, setHoldProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [mapSize, setMapSize] = useState({ width: 320, height: 210 });
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const marker = useRef(new Animated.ValueXY({ x: 24, y: 58 })).current;
  const routeOpacity = useRef(new Animated.Value(1)).current;
  const guidancePulse = useRef(new Animated.Value(1)).current;

  const zones = useMemo(() => {
    return lastRiskMap?.routingZones ?? [];
  }, [lastRiskMap]);

  const analysisByRouting = useMemo(() => {
    const map = new Map<string, { density?: number; anomaly?: number; risk: number }>();
    const byAnalysis = new Map(
      (lastRiskMap?.analysisZones ?? []).map((z) => [z.analysisZoneId, z])
    );

    zones.forEach((rz) => {
      const az = byAnalysis.get(rz.parentAnalysisZoneId);
      map.set(rz.routingZoneId, {
        density: az?.density,
        anomaly: az?.anomaly,
        risk: rz.risk,
      });
    });

    return map;
  }, [lastRiskMap, zones]);

  const blockedZoneIds = useMemo(() => {
    return new Set(
      incidents
        .filter(
          (inc) =>
            inc.routingImpact?.isBlocking ||
            (inc.routingImpact?.hazardPenalty ?? 0) >= 9999
        )
        .flatMap((inc) => inc.routingImpact?.affectedRoutingZoneIds ?? [inc.loc.zoneId])
    );
  }, [incidents]);

  const activePathNodes = emergencyRoute?.pathNodeIds ?? [];
  const previousPathNodes = previousRoute?.pathNodeIds ?? [];

  const nodePositions = useMemo(() => {
    const fallbackNodes = Array.from(
      new Set([
        ...activePathNodes,
        ...previousPathNodes,
        currentNodeId,
        activeExitNodeId,
      ])
    );
    return makeNodePositions(
      activePathNodes,
      fallbackNodes,
      mapSize.width,
      mapSize.height
    );
  }, [activePathNodes, previousPathNodes, currentNodeId, activeExitNodeId, mapSize]);

  const selectedZone = useMemo(() => {
    if (!selectedZoneId) return null;
    const zone = zones.find((z) => z.routingZoneId === selectedZoneId);
    if (!zone) return null;
    return {
      ...zone,
      details: analysisByRouting.get(selectedZoneId),
    };
  }, [analysisByRouting, selectedZoneId, zones]);

  useEffect(() => {
    if (activePathNodes.length === 0) return;
    Animated.sequence([
      Animated.timing(routeOpacity, { toValue: 0.3, duration: 150, useNativeDriver: true }),
      Animated.timing(routeOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  }, [activePathNodes, routeOpacity]);

  useEffect(() => {
    const target = nodePositions[currentNodeId];
    if (!target) return;

    Animated.timing(marker, {
      toValue: target,
      duration: 600,
      useNativeDriver: false,
    }).start();
  }, [currentNodeId, marker, nodePositions]);

  useEffect(() => {
    if (!guidance || guidance.severity !== "critical") {
      guidancePulse.stopAnimation();
      guidancePulse.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(guidancePulse, { toValue: 0.55, duration: 350, useNativeDriver: true }),
        Animated.timing(guidancePulse, { toValue: 1, duration: 350, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [guidance, guidancePulse]);

  const startCountdown = () => {
    setCountdown(PRE_SEND_COUNTDOWN_SEC);
  };

  const cancelHoldAndCountdown = () => {
    setIsHolding(false);
    setHoldProgress(0);
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
  };

  const onEmergencyPressIn = () => {
    if (countdown !== null) return;
    setIsHolding(true);
    const start = Date.now();
    holdTimerRef.current = setInterval(() => {
      const progress = Math.min((Date.now() - start) / HOLD_MS, 1);
      setHoldProgress(progress);
      if (progress >= 1) {
        if (holdTimerRef.current) clearInterval(holdTimerRef.current);
        holdTimerRef.current = null;
        setIsHolding(false);
        startCountdown();
      }
    }, 40);
  };

  const onEmergencyPressOut = () => {
    if (countdown !== null) return;
    cancelHoldAndCountdown();
  };

  useEffect(() => {
    if (countdown === null) return;
    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          void triggerEmergencyMode("manual_button");
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [countdown, triggerEmergencyMode]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };
  }, []);

  return (
    <View style={styles.root}>
      <View style={[styles.modeBanner, { backgroundColor: modeColor(globalMode) }]}>
        <Text style={styles.modeBannerText}>
          Mode: {globalMode.toUpperCase()} {globalMode === "evacuation" ? "⚠" : ""}
        </Text>
        <Text style={styles.modeMeta}>
          ws={wsStatus} · nav={navigationState}
        </Text>
      </View>

      {guidance && (
        <Animated.View
          style={[
            styles.guidanceBanner,
            guidance.severity === "critical" && styles.guidanceCritical,
            guidance.severity === "high" && styles.guidanceHigh,
            guidance.severity === "medium" && styles.guidanceMedium,
            { opacity: guidance.severity === "critical" ? guidancePulse : 1 },
          ]}>
          <Text style={styles.guidanceTitle}>{guidance.title}</Text>
          <Text style={styles.guidanceText}>{guidance.message}</Text>
        </Animated.View>
      )}

      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.mapCard}>
          <Text style={styles.cardTitle}>Navigation Canvas</Text>
          <View
            style={styles.mapCanvas}
            onLayout={(event) => {
              const { width, height } = event.nativeEvent.layout;
              setMapSize({ width, height });
            }}>
            <View style={styles.layerBase}>
              {zones.map((zone, idx) => {
                const col = idx % 3;
                const row = Math.floor(idx / 3);
                const width = mapSize.width / 3 - 8;
                const height = Math.max(38, mapSize.height / Math.max(2, Math.ceil(zones.length / 3)) - 8);

                return (
                  <Pressable
                    key={zone.routingZoneId}
                    style={[
                      styles.zonePatch,
                      {
                        left: 6 + col * (width + 6),
                        top: 6 + row * (height + 6),
                        width,
                        height,
                        backgroundColor: zoneColor(zone.risk),
                      },
                    ]}
                    onPress={() => setSelectedZoneId(zone.routingZoneId)}>
                    <Text style={styles.zonePatchText}>{zone.routingZoneId}</Text>
                    <Text style={styles.zonePatchRisk}>{Math.round(zone.risk * 100)}%</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.layerIncident}>
              {zones
                .filter((z) => blockedZoneIds.has(z.routingZoneId))
                .map((z, idx) => (
                  <View key={`${z.routingZoneId}-${idx}`} style={styles.blockedBadge}>
                    <Text style={styles.blockedText}>⛔ {z.routingZoneId}</Text>
                  </View>
                ))}
            </View>

            <View style={styles.layerRoute}>
              {previousPathNodes.slice(0, -1).map((nodeId, idx) => {
                const from = nodePositions[nodeId];
                const to = nodePositions[previousPathNodes[idx + 1]];
                if (!from || !to) return null;
                return (
                  <Segment
                    key={`prev-${nodeId}-${previousPathNodes[idx + 1]}`}
                    from={from}
                    to={to}
                    color="#6D8599"
                    width={4}
                    opacity={0.35}
                  />
                );
              })}

              <Animated.View style={{ opacity: routeOpacity }}>
                {activePathNodes.slice(0, -1).map((nodeId, idx) => {
                  const from = nodePositions[nodeId];
                  const to = nodePositions[activePathNodes[idx + 1]];
                  if (!from || !to) return null;
                  return (
                    <Segment
                      key={`active-${nodeId}-${activePathNodes[idx + 1]}`}
                      from={from}
                      to={to}
                      color={globalMode === "evacuation" ? "#FF3344" : "#1877C9"}
                      width={5}
                    />
                  );
                })}
              </Animated.View>

              {Object.entries(nodePositions).map(([nodeId, point]) => (
                <View key={nodeId} style={[styles.nodeDot, { left: point.x - 5, top: point.y - 5 }]}>
                  <Text style={styles.nodeLabel}>{nodeId}</Text>
                </View>
              ))}

              <Animated.View
                style={[
                  styles.userMarker,
                  {
                    transform: [{ translateX: marker.x }, { translateY: marker.y }],
                  },
                ]}>
                <Text style={styles.userMarkerText}>YOU</Text>
              </Animated.View>
            </View>
          </View>
        </View>

        <View style={styles.infoRow}>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Current Exit</Text>
            <Text style={styles.infoValue}>{activeExitNodeId}</Text>
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Distance</Text>
            <Text style={styles.infoValue}>{Math.round(emergencyRoute?.est?.distance ?? 0)} m</Text>
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>State</Text>
            <Text style={[styles.infoValue, { color: navStateColor(navigationState) }]}>
              {navigationState}
            </Text>
          </View>
        </View>

        {selectedZone && (
          <View style={styles.panelCard}>
            <Text style={styles.cardTitle}>Zone Inspector</Text>
            <Text style={styles.panelText}>Zone: {selectedZone.routingZoneId}</Text>
            <Text style={styles.panelText}>Risk: {(selectedZone.risk * 100).toFixed(1)}%</Text>
            <Text style={styles.panelText}>
              Density: {selectedZone.details?.density?.toFixed(2) ?? "n/a"}
            </Text>
            <Text style={styles.panelText}>
              Anomaly: {selectedZone.details?.anomaly?.toFixed(2) ?? "n/a"}
            </Text>
            <Text style={styles.panelText}>
              Trend: {selectedZone.risk >= 0.7 ? "↑ rising" : selectedZone.risk >= 0.3 ? "→ steady" : "↓ low"}
            </Text>
          </View>
        )}

        <View style={styles.panelCard}>
          <Text style={styles.cardTitle}>Developer Controls</Text>
          <View style={styles.buttonRow}>
            <Pressable style={styles.ctlBtn} onPress={() => void switchMode("normal")}>
              <Text style={styles.ctlText}>normal</Text>
            </Pressable>
            <Pressable style={styles.ctlBtn} onPress={() => void switchMode("alert")}>
              <Text style={styles.ctlText}>alert</Text>
            </Pressable>
            <Pressable style={styles.ctlBtn} onPress={() => void switchMode("evacuation")}>
              <Text style={styles.ctlText}>evacuation</Text>
            </Pressable>
          </View>
          <View style={styles.buttonRow}>
            <Pressable style={styles.ctlBtn} onPress={() => void injectZoneRisk("AZ1", 0.85)}>
              <Text style={styles.ctlText}>mock risk</Text>
            </Pressable>
            <Pressable style={styles.ctlBtn} onPress={() => void injectBlockedIncident("Z2")}>
              <Text style={styles.ctlText}>mock incident</Text>
            </Pressable>
            <Pressable style={styles.ctlBtn} onPress={clearLocalIncidents}>
              <Text style={styles.ctlText}>clear local</Text>
            </Pressable>
            <Pressable style={styles.ctlBtn} onPress={() => void resetLocalSystem()}>
              <Text style={styles.ctlText}>reset</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.panelCard}>
          <Text style={styles.cardTitle}>Emergency Actions</Text>
          <Text style={styles.panelText}>
            Sensor: {sensorAvailable ? "ON" : "OFF"} · emergency: {emergencyMode ? "active" : "inactive"}
          </Text>
          <View style={styles.buttonRow}>
            <Pressable style={styles.ctlBtn} onPress={() => void simulateFallDetection()}>
              <Text style={styles.ctlText}>simulate fall</Text>
            </Pressable>
          </View>

          {countdown !== null && (
            <View style={styles.countdownPanel}>
              <Text style={styles.countdownTitle}>Emergency signal in {countdown}s</Text>
              <Pressable style={styles.cancelButton} onPress={cancelHoldAndCountdown}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.emergencyButtonWrap}>
            <Pressable
              onPressIn={onEmergencyPressIn}
              onPressOut={onEmergencyPressOut}
              style={styles.emergencyButton}>
              <View style={styles.progressRing}>
                <Text style={styles.progressPercent}>{Math.round(holdProgress * 100)}%</Text>
              </View>
              <View style={styles.emergencyCore}>
                <Text style={styles.emergencyText}>{isHolding ? "Hold..." : "EMERGENCY"}</Text>
                <Text style={styles.emergencySub}>Press and hold 2s</Text>
              </View>
            </Pressable>
          </View>
        </View>

        <View style={styles.footerCard}>
          <Text style={styles.footerText}>
            system_status: {systemStatus ? `${systemStatus.mlMode} @ ${systemStatus.fps ?? "-"} fps` : "n/a"}
          </Text>
        </View>
      </ScrollView>

      {blockedReason === "NO_ROUTE_AVAILABLE" && (
        <View style={styles.blockedOverlay}>
          <Text style={styles.blockedOverlayTitle}>NO ROUTE AVAILABLE</Text>
          <Text style={styles.blockedOverlayText}>
            Navigation stopped. Please wait for staff guidance.
          </Text>
        </View>
      )}

      <Modal transparent visible={fallPromptVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Possible Fall Detected</Text>
            <Text style={styles.modalText}>We detected a possible fall. Are you okay?</Text>
            <Text style={styles.modalCountdown}>Auto-help in {fallPromptSecondsLeft}s</Text>
            <View style={styles.modalButtons}>
              <Pressable style={[styles.modalButton, styles.modalSafe]} onPress={resolveFallAsSafe}>
                <Text style={styles.modalButtonText}>I am okay</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.modalHelp]}
                onPress={() => {
                  void requestHelpFromFallPrompt();
                }}>
                <Text style={styles.modalButtonText}>Need help</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: SafeFlowPalette.neutral },
  screen: { flex: 1 },
  content: { padding: 12, gap: 10, paddingBottom: 120 },
  modeBanner: {
    paddingTop: 46,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  modeBannerText: { color: "#FFF", fontSize: 15, fontWeight: "800" },
  modeMeta: { color: "#FFF", fontSize: 12, opacity: 0.95, marginTop: 2 },
  guidanceBanner: {
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#1F6CB0",
  },
  guidanceCritical: { backgroundColor: "#B81E2C" },
  guidanceHigh: { backgroundColor: "#D45A1A" },
  guidanceMedium: { backgroundColor: "#AF8A1A" },
  guidanceTitle: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  guidanceText: { color: "#FFF", fontSize: 12, marginTop: 2 },
  mapCard: {
    backgroundColor: "#FFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#C6D5E1",
    padding: 10,
    gap: 8,
  },
  cardTitle: { color: "#1E3748", fontSize: 15, fontWeight: "800" },
  mapCanvas: {
    position: "relative",
    height: 210,
    borderRadius: 10,
    backgroundColor: "#EEF5FA",
    overflow: "hidden",
  },
  layerBase: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  layerIncident: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 4,
    alignItems: "flex-start",
    justifyContent: "flex-start",
    padding: 8,
    gap: 4,
  },
  layerRoute: { ...StyleSheet.absoluteFillObject, zIndex: 5 },
  zonePatch: {
    position: "absolute",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
    padding: 6,
    justifyContent: "space-between",
  },
  zonePatchText: { color: "#FFF", fontWeight: "700", fontSize: 11 },
  zonePatchRisk: { color: "#FFF", fontWeight: "700", fontSize: 10 },
  blockedBadge: {
    backgroundColor: "rgba(184,30,44,0.95)",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  blockedText: { color: "#FFF", fontWeight: "700", fontSize: 11 },
  segment: {
    position: "absolute",
    borderRadius: 999,
    transformOrigin: "left center",
  } as any,
  nodeDot: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#214B66",
  },
  nodeLabel: {
    position: "absolute",
    top: -16,
    left: -6,
    color: "#163244",
    fontSize: 9,
    fontWeight: "700",
  },
  userMarker: {
    position: "absolute",
    marginLeft: -10,
    marginTop: -10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#111",
    borderWidth: 2,
    borderColor: "#FFF",
    alignItems: "center",
    justifyContent: "center",
  },
  userMarkerText: { color: "#FFF", fontSize: 7, fontWeight: "800" },
  infoRow: { flexDirection: "row", gap: 8 },
  infoBlock: {
    flex: 1,
    backgroundColor: "#FFF",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#CFDCE7",
    padding: 10,
  },
  infoLabel: { color: "#5A6C7D", fontSize: 11, fontWeight: "700" },
  infoValue: { color: "#183A4F", marginTop: 3, fontSize: 13, fontWeight: "800" },
  panelCard: {
    backgroundColor: "#FFF",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#CFDCE7",
    padding: 10,
    gap: 8,
  },
  panelText: { color: "#2E4D62", fontSize: 13 },
  buttonRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  ctlBtn: {
    backgroundColor: "#EDF3F8",
    borderWidth: 1,
    borderColor: "#C1D2E0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  ctlText: { color: "#163244", fontWeight: "700", fontSize: 12 },
  countdownPanel: {
    backgroundColor: "#FFF2F4",
    borderWidth: 1,
    borderColor: "#FF233E",
    borderRadius: 12,
    padding: 10,
    alignItems: "center",
    gap: 8,
  },
  countdownTitle: { color: "#8A1022", fontWeight: "700" },
  cancelButton: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#FF233E",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  cancelButtonText: { color: "#B00020", fontWeight: "700" },
  emergencyButtonWrap: { alignItems: "center", marginTop: 2 },
  emergencyButton: { width: 104, height: 104, borderRadius: 52, justifyContent: "center", alignItems: "center" },
  progressRing: {
    position: "absolute",
    width: 92,
    height: 92,
    borderRadius: 46,
    borderWidth: 6,
    borderColor: "#FF233E",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 6,
    backgroundColor: "#FFECEF",
  },
  progressPercent: { color: "#A7182A", fontSize: 10, fontWeight: "700" },
  emergencyCore: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: "#B00020",
    borderWidth: 2,
    borderColor: "#FF7A8C",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  emergencyText: { color: "#FFFFFF", fontWeight: "800", fontSize: 10, textAlign: "center" },
  emergencySub: { color: "#FFDDE2", fontSize: 9, textAlign: "center", marginTop: 2 },
  footerCard: {
    backgroundColor: "#F4F8FC",
    borderRadius: 8,
    padding: 9,
    borderWidth: 1,
    borderColor: "#CCD9E5",
  },
  footerText: { color: "#486074", fontSize: 12 },
  blockedOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    backgroundColor: "rgba(176,0,32,0.92)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  blockedOverlayTitle: { color: "#FFF", fontWeight: "900", fontSize: 22, textAlign: "center" },
  blockedOverlayText: { color: "#FFE7EC", fontSize: 14, textAlign: "center", lineHeight: 21 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: SafeFlowPalette.accent,
    padding: 16,
    gap: 10,
  },
  modalTitle: { color: SafeFlowPalette.primaryDeep, fontSize: 18, fontWeight: "700" },
  modalText: { color: SafeFlowPalette.primary, fontSize: 14, lineHeight: 20 },
  modalCountdown: { color: "#B00020", fontWeight: "700" },
  modalButtons: { flexDirection: "row", gap: 8, marginTop: 4 },
  modalButton: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  modalSafe: { backgroundColor: SafeFlowPalette.primaryMid },
  modalHelp: { backgroundColor: "#B00020" },
  modalButtonText: { color: "#FFFFFF", fontWeight: "700" },
});

