/**
 * server.ts — SafeFlow Stampede Pipeline
 *
 * The FULL pipeline from ML output → staff alerts + evacuation routes.
 *
 * This file does 3 things:
 * 1. Loads the graph
 * 2. Provides a `processMLFrame()` function that your server calls
 *    every time the ML service sends a new frame
 * 3. When run directly, simulates a stampede scenario to demonstrate
 *    the full flow
 *
 * INTEGRATION POINT:
 * Your WebSocket server calls processMLFrame() on each ML frame.
 * It returns: { riskMap, stampedeAlerts, evacuationPlan? }
 * You then broadcast riskMap to all clients, stampedeAlerts to staff,
 * and evacuationPlan routes to affected users.
 */

import * as fs from "fs";
import * as path from "path";

import {
  RiskFusionEngine,
  type PerceptionFrameResult,
  type RiskMap,
  type StampedeAlert,
  type RoutingZone,
  type ID,
} from "./risk";

import {
  EvacuationRouter,
  type EvacuationPlan,
  type EvacuationRoute,
  type RoutePlan,
  type MapGraph,
} from "./routing";

// ─── Output types ───

export interface PipelineOutput {
  /** Always present: the fused risk map for all zones */
  riskMap: RiskMap;
  /** Present when stampede conditions detected in any zone */
  stampedeAlerts: StampedeAlert[];
  /** Present when stampede detected → evacuation routes computed */
  evacuationPlan: EvacuationPlan | null;
  /** Schema-compatible route plans ready to send over WebSocket */
  routePlans: RoutePlan[];
  /** Staff notification messages */
  staffMessages: string[];
}

// ─── Graph data shape (from graph.json) ───

interface GraphJson {
  mapId: string;
  analysisZones: { id: string; name: string; polygon: any[] }[];
  routingZones: {
    id: string;
    name: string;
    parentAnalysisZoneId: string;
    polygon: any[];
  }[];
  graph: {
    nodes: { id: string; pos: { x: number; y: number }; label?: string; kind?: string }[];
    edges: {
      id: string;
      from: string;
      to: string;
      length: number;
      routingZoneId: string;
    }[];
  };
  exits: string[];
}

// ─── The Pipeline ───

export class StampedePipeline {
  private riskEngine: RiskFusionEngine;
  private router: EvacuationRouter;
  private routingZones: RoutingZone[] = [];
  private exitNodeIds: string[] = [];
  private allRoutingZoneIds: string[] = [];

  /** Cooldown: don't spam evacuation plans. Min interval between plans (ms) */
  private lastEvacuationTs: number = 0;
  private evacuationCooldownMs: number = 10_000; // 10 seconds

  constructor() {
    this.riskEngine = new RiskFusionEngine();
    this.router = new EvacuationRouter();
  }

  /**
   * Load the graph from graph.json. Call once at startup.
   */
  loadGraph(graphJsonPath: string): void {
    const raw = fs.readFileSync(graphJsonPath, "utf-8");
    const data: GraphJson = JSON.parse(raw);

    this.routingZones = data.routingZones.map((rz) => ({
      id: rz.id,
      name: rz.name,
      parentAnalysisZoneId: rz.parentAnalysisZoneId,
    }));
    this.exitNodeIds = data.exits;
    this.allRoutingZoneIds = data.routingZones.map((rz) => rz.id);

    // Feed routing zones to risk engine (for AZ → Z expansion)
    this.riskEngine.loadRoutingZones(this.routingZones);

    // Feed graph to router
    this.router.loadGraph(
      {
        nodes: data.graph.nodes.map((n) => ({
          id: n.id,
          pos: n.pos,
          label: n.label,
          kind: n.kind as any,
        })),
        edges: data.graph.edges,
      },
      data.exits
    );

    console.log(
      `[Pipeline] Loaded graph: ${data.graph.nodes.length} nodes, ` +
        `${data.graph.edges.length} edges, ${data.exits.length} exits, ` +
        `${data.routingZones.length} routing zones`
    );
  }

  /**
   * MAIN FUNCTION: Process one ML perception frame.
   *
   * Call this every time the ML service sends a new frame.
   * Returns everything the server needs to broadcast.
   */
  processMLFrame(frame: PerceptionFrameResult): PipelineOutput {
    // ── Step 1: Fuse risk + detect stampede ──
    const { riskMap, stampedeAlerts } = this.riskEngine.processFrame(frame);

    // ── Step 2: If stampede detected, compute evacuation routes ──
    let evacuationPlan: EvacuationPlan | null = null;
    const routePlans: RoutePlan[] = [];
    const staffMessages: string[] = [];

    if (stampedeAlerts.length > 0) {
      // Collect alert messages for staff
      for (const alert of stampedeAlerts) {
        staffMessages.push(alert.message);
      }

      // Only compute evacuation if cooldown has passed
      const now = Date.now();
      if (now - this.lastEvacuationTs >= this.evacuationCooldownMs) {
        // Get all danger analysis zone IDs
        const dangerAZIds = stampedeAlerts.map((a) => a.analysisZoneId);

        // Compute evacuation for ALL populated zones (not just danger zones)
        // People everywhere need routes in case the stampede spreads
        evacuationPlan = this.router.computeEvacuationPlan(
          riskMap,
          dangerAZIds,
          this.allRoutingZoneIds
        );

        // Convert to schema RoutePlans for WebSocket broadcast
        for (const route of evacuationPlan.routes) {
          routePlans.push(this.router.toRoutePlan(route));
        }

        staffMessages.push(evacuationPlan.summary);
        this.lastEvacuationTs = now;
      }
    }

    return {
      riskMap,
      stampedeAlerts,
      evacuationPlan,
      routePlans,
      staffMessages,
    };
  }

  /**
   * Get current risk for a specific zone (for other modules to query).
   */
  getZoneRisk(analysisZoneId: string): number {
    return this.riskEngine.getZoneRisk(analysisZoneId);
  }
}

// ─────────────────────────────────────────────────────────
// DEMO: Run this file directly to simulate a stampede
// ─────────────────────────────────────────────────────────

function runDemo() {
  console.log("═══════════════════════════════════════════");
  console.log("  SafeFlow Stampede Pipeline — Demo Run");
  console.log("═══════════════════════════════════════════\n");

  const pipeline = new StampedePipeline();
  const graphPath = path.join(__dirname, "graph.json");
  pipeline.loadGraph(graphPath);

  // Simulate 5 frames of ML output, escalating from normal → stampede

  const scenarios: { label: string; frame: PerceptionFrameResult }[] = [
    {
      label: "Frame 1: Normal crowd — low density, low anomaly everywhere",
      frame: {
        ts: Date.now(),
        zones: [
          { zoneId: "AZ1", density: 0.15, anomaly: 0.05, conf: 0.90, peopleCount: 4 },
          { zoneId: "AZ2", density: 0.20, anomaly: 0.08, conf: 0.88, peopleCount: 5 },
          { zoneId: "AZ3", density: 0.10, anomaly: 0.03, conf: 0.92, peopleCount: 3 },
          { zoneId: "AZ4", density: 0.18, anomaly: 0.06, conf: 0.89, peopleCount: 5 },
          { zoneId: "AZ5", density: 0.12, anomaly: 0.04, conf: 0.91, peopleCount: 3 },
          { zoneId: "AZ6", density: 0.08, anomaly: 0.02, conf: 0.93, peopleCount: 2 },
        ],
      },
    },
    {
      label: "Frame 2: Crowd building in AZ2 — density rising, some anomaly",
      frame: {
        ts: Date.now() + 333,
        zones: [
          { zoneId: "AZ1", density: 0.20, anomaly: 0.10, conf: 0.88, peopleCount: 5 },
          { zoneId: "AZ2", density: 0.55, anomaly: 0.30, conf: 0.85, peopleCount: 14 },
          { zoneId: "AZ3", density: 0.15, anomaly: 0.05, conf: 0.90, peopleCount: 4 },
          { zoneId: "AZ4", density: 0.22, anomaly: 0.10, conf: 0.87, peopleCount: 6 },
          { zoneId: "AZ5", density: 0.25, anomaly: 0.12, conf: 0.88, peopleCount: 6 },
          { zoneId: "AZ6", density: 0.10, anomaly: 0.03, conf: 0.92, peopleCount: 3 },
        ],
      },
    },
    {
      label: "Frame 3: AZ2 getting dangerous — high density + rising anomaly",
      frame: {
        ts: Date.now() + 666,
        zones: [
          { zoneId: "AZ1", density: 0.25, anomaly: 0.15, conf: 0.86, peopleCount: 6 },
          { zoneId: "AZ2", density: 0.78, anomaly: 0.55, conf: 0.82, peopleCount: 20 },
          { zoneId: "AZ3", density: 0.20, anomaly: 0.08, conf: 0.89, peopleCount: 5 },
          { zoneId: "AZ4", density: 0.30, anomaly: 0.15, conf: 0.86, peopleCount: 8 },
          { zoneId: "AZ5", density: 0.35, anomaly: 0.20, conf: 0.85, peopleCount: 9 },
          { zoneId: "AZ6", density: 0.12, anomaly: 0.05, conf: 0.91, peopleCount: 3 },
        ],
      },
    },
    {
      label: "Frame 4: STAMPEDE — AZ2 packed + panic motion, AZ5 also rising",
      frame: {
        ts: Date.now() + 1000,
        zones: [
          { zoneId: "AZ1", density: 0.30, anomaly: 0.20, conf: 0.84, peopleCount: 8 },
          { zoneId: "AZ2", density: 0.92, anomaly: 0.75, conf: 0.78, peopleCount: 23 },
          { zoneId: "AZ3", density: 0.22, anomaly: 0.10, conf: 0.88, peopleCount: 6 },
          { zoneId: "AZ4", density: 0.35, anomaly: 0.20, conf: 0.85, peopleCount: 9 },
          { zoneId: "AZ5", density: 0.60, anomaly: 0.50, conf: 0.80, peopleCount: 15 },
          { zoneId: "AZ6", density: 0.15, anomaly: 0.06, conf: 0.90, peopleCount: 4 },
        ],
      },
    },
    {
      label: "Frame 5: CRITICAL — AZ2 full stampede, AZ5 escalating too",
      frame: {
        ts: Date.now() + 1333,
        zones: [
          { zoneId: "AZ1", density: 0.35, anomaly: 0.25, conf: 0.82, peopleCount: 9 },
          { zoneId: "AZ2", density: 0.95, anomaly: 0.88, conf: 0.75, peopleCount: 24 },
          { zoneId: "AZ3", density: 0.25, anomaly: 0.12, conf: 0.87, peopleCount: 6 },
          { zoneId: "AZ4", density: 0.40, anomaly: 0.25, conf: 0.83, peopleCount: 10 },
          { zoneId: "AZ5", density: 0.72, anomaly: 0.62, conf: 0.78, peopleCount: 18 },
          { zoneId: "AZ6", density: 0.18, anomaly: 0.08, conf: 0.89, peopleCount: 5 },
        ],
      },
    },
  ];

  for (const scenario of scenarios) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📹 ${scenario.label}`);
    console.log(`${"─".repeat(60)}`);

    const result = pipeline.processMLFrame(scenario.frame);

    // Print risk map summary
    console.log("\n  Risk Map:");
    for (const az of result.riskMap.analysisZones) {
      const bar = "█".repeat(Math.round(az.risk * 20)).padEnd(20, "░");
      const sev =
        az.severity === "critical"
          ? "🔴"
          : az.severity === "warn"
          ? "🟡"
          : "🟢";
      console.log(
        `    ${sev} ${az.analysisZoneId}: [${bar}] ${(az.risk * 100).toFixed(1)}% ` +
          `(d=${az.density.toFixed(2)} a=${az.anomaly.toFixed(2)} trend=${az.trend >= 0 ? "+" : ""}${az.trend.toFixed(3)})`
      );
    }

    // Print stampede alerts
    if (result.stampedeAlerts.length > 0) {
      console.log("\n  🚨 STAMPEDE ALERTS:");
      for (const alert of result.stampedeAlerts) {
        console.log(`    ${alert.message}`);
      }
    }

    // Print evacuation plan
    if (result.evacuationPlan) {
      console.log(`\n  📋 EVACUATION PLAN (${result.evacuationPlan.routes.length} routes):`);
      console.log(`    ${result.evacuationPlan.summary}`);
      for (let i = 0; i < result.evacuationPlan.routes.length; i++) {
        const route = result.evacuationPlan.routes[i];
        console.log(`\n    Route ${i + 1}: ${route.instruction}`);
      }
    }

    // Print staff messages
    if (result.staffMessages.length > 0 && !result.evacuationPlan) {
      console.log("\n  📢 Staff notifications:");
      for (const msg of result.staffMessages) {
        console.log(`    ${msg}`);
      }
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  Demo complete.");
  console.log(`${"═".repeat(60)}\n`);
}

// Run demo if executed directly
const isDirectRun =
  typeof require !== "undefined" && require.main === module;
if (isDirectRun) {
  runDemo();
}
