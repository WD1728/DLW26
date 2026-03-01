import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useSafeFlow } from "@/lib/safeflow-provider";

function severityColor(severity: string) {
  if (severity === "critical") return "#c62828";
  if (severity === "warn") return "#ef6c00";
  return "#2e7d32";
}

export default function OpsScreen() {
  const {
    wsStatus,
    lastRiskMap,
    incidents,
    activityLog,
    connectWs,
    disconnectWs,
    sendPerceptionSample,
    triggerFallIncident,
  } = useSafeFlow();

  const topRoutingZones = (lastRiskMap?.routingZones || []).slice().sort((a, b) => b.risk - a.risk).slice(0, 6);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Ops Dashboard</Text>
      <Text style={styles.subtitle}>Live crowd risk, incidents, and control actions</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Connection</Text>
        <Text style={styles.value}>WS status: {wsStatus}</Text>
        <View style={styles.row}>
          <Pressable style={styles.button} onPress={connectWs}>
            <Text style={styles.buttonText}>Reconnect WS</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonOutline]} onPress={disconnectWs}>
            <Text style={[styles.buttonText, styles.buttonOutlineText]}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Demo Controls</Text>
        <View style={styles.row}>
          <Pressable style={styles.button} onPress={sendPerceptionSample}>
            <Text style={styles.buttonText}>Send Perception Frame</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={triggerFallIncident}>
            <Text style={styles.buttonText}>Trigger Fall Incident</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Top Risk Zones</Text>
        {topRoutingZones.length === 0 ? (
          <Text style={styles.muted}>No risk updates yet.</Text>
        ) : (
          topRoutingZones.map((zone) => (
            <View key={zone.routingZoneId} style={styles.listRow}>
              <Text style={styles.listLabel}>{zone.routingZoneId}</Text>
              <Text style={[styles.badge, { color: severityColor(zone.severity) }]}>
                {zone.severity.toUpperCase()} ({zone.risk.toFixed(2)})
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Incidents</Text>
        {incidents.length === 0 ? (
          <Text style={styles.muted}>No incidents.</Text>
        ) : (
          incidents.slice(0, 6).map((incident) => (
            <View key={incident.incidentId} style={styles.listRow}>
              <Text style={styles.listLabel}>{incident.type}</Text>
              <Text style={[styles.badge, { color: severityColor(incident.severity) }]}>
                {incident.loc.zoneId}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recommended Action</Text>
        {topRoutingZones[0] ? (
          <Text style={styles.value}>
            Focus staff near {topRoutingZones[0].routingZoneId} and keep reroute messaging active.
          </Text>
        ) : (
          <Text style={styles.muted}>Waiting for risk data to generate recommendations.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Activity Log</Text>
        {activityLog.length === 0 ? (
          <Text style={styles.muted}>No activity yet.</Text>
        ) : (
          activityLog.slice(0, 12).map((line, index) => (
            <Text key={`${line}-${index}`} style={styles.logLine}>
              {line}
            </Text>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f2f4f7",
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
  value: {
    color: "#1e293b",
    fontSize: 14,
  },
  muted: {
    color: "#64748b",
    fontSize: 13,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    backgroundColor: "#0f172a",
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  buttonOutline: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#0f172a",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 13,
  },
  buttonOutlineText: {
    color: "#0f172a",
  },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
    paddingBottom: 8,
  },
  listLabel: {
    color: "#1e293b",
    fontSize: 14,
  },
  badge: {
    fontSize: 12,
    fontWeight: "700",
  },
  logLine: {
    color: "#334155",
    fontSize: 12,
  },
});

