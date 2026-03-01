import { PerceptionFrameResult, AnalysisZoneRisk, Severity } from "@schema";

export function fusePerception(frame: PerceptionFrameResult): AnalysisZoneRisk[] {
  return frame.zones.map(z => {
    const risk = clamp01(0.65*z.density + 0.35*z.anomaly);

    const severity: Severity =
      risk >= 0.8 ? "critical" :
      risk >= 0.5 ? "warn" : "info";

    return {
      analysisZoneId: z.zoneId,
      risk,
      density: z.density,
      anomaly: z.anomaly,
      severity,
      conf: z.conf
    };
  });
}

function clamp01(x:number){
  return Math.max(0, Math.min(1,x));
}