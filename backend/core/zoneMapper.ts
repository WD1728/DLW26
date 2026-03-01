import { AnalysisZoneRisk, RoutingZone, RoutingZoneRisk, Severity } from "@schema";

export function expandToRoutingZones(
  analysis: AnalysisZoneRisk[],
  routingZones: RoutingZone[],
  localDeltas: Record<string, number>
): RoutingZoneRisk[] {

  const byAZ: Record<string, AnalysisZoneRisk> =
    Object.fromEntries(analysis.map(a => [a.analysisZoneId, a]));

  return routingZones.map(rz => {

    const parent = byAZ[rz.parentAnalysisZoneId];
    const baseRisk = parent?.risk ?? 0;
    const delta = localDeltas[rz.id] ?? 0;

    const risk = clamp01(baseRisk + delta);

    const severity: Severity =
      risk >= 0.8 ? "critical" :
      risk >= 0.5 ? "warn" : "info";

    return {
      routingZoneId: rz.id,
      parentAnalysisZoneId: rz.parentAnalysisZoneId,
      risk,
      severity,
      localDelta: delta || undefined,
      conf: parent?.conf
    };
  });
}

function clamp01(x:number){
  return Math.max(0, Math.min(1,x));
}