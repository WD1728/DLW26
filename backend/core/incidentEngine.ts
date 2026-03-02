import { EventEmitter } from "events";
import { Incident } from "@schema";
import { computeLocalDeltas } from "./computeLocalDeltas";

export class IncidentEngine extends EventEmitter {

  private incidents: Incident[] = [];
  private localDeltas: Record<string, number> = {};

  constructor() {
    super();
  }

  /* ================================
     Update incidents
  ================================ */

  setIncidents(incidents: Incident[]) {
    this.incidents = incidents;
    this.recompute();
  }

  addIncident(incident: Incident) {
    this.incidents.push(incident);
    this.recompute();
  }

  clearIncident(id: string) {
    this.incidents = this.incidents.filter(i => i.id !== id);
    this.recompute();
  }

  /* ================================
     Internal recompute
  ================================ */

  private recompute() {
    this.localDeltas = computeLocalDeltas(this.incidents);
    this.emit("incidentUpdated", {
      changedZones: Object.keys(this.localDeltas)
    });
  }

  /* ================================
     Getters
  ================================ */

  getLocalDeltas(): Record<string, number> {
    return this.localDeltas;
  }

  isZoneBlocked(zoneId: string): boolean {
    return (this.localDeltas[zoneId] ?? 0) >= 9999;
  }
}
