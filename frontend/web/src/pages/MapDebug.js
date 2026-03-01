import React, { useMemo, useState } from 'react';
import mapData from '../data/map.debug.json';
import './MapDebug.css';

const SVG_SIZE = 820;

function zoneColor(zoneId) {
  if (!zoneId) return '#64748b';
  if (zoneId.startsWith('Z_LS_')) return '#0ea5e9';
  if (zoneId.startsWith('Z_US_')) return '#f97316';
  if (zoneId.startsWith('Z_CON_')) return '#22c55e';
  if (zoneId.startsWith('Z_STAIR_')) return '#a855f7';
  if (zoneId.startsWith('Z_PLAZA_')) return '#eab308';
  if (zoneId.startsWith('Z_EXIT_')) return '#ef4444';
  if (zoneId === 'Z_ARENA_CENTER') return '#1d4ed8';
  return '#64748b';
}

export default function MapDebug() {
  const [zoom, setZoom] = useState(1);
  const [showLabels, setShowLabels] = useState(true);

  const { nodesById, edges, bounds, stats } = useMemo(() => {
    const nodes = Array.isArray(mapData?.graph?.nodes) ? mapData.graph.nodes : [];
    const graphEdges = Array.isArray(mapData?.graph?.edges) ? mapData.graph.edges : [];
    const routingZones = Array.isArray(mapData?.routingZones) ? mapData.routingZones : [];
    const exits = new Set(Array.isArray(mapData?.exits) ? mapData.exits : []);

    const byId = new Map();
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const n of nodes) {
      const x = Number(n?.pos?.x);
      const y = Number(n?.pos?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      byId.set(n.id, {
        id: n.id,
        routingZoneId: n.routingZoneId,
        x,
        y,
        isExit: exits.has(n.id)
      });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    return {
      nodesById: byId,
      edges: graphEdges,
      bounds: {
        minX: Number.isFinite(minX) ? minX : -1,
        maxX: Number.isFinite(maxX) ? maxX : 1,
        minY: Number.isFinite(minY) ? minY : -1,
        maxY: Number.isFinite(maxY) ? maxY : 1
      },
      stats: {
        mapId: mapData?.mapId || 'unknown',
        analysisZones: Array.isArray(mapData?.analysisZones) ? mapData.analysisZones.length : 0,
        routingZones: routingZones.length,
        nodes: nodes.length,
        edges: graphEdges.length,
        exits: exits.size
      }
    };
  }, []);

  const worldWidth = bounds.maxX - bounds.minX || 1;
  const worldHeight = bounds.maxY - bounds.minY || 1;
  const padding = 80;
  const scaleBase = Math.min((SVG_SIZE - padding * 2) / worldWidth, (SVG_SIZE - padding * 2) / worldHeight);
  const scale = scaleBase * zoom;

  const toScreen = (x, y) => {
    const sx = (x - bounds.minX) * scale + padding;
    const sy = (bounds.maxY - y) * scale + padding;
    return [sx, sy];
  };

  return (
    <div className="map-debug-page">
      <header className="map-debug-header">
        <h1>Map Debug Viewer</h1>
        <p>Snapshot of backend/data/map.json rendered as node-edge topology.</p>
      </header>

      <main className="map-debug-main">
        <section className="map-debug-controls">
          <button onClick={() => setZoom((v) => Math.min(3.5, v + 0.2))}>Zoom In</button>
          <button onClick={() => setZoom((v) => Math.max(0.5, v - 0.2))}>Zoom Out</button>
          <button onClick={() => setZoom(1)}>Reset</button>
          <button onClick={() => setShowLabels((v) => !v)}>
            {showLabels ? 'Hide Labels' : 'Show Labels'}
          </button>
        </section>

        <section className="map-debug-stats">
          <span>Map: {stats.mapId}</span>
          <span>Analysis Zones: {stats.analysisZones}</span>
          <span>Routing Zones: {stats.routingZones}</span>
          <span>Nodes: {stats.nodes}</span>
          <span>Edges: {stats.edges}</span>
          <span>Exits: {stats.exits}</span>
        </section>

        <section className="map-debug-canvas-wrap">
          <svg className="map-debug-canvas" viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}>
            {edges.map((edge) => {
              const from = nodesById.get(edge.from);
              const to = nodesById.get(edge.to);
              if (!from || !to) return null;
              const [x1, y1] = toScreen(from.x, from.y);
              const [x2, y2] = toScreen(to.x, to.y);
              return (
                <line
                  key={edge.id}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={zoneColor(edge.routingZoneId)}
                  strokeWidth="2"
                  strokeOpacity="0.75"
                />
              );
            })}

            {Array.from(nodesById.values()).map((node) => {
              const [x, y] = toScreen(node.x, node.y);
              return (
                <g key={node.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r={node.isExit ? 7 : 5}
                    fill={node.isExit ? '#b91c1c' : zoneColor(node.routingZoneId)}
                    stroke="#0f172a"
                    strokeWidth="1"
                  />
                  {showLabels && (
                    <text x={x + 8} y={y - 8} className="map-debug-label">
                      {node.id}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </section>

        <section className="map-debug-legend">
          <span><i style={{ background: '#1d4ed8' }} />Arena</span>
          <span><i style={{ background: '#0ea5e9' }} />Lower Seats</span>
          <span><i style={{ background: '#f97316' }} />Upper Seats</span>
          <span><i style={{ background: '#22c55e' }} />Concourse</span>
          <span><i style={{ background: '#a855f7' }} />Stairs</span>
          <span><i style={{ background: '#eab308' }} />Plaza</span>
          <span><i style={{ background: '#ef4444' }} />Exit</span>
        </section>
      </main>
    </div>
  );
}
