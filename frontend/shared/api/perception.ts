import { PerceptionFrameResult } from "../../../schema";
import { getApiBaseUrl } from "./config";

export const sendPerceptionFrame = async (
  frame: PerceptionFrameResult
): Promise<{ ok: true }> => {
  const response = await fetch(`${getApiBaseUrl()}/perception`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(frame),
  });

  if (!response.ok) {
    throw new Error(`Perception request failed: ${response.status}`);
  }

  return response.json();
};

