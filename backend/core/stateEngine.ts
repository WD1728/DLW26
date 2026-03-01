// backend/core/stateEngine.ts
export type Severity = "info" | "warn" | "critical";
export type Trend = "rising" | "falling" | "flat";

export interface ZoneRiskInput {
  zoneId: string;
  ts: number;
  riskRaw: number;   // 0..1
  density?: number;  // 0..1
  anomaly?: number;  // 0..1
  conf?: number;     // 0..1
}

export interface ZoneRiskState {
  zoneId: string;
  riskEma: number;
  lastRiskRaw: number;

  trend: Trend;
  slopePerSec: number;

  severity: Severity;
  lastSeverityChangeTs: number;

  lastTs: number;
  sampleCount: number;

  aboveWarnMs: number;
  aboveCriticalMs: number;
  belowWarnMs: number;
  belowCriticalMs: number;
}

export interface ZoneRiskOutput {
  zoneId: string;
  ts: number;
  riskRaw: number;
  riskEma: number;
  trend: Trend;
  slopePerSec: number;
  severity: Severity;
  changed: boolean;

  density?: number;
  anomaly?: number;
  conf?: number;
}

export interface StateEngineConfig {
  emaAlpha: number;

  warnUp: number;
  warnDown: number;
  criticalUp: number;
  criticalDown: number;

  toWarnHoldMs: number;
  toCriticalHoldMs: number;
  toInfoHoldMs: number;
  toWarnFromCriticalHoldMs: number;

  minChangeIntervalMs: number;

  slopeEps: number;
  clampToUnit: boolean;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function classifyTrend(slopePerSec: number, eps: number): Trend {
  if (slopePerSec > eps) return "rising";
  if (slopePerSec < -eps) return "falling";
  return "flat";
}

export class RiskStateEngine {
  private cfg: StateEngineConfig;
  private states = new Map<string, ZoneRiskState>();

  constructor(cfg?: Partial<StateEngineConfig>) {
    this.cfg = {
      emaAlpha: 0.35,

      warnUp: 0.55,
      warnDown: 0.45,
      criticalUp: 0.8,
      criticalDown: 0.65,

      toWarnHoldMs: 1200,
      toCriticalHoldMs: 900,
      toInfoHoldMs: 2000,
      toWarnFromCriticalHoldMs: 1500,

      minChangeIntervalMs: 1200,

      slopeEps: 0.05,
      clampToUnit: true,
      ...cfg,
    };

    if (!(this.cfg.emaAlpha > 0 && this.cfg.emaAlpha <= 1)) {
      throw new Error("emaAlpha must be in (0,1].");
    }
    if (!(this.cfg.warnDown < this.cfg.warnUp)) {
      throw new Error("warnDown must be < warnUp.");
    }
    if (!(this.cfg.criticalDown < this.cfg.criticalUp)) {
      throw new Error("criticalDown must be < criticalUp.");
    }
  }

  update(input: ZoneRiskInput): ZoneRiskOutput {
    const zoneId = input.zoneId;
    const ts = input.ts;

    let riskRaw = input.riskRaw;
    if (this.cfg.clampToUnit) riskRaw = clamp01(riskRaw);

    const prev = this.states.get(zoneId);

    if (!prev) {
      const sev: Severity =
        riskRaw >= this.cfg.criticalUp ? "critical" :
        riskRaw >= this.cfg.warnUp ? "warn" : "info";

      const init: ZoneRiskState = {
        zoneId,
        riskEma: riskRaw,
        lastRiskRaw: riskRaw,
        trend: "flat",
        slopePerSec: 0,
        severity: sev,
        lastSeverityChangeTs: ts,
        lastTs: ts,
        sampleCount: 1,
        aboveWarnMs: 0,
        aboveCriticalMs: 0,
        belowWarnMs: 0,
        belowCriticalMs: 0,
      };
      this.states.set(zoneId, init);

      return {
        zoneId,
        ts,
        riskRaw,
        riskEma: init.riskEma,
        trend: init.trend,
        slopePerSec: init.slopePerSec,
        severity: init.severity,
        changed: false,
        density: input.density,
        anomaly: input.anomaly,
        conf: input.conf,
      };
    }

    const dtMs = Math.max(0, ts - prev.lastTs);
    const dtSec = dtMs / 1000;

    const alpha = this.cfg.emaAlpha;
    const riskEma = alpha * riskRaw + (1 - alpha) * prev.riskEma;

    let slopePerSec = prev.slopePerSec;
    if (dtSec > 0) slopePerSec = (riskEma - prev.riskEma) / dtSec;
    const trend = classifyTrend(slopePerSec, this.cfg.slopeEps);

    const aboveWarn = riskEma >= this.cfg.warnUp;
    const aboveCritical = riskEma >= this.cfg.criticalUp;
    const belowWarn = riskEma <= this.cfg.warnDown;
    const belowCritical = riskEma <= this.cfg.criticalDown;

    let aboveWarnMs = aboveWarn ? prev.aboveWarnMs + dtMs : 0;
    let aboveCriticalMs = aboveCritical ? prev.aboveCriticalMs + dtMs : 0;
    let belowWarnMs = belowWarn ? prev.belowWarnMs + dtMs : 0;
    let belowCriticalMs = belowCritical ? prev.belowCriticalMs + dtMs : 0;

    const nowSeverity = prev.severity;
    const canChange = (ts - prev.lastSeverityChangeTs) >= this.cfg.minChangeIntervalMs;

    let nextSeverity: Severity = nowSeverity;

    if (canChange) {
      if (nowSeverity === "info") {
        if (aboveWarnMs >= this.cfg.toWarnHoldMs) nextSeverity = "warn";
      } else if (nowSeverity === "warn") {
        if (aboveCriticalMs >= this.cfg.toCriticalHoldMs) nextSeverity = "critical";
        else if (belowWarnMs >= this.cfg.toInfoHoldMs) nextSeverity = "info";
      } else {
        if (belowCriticalMs >= this.cfg.toWarnFromCriticalHoldMs) nextSeverity = "warn";
      }
    }

    const changed = nextSeverity !== nowSeverity;

    const updated: ZoneRiskState = {
      ...prev,
      riskEma,
      lastRiskRaw: riskRaw,
      trend,
      slopePerSec,
      severity: nextSeverity,
      lastSeverityChangeTs: changed ? ts : prev.lastSeverityChangeTs,
      lastTs: ts,
      sampleCount: prev.sampleCount + 1,
      aboveWarnMs,
      aboveCriticalMs,
      belowWarnMs,
      belowCriticalMs,
    };

    this.states.set(zoneId, updated);

    return {
      zoneId,
      ts,
      riskRaw,
      riskEma,
      trend,
      slopePerSec,
      severity: nextSeverity,
      changed,
      density: input.density,
      anomaly: input.anomaly,
      conf: input.conf,
    };
  }

  updateMany(inputs: ZoneRiskInput[]): ZoneRiskOutput[] {
    return inputs.map((x) => this.update(x));
  }
}