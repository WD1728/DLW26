import type { RoutePlan } from "../../../schema";
import {
  HTTP_ENDPOINTS,
  type LegacyRouteRequest,
  type RouteRequest,
  toRouteRequest,
} from "../../../shared/backend-contract";
import { getApiBaseUrl } from "./config";

export type BackendRouteRequest = RouteRequest | LegacyRouteRequest;

export const requestRoute = async (
  request: BackendRouteRequest
): Promise<RoutePlan> => {
  const payload = toRouteRequest(request);

  const response = await fetch(`${getApiBaseUrl()}${HTTP_ENDPOINTS.route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Route request failed: ${response.status}`);
  }

  return response.json();
};
