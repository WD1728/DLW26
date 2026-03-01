const DEFAULT_HTTP_BASE_URL = "http://localhost:8080";
const DEFAULT_WS_BASE_URL = "ws://localhost:8080";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

export function getApiBaseUrl(): string {
  const fromExpo = readEnv("EXPO_PUBLIC_API_BASE_URL");
  const fromCra = readEnv("REACT_APP_API_BASE_URL");
  return normalizeBaseUrl(fromExpo || fromCra || DEFAULT_HTTP_BASE_URL);
}

export function getWsBaseUrl(): string {
  const fromExpo = readEnv("EXPO_PUBLIC_WS_BASE_URL");
  const fromCra = readEnv("REACT_APP_WS_BASE_URL");
  return normalizeBaseUrl(fromExpo || fromCra || DEFAULT_WS_BASE_URL);
}
