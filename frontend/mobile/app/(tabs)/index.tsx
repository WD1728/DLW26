import React, { useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
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

function modeBackgroundColor(mode: "normal" | "alert" | "evacuation") {
  void mode;
  return "#0F2B46";
}

function navStateColor(state: string) {
  if (state === "blocked") return "#B81E2C";
  if (state === "rerouting") return "#D8A619";
  if (state === "evacuation_override") return "#C73A2C";
  if (state === "navigating") return "#1B6DAE";
  return "#566574";
}

function AnimatedCard({
  animatedValue,
  children,
}: {
  animatedValue: Animated.Value;
  children: React.ReactNode;
}) {
  return (
    <Animated.View
      style={{
        opacity: animatedValue,
        transform: [
          {
            translateY: animatedValue.interpolate({
              inputRange: [0, 1],
              outputRange: [16, 0],
            }),
          },
        ],
      }}>
      {children}
    </Animated.View>
  );
}

export default function HomeScreen() {
  const {
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
  const modalScale = useRef(new Animated.Value(0.9)).current;
  const modalOpacity = useRef(new Animated.Value(0)).current;
  const backgroundFade = useRef(new Animated.Value(1)).current;

  const sectionMap = useRef(new Animated.Value(0)).current;
  const sectionInfo = useRef(new Animated.Value(0)).current;
  const sectionRisk = useRef(new Animated.Value(0)).current;
  const sectionEmergency = useRef(new Animated.Value(0)).current;
  const sectionFooter = useRef(new Animated.Value(0)).current;
  const [backgroundBaseColor, setBackgroundBaseColor] = useState(modeBackgroundColor(globalMode));
  const [backgroundNextColor, setBackgroundNextColor] = useState(modeBackgroundColor(globalMode));

  const riskSummary = useMemo(() => {
    const zones = lastRiskMap?.routingZones ?? [];
    if (zones.length === 0) return { max: 0, avg: 0, count: 0 };
    const max = zones.reduce((m, z) => Math.max(m, z.risk), 0);
    const avg = zones.reduce((sum, z) => sum + z.risk, 0) / zones.length;
    return { max, avg, count: zones.length };
  }, [lastRiskMap]);

  useEffect(() => {
    Animated.stagger(90, [
      Animated.timing(sectionMap, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(sectionInfo, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(sectionRisk, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(sectionEmergency, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(sectionFooter, { toValue: 1, duration: 280, useNativeDriver: true }),
    ]).start();
  }, [sectionEmergency, sectionFooter, sectionInfo, sectionMap, sectionRisk]);

  useEffect(() => {
    const target = modeBackgroundColor(globalMode);
    if (target === backgroundNextColor) return;
    setBackgroundBaseColor(backgroundNextColor);
    setBackgroundNextColor(target);
    backgroundFade.setValue(0);
    Animated.timing(backgroundFade, {
      toValue: 1,
      duration: 280,
      useNativeDriver: true,
    }).start(() => {
      setBackgroundBaseColor(target);
    });
  }, [backgroundFade, backgroundNextColor, globalMode]);

  useEffect(() => {
    if (!guidance || guidance.severity !== "critical") {
      guidancePulse.stopAnimation();
      guidancePulse.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(guidancePulse, { toValue: 0.55, duration: 300, useNativeDriver: true }),
        Animated.timing(guidancePulse, { toValue: 1, duration: 300, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [guidance, guidancePulse]);

  useEffect(() => {
    if (fallPromptVisible || countdown !== null) {
      modalScale.setValue(0.78);
      modalOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(modalScale, {
          toValue: 1,
          friction: 9,
          tension: 86,
          useNativeDriver: true,
        }),
        Animated.timing(modalOpacity, { toValue: 1, duration: 320, useNativeDriver: true }),
      ]).start();
    }
  }, [countdown, fallPromptVisible, modalOpacity, modalScale]);

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
    <View style={[styles.root, { backgroundColor: backgroundBaseColor }]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.backgroundTransitionLayer,
          {
            backgroundColor: backgroundNextColor,
            opacity: backgroundFade,
          },
        ]}
      />
      <View style={styles.bgGlowOne} />
      <View style={styles.bgGlowTwo} />
      <View style={styles.patternStripeA} />
      <View style={styles.patternStripeB} />
      <View style={styles.patternRingA} />
      <View style={styles.patternRingB} />

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
        <AnimatedCard animatedValue={sectionMap}>
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
        </AnimatedCard>

        <AnimatedCard animatedValue={sectionInfo}>
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
        </AnimatedCard>

        <AnimatedCard animatedValue={sectionRisk}>
          <View style={styles.panelCard}>
            <Text style={styles.cardTitle}>Risk Snapshot</Text>
            <Text style={styles.panelText}>Routing zones: {riskSummary.count}</Text>
            <Text style={styles.panelText}>Max risk: {(riskSummary.max * 100).toFixed(1)}%</Text>
            <Text style={styles.panelText}>Avg risk: {(riskSummary.avg * 100).toFixed(1)}%</Text>
            <Text style={styles.panelText}>Active incidents: {incidents.length}</Text>
          </View>
        </AnimatedCard>

        <AnimatedCard animatedValue={sectionEmergency}>
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

            <View style={styles.emergencyZone}>
              <Pressable
                onPressIn={onEmergencyPressIn}
                onPressOut={onEmergencyPressOut}
                style={styles.emergencyButton}>
                <Ionicons name="notifications" size={72} color="#FFFFFF" />
              </Pressable>
              <Text selectable={false} style={styles.emergencyCaption}>
                {isHolding ? `holding ${Math.round(holdProgress * 100)}%` : "emergency button"}
              </Text>
            </View>
          </View>
        </AnimatedCard>

        <AnimatedCard animatedValue={sectionFooter}>
          <View style={styles.footerCard}>
            <Text style={styles.footerText}>
              system_status: {systemStatus ? `${systemStatus.mlMode} @ ${systemStatus.fps ?? "-"} fps` : "n/a"}
            </Text>
          </View>
        </AnimatedCard>
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
          <Animated.View
            style={[
              styles.modalCard,
              {
                opacity: modalOpacity,
                transform: [{ scale: modalScale }],
              },
            ]}>
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
          </Animated.View>
        </View>
      </Modal>

      <Modal transparent visible={countdown !== null} animationType="fade">
        <View style={styles.modalBackdrop}>
          <Animated.View
            style={[
              styles.modalCard,
              {
                opacity: modalOpacity,
                transform: [{ scale: modalScale }],
              },
            ]}>
            <Text style={styles.modalTitle}>Emergency signal in {countdown ?? 0}s</Text>
            <View style={styles.modalButtons}>
              <Pressable style={[styles.modalButton, styles.modalHelp]} onPress={cancelHoldAndCountdown}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0F2B46",
  },
  backgroundTransitionLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  bgGlowOne: {
    position: "absolute",
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "rgba(84,152,214,0.16)",
    top: -60,
    right: -70,
  },
  bgGlowTwo: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(255,255,255,0.16)",
    bottom: -50,
    left: -70,
  },
  patternStripeA: {
    position: "absolute",
    width: 420,
    height: 28,
    backgroundColor: "rgba(255,255,255,0.2)",
    top: 170,
    left: -140,
    transform: [{ rotate: "-18deg" }],
  },
  patternStripeB: {
    position: "absolute",
    width: 420,
    height: 18,
    backgroundColor: "rgba(255,255,255,0.16)",
    top: 260,
    right: -160,
    transform: [{ rotate: "14deg" }],
  },
  patternRingA: {
    position: "absolute",
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    borderColor: "rgba(27,109,174,0.12)",
    top: 430,
    right: -60,
  },
  patternRingB: {
    position: "absolute",
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 2,
    borderColor: "rgba(175,27,45,0.1)",
    top: 560,
    left: -44,
  },
  screen: { flex: 1 },
  content: { padding: 12, gap: 12, paddingTop: 6, paddingBottom: 10 },
  guidanceBanner: {
    marginHorizontal: 12,
    marginTop: 0,
    borderRadius: 12,
    padding: 11,
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
    backgroundColor: "#1F6CB0",
  },
  guidanceCritical: { backgroundColor: "#AF1B2D" },
  guidanceHigh: { backgroundColor: "#D45A1A" },
  guidanceMedium: { backgroundColor: "#AF8A1A" },
  guidanceTitle: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  guidanceText: { color: "#FFF", fontSize: 12, marginTop: 2 },
  mapCard: {
    backgroundColor: "rgba(214,232,247,0.78)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#C8D8E5",
    padding: 12,
    gap: 8,
    shadowColor: "#000",
    shadowOpacity: 0.09,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  cardTitle: { color: "#1B3E54", fontSize: 16, fontWeight: "800" },
  mapWrap: {
    height: 290,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#D0DCE8",
    backgroundColor: "#F0F4F8",
  },
  mapWebView: { flex: 1, backgroundColor: "#EEF5FA" },
  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  locationText: { fontSize: 12, color: "#365468", fontWeight: "600" },
  infoRow: { flexDirection: "row", gap: 8 },
  infoBlock: {
    flex: 1,
    backgroundColor: "rgba(214,232,247,0.75)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#D2DEE8",
    padding: 10,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  infoLabel: { color: "#5A6C7D", fontSize: 11, fontWeight: "700" },
  infoValue: { color: "#183A4F", marginTop: 3, fontSize: 13, fontWeight: "800" },
  panelCard: {
    backgroundColor: "rgba(214,232,247,0.78)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#D2DEE8",
    padding: 12,
    gap: 9,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  panelText: { color: "#2E4D62", fontSize: 13 },
  buttonRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  ctlBtn: {
    backgroundColor: "#EEF4F9",
    borderWidth: 1,
    borderColor: "#C5D5E4",
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  ctlText: { color: "#163244", fontWeight: "700", fontSize: 12 },
  emergencyZone: {
    marginTop: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  emergencyButton: {
    width: 152,
    height: 152,
    borderRadius: 76,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#B00020",
    shadowColor: "#7B0015",
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 5,
  },
  emergencyCaption: {
    marginTop: 10,
    textAlign: "center",
    fontSize: 12,
    color: "#8A1123",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  footerCard: {
    backgroundColor: "rgba(214,232,247,0.72)",
    borderRadius: 10,
    padding: 10,
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
    backgroundColor: "rgba(0,0,0,0.48)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    width: "96%",
    maxWidth: 640,
    backgroundColor: "#173A57",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(190,214,233,0.45)",
    paddingVertical: 20,
    paddingHorizontal: 18,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.26,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 9,
  },
  modalTitle: { color: "#F4FAFF", fontSize: 24, fontWeight: "800" },
  modalText: { color: "#D9E8F3", fontSize: 15, lineHeight: 22 },
  modalCountdown: { color: "#FFE49C", fontWeight: "700", fontSize: 15 },
  modalButtons: { flexDirection: "row", gap: 8, marginTop: 4 },
  modalButton: { flex: 1, borderRadius: 9, paddingVertical: 10, alignItems: "center" },
  modalSafe: { backgroundColor: SafeFlowPalette.primaryMid },
  modalHelp: { backgroundColor: "#B00020" },
  modalButtonText: { color: "#FFFFFF", fontWeight: "700" },
});
