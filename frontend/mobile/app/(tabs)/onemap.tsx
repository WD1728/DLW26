import React, { useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

function getDefaultHost(): string {
  const maybeLocation = (globalThis as { location?: { hostname?: string } }).location;
  return maybeLocation?.hostname || "localhost";
}

function getApiBaseUrl(): string {
  const fromExpo = String(readEnv("EXPO_PUBLIC_API_BASE_URL") || "").trim();
  if (fromExpo) return fromExpo.replace(/\/+$/, "");
  return `http://${getDefaultHost()}:8080`;
}

function buildMapHtml(apiBaseUrl: string): string {
  void apiBaseUrl;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""
    />
    <style>
      html, body, #map { margin: 0; width: 100%; height: 100%; background: #0f2b46; }
      .leaflet-popup-content { font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 12px; }
      .map-status {
        position: absolute;
        z-index: 999;
        left: 8px;
        top: 8px;
        background: rgba(15,43,70,0.86);
        color: #dff2ff;
        border: 1px solid rgba(121,187,207,0.55);
        border-radius: 8px;
        padding: 6px 8px;
        font: 12px/1.35 -apple-system, Segoe UI, Roboto, sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div id="status" class="map-status">Loading OneMap tiles...</div>

    <script
      src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
      crossorigin=""
    ></script>
    <script>
      (function () {
        const statusEl = document.getElementById("status");
        const map = L.map("map", {
          center: [1.3521, 103.8198],
          zoom: 11,
          minZoom: 11,
          maxZoom: 20,
          zoomSnap: 0.25
        });

        L.tileLayer("https://www.onemap.gov.sg/maps/tiles/Default_HD/{z}/{x}/{y}.png", {
          attribution: "Map data (c) OpenStreetMap contributors, OneMap, Singapore Land Authority",
          maxNativeZoom: 20,
          maxZoom: 20
        }).addTo(map);
        statusEl.textContent = "OneMap tiles ready.";
      })();
    </script>
  </body>
</html>`;
}

export default function OneMapScreen() {
  const [mapStatus, setMapStatus] = useState("loading");
  const [reloadToken, setReloadToken] = useState(0);
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const html = useMemo(() => buildMapHtml(apiBaseUrl), [apiBaseUrl]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>OneMap Singapore</Text>
          <Text style={styles.subtitle}>OneMap tiles only</Text>
        </View>
        <Pressable
          style={styles.reloadButton}
          onPress={() => {
            setReloadToken((v) => v + 1);
            setMapStatus("loading");
          }}>
          <Text style={styles.reloadButtonText}>Reload</Text>
        </Pressable>
      </View>

      <View style={styles.mapWrap}>
        {Platform.OS === "web" ? (
          <iframe
            key={reloadToken}
            title="OneMap Singapore"
            srcDoc={html}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
            style={{ width: "100%", height: "100%", border: 0 }}
            onLoad={() => setMapStatus("ready")}
          />
        ) : (
          (() => {
            const NativeWebView = require("react-native-webview").WebView as React.ComponentType<any>;
            return (
              <NativeWebView
                key={reloadToken}
                source={{ html, baseUrl: apiBaseUrl }}
                style={styles.mapWebView}
                onLoadStart={() => setMapStatus("loading")}
                onLoadEnd={() => setMapStatus("ready")}
                onError={(event: any) => {
                  const msg = event.nativeEvent?.description || "webview_error";
                  setMapStatus(`error:${msg}`);
                }}
                onHttpError={(event: any) => {
                  const code = event.nativeEvent?.statusCode;
                  setMapStatus(`http_error:${code}`);
                }}
              />
            );
          })()
        )}
      </View>

      <Text style={styles.statusText}>Map status: {mapStatus}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0F2B46",
    paddingTop: 14,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  title: {
    color: "#F4FAFF",
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    marginTop: 4,
    color: "#BFD5E6",
    fontSize: 13,
    fontWeight: "500",
  },
  reloadButton: {
    backgroundColor: "#1B6DAE",
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  reloadButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 12,
  },
  mapWrap: {
    flex: 1,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2D5A7D",
    backgroundColor: "#12344F",
  },
  mapWebView: {
    flex: 1,
    backgroundColor: "#12344F",
  },
  statusText: {
    marginTop: 10,
    color: "#BFD5E6",
    fontSize: 12,
  },
});
