import type { Incident } from "../../schema";
import CONFIG from "../src/config";

export function computeLocalDeltas(
  incidents: Incident[]
): Record<string, number> {

  const deltas: Record<string, number> = {};

  for (const inc of incidents) {

    const penalty =
      inc.routingImpact?.hazardPenalty ??
      CONFIG.INCIDENT_PENALTY_DEFAULT;

    if (inc.routingImpact?.affectedRoutingZoneIds) {
      for (const z of inc.routingImpact.affectedRoutingZoneIds) {
        deltas[z] = (deltas[z] ?? 0) + penalty;
      }
    } else {
      deltas[inc.loc.zoneId] =
        (deltas[inc.loc.zoneId] ?? 0) + penalty;
    }
  }

  return deltas;
}
