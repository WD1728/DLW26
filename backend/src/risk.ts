import { InferPayload, RiskZone, ZoneId } from "./types";
import { riskByZone } from "./state";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// constants for risk calculation
const W_DENS = 0.65;
const W_ANOM = 0.35;

// smoothing
const LAMBDA = 0.7; 
// hysteresis thresholds
const WARN_ON = 0.55;
const WARN_OFF = 0.45;

const CRIT_ON = 0.78;
const CRIT_OFF = 0.68;

export function updateRiskFromInfer(p: InferPayload): RiskZone[] {
  const updated: RiskZone[] = [];

  for (const z of p.zones) {
    const id: ZoneId = z.id;
    const density = clamp01(z.density);
    const anomaly = clamp01(z.anomaly);
    const conf = clamp01(z.conf ?? 1);

    const riskRaw = clamp01(W_DENS * density + W_ANOM * anomaly);

    const prev = riskByZone.get(id);
    const prevRisk = prev?.risk ?? 0;

    // confidence-aware smoothing: if conf is low, we rely more on historical risk (hysteresis helps here too)
    const effLambda = 0.25 + 0.75 * conf; // conf=0 ->0.25, conf=1 ->1.0
    const lambda = LAMBDA * effLambda;

    const risk = clamp01(lambda * riskRaw + (1 - lambda) * prevRisk);

    // hysteresis state machine
    const prevState = prev?.state ?? "normal";
    const state = transition(prevState, risk);

    const rz: RiskZone = {
      id,
      density,
      anomaly,
      conf,
      riskRaw,
      risk,
      state
    };

    riskByZone.set(id, rz);
    updated.push(rz);
  }

  return updated;
}

function transition(prev: RiskZone["state"], risk: number): RiskZone["state"] {
  if (prev === "normal") {
    if (risk >= CRIT_ON) return "critical";
    if (risk >= WARN_ON) return "warn";
    return "normal";
  }

  if (prev === "warn") {
    if (risk >= CRIT_ON) return "critical";
    if (risk <= WARN_OFF) return "normal";
    return "warn";
  }

  // prev === "critical"
  if (risk <= CRIT_OFF) {
    // fall back to warn or normal based on risk level
    if (risk <= WARN_OFF) return "normal";
    return "warn";
  }
  return "critical";
}