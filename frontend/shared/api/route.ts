import { RouteRequest, RoutePlan } from '@/shared/schema';
import { API_BASE_URL } from '@/config';

export const requestRoute = async (request: RouteRequest): Promise<RoutePlan> => {
  const response = await fetch(`${API_BASE_URL}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  
  if (!response.ok) {
    throw new Error(`Route request failed: ${response.status}`);
  }
  
  return response.json();
};