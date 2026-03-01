import { Incident } from '@/shared/schema';
import { API_BASE_URL } from '@/config';

export const reportIncident = async (incident: Incident): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/incident`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(incident)
  });
  
  if (!response.ok) {
    throw new Error(`Incident report failed: ${response.status}`);
  }
};