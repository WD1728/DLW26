import type { AnalysisZoneRisk, RoutingZone, RoutingZoneRisk, Severity } from "../../schema";

/**
 * Expand analysis-zone risk (EMA-based) to routing zones.
 * Does NOT mix in local deltas. Risk remains perception-derived only.
 */
export function expandToRoutingZones(
  analysis: AnalysisZoneRisk[],
  routingZones: RoutingZone[]
): RoutingZoneRisk[] {

  const byAZ: Record<string, AnalysisZoneRisk> =
    Object.fromEntries(analysis.map(a => [a.analysisZoneId, a]));

  return routingZones.map(rz => {

    const parent = byAZ[rz.parentAnalysisZoneId];

    const risk = clamp01(parent?.risk ?? 0);

    const severity: Severity =
      risk >= 0.8 ? "critical" :
      risk >= 0.5 ? "warn" : "info";

    return {
      routingZoneId: rz.id,
      parentAnalysisZoneId: rz.parentAnalysisZoneId,
      risk,
      severity,
      conf: parent?.conf
    };
  });
}

function clamp01(x: number) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
