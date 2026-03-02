import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

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

app.use(express.json());
app.use(cors());

const ML_SERVICE_BASE_URL = (process.env.ML_SERVICE_BASE_URL || "http://127.0.0.1:8099").replace(/\/+$/, "");
const TRAFFIC_ML_ENDPOINT = `${ML_SERVICE_BASE_URL}/infer/traffic-camera`;

type TrafficCameraRaw = {
  camera_id?: string;
  image?: string;
  timestamp?: string;
  location?: {
    latitude?: number;
    longitude?: number;
  };
};

type TrafficImagesResponse = {
  items?: Array<{
    timestamp?: string;
    cameras?: TrafficCameraRaw[];
  }>;
};

type MlVehicleInferRequest = {
  cameraId: string;
  imageUrl?: string;
  imageBase64: string;
  capturedAt?: string;
};

type MlVehicleInferResponse = {
  cameraId: string;
  model: string;
  ts: number;
  imageWidth?: number;
  imageHeight?: number;
  vehicleCount: number;
  detections: Array<{
    bbox: [number, number, number, number];
    conf: number;
    className: string;
  }>;
};

const trafficInferCache = new Map<string, { expiresAt: number; value: MlVehicleInferResponse }>();

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function inferTrafficCamera(
  payload: MlVehicleInferRequest,
  cacheTtlMs: number
): Promise<MlVehicleInferResponse> {
  const cacheKey = `${payload.cameraId}:${payload.capturedAt || ""}`;
  const now = Date.now();
  const cached = trafficInferCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const response = await fetch(TRAFFIC_ML_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML infer failed (${response.status}): ${text.slice(0, 180)}`);
  }
  const data = (await response.json()) as MlVehicleInferResponse;
  trafficInferCache.set(cacheKey, { expiresAt: now + cacheTtlMs, value: data });
  return data;
}

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

const publisher = new WebSocketPublisher(io);

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
const userPresence = new Map<
  string,
  {
    userId: string;
    lat: number;
    lng: number;
    ts: number;
    source?: string;
  }
>();

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

app.post("/presence/update", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const ts = Number(req.body?.ts) || Date.now();
  const source = String(req.body?.source || "").trim() || undefined;

  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "lat/lng must be finite numbers" });
    return;
  }

  const payload = { userId, lat, lng, ts, source };
  userPresence.set(userId, payload);
  io.emit("user_presence", payload);
  res.json({ ok: true });
});

app.get("/presence/users", (req, res) => {
  const maxAgeMs = Math.max(1000, Number(req.query.maxAgeMs ?? 180000) || 180000);
  const now = Date.now();
  const rows = Array.from(userPresence.values()).filter((item) => now - item.ts <= maxAgeMs);
  res.json({
    ts: now,
    count: rows.length,
    users: rows,
  });
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

app.get("/traffic/cameras", async (_req, res) => {
  try {
    const data = await fetchOneMapPublicJson<unknown>(
      "https://api.data.gov.sg/v1/transport/traffic-images"
    );
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown traffic camera error";
    res.status(502).json({ error: message });
  }
});

app.get("/traffic/cameras/enriched", async (req, res) => {
  try {
    const maxCameras = Math.max(1, Math.min(30, Number(req.query.maxCameras ?? 8) || 8));
    const withInfer = String(req.query.withInfer ?? "1") !== "0";
    const cacheTtlMs = Math.max(1000, Number(req.query.cacheTtlMs ?? 45000) || 45000);

    const upstream = await fetchOneMapPublicJson<TrafficImagesResponse>(
      "https://api.data.gov.sg/v1/transport/traffic-images"
    );
    const latestItem = Array.isArray(upstream?.items) && upstream.items.length > 0 ? upstream.items[0] : null;
    const cameras = (latestItem?.cameras || []).slice(0, maxCameras);

    const enriched = await Promise.all(
      cameras.map(async (camera) => {
        const cameraId = String(camera?.camera_id || "").trim();
        const imageUrl = String(camera?.image || "").trim();
        const capturedAt = String(camera?.timestamp || latestItem?.timestamp || "");
        const lat = Number(camera?.location?.latitude);
        const lng = Number(camera?.location?.longitude);

        if (!cameraId || !imageUrl || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          return null;
        }

        if (!withInfer) {
          return {
            cameraId,
            lat,
            lng,
            imageUrl,
            capturedAt,
            inference: { status: "skipped", reason: "withInfer=0" },
          };
        }

        try {
          const imageBase64 = await fetchImageAsDataUrl(imageUrl);
          const infer = await inferTrafficCamera(
            { cameraId, imageUrl, imageBase64, capturedAt },
            cacheTtlMs
          );
          return {
            cameraId,
            lat,
            lng,
            imageUrl,
            capturedAt,
            inference: {
              status: "ok",
              vehicleCount: infer.vehicleCount,
              model: infer.model,
              ts: infer.ts,
              imageWidth: Number.isFinite(Number(infer.imageWidth)) ? Number(infer.imageWidth) : undefined,
              imageHeight: Number.isFinite(Number(infer.imageHeight)) ? Number(infer.imageHeight) : undefined,
              detections: infer.detections,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown ML infer error";
          return {
            cameraId,
            lat,
            lng,
            imageUrl,
            capturedAt,
            inference: { status: "error", error: message },
          };
        }
      })
    );

    res.json({
      generatedAt: new Date().toISOString(),
      source: "data.gov.sg",
      modelService: TRAFFIC_ML_ENDPOINT,
      cameras: enriched.filter(Boolean),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown enriched camera error";
    res.status(502).json({ error: message });
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
