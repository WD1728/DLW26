import { PerceptionFrameResult } from "../../../schema";
import { HTTP_ENDPOINTS } from "../backend-contract";
import { getApiBaseUrl } from "./config";

export const sendPerceptionFrame = async (
  frame: PerceptionFrameResult
): Promise<{ ok: true }> => {
  const baseUrl = getApiBaseUrl();

  for (const zone of frame.zones) {
    const risk = Math.max(0, Math.min(1, zone.density * 0.6 + zone.anomaly * 0.4));

    const response = await fetch(`${baseUrl}${HTTP_ENDPOINTS.mockRisk}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zoneId: zone.zoneId,
        risk
      }),
    });

    if (!response.ok) {
      throw new Error(`Perception request failed: ${response.status}`);
    }
  }

  return { ok: true };
};
