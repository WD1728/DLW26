import { Incident } from "../../../schema";
import { getApiBaseUrl } from "./config";

export const reportIncident = async (
  incident: Incident
): Promise<{ ok: true }> => {
  const response = await fetch(`${getApiBaseUrl()}/incident`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(incident)
  });
  
  if (!response.ok) {
    throw new Error(`Incident report failed: ${response.status}`);
  }

  return response.json();
};
