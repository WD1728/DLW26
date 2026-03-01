import React, { useEffect, useMemo, useRef, useState } from "react";
import {
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

function riskColor(risk: number): string {
  if (risk >= 0.8) return "#A7182A";
  if (risk >= 0.5) return "#D64A5E";
  if (risk >= 0.25) return "#79BBCF";
  return "#D4E5EC";
}

export default function HomeScreen() {
  const {
    wsStatus,
    lastRiskMap,
    emergencyMode,
    emergencyRoute,
    emergencyZoneId,
    sensorAvailable,
    fallPromptVisible,
    fallPromptSecondsLeft,
    triggerEmergencyMode,
    simulateFallDetection,
    resolveFallAsSafe,
    requestHelpFromFallPrompt,
  } = useSafeFlow();

  const [holdProgress, setHoldProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const zones = useMemo(() => {
    const list = lastRiskMap?.routingZones || [];
    if (list.length === 0) {
      return [
        { routingZoneId: "Z1", risk: 0, severity: "info" as const },
        { routingZoneId: "Z2", risk: 0, severity: "info" as const },
        { routingZoneId: "Z3", risk: 0, severity: "info" as const },
        { routingZoneId: "Z4", risk: 0, severity: "info" as const },
      ];
    }
    return list;
  }, [lastRiskMap]);

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
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>SafeFlow Mobile</Text>
          <Text style={styles.heroSubtitle}>Live crowd heatmap + discreet emergency workflow</Text>
          <View style={styles.statusRow}>
            <View style={styles.pill}>
              <Text style={styles.pillText}>WS: {wsStatus}</Text>
            </View>
            <View style={styles.pill}>
              <Text style={styles.pillText}>Sensor: {sensorAvailable ? "ON" : "OFF"}</Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Realtime Crowd Heatmap</Text>
          <View style={styles.heatmapGrid}>
            {zones.map((zone) => (
              <View
                key={zone.routingZoneId}
                style={[
                  styles.zoneCell,
                  { backgroundColor: riskColor(zone.risk) },
                  emergencyZoneId === zone.routingZoneId && styles.zoneCellEmergency,
                ]}>
                <Text style={styles.zoneId}>{zone.routingZoneId}</Text>
                <Text style={styles.zoneRisk}>{Math.round(zone.risk * 100)}%</Text>
              </View>
            ))}
          </View>
          <Text style={styles.legend}>
            Darker red indicates stronger local crowd risk. Data source: backend `risk_update`.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Emergency Mode</Text>
          <Text style={styles.value}>
            {emergencyMode
              ? `ACTIVE in zone ${emergencyZoneId || "-"}.`
              : "Inactive. Hold the emergency button for 2 seconds to arm."}
          </Text>
          {emergencyRoute ? (
            <View style={styles.routeBox}>
              <Text style={styles.routeTitle}>Emergency Route</Text>
              <Text style={styles.routeText}>{emergencyRoute.pathNodeIds.join(" -> ")}</Text>
            </View>
          ) : (
            <Text style={styles.muted}>No emergency route yet.</Text>
          )}
          <Pressable
            style={styles.testButton}
            onPress={() => {
              void simulateFallDetection();
            }}>
            <Text style={styles.testButtonText}>Simulate Fall Detection</Text>
          </Pressable>
        </View>

        <View style={styles.emergencySection}>
          <Text style={styles.emergencySectionTitle}>Emergency Report</Text>
          <Text style={styles.emergencySectionText}>
            Hold for 2 seconds to arm. Release early to cancel.
          </Text>
          {countdown !== null && (
            <View style={styles.countdownPanel}>
              <Text style={styles.countdownTitle}>Emergency signal will be sent in {countdown}s</Text>
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
      </ScrollView>

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
  root: {
    flex: 1,
    backgroundColor: SafeFlowPalette.neutral,
  },
  screen: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 180,
  },
  hero: {
    backgroundColor: SafeFlowPalette.primaryDeep,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 26,
    fontWeight: "700",
  },
  heroSubtitle: {
    color: SafeFlowPalette.neutral,
    fontSize: 13,
  },
  statusRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  pill: {
    backgroundColor: SafeFlowPalette.accent,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  pillText: {
    color: SafeFlowPalette.primaryDeep,
    fontWeight: "700",
    fontSize: 12,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: SafeFlowPalette.accent,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 16,
    fontWeight: "700",
  },
  heatmapGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  zoneCell: {
    width: "48%",
    minHeight: 70,
    borderRadius: 10,
    padding: 10,
    justifyContent: "space-between",
  },
  zoneId: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 14,
  },
  zoneRisk: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 12,
  },
  zoneCellEmergency: {
    borderWidth: 3,
    borderColor: "#FF233E",
  },
  legend: {
    color: SafeFlowPalette.primary,
    fontSize: 12,
  },
  value: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 14,
    lineHeight: 20,
  },
  muted: {
    color: SafeFlowPalette.primary,
    fontSize: 13,
  },
  routeBox: {
    backgroundColor: "#F7FBFE",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: SafeFlowPalette.accent,
    padding: 10,
    gap: 4,
  },
  routeTitle: {
    color: SafeFlowPalette.primary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  routeText: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 13,
    lineHeight: 18,
  },
  testButton: {
    marginTop: 4,
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: SafeFlowPalette.primary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  testButtonText: {
    color: SafeFlowPalette.primaryDeep,
    fontWeight: "700",
    fontSize: 12,
  },
  footerSpacer: {
    height: 0,
  },
  emergencySection: {
    backgroundColor: "#FFF8F9",
    borderWidth: 1,
    borderColor: "#FFCDD5",
    borderRadius: 12,
    padding: 14,
    gap: 10,
    marginBottom: 16,
  },
  emergencySectionTitle: {
    color: "#8A1022",
    fontWeight: "800",
    fontSize: 16,
  },
  emergencySectionText: {
    color: "#8A1022",
    fontSize: 13,
  },
  countdownPanel: {
    backgroundColor: "#FFF2F4",
    borderWidth: 1,
    borderColor: "#FF233E",
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    gap: 8,
  },
  countdownTitle: {
    color: "#8A1022",
    fontWeight: "700",
  },
  cancelButton: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#FF233E",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  cancelButtonText: {
    color: "#B00020",
    fontWeight: "700",
  },
  emergencyButtonWrap: {
    alignItems: "center",
    marginTop: 2,
  },
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
  progressPercent: {
    color: "#A7182A",
    fontSize: 10,
    fontWeight: "700",
  },
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
  emergencyText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 10,
    textAlign: "center",
  },
  emergencySub: {
    color: "#FFDDE2",
    fontSize: 9,
    textAlign: "center",
    marginTop: 2,
  },
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
  modalTitle: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 18,
    fontWeight: "700",
  },
  modalText: {
    color: SafeFlowPalette.primary,
    fontSize: 14,
    lineHeight: 20,
  },
  modalCountdown: {
    color: "#B00020",
    fontWeight: "700",
  },
  modalButtons: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  modalButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  modalSafe: {
    backgroundColor: SafeFlowPalette.primaryMid,
  },
  modalHelp: {
    backgroundColor: "#B00020",
  },
  modalButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
});
