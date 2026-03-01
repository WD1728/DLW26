/**
 * risk.ts — Risk Fusion + Stampede Detection
 *
 * Takes the raw ML perception output (per-frame zone data) and:
 * 1. Fuses density + anomaly into a single risk score per analysis zone
 * 2. Applies EWMA smoothing so risk doesn't flicker
 * 3. Applies hysteresis so severity doesn't flip-flop
 * 4. Detects STAMPEDE conditions (high density + high anomaly + rising trend)
 * 5. Expands analysis zone risk → routing zone risk
 * 6. Emits alerts when stampede threshold is crossed
 *
 * INPUT:  ML PerceptionFrameResult (the exact JSON the ML service outputs)
 * OUTPUT: RiskMap + StampedeAlert[] (list of zones where stampede is detected)
 */

// ─── Types (matching schema + ML output) ───

type ID = string;
type EpochMs = number;
type Severity = "info" | "warn" | "critical";
type Confidence = number;

/** What ML service sends per zone (from infer_video.py line 94-101) */
interface ZonePerception {
  zoneId: ID;       // "AZ1", "AZ2", etc.
  density: number;  // 0..1
  anomaly: number;  // 0..1
  conf: number;     // 0..1
  peopleCount: number;
}

/** What ML service sends per frame */
interface PerceptionFrameResult {
  ts: EpochMs;
  zones: ZonePerception[];
}

/** Fused risk per analysis zone */
interface AnalysisZoneRisk {
  analysisZoneId: ID;
  risk: number;
  density: number;
  anomaly: number;
  trend: number;
  severity: Severity;
  conf: Confidence;
}

/** Expanded risk per routing zone */
interface RoutingZoneRisk {
  routingZoneId: ID;
  parentAnalysisZoneId: ID;
  risk: number;
  severity: Severity;
  localDelta?: number;
  conf?: Confidence;
}

/** Full risk map broadcast to clients */
interface RiskMap {
  ts: EpochMs;
  mapId: ID;
  analysisZones: AnalysisZoneRisk[];
  routingZones: RoutingZoneRisk[];
}

/** Routing zone definition (from graph.json) */
interface RoutingZone {
  id: ID;
  name: string;
  parentAnalysisZoneId: ID;
}

/** Stampede alert — emitted when a zone crosses stampede threshold */
export interface StampedeAlert {
  ts: EpochMs;
  analysisZoneId: ID;
  affectedRoutingZoneIds: ID[];
  risk: number;
  density: number;
  anomaly: number;
  trend: number;
  peopleCount: number;
  severity: "warn" | "critical";
  message: string;
}

/** Full output of processing one ML frame */
export interface RiskProcessingResult {
  riskMap: RiskMap;
  stampedeAlerts: StampedeAlert[];
}

// ─── Configuration ───

export interface RiskFusionConfig {
  /** Weight for density in risk formula */
  wDensity: number;
  /** Weight for anomaly in risk formula */
  wAnomaly: number;
  /** Weight for trend (rate of change) in risk formula */
  wTrend: number;

  /** EWMA smoothing factor: higher = more weight on previous value (stability) */
  ewmaAlpha: number;

  /** Hysteresis thresholds — prevents flip-flopping */
  thresholds: {
    /** Risk must EXCEED this to become "warn" */
    warnUp: number;
    /** Risk must DROP BELOW this to go back to "info" from "warn" */
    warnDown: number;
    /** Risk must EXCEED this to become "critical" */
    criticalUp: number;
    /** Risk must DROP BELOW this to go back to "warn" from "critical" */
    criticalDown: number;
  };

  /** Stampede detection thresholds */
  stampede: {
    /** Minimum density to even consider stampede */
    minDensity: number;
    /** Minimum anomaly to consider stampede */
    minAnomaly: number;
    /** Minimum fused risk for stampede warning */
    warnRisk: number;
    /** Minimum fused risk for critical stampede */
    criticalRisk: number;
    /** Minimum positive trend (risk rising) to flag stampede */
    minTrend: number;
  };

  mapId: string;
}

const DEFAULT_CONFIG: RiskFusionConfig = {
  wDensity: 0.45,
  wAnomaly: 0.40,
  wTrend: 0.15,

  ewmaAlpha: 0.35, // 35% previous, 65% new → responsive enough for demo

  thresholds: {
    warnUp: 0.45,
    warnDown: 0.30,
    criticalUp: 0.70,
    criticalDown: 0.50,
  },

  stampede: {
    minDensity: 0.50,
    minAnomaly: 0.40,
    warnRisk: 0.50,
    criticalRisk: 0.70,
    minTrend: 0.01,
  },

  mapId: "mall_demo_v1",
};

// ─── Internal state per analysis zone ───

interface ZoneState {
  prevRisk: number;
  prevDensity: number;
  prevAnomaly: number;
  prevSeverity: Severity;
  /** Trend = smoothed delta of risk over time */
  trend: number;
  /** People count from last frame */
  peopleCount: number;
}

// ─── Utility ───

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ─── The Risk Fusion Engine ───

export class RiskFusionEngine {
  private config: RiskFusionConfig;
  private state: Map<ID, ZoneState> = new Map();
  private routingZones: RoutingZone[] = [];
  /** Maps routing zone ID → parent analysis zone ID */
  private rzToAz: Map<ID, ID> = new Map();

  constructor(config?: Partial<RiskFusionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load routing zones from graph.json so we can expand AZ risk → Z risk.
   */
  loadRoutingZones(routingZones: RoutingZone[]): void {
    this.routingZones = routingZones;
    this.rzToAz.clear();
    for (const rz of routingZones) {
      this.rzToAz.set(rz.id, rz.parentAnalysisZoneId);
    }
  }

  /**
   * MAIN FUNCTION: Process one ML perception frame.
   *
   * Call this every time the ML service sends a new frame result.
   * Returns the fused risk map + any stampede alerts.
   */
  processFrame(
    frame: PerceptionFrameResult,
    localDeltas?: Record<string, number>
  ): RiskProcessingResult {
    const { config } = this;
    const analysisRisks: AnalysisZoneRisk[] = [];
    const stampedeAlerts: StampedeAlert[] = [];

    for (const zp of frame.zones) {
      const azId = zp.zoneId; // "AZ1", "AZ2", etc.

      // ── Get or initialize state for this zone ──
      let s = this.state.get(azId);
      if (!s) {
        s = {
          prevRisk: 0,
          prevDensity: 0,
          prevAnomaly: 0,
          prevSeverity: "info",
          trend: 0,
          peopleCount: 0,
        };
        this.state.set(azId, s);
      }

      // ── 1. Compute raw risk from ML signals ──
      const rawRisk = clamp01(
        config.wDensity * zp.density +
        config.wAnomaly * zp.anomaly +
        config.wTrend * Math.max(0, s.trend) // only positive trend increases risk
      );

      // ── 2. EWMA smoothing ──
      const smoothedRisk = clamp01(
        config.ewmaAlpha * s.prevRisk +
        (1 - config.ewmaAlpha) * rawRisk
      );

      // ── 3. Compute trend (is risk rising or falling?) ──
      const riskDelta = smoothedRisk - s.prevRisk;
      // Smooth the trend too, so a single spike doesn't trigger
      const smoothedTrend = 0.6 * s.trend + 0.4 * riskDelta;

      // ── 4. Apply hysteresis for severity ──
      const severity = this.applySeverityHysteresis(
        smoothedRisk,
        s.prevSeverity
      );

      // ── 5. Build the analysis zone risk object ──
      const azRisk: AnalysisZoneRisk = {
        analysisZoneId: azId,
        risk: Math.round(smoothedRisk * 1000) / 1000, // 3 decimal places
        density: zp.density,
        anomaly: zp.anomaly,
        trend: Math.round(smoothedTrend * 1000) / 1000,
        severity,
        conf: zp.conf,
      };
      analysisRisks.push(azRisk);

      // ── 6. Check for stampede conditions ──
      const alert = this.checkStampede(azRisk, zp.peopleCount, frame.ts);
      if (alert) {
        stampedeAlerts.push(alert);
      }

      // ── 7. Update state for next frame ──
      s.prevRisk = smoothedRisk;
      s.prevDensity = zp.density;
      s.prevAnomaly = zp.anomaly;
      s.prevSeverity = severity;
      s.trend = smoothedTrend;
      s.peopleCount = zp.peopleCount;
    }

    // ── 8. Expand to routing zones ──
    const routingRisks = this.expandToRoutingZones(analysisRisks, localDeltas);

    const riskMap: RiskMap = {
      ts: frame.ts,
      mapId: config.mapId,
      analysisZones: analysisRisks,
      routingZones: routingRisks,
    };

    return { riskMap, stampedeAlerts };
  }

  /**
   * Get the current risk for a specific analysis zone.
   * Useful for other modules checking zone state.
   */
  getZoneRisk(analysisZoneId: ID): number {
    return this.state.get(analysisZoneId)?.prevRisk ?? 0;
  }

  /**
   * Get all zones currently at or above a given severity.
   */
  getZonesAtSeverity(minSeverity: "warn" | "critical"): ID[] {
    const result: ID[] = [];
    for (const [azId, s] of this.state) {
      if (minSeverity === "warn" && (s.prevSeverity === "warn" || s.prevSeverity === "critical")) {
        result.push(azId);
      } else if (minSeverity === "critical" && s.prevSeverity === "critical") {
        result.push(azId);
      }
    }
    return result;
  }

  // ─── Private helpers ───

  /**
   * Hysteresis: once a zone is "critical", it stays critical until risk drops
   * below criticalDown (not just below criticalUp). This prevents flickering.
   */
  private applySeverityHysteresis(
    risk: number,
    prevSeverity: Severity
  ): Severity {
    const t = this.config.thresholds;

    if (prevSeverity === "critical") {
      // Stay critical unless risk drops significantly
      if (risk < t.criticalDown) return risk >= t.warnUp ? "warn" : "info";
      return "critical";
    }

    if (prevSeverity === "warn") {
      // Escalate to critical?
      if (risk >= t.criticalUp) return "critical";
      // Drop back to info?
      if (risk < t.warnDown) return "info";
      return "warn";
    }

    // Was "info" — check if we should escalate
    if (risk >= t.criticalUp) return "critical";
    if (risk >= t.warnUp) return "warn";
    return "info";
  }

  /**
   * Stampede detection: high density + high anomaly + rising risk = stampede.
   *
   * The ML anomaly score already captures panic-like motion (high direction
   * entropy, high turbulence, sudden speed changes) via the Isolation Forest
   * or the fallback formula:
   *   anomaly = 0.45*dir_entropy + 0.35*turbulence + 0.20*pressure
   *
   * So when anomaly is high AND density is high, that's a stampede signature.
   */
  private checkStampede(
    azRisk: AnalysisZoneRisk,
    peopleCount: number,
    ts: EpochMs
  ): StampedeAlert | null {
    const s = this.config.stampede;

    // Must meet ALL conditions to be a stampede risk
    if (azRisk.density < s.minDensity) return null;
    if (azRisk.anomaly < s.minAnomaly) return null;
    if (azRisk.risk < s.warnRisk) return null;

    // Determine severity
    const severity: "warn" | "critical" =
      azRisk.risk >= s.criticalRisk && azRisk.trend >= s.minTrend
        ? "critical"
        : "warn";

    // Find which routing zones belong to this analysis zone
    const affectedRoutingZoneIds = this.routingZones
      .filter((rz) => rz.parentAnalysisZoneId === azRisk.analysisZoneId)
      .map((rz) => rz.id);

    const zoneName = azRisk.analysisZoneId;
    const message =
      severity === "critical"
        ? `🚨 STAMPEDE RISK CRITICAL in ${zoneName}: density=${azRisk.density.toFixed(2)}, ` +
          `anomaly=${azRisk.anomaly.toFixed(2)}, ${peopleCount} people, risk rising. ` +
          `Immediate evacuation recommended.`
        : `⚠️ Stampede risk elevated in ${zoneName}: density=${azRisk.density.toFixed(2)}, ` +
          `anomaly=${azRisk.anomaly.toFixed(2)}, ${peopleCount} people. Monitor closely.`;

    return {
      ts,
      analysisZoneId: azRisk.analysisZoneId,
      affectedRoutingZoneIds,
      risk: azRisk.risk,
      density: azRisk.density,
      anomaly: azRisk.anomaly,
      trend: azRisk.trend,
      peopleCount,
      severity,
      message,
    };
  }

  /**
   * Expand analysis zone risks → routing zone risks.
   * Each routing zone inherits its parent AZ's risk, plus any local deltas
   * from active incidents.
   */
  private expandToRoutingZones(
    analysisRisks: AnalysisZoneRisk[],
    localDeltas?: Record<string, number>
  ): RoutingZoneRisk[] {
    const byAZ = new Map(analysisRisks.map((r) => [r.analysisZoneId, r]));

    return this.routingZones.map((rz) => {
      const parent = byAZ.get(rz.parentAnalysisZoneId);
      const baseRisk = parent?.risk ?? 0;
      const delta = localDeltas?.[rz.id] ?? 0;
      const risk = clamp01(baseRisk + delta);

      const severity: Severity =
        risk >= 0.75 ? "critical" : risk >= 0.5 ? "warn" : "info";

      return {
        routingZoneId: rz.id,
        parentAnalysisZoneId: rz.parentAnalysisZoneId,
        risk,
        severity,
        localDelta: delta || undefined,
        conf: parent?.conf,
      };
    });
  }
}

export type {
  PerceptionFrameResult,
  ZonePerception,
  RiskMap,
  AnalysisZoneRisk,
  RoutingZoneRisk,
  RoutingZone,
  RiskFusionConfig,
  Severity,
  ID,
  EpochMs,
};
