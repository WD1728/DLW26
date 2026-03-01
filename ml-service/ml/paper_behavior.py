from __future__ import annotations

from typing import Dict, List


# Crowd-11 labels as described in the paper.
PAPER_CLASS_NAMES: List[str] = [
    "laminar_flow",
    "turbulent_flow",
    "crossing_flows",
    "merging_flow",
    "diverging_flow",
    "gas_free",
    "gas_jammed",
    "static_calm",
    "static_agitated",
    "interacting_crowd",
    "no_crowd",
]


# Hand-crafted mapping from crowd behavior class to safety risk in [0, 1].
# This is used to convert paper-style behavior predictions into an anomaly signal.
PAPER_CLASS_RISK: Dict[str, float] = {
    "no_crowd": 0.00,
    "static_calm": 0.08,
    "gas_free": 0.15,
    "laminar_flow": 0.20,
    "diverging_flow": 0.35,
    "crossing_flows": 0.55,
    "merging_flow": 0.62,
    "static_agitated": 0.68,
    "turbulent_flow": 0.78,
    "gas_jammed": 0.90,
    "interacting_crowd": 0.95,
}


def risk_from_behavior_label(label: str, default: float = 0.5) -> float:
    return float(PAPER_CLASS_RISK.get(label, default))


def expected_risk_from_probs(
    probs: List[float],
    idx_to_class: Dict[int, str],
    default_risk: float = 0.5,
) -> float:
    """
    Expected risk under the model's full probability distribution, not just argmax.

    This is more stable for demos because it naturally softens uncertain predictions.
    """
    if not probs:
        return float(default_risk)

    total = 0.0
    for i, p in enumerate(probs):
        label = idx_to_class.get(int(i), str(i))
        total += float(p) * risk_from_behavior_label(label, default=default_risk)
    return float(total)
