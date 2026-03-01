import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { WebSocketServer, WebSocket } from "ws";

import { RiskEngine } from "../core/riskEngine";
import { IncidentEngine } from "../core/incidentEngine";
import { RoutingEngine } from "../core/routingEngine";

import { RouteEvaluator } from "../decision/RouteEvaluator";
import { AutoReroutePolicy } from "../decision/AutoReroutePolicy";
import { ExitSelector } from "../decision/ExitSelector";
import { DecisionOrchestrator } from "../decision/DecisionOrchestrator";

import { WebSocketPublisher } from "../events/WebSocketPublisher";

import mapData from "../data/map.json";
import CONFIG from "./config";
import { buildMockCrowdHeatSnapshot } from "./mock/crowdHeat";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});
const rawWss = new WebSocketServer({ server, path: "/" });

app.use(express.json());
app.use(cors());

function getOneMapToken(): string {
  const token = process.env.ONEMAP_API_TOKEN;
  if (!token) {
    throw new Error("Missing ONEMAP_API_TOKEN");
  }
  return token;
}

async function fetchOneMapJson<T>(url: string): Promise<T> {
  const token = getOneMapToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`OneMap request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function fetchOneMapPublicJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OneMap public request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

let globalMode: "normal" | "alert" | "evacuation" = "normal";

const riskEngine = new RiskEngine();
const incidentEngine = new IncidentEngine();
const routingEngine = new RoutingEngine(mapData as any);

const evaluator = new RouteEvaluator(
  (zoneId: string) => riskEngine.getZoneRisk(zoneId),
  (zoneId: string) => incidentEngine.isZoneBlocked(zoneId),
  () => 1
);

const policy = new AutoReroutePolicy();

const users = new Map<string, UserContext>();
const incidentsById = new Map<string, any>();
const assistRequestsById = new Map<string, any>();

const exits = routingEngine.getExitNodes();
const exitSelector = new ExitSelector(exits, (from, to) => {
  const route = routingEngine.computeRoute(
    riskEngine.getAllZoneRisk(),
    incidentEngine.getLocalDeltas(),
    {},
    globalMode,
    from,
    to,
    "SYSTEM"
  );
  return {
    cost: route.est?.distance ?? Number.POSITIVE_INFINITY
  };
});

interface RawSocketContext {
  userId?: string;
  role?: "user" | "staff" | "ally";
}

const rawSocketsByUserId = new Map<string, Set<WebSocket>>();
const rawSocketContext = new Map<WebSocket, RawSocketContext>();

function emitRaw(userId: string, type: string, payload: unknown) {
  const sockets = rawSocketsByUserId.get(userId);
  if (!sockets || sockets.size === 0) {
    return;
  }

  const message = JSON.stringify({ type, payload });
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  }
}

function broadcastRaw(type: string, payload: unknown) {
  const message = JSON.stringify({ type, payload });
  for (const socket of rawSocketContext.keys()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  }
}

function emitRawByRole(role: "staff" | "ally", type: string, payload: unknown) {
  const message = JSON.stringify({ type, payload });
  for (const [socket, ctx] of rawSocketContext.entries()) {
    if (ctx.role !== role) continue;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  }
}

const publisher = new WebSocketPublisher(io, emitRaw, broadcastRaw, emitRawByRole);

const rerouteAdapter = {
  computeRoute: (fromNodeId: string, toNodeId: string) =>
    routingEngine.computeRoute(
      riskEngine.getAllZoneRisk(),
      incidentEngine.getLocalDeltas(),
      {},
      globalMode,
      fromNodeId,
      toNodeId,
      "SYSTEM"
    )
};

const orchestrator = new DecisionOrchestrator(
  evaluator,
  policy,
  exitSelector,
  rerouteAdapter,
  publisher,
  () => globalMode
);

interface UserContext {
  userId: string;
  currentNodeId: string;
  destinationNodeId?: string;
  role?: "user" | "staff" | "ally";
  activeRoute?: any;
  lastRerouteAt?: number;
}

function buildRiskUpdatePayload() {
  const analysisSnapshots = riskEngine.getAnalysisSnapshots();
  const localDeltas = incidentEngine.getLocalDeltas();
  const riskPenaltyScale = CONFIG.RISK_PENALTY_SCALE || 1;

  const analysisZones = Object.values(analysisSnapshots).map((s: any) => ({
    analysisZoneId: s.analysisZoneId,
    risk: s.riskEma,
    density: s.density,
    anomaly: s.anomaly,
    trend: s.slopePerSec,
    severity: s.severity,
    conf: s.conf
  }));

  const routingZones = ((mapData as any).routingZones ?? []).map((rz: any) => {
    const inheritedRisk = riskEngine.getZoneRisk(rz.id);
    const delta = localDeltas[rz.id] ?? 0;
    const normalizedDelta = Math.max(0, Math.min(1, delta / riskPenaltyScale));
    const risk = Math.max(0, Math.min(1, inheritedRisk + normalizedDelta));
    return {
      routingZoneId: rz.id,
      parentAnalysisZoneId: rz.parentAnalysisZoneId,
      risk,
      severity: risk >= 0.8 ? "critical" : risk >= 0.5 ? "warn" : "info",
      localDelta: delta || undefined
    };
  });

  return {
    contractVersion: "v1",
    ts: Date.now(),
    mapId: (mapData as any).mapId,
    analysisZones,
    routingZones
  };
}

function publishRiskUpdate() {
  publisher.emitRiskUpdate(buildRiskUpdatePayload());
}

function buildAssistRequestFromIncident(incident: any) {
  return {
    requestId: `AR_${incident.incidentId}_${Date.now()}`,
    ts: Date.now(),
    mapId: incident.mapId,
    incidentId: incident.incidentId,
    targetRole: "staff",
    loc: incident.loc,
    severity: incident.severity,
    message: incident.description || `Incident ${incident.type} at zone ${incident.loc?.zoneId}`,
    exclusive: true
  };
}

function emitIncidentAndAssist(incident: any) {
  publisher.emitIncident(incident);
  const assist = buildAssistRequestFromIncident(incident);
  assistRequestsById.set(assist.requestId, {
    ...assist,
    status: "open"
  });
  publisher.emitAssistRequest("staff", assist);
}

function evaluateAffectedUsers(changedZones?: string[]) {
  const changed = Array.isArray(changedZones) && changedZones.length > 0 ? new Set(changedZones) : null;

  users.forEach((user) => {
    if (!user.activeRoute) return;
    if (!changed) {
      orchestrator.evaluateUser(user);
      return;
    }

    const zonePath: string[] = user.activeRoute.zonePath ?? [];
    const intersects = zonePath.some((z) => changed.has(z));
    if (intersects) {
      orchestrator.evaluateUser(user);
    }
  });
}

function upsertUserFromLocationUpdate(data: any) {
  const { userId, currentNodeId, destinationNodeId } = data;
  if (!userId || !currentNodeId) return;

  let user = users.get(userId);

  if (!user) {
    user = {
      userId,
      currentNodeId,
      destinationNodeId
    };
    users.set(userId, user);
  }

  user.currentNodeId = currentNodeId;

  if (destinationNodeId) {
    user.destinationNodeId = destinationNodeId;
  }

  if (!user.activeRoute && user.destinationNodeId) {
    const route = routingEngine.computeRoute(
      riskEngine.getAllZoneRisk(),
      incidentEngine.getLocalDeltas(),
      {},
      globalMode,
      user.currentNodeId,
      user.destinationNodeId,
      user.userId
    );

    route.reason = "initial";
    user.activeRoute = route;
    publisher.emitRouteUpdate(user.userId, route);
  }

  orchestrator.evaluateUser(user);
}

app.get("/", (_, res) => {
  res.json({ status: "ok" });
});

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

app.post("/route", (req, res) => {
  const { userId, currentNodeId, destinationNodeId } = req.body;

  const route = routingEngine.computeRoute(
    riskEngine.getAllZoneRisk(),
    incidentEngine.getLocalDeltas(),
    {},
    globalMode,
    currentNodeId,
    destinationNodeId,
    userId
  );

  res.json(route);
});

app.post("/mode", (req, res) => {
  globalMode = req.body.mode;
  evaluateAffectedUsers();
  res.json({ ok: true });
});

app.post("/perception", (req, res) => {
  riskEngine.ingestFrame(req.body);
  publishRiskUpdate();
  res.json({ ok: true });
});

app.post("/incident", (req, res) => {
  const incident = {
    ...req.body,
    incidentId: req.body.incidentId || `INC_${Date.now()}`,
    ts: req.body.ts || Date.now(),
    mapId: req.body.mapId || (mapData as any).mapId,
    status: req.body.status || "open"
  };

  incidentsById.set(incident.incidentId, incident);
  incidentEngine.addIncident(incident);
  emitIncidentAndAssist(incident);
  publishRiskUpdate();
  res.json({ ok: true, incidentId: incident.incidentId });
});

app.post("/mock-risk", (req, res) => {
  const { zoneId, risk } = req.body;
  riskEngine.setZoneRisk(zoneId, risk);
  publishRiskUpdate();
  res.json({ ok: true });
});

app.post("/mock-incident", (req, res) => {
  const incident = {
    ...req.body,
    incidentId: req.body.incidentId || `INC_${Date.now()}`,
    ts: req.body.ts || Date.now(),
    mapId: req.body.mapId || (mapData as any).mapId,
    status: req.body.status || "open"
  };
  incidentsById.set(incident.incidentId, incident);
  incidentEngine.addIncident(incident);
  emitIncidentAndAssist(incident);
  publishRiskUpdate();
  res.json({ ok: true, incidentId: incident.incidentId });
});

app.get("/onemap/health", async (_req, res) => {
  try {
    await fetchOneMapJson<unknown>(
      "https://www.onemap.gov.sg/api/public/popapi/getPlanningareaNames?year=2019"
    );
    res.json({ ok: true, provider: "onemap", auth: "token" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OneMap error";
    res.status(502).json({ ok: false, error: message });
  }
});

app.get("/onemap/search", async (req, res) => {
  try {
    const searchVal = String(req.query.searchVal ?? "").trim();
    const pageNum = String(req.query.pageNum ?? "1").trim();
    if (!searchVal) {
      res.status(400).json({ error: "searchVal is required" });
      return;
    }

    const data = await fetchOneMapPublicJson<unknown>(
      `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
        searchVal
      )}&returnGeom=Y&getAddrDetails=Y&pageNum=${encodeURIComponent(pageNum)}`
    );
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OneMap error";
    res.status(502).json({ error: message });
  }
});

app.get("/onemap/planning-areas", async (req, res) => {
  try {
    const year = String(req.query.year ?? "2019").trim();
    const data = await fetchOneMapJson<unknown>(
      `https://www.onemap.gov.sg/api/public/popapi/getAllPlanningarea?year=${encodeURIComponent(year)}`
    );
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OneMap error";
    res.status(502).json({ error: message });
  }
});

app.get("/onemap/crowd-heat", (_req, res) => {
  try {
    const snapshot = buildMockCrowdHeatSnapshot();
    res.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown crowd heat error";
    res.status(500).json({ error: message });
  }
});

io.on("connection", socket => {
  socket.on("register", ({ userId, role }) => {
    if (!userId) return;
    socket.join(userId);
    if (role) {
      socket.join(role);
    }
    const user = users.get(userId);
    if (user && role) {
      user.role = role;
    }
  });

  socket.on("location_update", data => {
    upsertUserFromLocationUpdate(data);
  });

  socket.on("assist_response", payload => {
    const requestId = payload?.requestId;
    const action = payload?.action;
    const responderUserId = payload?.responderUserId || socket.id;
    if (!requestId || !action) return;

    const req = assistRequestsById.get(requestId);
    if (!req || req.status !== "open") return;

    if (action === "accept") {
      req.status = "acknowledged";
      req.acknowledgedBy = responderUserId;
      const incident = incidentsById.get(req.incidentId);
      if (incident) {
        incident.status = "acknowledged";
        incident.acknowledgedBy = responderUserId;
        publisher.emitIncident(incident);
      }
    }
  });
});

rawWss.on("connection", socket => {
  rawSocketContext.set(socket, {});

  socket.on("message", rawData => {
    try {
      const text = typeof rawData === "string" ? rawData : rawData.toString();
      const message = JSON.parse(text);
      const type = message?.type;
      const payload = message?.payload ?? {};

      if (type === "register") {
        const incomingUserId = typeof payload?.userId === "string" ? payload.userId : "";
        const incomingRole = payload?.role;

        if (!incomingUserId) return;

        const ctx = rawSocketContext.get(socket) || {};
        ctx.userId = incomingUserId;
        if (incomingRole === "user" || incomingRole === "staff" || incomingRole === "ally") {
          ctx.role = incomingRole;
        }
        rawSocketContext.set(socket, ctx);

        if (!rawSocketsByUserId.has(incomingUserId)) {
          rawSocketsByUserId.set(incomingUserId, new Set());
        }
        rawSocketsByUserId.get(incomingUserId)?.add(socket);
        return;
      }

      if (type === "location_update") {
        upsertUserFromLocationUpdate(payload);
        return;
      }

      if (type === "assist_response") {
        const requestId = payload?.requestId;
        const action = payload?.action;
        const responderUserId = payload?.responderUserId || rawSocketContext.get(socket)?.userId || "UNKNOWN";
        if (!requestId || !action) return;

        const req = assistRequestsById.get(requestId);
        if (!req || req.status !== "open") return;

        if (action === "accept") {
          req.status = "acknowledged";
          req.acknowledgedBy = responderUserId;
          const incident = incidentsById.get(req.incidentId);
          if (incident) {
            incident.status = "acknowledged";
            incident.acknowledgedBy = responderUserId;
            publisher.emitIncident(incident);
          }
        }
      }
    } catch {
      // Ignore malformed payloads from raw websocket clients.
    }
  });

  socket.on("close", () => {
    const ctx = rawSocketContext.get(socket);
    if (ctx?.userId) {
      const sockets = rawSocketsByUserId.get(ctx.userId);
      if (sockets) {
        sockets.delete(socket);
        if (sockets.size === 0) {
          rawSocketsByUserId.delete(ctx.userId);
        }
      }
    }

    rawSocketContext.delete(socket);
  });
});

riskEngine.on("riskUpdated", (payload: any) => {
  publishRiskUpdate();
  evaluateAffectedUsers(payload?.changedRoutingZones);
});

incidentEngine.on("incidentUpdated", (payload: any) => {
  publishRiskUpdate();
  evaluateAffectedUsers(payload?.changedZones);
});

const PORT = CONFIG.PORT;

server.listen(PORT, () => {
  console.log(`SafeFlow backend running on port ${PORT}`);
});
