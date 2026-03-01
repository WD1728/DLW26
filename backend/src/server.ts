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