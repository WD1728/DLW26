import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { SafeFlowPalette } from "@/constants/theme";
import { useSafeFlow } from "@/lib/safeflow-provider";

function severityColor(severity: string) {
  if (severity === "critical") return SafeFlowPalette.primaryDeep;
  if (severity === "warn") return SafeFlowPalette.primary;
  return SafeFlowPalette.primaryMid;
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

  const topRoutingZones = (lastRiskMap?.routingZones || [])
    .slice()
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 6);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>SafeFlow Ops</Text>
        <Text style={styles.heroSubtitle}>Live crowd risk intelligence and intervention controls</Text>
        <View style={styles.statusPill}>
          <Text style={styles.statusText}>WebSocket: {wsStatus}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Connection Controls</Text>
        <View style={styles.row}>
          <Pressable style={styles.button} onPress={connectWs}>
            <Text style={styles.buttonText}>Reconnect</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonAlt]} onPress={disconnectWs}>
            <Text style={[styles.buttonText, styles.buttonAltText]}>Disconnect</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Demo Triggers</Text>
        <View style={styles.row}>
          <Pressable style={styles.button} onPress={sendPerceptionSample}>
            <Text style={styles.buttonText}>Send Perception</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={triggerFallIncident}>
            <Text style={styles.buttonText}>Trigger Fall</Text>
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
            Allocate responders near {topRoutingZones[0].routingZoneId} and keep reroute guidance active.
          </Text>
        ) : (
          <Text style={styles.muted}>Waiting for risk data to generate recommendation.</Text>
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
    backgroundColor: SafeFlowPalette.neutral,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 42,
  },
  hero: {
    backgroundColor: SafeFlowPalette.primaryDeep,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: SafeFlowPalette.primary,
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
  statusPill: {
    alignSelf: "flex-start",
    backgroundColor: SafeFlowPalette.accent,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  statusText: {
    color: SafeFlowPalette.primaryDeep,
    fontWeight: "700",
    fontSize: 12,
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
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    backgroundColor: SafeFlowPalette.primary,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  buttonAlt: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: SafeFlowPalette.primary,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },
  buttonAltText: {
    color: SafeFlowPalette.primaryDeep,
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
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: SafeFlowPalette.neutral,
    paddingBottom: 8,
  },
  listLabel: {
    color: SafeFlowPalette.primaryDeep,
    fontSize: 14,
  },
  badge: {
    fontSize: 12,
    fontWeight: "700",
  },
  logLine: {
    color: SafeFlowPalette.primary,
    fontSize: 12,
  },
});

