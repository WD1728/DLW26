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
import { GuidanceGenerator } from "../decision/GuidanceGenerator";
import { DecisionOrchestrator } from "../decision/DecisionOrchestrator";

import { WebSocketPublisher } from "../events/WebSocketPublisher";

import mapData from "../data/map.json";
import CONFIG from "./config";
import { buildMockCrowdHeatSnapshot } from "./mock/crowdHeat";

/* =====================================================
   App + Server
===================================================== */

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
      "SYSTEM"
    )
);

const rawSocketsByUserId = new Map<string, Set<WebSocket>>();

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

const publisher = new WebSocketPublisher(io, emitRaw);

const orchestrator = new DecisionOrchestrator(
  evaluator,
  policy,
  exitSelector,
  routingEngine,
  publisher,
  () => globalMode
);

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

// Health check
app.get("/", (_, res) => {
  res.json({ status: "ok" });
});

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

// Manual route testing
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

// Change global mode
app.post("/mode", (req, res) => {
  globalMode = req.body.mode;
  console.log("Global mode changed:", globalMode);

  users.forEach(user => orchestrator.evaluateUser(user));

  res.json({ ok: true });
});

// Mock risk injection
app.post("/mock-risk", (req, res) => {
  const { zoneId, risk } = req.body;
  riskEngine.setZoneRisk(zoneId, risk);
  res.json({ ok: true });
});

// Mock incident injection
app.post("/mock-incident", (req, res) => {
  incidentEngine.addIncident(req.body);
  res.json({ ok: true });
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

app.get("/onemap/crowd-heat", (req, res) => {
  try {
    const snapshot = buildMockCrowdHeatSnapshot();
    res.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown crowd heat error";
    res.status(500).json({ error: message });
  }
});

/* =====================================================
   WebSocket
===================================================== */

io.on("connection", socket => {

  console.log("User connected:", socket.id);

  socket.on("register", ({ userId }) => {
    socket.join(userId);
  });

  socket.on("location_update", data => {

    const { userId, currentNodeId, destinationNodeId } = data;

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

    // Initial route
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

      user.activeRoute = route;

      publisher.emitRouteUpdate(user.userId, route);
    }

    orchestrator.evaluateUser(user);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

rawWss.on("connection", socket => {
  let userIdForSocket: string | null = null;

  socket.on("message", rawData => {
    try {
      const text = typeof rawData === "string" ? rawData : rawData.toString();
      const message = JSON.parse(text);
      const type = message?.type;
      const payload = message?.payload ?? {};

      if (type === "register") {
        const incomingUserId = typeof payload?.userId === "string" ? payload.userId : "";
        if (!incomingUserId) {
          return;
        }

        userIdForSocket = incomingUserId;
        if (!rawSocketsByUserId.has(incomingUserId)) {
          rawSocketsByUserId.set(incomingUserId, new Set());
        }
        rawSocketsByUserId.get(incomingUserId)?.add(socket);
        return;
      }

      if (type === "location_update") {
        const { userId, currentNodeId, destinationNodeId } = payload;
        if (!userId || !currentNodeId) {
          return;
        }

        let user = users.get(userId);
        if (!user) {
          user = { userId, currentNodeId, destinationNodeId };
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

          user.activeRoute = route;
          publisher.emitRouteUpdate(user.userId, route);
        }

        orchestrator.evaluateUser(user);
      }
    } catch {
      // Ignore malformed payloads from raw websocket clients.
    }
  });

  socket.on("close", () => {
    if (!userIdForSocket) {
      return;
    }

    const sockets = rawSocketsByUserId.get(userIdForSocket);
    if (!sockets) {
      return;
    }

    sockets.delete(socket);
    if (sockets.size === 0) {
      rawSocketsByUserId.delete(userIdForSocket);
    }
  });
});

/* =====================================================
   Auto Re-evaluation Triggers
===================================================== */

riskEngine.on("riskUpdated", () => {
  users.forEach(user => orchestrator.evaluateUser(user));
});

incidentEngine.on("incidentUpdated", () => {
  users.forEach(user => orchestrator.evaluateUser(user));
});

/* =====================================================
   Start Server
===================================================== */

const PORT = CONFIG.PORT;

server.listen(PORT, () => {
  console.log(`SafeFlow backend running on port ${PORT}`);
});
