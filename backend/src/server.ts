import "dotenv/config";
import express from "express";
import cors from "cors";
import WebSocket from "ws";
import fs from "fs";
import path from "path";

import CONFIG from "./config";
import { fusePerception } from "../core/riskEngine";
import { expandToRoutingZones } from "../core/zoneMapper";
import { computeLocalDeltas } from "../core/incidentEngine";
import { computeRoute } from "../core/routingEngine";

import {
  PerceptionFrameResult,
  Incident,
  RiskMap,
  WsServerEvent
} from "@schema";

const app = express();
app.use(cors());
app.use(express.json());

const server = app.listen(CONFIG.PORT, () => {
  console.log("Backend running on port", CONFIG.PORT);
});

const wss = new WebSocket.Server({ server });

let map = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../data/map.json"),
    "utf-8"
  )
);

let analysisRisks: any[] = [];
let routingRisks: any[] = [];
let incidents: Incident[] = [];
let localDeltas: Record<string, number> = {};

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

function broadcast(event: WsServerEvent){
  const msg = JSON.stringify(event);
  wss.clients.forEach(client=>{
    if(client.readyState === WebSocket.OPEN){
      client.send(msg);
    }
  });
}

app.post("/perception",(req,res)=>{
  const frame = req.body as PerceptionFrameResult;

  analysisRisks = fusePerception(frame);

  routingRisks = expandToRoutingZones(
    analysisRisks,
    map.routingZones,
    localDeltas
  );

  const riskMap: RiskMap = {
    ts: Date.now(),
    mapId: map.mapId,
    analysisZones: analysisRisks,
    routingZones: routingRisks
  };

  broadcast({ type:"risk_update", payload:riskMap });

  res.json({ok:true});
});

app.post("/incident",(req,res)=>{
  const inc = req.body as Incident;
  incidents.push(inc);

  localDeltas = computeLocalDeltas(incidents);

  routingRisks = expandToRoutingZones(
    analysisRisks,
    map.routingZones,
    localDeltas
  );

  broadcast({ type:"incident", payload:inc });

  res.json({ok:true});
});

app.post("/route",(req,res)=>{
  const { userId, fromNodeId, toNodeId } = req.body;

  const riskMap: Record<string, number> =
    Object.fromEntries(routingRisks.map((r:any)=>[r.routingZoneId,r.risk]));

  const plan = computeRoute(
    map,
    riskMap,
    localDeltas,
    fromNodeId,
    toNodeId,
    userId
  );

  broadcast({ type:"route_update", payload:plan });

  res.json(plan);
});

app.get("/onemap/health", async (_req, res) => {
  try {
    await fetchOneMapJson<unknown>(
      "https://www.onemap.gov.sg/api/public/themesvc/getAllThemesInfo?moreInfo=Y"
    );
    res.json({ ok: true, provider: "onemap", auth: "token" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OneMap error";
    res.status(502).json({ ok: false, error: message });
  }
});

app.get("/onemap/themes", async (_req, res) => {
  try {
    const data = await fetchOneMapJson<unknown>(
      "https://www.onemap.gov.sg/api/public/themesvc/getAllThemesInfo?moreInfo=Y"
    );
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OneMap error";
    res.status(502).json({ error: message });
  }
});

app.get("/onemap/theme/:queryName", async (req, res) => {
  try {
    const queryName = req.params.queryName;
    if (!queryName) {
      res.status(400).json({ error: "queryName is required" });
      return;
    }

    const data = await fetchOneMapJson<unknown>(
      `https://www.onemap.gov.sg/api/public/themesvc/retrieveTheme?queryName=${encodeURIComponent(queryName)}`
    );
    const rows = Array.isArray((data as { SrchResults?: unknown[] }).SrchResults)
      ? (data as { SrchResults?: unknown[] }).SrchResults ?? []
      : [];
    const sampleRow = rows.find((row) => typeof row === "object" && row !== null) as Record<string, unknown> | undefined;
    const fieldNames = sampleRow ? Object.keys(sampleRow) : [];
    console.log(`[OneMap retrieveTheme] queryName=${queryName} rows=${rows.length} fields=${fieldNames.join(",")}`);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OneMap error";
    res.status(502).json({ error: message });
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
