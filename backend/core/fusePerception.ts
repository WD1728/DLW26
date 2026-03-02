import { PerceptionFrameResult } from "@schema";

/* =====================================
   Types
===================================== */

export type Severity = "info" | "warn" | "critical";

export interface AnalysisZoneRisk {
  analysisZoneId: string;
  risk: number;        // normalized 0–1
  density: number;     // raw input
  anomaly: number;     // raw input
  severity: Severity;
  confidence: number;  // 0–1
  timestamp: number;
}

/* =====================================
   Configurable Parameters
===================================== */

const WEIGHTS = {
  density: 0.6,
  anomaly: 0.4
};

const SEVERITY_THRESHOLDS = {
  warn: 0.5,
  critical: 0.8
};

/* =====================================
   Risk Fusion
===================================== */

export function fusePerception(
  frame: PerceptionFrameResult
): AnalysisZoneRisk[] {

  const now = Date.now();

  return frame.zones.map(zone => {

    // 1. Linear weighted fusion
    const rawRisk =
      WEIGHTS.density * zone.density +
      WEIGHTS.anomaly * zone.anomaly;

    // 2. Confidence modulation
    const confidenceAdjustedRisk =
      rawRisk * clamp01(zone.conf);

    // 3. Normalization
    const risk = clamp01(confidenceAdjustedRisk);

    // 4. Severity classification
    const severity: Severity =
      risk >= SEVERITY_THRESHOLDS.critical
        ? "critical"
        : risk >= SEVERITY_THRESHOLDS.warn
        ? "warn"
        : "info";

    return {
      analysisZoneId: zone.zoneId,
      risk,
      density: zone.density,
      anomaly: zone.anomaly,
      severity,
      confidence: zone.conf,
      timestamp: now
    };
  });
}

/* =====================================
   Utilities
===================================== */

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
