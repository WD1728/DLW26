import { Incident } from "../../../schema";
import { HTTP_ENDPOINTS } from "../../../shared/backend-contract";
import { getApiBaseUrl } from "./config";

export const reportIncident = async (
  incident: Incident
): Promise<{ ok: true }> => {
  const response = await fetch(`${getApiBaseUrl()}${HTTP_ENDPOINTS.mockIncident}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(incident)
  });
  
  if (!response.ok) {
    throw new Error(`Incident report failed: ${response.status}`);
  }

  return response.json();
};
