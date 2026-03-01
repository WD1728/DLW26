import { RoutePlan } from "../../../schema";
import { getApiBaseUrl } from "./config";

export type BackendRouteRequest = {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
};

export const requestRoute = async (
  request: BackendRouteRequest
): Promise<RoutePlan> => {
  const response = await fetch(`${getApiBaseUrl()}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  
  if (!response.ok) {
    throw new Error(`Route request failed: ${response.status}`);
  }
  
  return response.json();
};
