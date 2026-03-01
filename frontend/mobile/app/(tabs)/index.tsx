import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
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
const STADIUM_EMBED_URL = "https://www.google.com/maps?q=1.30092,103.87418&z=19&output=embed";

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
    activeExitNodeId,
    blockedReason,
    sensorAvailable,
    fallPromptVisible,
    fallPromptSecondsLeft,
    triggerEmergencyMode,
    simulateFallDetection,
    resolveFallAsSafe,
    requestHelpFromFallPrompt,
    switchMode,
  } = useSafeFlow();

  const [mapStatus, setMapStatus] = useState("loading");

  const [holdProgress, setHoldProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const guidancePulse = useRef(new Animated.Value(1)).current;

  const riskSummary = useMemo(() => {
    const zones = lastRiskMap?.routingZones ?? [];
    if (zones.length === 0) return { max: 0, avg: 0, count: 0 };
    const max = zones.reduce((m, z) => Math.max(m, z.risk), 0);
    const avg = zones.reduce((sum, z) => sum + z.risk, 0) / zones.length;
    return { max, avg, count: zones.length };
  }, [lastRiskMap]);

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
          Mode: {globalMode.toUpperCase()} {globalMode === "evacuation" ? "!" : ""}
        </Text>
        <Text style={styles.modeMeta}>ws={wsStatus} | nav={navigationState}</Text>
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
          <Text style={styles.cardTitle}>Singapore Indoor Stadium Map</Text>
          <View style={styles.mapWrap}>
            {Platform.OS === "web" ? (
              <iframe
                title="Singapore Indoor Stadium"
                src={STADIUM_EMBED_URL}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
                style={{ width: "100%", height: "100%", border: 0 }}
                onLoad={() => setMapStatus("ready")}
              />
            ) : (
              (() => {
                const NativeWebView = require("react-native-webview").WebView as React.ComponentType<any>;
                return (
                  <NativeWebView
                    source={{ uri: STADIUM_EMBED_URL }}
                    style={styles.mapWebView}
                    onLoadStart={() => setMapStatus("loading")}
                    onLoadEnd={() => setMapStatus("ready")}
                    onError={(event: any) => {
                      const msg = event.nativeEvent?.description || "webview_error";
                      setMapStatus(`error:${msg}`);
                    }}
                    onHttpError={(event: any) => {
                      const code = event.nativeEvent?.statusCode;
                      setMapStatus(`http_error:${code}`);
                    }}
                  />
                );
              })()
            )}
          </View>

          <View style={styles.locationRow}>
            <Text style={styles.locationText}>Map: {mapStatus}</Text>
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
            <Text style={styles.infoLabel}>Nav State</Text>
            <Text style={[styles.infoValue, { color: navStateColor(navigationState) }]}>
              {navigationState}
            </Text>
          </View>
        </View>

        <View style={styles.panelCard}>
          <Text style={styles.cardTitle}>Risk Snapshot</Text>
          <Text style={styles.panelText}>Routing zones: {riskSummary.count}</Text>
          <Text style={styles.panelText}>Max risk: {(riskSummary.max * 100).toFixed(1)}%</Text>
          <Text style={styles.panelText}>Avg risk: {(riskSummary.avg * 100).toFixed(1)}%</Text>
          <Text style={styles.panelText}>Active incidents: {incidents.length}</Text>
        </View>

        <View style={styles.panelCard}>
          <Text style={styles.cardTitle}>Emergency Actions</Text>
          <Text style={styles.panelText}>
            Sensor: {sensorAvailable ? "ON" : "OFF"} | emergency: {emergencyMode ? "active" : "inactive"}
          </Text>
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
  mapWrap: {
    height: 280,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#D0DCE8",
  },
  mapWebView: { flex: 1, backgroundColor: "#EEF5FA" },
  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  locationText: {
    fontSize: 12,
    color: "#2E4D62",
    fontWeight: "600",
  },
  recenterBtn: {
    backgroundColor: "#EDF3F8",
    borderWidth: 1,
    borderColor: "#C1D2E0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  recenterText: { color: "#163244", fontWeight: "700", fontSize: 12 },
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
  emergencyButton: {
    width: 104,
    height: 104,
    borderRadius: 52,
    justifyContent: "center",
    alignItems: "center",
  },
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
