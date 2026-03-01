import { EventEmitter } from "events";
import type { PerceptionFrameResult } from "../../schema";
import { fusePerception } from "./fusePerception";
import zoneMapping from "../data/zoneMapping.json";
import { RiskStateEngine } from "./stateEngine";

type Severity = "info" | "warn" | "critical";

export interface AnalysisZoneRiskSnapshot {
  analysisZoneId: string;
  riskRaw: number;      // 0..1 (from fusePerception)
  riskEma: number;      // 0..1 (from state engine)
  severity: Severity;   // from state engine
  trend: "rising" | "falling" | "flat";
  slopePerSec: number;
  ts: number;

  density?: number;
  anomaly?: number;
  conf?: number;
}

export interface RiskUpdatedEventPayload {
  ts: number;
  changedAnalysisZones: string[];
  changedRoutingZones: string[];
  globalMaxRiskEma: number;
}

export class RiskEngine extends EventEmitter {
  private state: RiskStateEngine;

  private analysisSnapshots = new Map<string, AnalysisZoneRiskSnapshot>();
  private routingZoneRiskEma = new Map<string, number>();

  constructor(cfg?: ConstructorParameters<typeof RiskStateEngine>[0]) {
    super();
    this.state = new RiskStateEngine(cfg);
  }

  /**
   * ML → fusePerception → RiskStateEngine (EMA + hysteresis) → expandToRoutingZones
   */
  ingestFrame(frame: PerceptionFrameResult) {
    const fused = fusePerception(frame);
    const ts = Date.now();

    const outputs = this.state.updateMany(
      fused.map(z => ({
        zoneId: z.analysisZoneId,
        ts,
        riskRaw: z.risk,
        density: z.density,
        anomaly: z.anomaly,
        conf: z.confidence
      }))
    );

    const changedAnalysisZones: string[] = [];

    for (const o of outputs) {
      const prev = this.analysisSnapshots.get(o.zoneId);

      const snapshot: AnalysisZoneRiskSnapshot = {
        analysisZoneId: o.zoneId,
        riskRaw: o.riskRaw,
        riskEma: o.riskEma,
        severity: o.severity,
        trend: o.trend,
        slopePerSec: o.slopePerSec,
        ts: o.ts,
        density: o.density,
        anomaly: o.anomaly,
        conf: o.conf
      };

      this.analysisSnapshots.set(o.zoneId, snapshot);

      // "changed" from RiskStateEngine only flags severity transitions.
      // Also treat significant EMA delta as change for decision triggers.
      const prevEma = prev?.riskEma ?? snapshot.riskEma;
      const emaDelta = Math.abs(snapshot.riskEma - prevEma);

      if (o.changed || emaDelta >= 0.08) {
        changedAnalysisZones.push(o.zoneId);
      }
    }

    const changedRoutingZones = this.expandToRoutingZones(changedAnalysisZones);

    const payload: RiskUpdatedEventPayload = {
      ts,
      changedAnalysisZones,
      changedRoutingZones,
      globalMaxRiskEma: this.getGlobalMaxRiskEma()
    };

    // Emit always if you want maximum reactivity:
    // this.emit("riskUpdated", payload);

    // Emit only when meaningful changes happened:
    if (changedAnalysisZones.length > 0 || changedRoutingZones.length > 0) {
      this.emit("riskUpdated", payload);
    }
  }

  /**
   * Expand analysis-zone EMA risk to routing zones using routingToAnalysis mapping.
   * Returns routing zones that changed by >= threshold.
   */
  private expandToRoutingZones(changedAnalysisZones?: string[]): string[] {
    const routingToAnalysis = (zoneMapping as any).routingToAnalysis as Record<string, string>;
    const changedRoutingZones: string[] = [];

    // If you want smarter diffing: only recompute routing zones whose parent AZ changed.
    // Otherwise recompute all routing zones (still cheap for small maps).
    const shouldDiff = Array.isArray(changedAnalysisZones) && changedAnalysisZones.length > 0;

    for (const routingZoneId of Object.keys(routingToAnalysis)) {
      const analysisZoneId = routingToAnalysis[routingZoneId];

      if (shouldDiff && !changedAnalysisZones!.includes(analysisZoneId)) {
        continue;
      }

      const ema = this.analysisSnapshots.get(analysisZoneId)?.riskEma ?? 0;
      const prev = this.routingZoneRiskEma.get(routingZoneId) ?? 0;

      this.routingZoneRiskEma.set(routingZoneId, ema);

      if (Math.abs(ema - prev) >= 0.08) {
        changedRoutingZones.push(routingZoneId);
      }
    }

    // If diffing skipped zones, ensure routingZoneRiskEma exists for all zones at least once.
    if (!shouldDiff) return changedRoutingZones;

    // One-time initialization fallback: if map expanded, fill missing routing zones.
    for (const routingZoneId of Object.keys(routingToAnalysis)) {
      if (!this.routingZoneRiskEma.has(routingZoneId)) {
        const analysisZoneId = routingToAnalysis[routingZoneId];
        const ema = this.analysisSnapshots.get(analysisZoneId)?.riskEma ?? 0;
        this.routingZoneRiskEma.set(routingZoneId, ema);
        changedRoutingZones.push(routingZoneId);
      }
    }

    return changedRoutingZones;
  }

  /**
   * Routing-zone EMA risk (0..1)
   */
  getZoneRisk(routingZoneId: string): number {
    return this.routingZoneRiskEma.get(routingZoneId) ?? 0;
  }

  /**
   * Returns a plain object snapshot for routing risk.
   */
  getAllZoneRisk(): Record<string, number> {
    return Object.fromEntries(this.routingZoneRiskEma.entries());
  }

  /**
   * Analysis-zone snapshots (EMA + severity + trend). Useful for debugging / UI.
   */
  getAnalysisSnapshots(): Record<string, AnalysisZoneRiskSnapshot> {
    return Object.fromEntries(this.analysisSnapshots.entries());
  }

  getGlobalMaxRiskEma(): number {
    let m = 0;
    for (const s of this.analysisSnapshots.values()) {
      if (s.riskEma > m) m = s.riskEma;
    }
    return m;
  }

  /**
   * Testing hook: override routing zone EMA risk directly.
   * Use this to validate auto-reroute logic without ML.
   */
  setZoneRisk(routingZoneId: string, riskEma: number) {
    const clamped = clamp01(riskEma);
    const prev = this.routingZoneRiskEma.get(routingZoneId) ?? 0;
    this.routingZoneRiskEma.set(routingZoneId, clamped);

    const payload: RiskUpdatedEventPayload = {
      ts: Date.now(),
      changedAnalysisZones: [],
      changedRoutingZones: Math.abs(clamped - prev) >= 0.01 ? [routingZoneId] : [],
      globalMaxRiskEma: this.getGlobalMaxRiskEma()
    };

    this.emit("riskUpdated", payload);
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
