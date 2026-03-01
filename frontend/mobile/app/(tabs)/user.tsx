import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { SafeFlowPalette } from "@/constants/theme";
import { useSafeFlow } from "@/lib/safeflow-provider";

export default function UserScreen() {
  const { lastRiskMap, routesByUser, requestSaferRoute, sendSafetySignal } = useSafeFlow();

  const [userId, setUserId] = useState("U_DEMO_1");
  const [fromNodeId, setFromNodeId] = useState("N1");
  const [toNodeId, setToNodeId] = useState("EXIT");
  const [zoneId, setZoneId] = useState("Z2");
  const [codedMessage, setCodedMessage] = useState("Please check in with me in 1 minute.");
  const [guardianMode, setGuardianMode] = useState(true);

  const activeRoute = routesByUser[userId];

  const criticalCount = useMemo(
    () => (lastRiskMap?.routingZones || []).filter((z) => z.severity === "critical").length,
    [lastRiskMap]
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>SafeFlow User</Text>
        <Text style={styles.heroSubtitle}>Safer path guidance with discreet emergency controls</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Navigation</Text>
        <TextInput value={userId} onChangeText={setUserId} placeholder="User ID" style={styles.input} />
        <TextInput value={fromNodeId} onChangeText={setFromNodeId} placeholder="From node" style={styles.input} />
        <TextInput value={toNodeId} onChangeText={setToNodeId} placeholder="To node" style={styles.input} />
        <Pressable style={styles.button} onPress={() => requestSaferRoute({ userId, fromNodeId, toNodeId })}>
          <Text style={styles.buttonText}>Request Safer Route</Text>
        </Pressable>

        {activeRoute ? (
          <View style={styles.routeBox}>
            <Text style={styles.routeLabel}>Path</Text>
            <Text style={styles.routeText}>{activeRoute.pathNodeIds.join(" -> ")}</Text>
            <Text style={styles.routeMeta}>Reason: {activeRoute.reason}</Text>
          </View>
        ) : (
          <Text style={styles.muted}>No route available for this user yet.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Risk Summary</Text>
        <Text style={styles.value}>
          {criticalCount > 0
            ? `${criticalCount} critical routing zones detected. Reroute suggestions are prioritized.`
            : "No critical zones detected right now."}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Women-Safety Controls</Text>
        <View style={styles.switchRow}>
          <Text style={styles.value}>Guardian Mode</Text>
          <Switch
            value={guardianMode}
            onValueChange={setGuardianMode}
            trackColor={{ false: SafeFlowPalette.neutral, true: SafeFlowPalette.accent }}
            thumbColor={guardianMode ? SafeFlowPalette.primaryDeep : "#ffffff"}
          />
        </View>

        <TextInput value={zoneId} onChangeText={setZoneId} placeholder="Current zone ID" style={styles.input} />

        <Pressable
          style={styles.button}
          onPress={() =>
            sendSafetySignal({
              userId,
              mapId: "mall_demo_v1",
              zoneId,
              type: "silent_trigger",
              note: "Silent safety trigger activated.",
            })
          }>
          <Text style={styles.buttonText}>Send Silent Trigger</Text>
        </Pressable>

        <TextInput
          value={codedMessage}
          onChangeText={setCodedMessage}
          placeholder="Coded safety message"
          style={[styles.input, styles.textarea]}
          multiline
        />

        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={() =>
            sendSafetySignal({
              userId,
              mapId: "mall_demo_v1",
              zoneId,
              type: "coded_text_trigger",
              note: codedMessage,
            })
          }>
          <Text style={styles.buttonText}>Send Coded Message</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: SafeFlowPalette.neutral,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 42,
  },
  hero: {
    backgroundColor: SafeFlowPalette.primary,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: SafeFlowPalette.primaryDeep,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  heroSubtitle: {
    fontSize: 13,
    color: SafeFlowPalette.neutral,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: SafeFlowPalette.accent,
    gap: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: SafeFlowPalette.primaryDeep,
  },
  input: {
    borderWidth: 1,
    borderColor: SafeFlowPalette.accent,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: "#FFFFFF",
    color: SafeFlowPalette.primaryDeep,
  },
  textarea: {
    minHeight: 74,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: SafeFlowPalette.primaryDeep,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: SafeFlowPalette.primaryMid,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
  muted: {
    color: SafeFlowPalette.primary,
    fontSize: 13,
  },
  value: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 14,
    lineHeight: 20,
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  routeBox: {
    backgroundColor: "#F8FBFD",
    borderWidth: 1,
    borderColor: SafeFlowPalette.accent,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  routeLabel: {
    color: SafeFlowPalette.primary,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  routeText: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 13,
  },
  routeMeta: {
    color: SafeFlowPalette.primaryMid,
    fontSize: 12,
  },
});

