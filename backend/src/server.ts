let riskInputMode: "ml" | "manual" = "manual";

import express from "express";
import cors from "cors";
import http from "http";
import https from "https";
import { WebSocket, WebSocketServer } from "ws";

import { RiskEngine } from "../core/riskEngine";
import { IncidentEngine } from "../core/incidentEngine";
import { RoutingEngine } from "../core/routingEngine";
import { expandToRoutingZones } from "../core/zoneMapper";

import { RouteEvaluator } from "../decision/RouteEvaluator";
import { AutoReroutePolicy } from "../decision/AutoReroutePolicy";
import { ExitSelector } from "../decision/ExitSelector";
import { DecisionOrchestrator } from "../decision/DecisionOrchestrator";

import { WebSocketPublisher } from "../events/WebSocketPublisher";

import mapData from "../data/map.json";
import CONFIG from "./config";
import type { AnalysisZoneRisk, AssistRequest, Incident, PerceptionFrameResult, RiskMap, RoutePlan, WsClientEvent, WsServerEvent } from "../../schema";

/* =====================================================
   App + Server
===================================================== */

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

/* =====================================================
   Global Mode
===================================================== */

let globalMode: "normal" | "alert" | "evacuation" = "normal";

/* =====================================================
   Core Engines
===================================================== */

const riskEngine = new RiskEngine();
const incidentEngine = new IncidentEngine();
const routingEngine = new RoutingEngine(mapData);

/* =====================================================
   ML Frame Ingestion Hook
===================================================== */

function onMLFrame(frame: any) {

  if (riskInputMode === "ml") {
    riskEngine.ingestFrame(frame);
  }
}

/* =====================================================
   Decision Layer Setup
===================================================== */

const evaluator = new RouteEvaluator(
  (zoneId: string) => riskEngine.getZoneRisk(zoneId),
  (zoneId: string) => incidentEngine.isZoneBlocked(zoneId),
  () => 1
);

const policy = new AutoReroutePolicy();

const exits = routingEngine.getExitNodes();

const exitSelector = new ExitSelector(
  exits,
  (from, to) =>
    routingEngine.computeRoute(
      riskEngine.getAllZoneRisk(),
      incidentEngine.getLocalDeltas(),
      {},
      globalMode,
      from,
      to,
      "SYSTEM",
      "manual_request"
    )
);

function broadcast(event: unknown) {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

const publisher = new WebSocketPublisher(wss);

const computeRoute = (input: {
  fromNodeId: string;
  toNodeId: string;
  userId: string;
  reason: RoutePlan["reason"];
}): RoutePlan =>
  routingEngine.computeRoute(
    riskEngine.getAllZoneRisk(),
    incidentEngine.getLocalDeltas(),
    {},
    globalMode,
    input.fromNodeId,
    input.toNodeId,
    input.userId,
    input.reason
  );

const orchestrator = new DecisionOrchestrator(
  evaluator,
  policy,
  exitSelector,
  computeRoute,
  publisher as any,
  () => globalMode
);

function toAssistRequestFromIncident(incident: Incident): AssistRequest {
  return {
    requestId: `AR_${incident.incidentId}`,
    ts: incident.ts || Date.now(),
    mapId: incident.mapId || mapData.mapId,
    incidentId: incident.incidentId,
    targetRole: "staff",
    loc: incident.loc,
    severity: incident.severity,
    message: incident.description || `${incident.type.replaceAll("_", " ")} in ${incident.loc.zoneId}`,
    exclusive: false,
  };
}

/* =====================================================
   User Store
===================================================== */

interface UserContext {
  userId: string;
  currentNodeId: string;
  destinationNodeId?: string;
  activeRoute?: any;
  lastRerouteAt?: number;
}

const users = new Map<string, UserContext>();

/* =====================================================
   REST Endpoints
===================================================== */

/* ================================
   Risk Input Mode Switch
================================ */

app.post("/demo/set-risk-mode", (req, res) => {

  const { mode } = req.body;

  if (mode !== "ml" && mode !== "manual") {
    return res.status(400).json({
      error: "Invalid mode. Use 'ml' or 'manual'."
    });
  }

  riskInputMode = mode;

  console.log("Risk input mode switched to:", riskInputMode);

  res.json({ ok: true, mode: riskInputMode });
});

// Health check
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

app.post("/perception", (req, res) => {
  const frame = req.body as PerceptionFrameResult;
  riskEngine.ingestFrame(frame);
  res.json({ ok: true });
});

app.post("/incident", (req, res) => {
  const incident = req.body as Incident;
  incidentEngine.addIncident(incident);

  broadcast({ type: "incident", payload: incident } satisfies WsServerEvent);

  // Fan-out to staff UI as an assist request (best-effort).
  const assist = toAssistRequestFromIncident(incident);
  broadcast({ type: "assist_request", payload: assist } satisfies WsServerEvent);

  res.json({ ok: true });
});

// Manual route request (used by mobile demo)
app.post("/route", (req, res) => {
  const body = req.body as any;

  const userId = String(body.userId || "U_DEMO_1");
  const fromNodeId = String(body.fromNodeId || body.currentNodeId || "N1");
  const toNodeId = String(body.toNodeId || body.destinationNodeId || "EXIT_N");

  const route = computeRoute({
    fromNodeId,
    toNodeId,
    userId,
    reason: "manual_request",
  });

  // Store user context for auto-reroute triggers
  users.set(userId, {
    userId,
    currentNodeId: fromNodeId,
    destinationNodeId: toNodeId,
    activeRoute: route,
  });

  broadcast({ type: "route_update", payload: route } satisfies WsServerEvent);
  res.json(route);
});

// Change global mode
app.post("/mode", (req, res) => {
  globalMode = req.body.mode;
  console.log("Global mode changed:", globalMode);

  users.forEach(user => orchestrator.evaluateUser(user));

  res.json({ ok: true });
});

// Mock risk injection
app.post("/mock-risk", (req, res) => {

  if (riskInputMode !== "manual") {
    return res.status(400).json({
      error: "System is in ML mode"
    });
  }

  const { zoneId, risk } = req.body;
  riskEngine.setZoneRisk(zoneId, risk);

  res.json({ ok: true });
});

// Mock incident injection
app.post("/mock-incident", (req, res) => {
  incidentEngine.addIncident(req.body);
  res.json({ ok: true });
});

/* =====================================================
   OneMap Proxy (for staff web map)
===================================================== */

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (resp) => {
        let data = "";
        resp.on("data", (chunk) => {
          data += chunk;
        });
        resp.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function getOneMapToken(): string | undefined {
  return process.env.ONEMAP_TOKEN || process.env.ONEMAP_API_TOKEN;
}

function withToken(url: URL): URL {
  const token = getOneMapToken();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url;
}

app.get("/onemap/search", async (req, res) => {
  const searchVal = String(req.query.searchVal || "");
  const pageNum = String(req.query.pageNum || "1");
  const upstream = withToken(
    new URL("https://www.onemap.gov.sg/api/common/elastic/search")
  );
  upstream.searchParams.set("searchVal", searchVal);
  upstream.searchParams.set("returnGeom", "Y");
  upstream.searchParams.set("getAddrDetails", "Y");
  upstream.searchParams.set("pageNum", pageNum);

  try {
    const data = await httpGetJson(upstream.toString());
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `OneMap search failed: ${String(error)}` });
  }
});

app.get("/onemap/planning-areas", async (req, res) => {
  const year = String(req.query.year || "2019");
  const upstream = withToken(
    new URL("https://www.onemap.gov.sg/api/common/elastic/getAllPlanningarea")
  );
  upstream.searchParams.set("year", year);

  try {
    const data = await httpGetJson(upstream.toString());
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: `OneMap planning areas failed: ${String(error)}` });
  }
});

/* =====================================================
   WebSocket (raw ws://)
===================================================== */

function buildRiskMap(): RiskMap {
  const snapshots = riskEngine.getAnalysisSnapshots();

  const analysisZones: AnalysisZoneRisk[] = mapData.analysisZones.map((zone) => {
    const snapshot = snapshots[zone.id];
    const risk = snapshot?.riskEma ?? 0;
    return {
      analysisZoneId: zone.id,
      risk,
      density: snapshot?.density,
      anomaly: snapshot?.anomaly,
      severity: snapshot?.severity ?? (risk >= 0.8 ? "critical" : risk >= 0.5 ? "warn" : "info"),
      conf: snapshot?.conf,
    };
  });

  const routingZones = expandToRoutingZones(analysisZones, mapData.routingZones as any).map((rz) => ({
    ...rz,
    localDelta: incidentEngine.getLocalDeltas()[rz.routingZoneId] ?? undefined,
  }));

  return {
    ts: Date.now(),
    mapId: mapData.mapId,
    analysisZones,
    routingZones,
  };
}

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  ws.send(
    JSON.stringify({
      type: "system_status",
      payload: { ts: Date.now(), mlMode: "fake", note: "Connected to SafeFlow backend (ws)." },
    } satisfies WsServerEvent)
  );

  ws.send(JSON.stringify({ type: "risk_update", payload: buildRiskMap() } satisfies WsServerEvent));

  for (const incident of incidentEngine.getIncidents()) {
    ws.send(JSON.stringify({ type: "incident", payload: incident } satisfies WsServerEvent));
  }

  for (const incident of incidentEngine.getIncidents()) {
    const assist = toAssistRequestFromIncident(incident);
    ws.send(JSON.stringify({ type: "assist_request", payload: assist } satisfies WsServerEvent));
  }

  ws.on("message", (raw) => {
    let msg: WsClientEvent | { type?: string; payload?: any } | null = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!msg?.type) return;

    if (msg.type === "route_request") {
      const payload = (msg as any).payload || {};
      try {
        const route = computeRoute({
          fromNodeId: String(payload.fromNodeId || "N1"),
          toNodeId: String(payload.toNodeId || "EXIT_N"),
          userId: String(payload.userId || "U_DEMO_1"),
          reason: "manual_request",
        });
        ws.send(JSON.stringify({ type: "route_update", payload: route } satisfies WsServerEvent));
      } catch (error) {
        console.warn("route_request failed:", error);
      }
      return;
    }

    if (msg.type === "safety_signal") {
      const payload = (msg as any).payload || {};
      const loc = payload.loc || { zoneId: "UNKNOWN" };
      const assist: AssistRequest = {
        requestId: `AR_${payload.signalId || Date.now()}`,
        ts: Date.now(),
        mapId: String(payload.mapId || mapData.mapId),
        incidentId: String(payload.signalId || `SIG_${Date.now()}`),
        targetRole: "staff",
        loc,
        severity: "critical",
        message: `Safety signal (${payload.type || "unknown"}) from ${payload.userId || "unknown"} at ${loc.zoneId}`,
        exclusive: false,
      };
      broadcast({ type: "assist_request", payload: assist } satisfies WsServerEvent);
      return;
    }

    if (msg.type === "assist_response") {
      const payload = (msg as any).payload || {};
      console.log("assist_response:", payload);
      return;
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

/* =====================================================
   Auto Re-evaluation Triggers
===================================================== */

riskEngine.on("riskUpdated", () => {
  broadcast({ type: "risk_update", payload: buildRiskMap() } satisfies WsServerEvent);
  users.forEach((user) => orchestrator.evaluateUser(user));
});

incidentEngine.on("incidentUpdated", () => {
  broadcast({ type: "risk_update", payload: buildRiskMap() } satisfies WsServerEvent);
  users.forEach((user) => orchestrator.evaluateUser(user));
});

/* =====================================================
   Start Server
===================================================== */

const PORT = CONFIG.PORT;

server.listen(PORT, () => {
  console.log(`SafeFlow backend running on port ${PORT}`);
});
