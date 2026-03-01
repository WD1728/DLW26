// backend/core/policyEngine.ts
// Policy layer that converts zone risk state into actionable guidance.
// Output can be broadcast to frontend via WebSocket.

import type { Severity, Trend, ZoneRiskOutput } from "./stateEngine";

export type AdvisoryAction =
  | "NONE"
  | "MONITOR"
  | "SLOW_DOWN"
  | "PREPARE_DIVERT"
  | "DIVERT"
  | "DISPERSE"
  | "CLOSE_ENTRY"
  | "OPEN_EXIT"
  | "CALL_STAFF";

export type RoutingMode = "normal" | "heightened" | "evacuation";

export interface ZoneContext {
  zoneId: string; // routing zone or analysis zone, your choice
  // Optional metadata from zoneMapper/map.json if you have it
  label?: string;
  isExit?: boolean;
  isEntry?: boolean;
  neighbors?: string[];
}

export interface Advisory {
  ts: number;
  zoneId: string;

  severity: Severity;
  trend: Trend;

  action: AdvisoryAction;
  routingMode: RoutingMode;

  // Human-facing
  messageShort: string;
  messageLong?: string;

  // Machine-facing knobs (for routing engine / UI)
  suggestedPenaltyMultiplier: number; // multiply risk penalty scale
  suggestedReroute: boolean;

  // Optional: which exits to open / entries to close
  directives?: {
    openExits?: string[];
    closeEntries?: string[];
    notifyRoles?: string[]; // e.g. ["security", "ops"]
  };

  // Debug
  rationale?: {
    riskEma: number;
    slopePerSec: number;
  };
}

export interface PolicyEngineConfig {
  // thresholds to trigger proactive guidance
  risingWarnSlope: number;     // risk/sec above which warn+rising becomes more aggressive
  risingCriticalSlope: number; // risk/sec above which critical+rising triggers evacuation actions

  // penalty multipliers by severity/mode
  penaltyMultiplierInfo: number;
  penaltyMultiplierWarn: number;
  penaltyMultiplierCritical: number;

  // reroute trigger control
  rerouteOnWarn: boolean;
  rerouteOnCritical: boolean;

  // message templates
  zoneNameFallbackPrefix: string;
}

export class PolicyEngine {
  private cfg: PolicyEngineConfig;

  constructor(cfg?: Partial<PolicyEngineConfig>) {
    this.cfg = {
      risingWarnSlope: 0.10,
      risingCriticalSlope: 0.15,

      penaltyMultiplierInfo: 1.0,
      penaltyMultiplierWarn: 1.8,
      penaltyMultiplierCritical: 3.0,

      rerouteOnWarn: true,
      rerouteOnCritical: true,

      zoneNameFallbackPrefix: "Zone ",
      ...cfg,
    };
  }

  /**
   * Generate advisory for a zone given the stateEngine output (riskEma/severity/trend).
   * You can pass a ZoneContext if you have map metadata.
   */
  generate(zone: ZoneRiskOutput, ctx?: ZoneContext): Advisory {
    const name = ctx?.label ?? `${this.cfg.zoneNameFallbackPrefix}${zone.zoneId}`;
    const ts = zone.ts;

    const { severity, trend, slopePerSec } = zone;

    // Decide routing mode + action
    let routingMode: RoutingMode = "normal";
    let action: AdvisoryAction = "NONE";
    let penaltyMult = this.cfg.penaltyMultiplierInfo;
    let suggestedReroute = false;

    // Messages
    let shortMsg = "";
    let longMsg: string | undefined;

    if (severity === "info") {
      routingMode = "normal";
      action = trend === "rising" ? "MONITOR" : "NONE";
      penaltyMult = this.cfg.penaltyMultiplierInfo;
      suggestedReroute = false;

      shortMsg =
        action === "MONITOR"
          ? `Monitoring ${name} (risk rising).`
          : `Normal conditions in ${name}.`;
    }

    if (severity === "warn") {
      routingMode = "heightened";
      penaltyMult = this.cfg.penaltyMultiplierWarn;
      suggestedReroute = this.cfg.rerouteOnWarn;

      // If warn + rising fast => prepare divert / divert
      if (trend === "rising" && slopePerSec >= this.cfg.risingWarnSlope) {
        action = "PREPARE_DIVERT";
        shortMsg = `Crowd building in ${name}. Prepare to divert.`;
        longMsg =
          `Risk is rising in ${name}. Redirect flow early to reduce congestion and avoid counter-flow.`;
      } else {
        action = "SLOW_DOWN";
        shortMsg = `Caution in ${name}. Slow down and keep moving.`;
        longMsg =
          `Moderate risk detected in ${name}. Reduce speed, avoid stopping, and follow guidance.`;
      }
    }

    if (severity === "critical") {
      routingMode = "evacuation";
      penaltyMult = this.cfg.penaltyMultiplierCritical;
      suggestedReroute = this.cfg.rerouteOnCritical;

      // If critical and rising quickly => escalate to disperse/close entry/call staff
      if (trend === "rising" && slopePerSec >= this.cfg.risingCriticalSlope) {
        action = "DISPERSE";
        shortMsg = `Critical congestion in ${name}. Disperse immediately.`;
        longMsg =
          `High risk and worsening conditions in ${name}. Initiate crowd dispersal, open alternative exits, and close incoming entries.`;
      } else {
        action = "DIVERT";
        shortMsg = `Critical risk in ${name}. Rerouting to safer paths.`;
        longMsg =
          `Severe congestion detected in ${name}. Avoid this area and follow evacuation routing.`;
      }
    }

    // Optional directives based on zone type (entry/exit)
    const directives: Advisory["directives"] = {};
    if (severity === "critical") {
      directives.notifyRoles = ["security", "ops"];
      if (ctx?.isEntry) directives.closeEntries = [zone.zoneId];
      if (ctx?.isExit) directives.openExits = [zone.zoneId];
      // In a real system you would pick neighbor exits/entries; this is a safe default.
    }

    // If no directive actually set, remove it to keep payload clean
    const hasDirectives =
      (directives.openExits && directives.openExits.length) ||
      (directives.closeEntries && directives.closeEntries.length) ||
      (directives.notifyRoles && directives.notifyRoles.length);

    return {
      ts,
      zoneId: zone.zoneId,
      severity,
      trend,
      action,
      routingMode,
      messageShort: shortMsg,
      messageLong: longMsg,
      suggestedPenaltyMultiplier: penaltyMult,
      suggestedReroute,
      directives: hasDirectives ? directives : undefined,
      rationale: {
        riskEma: zone.riskEma,
        slopePerSec: zone.slopePerSec,
      },
    };
  }

  /** Batch generate advisories */
  generateMany(zones: ZoneRiskOutput[], ctxMap?: Map<string, ZoneContext>): Advisory[] {
    return zones.map((z) => this.generate(z, ctxMap?.get(z.zoneId)));
  }
}