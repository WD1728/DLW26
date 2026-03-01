import { RouteAssessment } from "./types";

export class RouteEvaluator {
  constructor(
    private getZoneRisk: (zoneId: string) => number,
    private getZoneIncident: (zoneId: string) => boolean,
    private getZoneLoadRatio: (zoneId: string) => number
  ) {}

  evaluate(routeZones: string[]): RouteAssessment {
    let maxRisk = 0;
    let hasIncidentBlock = false;
    let congestionViolationSoon = false;
    let entersHighRiskSoon = false;
    const violatingZones: string[] = [];

    for (let i = 0; i < Math.min(routeZones.length, 6); i++) {
      const zone = routeZones[i];
      const risk = this.getZoneRisk(zone);
      const incident = this.getZoneIncident(zone);
      const loadRatio = this.getZoneLoadRatio(zone);

      maxRisk = Math.max(maxRisk, risk);

      if (incident) {
        hasIncidentBlock = true;
        violatingZones.push(zone);
      }

      if (risk >= 0.75) {
        entersHighRiskSoon = true;
        violatingZones.push(zone);
      }

      if (loadRatio >= 1.15) {
        congestionViolationSoon = true;
        violatingZones.push(zone);
      }
    }

    return {
      hasIncidentBlock,
      entersHighRiskSoon,
      congestionViolationSoon,
      violatingZones,
      maxRisk,
    };
  }
}