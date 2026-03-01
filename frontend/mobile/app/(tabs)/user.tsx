import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

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
      <Text style={styles.title}>User View</Text>
      <Text style={styles.subtitle}>Route guidance + discreet safety controls</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Navigation</Text>
        <TextInput value={userId} onChangeText={setUserId} placeholder="User ID" style={styles.input} />
        <TextInput value={fromNodeId} onChangeText={setFromNodeId} placeholder="From node" style={styles.input} />
        <TextInput value={toNodeId} onChangeText={setToNodeId} placeholder="To node" style={styles.input} />
        <Pressable
          style={styles.button}
          onPress={() => requestSaferRoute({ userId, fromNodeId, toNodeId })}
        >
          <Text style={styles.buttonText}>Request Safer Route</Text>
        </Pressable>

        {activeRoute ? (
          <View style={styles.routeBox}>
            <Text style={styles.routeText}>Path: {activeRoute.pathNodeIds.join(" -> ")}</Text>
            <Text style={styles.routeText}>Reason: {activeRoute.reason}</Text>
          </View>
        ) : (
          <Text style={styles.muted}>No route yet for this user.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Risk Aware Prompt</Text>
        <Text style={styles.value}>
          {criticalCount > 0
            ? `${criticalCount} critical routing zones detected. Expect reroute recommendations.`
            : "No critical zones detected right now."}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Women-Safety Controls</Text>
        <View style={styles.switchRow}>
          <Text style={styles.value}>Guardian Mode</Text>
          <Switch value={guardianMode} onValueChange={setGuardianMode} />
        </View>

        <TextInput
          value={zoneId}
          onChangeText={setZoneId}
          placeholder="Current zone ID"
          style={styles.input}
        />

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
          }
        >
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
          }
        >
          <Text style={styles.buttonText}>Send Coded Message</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 40,
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: "#0f172a",
  },
  subtitle: {
    fontSize: 14,
    color: "#475569",
    marginBottom: 4,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0f172a",
  },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: "#ffffff",
  },
  textarea: {
    minHeight: 70,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: "#0f172a",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonSecondary: {
    backgroundColor: "#1d4ed8",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  muted: {
    color: "#64748b",
    fontSize: 13,
  },
  value: {
    color: "#1e293b",
    fontSize: 14,
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  routeBox: {
    backgroundColor: "#f1f5f9",
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  routeText: {
    color: "#334155",
    fontSize: 13,
  },
});

