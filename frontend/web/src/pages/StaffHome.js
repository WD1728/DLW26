import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { WebSocketClient } from '../api/websocket';
import './StaffHome.css';

const POI_TYPES = [
  { key: 'police', label: 'Police Station', query: 'Police Station', color: '#2563eb', symbol: '🧢', markerClass: 'poi-police' },
  { key: 'fire', label: 'Fire Station', query: 'Fire Station', color: '#dc2626', symbol: '⛑', markerClass: 'poi-fire' },
  { key: 'hospital', label: 'Hospital', query: 'Hospital', color: '#16a34a', symbol: '✚', markerClass: 'poi-hospital' }
];

const BACKEND_BASE_URL = (process.env.REACT_APP_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const DISPATCH_ENDPOINT = process.env.REACT_APP_DISPATCH_ENDPOINT || '/dispatch/request';
const PLANNING_AREA_YEAR = process.env.REACT_APP_PLANNING_AREA_YEAR || '2019';
const CROWD_DETAIL_ZOOM = 13.5;
const ENABLE_MOCK_CROWD_HEAT = false;
const TRAFFIC_REFRESH_MS = 60000;
const PRESENCE_REFRESH_MS = 3000;
const PRESENCE_MAX_AGE_MS = 30000;
const CAMERA_EXPLORER_ZOOM = 13.5;

const CAMERA_REGIONS = [
  { key: 'central', label: 'Central', center: [1.2966, 103.85], zoom: 14 },
  { key: 'east', label: 'East', center: [1.352, 103.956], zoom: 14 },
  { key: 'west', label: 'West', center: [1.35, 103.705], zoom: 14 },
  { key: 'north', label: 'North', center: [1.4307, 103.8354], zoom: 14 },
  { key: 'north-east', label: 'North-East', center: [1.3821, 103.893], zoom: 14 },
  { key: 'south', label: 'South', center: [1.2746, 103.814], zoom: 14 }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function metersToLat(meters) {
  return meters / 111320;
}

function metersToLng(meters, lat) {
  return meters / (111320 * Math.cos((lat * Math.PI) / 180));
}

function presenceHeatColor(intensity) {
  if (intensity >= 0.9) return '#7f1d1d';
  if (intensity >= 0.75) return '#b91c1c';
  if (intensity >= 0.6) return '#dc2626';
  if (intensity >= 0.45) return '#ef4444';
  if (intensity >= 0.3) return '#f97316';
  return '#f59e0b';
}

function presenceIntensityFromCount(count) {
  if (count >= 14) return 1;
  if (count >= 10) return 0.85;
  if (count >= 7) return 0.72;
  if (count >= 5) return 0.56;
  if (count >= 3) return 0.4;
  if (count >= 2) return 0.28;
  return 0;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function normalizeAreaName(value) {
  return String(value || '').trim().toUpperCase();
}

function parseCoordinatePair(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return null;
  }
  return [parts[0], parts[1]];
}

function toLeafletPoint(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lng = Number(pair[0]);
  const lat = Number(pair[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function extractPathsFromGeoJson(rawGeoJson) {
  if (!rawGeoJson) return [];
  let parsed = rawGeoJson;
  if (typeof rawGeoJson === 'string') {
    try {
      parsed = JSON.parse(rawGeoJson);
    } catch {
      return [];
    }
  }

  const geometry = parsed?.geometry ? parsed.geometry : parsed;
  const geometryType = normalizeText(geometry?.type);
  const geometryCoordinates = geometry?.coordinates;
  const paths = [];

  if (geometryType === 'polygon' && Array.isArray(geometryCoordinates)) {
    for (const ring of geometryCoordinates) {
      if (!Array.isArray(ring)) continue;
      const path = ring.map(toLeafletPoint).filter(Boolean);
      if (path.length >= 3) paths.push(path);
    }
    return paths;
  }

  if (geometryType === 'multipolygon' && Array.isArray(geometryCoordinates)) {
    for (const polygon of geometryCoordinates) {
      if (!Array.isArray(polygon)) continue;
      for (const ring of polygon) {
        if (!Array.isArray(ring)) continue;
        const path = ring.map(toLeafletPoint).filter(Boolean);
        if (path.length >= 3) paths.push(path);
      }
    }
    return paths;
  }

  return [];
}

function extractPathsFromRecord(record) {
  const paths = [];
  const directGeoJsonPaths = extractPathsFromGeoJson(record?.geojson || record?.GeoJSON);
  if (directGeoJsonPaths.length > 0) {
    return directGeoJsonPaths;
  }
  const geometry = record?.GeoJSON?.geometry;
  const geometryType = normalizeText(geometry?.type);
  const geometryCoordinates = geometry?.coordinates;

  if (geometryType === 'polygon' && Array.isArray(geometryCoordinates)) {
    for (const ring of geometryCoordinates) {
      if (!Array.isArray(ring)) continue;
      const path = ring.map(toLeafletPoint).filter(Boolean);
      if (path.length >= 3) paths.push(path);
    }
    if (paths.length > 0) return paths;
  }

  if (geometryType === 'multipolygon' && Array.isArray(geometryCoordinates)) {
    for (const polygon of geometryCoordinates) {
      if (!Array.isArray(polygon)) continue;
      for (const ring of polygon) {
        if (!Array.isArray(ring)) continue;
        const path = ring.map(toLeafletPoint).filter(Boolean);
        if (path.length >= 3) paths.push(path);
      }
    }
    if (paths.length > 0) return paths;
  }

  if (Array.isArray(record?.LatLng)) {
    const path = record.LatLng.map(toLeafletPoint).filter(Boolean);
    if (path.length >= 3) {
      paths.push(path);
      return paths;
    }
  }

  const pathSource =
    record.LAT_LNG ||
    record.LATLNG ||
    record.LatLng ||
    record.SHAPE ||
    record.GEOMETRY ||
    record.POLY ||
    record.POLYGON;

  if (!pathSource || typeof pathSource !== 'string') {
    return paths;
  }

  if (pathSource.includes('|')) {
    const points = pathSource
      .split('|')
      .map(parseCoordinatePair)
      .filter(Boolean)
      .map((pair) => [pair[1], pair[0]]);
    if (points.length >= 3) {
      paths.push(points);
      return paths;
    }
  }

  const wktMatch = pathSource.match(/-?\d+(\.\d+)?\s+-?\d+(\.\d+)?/g);
  if (wktMatch && wktMatch.length >= 3) {
    const points = wktMatch
      .map((pair) => {
        const [lng, lat] = pair.split(/\s+/).map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return [lat, lng];
      })
      .filter(Boolean);
    if (points.length >= 3) {
      paths.push(points);
      return paths;
    }
  }

  return paths;
}

function getPathCenter(path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  let latSum = 0;
  let lngSum = 0;
  for (const point of path) {
    latSum += point[0];
    lngSum += point[1];
  }
  return [latSum / path.length, lngSum / path.length];
}

function crowdColor(score) {
  if (score >= 0.85) return '#7f1d1d';
  if (score >= 0.7) return '#b91c1c';
  if (score >= 0.55) return '#dc2626';
  if (score >= 0.4) return '#ef4444';
  if (score >= 0.25) return '#f97316';
  return '#f59e0b';
}

function buildBackendUrl(endpoint) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) {
    return `${BACKEND_BASE_URL}/dispatch/request`;
  }
  if (/^https?:\/\//i.test(normalizedEndpoint)) {
    return normalizedEndpoint;
  }
  if (normalizedEndpoint.startsWith('/')) {
    return `${BACKEND_BASE_URL}${normalizedEndpoint}`;
  }
  return `${BACKEND_BASE_URL}/${normalizedEndpoint}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPoiIcon(poiType) {
  const symbol = escapeHtml(poiType?.symbol || '•');
  const markerClass = escapeHtml(poiType?.markerClass || 'poi-default');
  const label = escapeHtml(poiType?.label || 'POI');
  return L.divIcon({
    className: 'poi-icon-wrapper',
    html: `<div class="poi-icon ${markerClass}" aria-label="${label}" title="${label}"><span>${symbol}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -12]
  });
}

function buildTrafficCameraIcon() {
  return L.divIcon({
    className: 'traffic-camera-icon-wrapper',
    html: '<div class="traffic-camera-icon" aria-label="Traffic Camera" title="Traffic Camera"><span>📹</span></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -10]
  });
}

function buildTrafficPopupHtml(camera) {
  const cameraId = escapeHtml(camera.cameraId || 'unknown');
  const imageUrl = escapeHtml(camera.imageUrl || '');
  const capturedAt = camera.capturedAt
    ? `Captured: ${new Date(camera.capturedAt).toLocaleString()}`
    : 'Captured time unavailable';
  const info = camera?.inference;
  const imgW = Number(info?.imageWidth) || 1;
  const imgH = Number(info?.imageHeight) || 1;
  const vehicleCount = Number.isFinite(Number(info?.vehicleCount)) ? Number(info.vehicleCount) : 0;
  const inferStatus = info?.status === 'ok'
    ? `Vehicles: ${vehicleCount}`
    : info?.status === 'error'
      ? `Infer: ${escapeHtml(info.error || 'error')}`
      : `Infer: ${escapeHtml(info?.reason || 'skipped')}`;
  const dets = Array.isArray(info?.detections) ? info.detections : [];
  const boxes = info?.status === 'ok'
    ? dets
        .map((det) => {
          const bbox = Array.isArray(det?.bbox) ? det.bbox : null;
          if (!bbox || bbox.length !== 4) return '';
          const [x1, y1, x2, y2] = bbox.map(Number);
          if (![x1, y1, x2, y2].every(Number.isFinite)) return '';
          const left = Math.max(0, Math.min(100, (x1 / imgW) * 100));
          const top = Math.max(0, Math.min(100, (y1 / imgH) * 100));
          const width = Math.max(0.8, Math.min(100, ((x2 - x1) / imgW) * 100));
          const height = Math.max(0.8, Math.min(100, ((y2 - y1) / imgH) * 100));
          const className = escapeHtml(det?.className || 'vehicle');
          const conf = Number.isFinite(Number(det?.conf)) ? Number(det.conf).toFixed(2) : '0.00';
          return `<div class="traffic-bbox" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"><span>${className} ${conf}</span></div>`;
        })
        .join('')
    : '';

  return `
    <div class="traffic-popup">
      <div class="traffic-popup-head">Traffic Cam ${cameraId}</div>
      <div class="traffic-popup-frame">
        <img class="traffic-popup-image" src="${imageUrl}" alt="Traffic camera ${cameraId}" />
        ${boxes}
      </div>
      <div class="traffic-popup-meta">${inferStatus}</div>
      <div class="traffic-popup-time">${escapeHtml(capturedAt)}</div>
    </div>
  `;
}

export default function StaffHome() {
  const [, setPoiStatus] = useState('Loading police, fire and hospital markers...');
  const [, setAdminStatus] = useState('Loading planning area boundaries...');
  const [, setCrowdStatus] = useState(
    ENABLE_MOCK_CROWD_HEAT
      ? 'Loading crowd heat from backend...'
      : 'Mock crowd heat is disabled.'
  );
  const [trafficStatus, setTrafficStatus] = useState('Loading traffic cameras from backend...');
  const [presenceStatus, setPresenceStatus] = useState('Waiting for mobile GPS presence...');
  const [systemMetrics, setSystemMetrics] = useState({
    workingCameras: null,
    totalUsers: null,
    generatedAt: null
  });
  const [systemStatus, setSystemStatus] = useState('Loading system metrics from backend...');
  const [selectedPin, setSelectedPin] = useState(null);
  const [dispatchMode, setDispatchMode] = useState(false);
  const [dispatchStatus, setDispatchStatus] = useState('Enable Dispatch Mode first, then click the map to pin a location.');
  const [isDispatching, setIsDispatching] = useState(false);
  const [mapZoom, setMapZoom] = useState(11);
  const [visibleTrafficCameras, setVisibleTrafficCameras] = useState([]);
  const [debugMessages, setDebugMessages] = useState({});
  const wsRef = useRef(null);
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const dispatchPinLayerRef = useRef(null);
  const dispatchModeRef = useRef(false);
  const trafficCameraMarkersRef = useRef(new Map());
  const trafficCamerasRef = useRef([]);

  const setDebugMessage = (key, message) => {
    setDebugMessages((prev) => {
      const next = { ...prev };
      if (message) {
        next[key] = message;
      } else {
        delete next[key];
      }
      return next;
    });
  };

  useEffect(() => {
    dispatchModeRef.current = dispatchMode;
  }, [dispatchMode]);

  const syncVisibleTrafficCameras = (map) => {
    if (!map) return;
    setMapZoom(map.getZoom());
    const bounds = map.getBounds();
    const visible = trafficCamerasRef.current.filter((camera) => bounds.contains([camera.lat, camera.lng]));
    setVisibleTrafficCameras(visible);
  };

  const focusTrafficCamera = (cameraId) => {
    const map = mapRef.current;
    const marker = trafficCameraMarkersRef.current.get(cameraId);
    if (!map || !marker) return;
    const latLng = marker.getLatLng();
    map.flyTo([latLng.lat, latLng.lng], Math.max(map.getZoom(), 16), { duration: 0.8 });
    marker.openPopup();
  };

  useEffect(() => {
    if (!localStorage.getItem('staffAuth')) {
      window.location.href = '/';
      return;
    }

    const ws = new WebSocketClient();
    wsRef.current = ws;

    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    const fetchSystemMetrics = async () => {
      try {
        const response = await fetch(`${BACKEND_BASE_URL}/system/metrics`);
        if (!response.ok) {
          throw new Error(`Backend request failed (${response.status})`);
        }
        const data = await response.json();
        if (isCancelled) return;

        setSystemMetrics({
          workingCameras: Number.isFinite(Number(data?.workingCameras))
            ? Number(data.workingCameras)
            : null,
          totalUsers: Number.isFinite(Number(data?.totalUsers))
            ? Number(data.totalUsers)
            : null,
          generatedAt: Number.isFinite(Number(data?.generatedAt))
            ? Number(data.generatedAt)
            : null
        });
        const source = String(data?.cameraSource || '').toLowerCase();
        setSystemStatus(
          source === 'cache'
            ? 'System metrics connected (camera count from cache).'
            : 'System metrics connected.'
        );
        setDebugMessage('system', null);
      } catch (error) {
        if (isCancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        setSystemStatus('System metrics unavailable.');
        setDebugMessage('system', `System metrics: ${detail}`);
        console.error('[StaffHome] system metrics error:', error);
      }
    };

    fetchSystemMetrics();
    const intervalId = window.setInterval(fetchSystemMetrics, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) {
      return;
    }

    const singaporeCenter = [1.3521, 103.8198];
    const map = L.map(mapContainerRef.current, {
      center: singaporeCenter,
      zoom: 11,
      minZoom: 11,
      maxZoom: 20,
      zoomSnap: 0.25
    });

    L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default_HD/{z}/{x}/{y}.png', {
      attribution: 'Map data (c) OpenStreetMap contributors, OneMap, Singapore Land Authority',
      maxNativeZoom: 20,
      maxZoom: 20
    }).addTo(map);

    const poiLayers = {};
    POI_TYPES.forEach((poiType) => {
      poiLayers[poiType.key] = L.layerGroup().addTo(map);
    });
    const adminBoundaryLayer = L.layerGroup().addTo(map);
    const crowdAreaLayer = L.layerGroup();
    const crowdHeatLayer = L.layerGroup();
    if (ENABLE_MOCK_CROWD_HEAT) {
      crowdAreaLayer.addTo(map);
    }
    const trafficCameraLayer = L.layerGroup().addTo(map);
    const userPresenceLayer = L.layerGroup().addTo(map);
    const dispatchPinLayer = L.layerGroup().addTo(map);
    dispatchPinLayerRef.current = dispatchPinLayer;

    const crowdAreaScoreByName = new Map();
    const crowdAreas = [];
    let crowdHotspots = [];
    let crowdHeatPoints = [];

    const toLatLng = (record) => {
      const lat = Number(record.LATITUDE || record.Latitude || record.lat);
      const lng = Number(record.LONGITUDE || record.Longitude || record.lng || record.LONGTITUDE);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }
      return [lat, lng];
    };

    const getName = (record) =>
      record.BUILDING || record.SEARCHVAL || record.NAME || record.POSTAL || 'Unknown location';

    const getAddress = (record) => record.ADDRESS || record.ROAD_NAME || '';

    const fetchBackendJson = async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        let detail = '';
        try {
          const json = await response.json();
          detail = json?.error ? `: ${json.error}` : '';
        } catch {
          // no-op
        }
        throw new Error(`Backend request failed (${response.status})${detail}`);
      }
      return response.json();
    };

    const fetchAllPages = async (searchVal) => {
      const results = [];
      const pageLimit = 12;
      for (let pageNum = 1; pageNum <= pageLimit; pageNum += 1) {
        const data = await fetchBackendJson(
          `${BACKEND_BASE_URL}/onemap/search?searchVal=${encodeURIComponent(searchVal)}&pageNum=${pageNum}`
        );
        const pageResults = Array.isArray(data.results) ? data.results : [];
        results.push(...pageResults);
        const totalPages = Number(data.totalNumPages || 0);
        if (!totalPages || pageNum >= totalPages) {
          break;
        }
      }
      return results;
    };

    const uniqueByLatLng = (records) => {
      const seen = new Set();
      return records.filter((item) => {
        const latLng = toLatLng(item);
        if (!latLng) return false;
        const key = `${latLng[0].toFixed(6)},${latLng[1].toFixed(6)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const estimateScoreByDistance = (center) => {
      if (!center || crowdHotspots.length === 0) return 0.08;
      let score = 0;
      for (const hotspot of crowdHotspots) {
        const distance = map.distance(center, [hotspot.lat, hotspot.lng]);
        const influence = hotspot.intensity * Math.exp(-(distance * distance) / (2 * 2200 * 2200));
        score += influence;
      }
      return clamp(score, 0, 1);
    };

    const resolveAreaScore = (areaName, center) => {
      const key = normalizeAreaName(areaName);
      const explicitScore = crowdAreaScoreByName.get(key);
      if (Number.isFinite(explicitScore)) {
        return explicitScore;
      }
      return estimateScoreByDistance(center);
    };

    const drawCrowdHeatLayer = () => {
      crowdHeatLayer.clearLayers();
      for (const point of crowdHeatPoints) {
        const color = crowdColor(point.intensity);
        L.circleMarker([point.lat, point.lng], {
          radius: 2.5 + point.intensity * 6,
          color,
          fillColor: color,
          fillOpacity: 0.22 + point.intensity * 0.35,
          weight: 0
        })
          .bindTooltip(`Crowd: ${(point.intensity * 100).toFixed(0)}%`)
          .addTo(crowdHeatLayer);
      }
    };

    const drawCrowdAreaLayer = () => {
      crowdAreaLayer.clearLayers();
      for (const area of crowdAreas) {
        const color = crowdColor(area.score);
        L.polygon(area.path, {
          color,
          dashArray: '6 6',
          weight: 1,
          fillColor: color,
          fillOpacity: 0.14 + area.score * 0.34
        })
          .bindTooltip(`${area.name}: crowd level ${(area.score * 100).toFixed(0)}%`)
          .addTo(crowdAreaLayer);
      }
    };

    const toggleCrowdViewByZoom = () => {
      if (!ENABLE_MOCK_CROWD_HEAT) {
        if (map.hasLayer(crowdAreaLayer)) map.removeLayer(crowdAreaLayer);
        if (map.hasLayer(crowdHeatLayer)) map.removeLayer(crowdHeatLayer);
        setCrowdStatus('Mock crowd heat is disabled.');
        return;
      }
      const zoom = map.getZoom();
      const showHeat = zoom >= CROWD_DETAIL_ZOOM;
      if (showHeat) {
        if (!map.hasLayer(crowdHeatLayer)) map.addLayer(crowdHeatLayer);
        if (map.hasLayer(crowdAreaLayer)) map.removeLayer(crowdAreaLayer);
        setCrowdStatus((prev) =>
          prev.startsWith('Failed') ? prev : 'Crowd detail mode: zoomed-in backend heat points.'
        );
      } else {
        if (!map.hasLayer(crowdAreaLayer)) map.addLayer(crowdAreaLayer);
        if (map.hasLayer(crowdHeatLayer)) map.removeLayer(crowdHeatLayer);
        setCrowdStatus((prev) =>
          prev.startsWith('Failed') ? prev : 'Crowd overview mode: zoomed-out area crowd alert.'
        );
      }
    };

    const loadPoiMarkers = async () => {
      try {
        for (const poiType of POI_TYPES) {
          const rows = await fetchAllPages(poiType.query);
          const deduped = uniqueByLatLng(rows);
          deduped.forEach((row) => {
            const latLng = toLatLng(row);
            if (!latLng) return;
            const marker = L.marker(latLng, {
              icon: buildPoiIcon(poiType),
              bubblingMouseEvents: false,
              keyboard: false
            });
            marker.bindPopup(
              `<strong>${poiType.label}</strong><br/>${getName(row)}${getAddress(row) ? `<br/>${getAddress(row)}` : ''}`
            );
            marker.on('click', () => {
              map.flyTo(latLng, 19.25, { duration: 0.8 });
            });
            marker.addTo(poiLayers[poiType.key]);
          });
        }
        setPoiStatus('Map markers loaded.');
        setDebugMessage('poi', null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setPoiStatus('Some map markers are unavailable.');
        setDebugMessage('poi', `POI markers: ${detail}`);
        console.error('[StaffHome] poi markers error:', error);
      }
    };

    const loadCrowdHeat = async () => {
      if (!ENABLE_MOCK_CROWD_HEAT) {
        return;
      }
      try {
        const data = await fetchBackendJson(`${BACKEND_BASE_URL}/onemap/crowd-heat`);

        const rawHotspots = Array.isArray(data?.hotspots) ? data.hotspots : [];
        crowdHotspots = rawHotspots
          .map((item) => ({
            lat: Number(item.lat),
            lng: Number(item.lng),
            intensity: clamp(Number(item.intensity), 0, 1),
            planningArea: String(item.planningArea || '')
          }))
          .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng) && Number.isFinite(item.intensity));

        const rawPoints = Array.isArray(data?.detailPoints) ? data.detailPoints : [];
        crowdHeatPoints = rawPoints
          .map((item) => ({
            lat: Number(item.lat),
            lng: Number(item.lng),
            intensity: clamp(Number(item.intensity), 0, 1)
          }))
          .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng) && Number.isFinite(item.intensity));

        crowdAreaScoreByName.clear();
        const rawAreaAlerts = Array.isArray(data?.areaAlerts) ? data.areaAlerts : [];
        for (const area of rawAreaAlerts) {
          const key = normalizeAreaName(area?.planningArea);
          const score = clamp(Number(area?.score), 0, 1);
          if (key && Number.isFinite(score)) {
            crowdAreaScoreByName.set(key, score);
          }
        }

        for (const area of crowdAreas) {
          area.score = resolveAreaScore(area.name, area.center);
        }

        drawCrowdHeatLayer();
        drawCrowdAreaLayer();
        toggleCrowdViewByZoom();

        const profile = data?.context?.profile ? `, profile ${data.context.profile}` : '';
        setCrowdStatus(
          `Crowd heat loaded from backend (${crowdHeatPoints.length} detail points, ${crowdAreaScoreByName.size} area alerts${profile}).`
        );
        setDebugMessage('crowd', null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setCrowdStatus('Crowd heat unavailable.');
        setDebugMessage('crowd', `Crowd heat: ${detail}`);
        console.error('[StaffHome] crowd heat error:', error);
      }
    };

    const loadTrafficCameras = async () => {
      try {
        const data = await fetchBackendJson(`${BACKEND_BASE_URL}/traffic/cameras/enriched?maxCameras=30&withInfer=1`);
        const cameras = Array.isArray(data?.cameras) ? data.cameras : [];

        trafficCameraMarkersRef.current.clear();
        trafficCameraLayer.clearLayers();
        const parsedCameras = [];
        let inferOkCount = 0;
        for (const camera of cameras) {
          const lat = Number(camera?.lat);
          const lng = Number(camera?.lng);
          const imageFromSnapshot = String(camera?.imageUrl || '').trim();
          const finalImageUrl = imageFromSnapshot || String(camera?.image || '').trim();
          const cameraId = String(camera?.cameraId || camera?.camera_id || camera?.id || 'unknown');
          const capturedAt = String(camera?.capturedAt || camera?.timestamp || '');
          const inference = camera?.inference || { status: 'skipped', reason: 'no-inference' };
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || !finalImageUrl) {
            continue;
          }

          const marker = L.marker([lat, lng], {
            icon: buildTrafficCameraIcon(),
            bubblingMouseEvents: false,
            keyboard: false
          });

          const popupHtml = buildTrafficPopupHtml({
            cameraId,
            imageUrl: finalImageUrl,
            capturedAt,
            inference
          });

          marker.bindPopup(popupHtml, { maxWidth: 280, minWidth: 220 });
          marker.addTo(trafficCameraLayer);
          trafficCameraMarkersRef.current.set(cameraId, marker);
          if (inference?.status === 'ok') inferOkCount += 1;
          parsedCameras.push({
            cameraId,
            lat,
            lng,
            imageUrl: finalImageUrl,
            capturedAt,
            inference
          });
        }

        trafficCamerasRef.current = parsedCameras;
        syncVisibleTrafficCameras(map);

        setTrafficStatus(
          `Traffic cameras online: ${parsedCameras.length} (inferred ${inferOkCount}, refresh ${Math.round(TRAFFIC_REFRESH_MS / 1000)}s).`
        );
        setDebugMessage('traffic', null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setTrafficStatus('Traffic cameras unavailable.');
        setDebugMessage('traffic', `Traffic cameras: ${detail}`);
        console.error('[StaffHome] traffic camera error:', error);
      }
    };

    const loadUserPresence = async () => {
      try {
        const data = await fetchBackendJson(`${BACKEND_BASE_URL}/presence/users?maxAgeMs=${PRESENCE_MAX_AGE_MS}`);
        const users = Array.isArray(data?.users) ? data.users : [];
        userPresenceLayer.clearLayers();

        const gridSizeM = 180;
        const hotspotMinUsers = 2;
        const presenceCells = new Map();
        for (const user of users) {
          const lat = Number(user?.lat);
          const lng = Number(user?.lng);
          const ts = Number(user?.ts);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

          const latCell = Math.round(lat / metersToLat(gridSizeM));
          const lngCell = Math.round(lng / metersToLng(gridSizeM, lat));
          const key = `${latCell}:${lngCell}`;
          const existing = presenceCells.get(key) || {
            latSum: 0,
            lngSum: 0,
            count: 0,
            latestTs: 0
          };
          existing.latSum += lat;
          existing.lngSum += lng;
          existing.count += 1;
          existing.latestTs = Number.isFinite(ts) ? Math.max(existing.latestTs, ts) : existing.latestTs;
          presenceCells.set(key, existing);
        }

        const cells = Array.from(presenceCells.values());
        const hotspotCells = cells.filter((cell) => cell.count >= hotspotMinUsers);
        for (const cell of hotspotCells) {
          const centerLat = cell.latSum / cell.count;
          const centerLng = cell.lngSum / cell.count;
          const intensity = presenceIntensityFromCount(cell.count);
          if (intensity <= 0) continue;
          const color = presenceHeatColor(intensity);
          const radius = 7 + intensity * 8;
          L.circleMarker([centerLat, centerLng], {
            radius,
            color,
            fillColor: color,
            fillOpacity: 0.16 + intensity * 0.24,
            weight: 0
          })
            .bindPopup(
              `<strong>Crowd cell</strong><br/>Users: ${cell.count}<br/>Center: ${centerLat.toFixed(5)}, ${centerLng.toFixed(5)}<br/>Last seen: ${
                Number.isFinite(cell.latestTs) && cell.latestTs > 0 ? new Date(cell.latestTs).toLocaleString() : '--'
              }`
            )
            .addTo(userPresenceLayer);
        }

        setPresenceStatus(
          users.length > 0
            ? `Live mobile users: ${users.length}, hotspots: ${hotspotCells.length} (>=${hotspotMinUsers} users/cell, refresh ${Math.round(PRESENCE_REFRESH_MS / 1000)}s).`
            : 'Live mobile users: 0'
        );
        setDebugMessage('presence', null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setPresenceStatus('Live mobile users unavailable.');
        setDebugMessage('presence', `Mobile presence: ${detail}`);
        console.error('[StaffHome] presence error:', error);
      }
    };

    const loadAdministrativeBoundaries = async () => {
      try {
        const data = await fetchBackendJson(
          `${BACKEND_BASE_URL}/onemap/planning-areas?year=${encodeURIComponent(PLANNING_AREA_YEAR)}`
        );
        let drawn = 0;
        const rows = Array.isArray(data?.SearchResults) ? data.SearchResults : [];
        for (const row of rows) {
          const paths = extractPathsFromRecord(row);
          const areaName = row?.pln_area_n || 'Planning Area';

          for (const path of paths) {
            L.polygon(path, {
              color: '#367098',
              weight: 2,
              fillOpacity: 0.06
            })
              .bindTooltip(areaName)
              .addTo(adminBoundaryLayer);

            const center = getPathCenter(path);
            crowdAreas.push({
              name: areaName,
              path,
              center,
              score: resolveAreaScore(areaName, center)
            });
            drawn += 1;
          }
        }

        if (ENABLE_MOCK_CROWD_HEAT) {
          drawCrowdAreaLayer();
          toggleCrowdViewByZoom();
        }
        setAdminStatus(
          drawn > 0
            ? `Planning area boundaries loaded (${drawn} polygons, year ${PLANNING_AREA_YEAR}).`
            : `Planning area API returned no polygon geometry (year ${PLANNING_AREA_YEAR}).`
        );
        setDebugMessage('admin', null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setAdminStatus('Administrative boundaries unavailable.');
        setDebugMessage('admin', `Administrative boundaries: ${detail}`);
        console.error('[StaffHome] administrative boundaries error:', error);
      }
    };

    const syncViewportTraffic = () => syncVisibleTrafficCameras(map);
    map.on('zoomend', toggleCrowdViewByZoom);
    map.on('zoomend', syncViewportTraffic);
    map.on('moveend', syncViewportTraffic);
    map.on('click', (event) => {
      if (!dispatchModeRef.current) {
        return;
      }

      const targetEl = event?.originalEvent?.target;
      if (targetEl && typeof targetEl.closest === 'function') {
        if (
          targetEl.closest('.traffic-camera-marker') ||
          targetEl.closest('.traffic-camera-icon') ||
          targetEl.closest('.leaflet-interactive') ||
          targetEl.closest('.leaflet-popup') ||
          targetEl.closest('.leaflet-marker-icon')
        ) {
          return;
        }
      }

      const lat = Number(event.latlng?.lat);
      const lng = Number(event.latlng?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }

      dispatchPinLayer.clearLayers();
      L.circleMarker([lat, lng], {
        radius: 9,
        color: '#183a4f',
        fillColor: '#79bbcf',
        fillOpacity: 0.95,
        weight: 2
      })
        .bindTooltip(`Dispatch Pin (${lat.toFixed(5)}, ${lng.toFixed(5)})`)
        .addTo(dispatchPinLayer);

      setSelectedPin({ lat, lng });
      setDispatchStatus(`Pin set at (${lat.toFixed(5)}, ${lng.toFixed(5)}).`);
    });
    toggleCrowdViewByZoom();

    loadPoiMarkers();
    loadAdministrativeBoundaries();
    loadCrowdHeat();
    loadTrafficCameras();
    loadUserPresence();
    syncVisibleTrafficCameras(map);
    const trafficIntervalId = window.setInterval(loadTrafficCameras, TRAFFIC_REFRESH_MS);
    const presenceIntervalId = window.setInterval(loadUserPresence, PRESENCE_REFRESH_MS);
    mapRef.current = map;

    return () => {
      window.clearInterval(trafficIntervalId);
      window.clearInterval(presenceIntervalId);
      map.off('zoomend', syncViewportTraffic);
      map.off('moveend', syncViewportTraffic);
      map.off('zoomend', toggleCrowdViewByZoom);
      map.off('click');
      map.remove();
      mapRef.current = null;
      dispatchPinLayerRef.current = null;
    };
  }, []);

  const handleDispatch = async (serviceType) => {
    if (!dispatchMode) {
      setDispatchStatus('Enable Dispatch Mode first, then click the map to place a pin.');
      return;
    }

    if (!selectedPin) {
      setDispatchStatus('Please pin a location on the map first.');
      return;
    }

    setIsDispatching(true);
    setDispatchStatus('Sending dispatch request to backend...');

    const payload = {
      type: 'emergency_dispatch',
      serviceType,
      strategy: 'nearest_unit',
      target: {
        lat: selectedPin.lat,
        lng: selectedPin.lng
      },
      requestedAt: new Date().toISOString(),
      source: 'staff_home'
    };

    try {
      const response = await fetch(buildBackendUrl(DISPATCH_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let detail = '';
        try {
          const errorBody = await response.json();
          detail = errorBody?.error ? `: ${errorBody.error}` : '';
        } catch {
          // no-op
        }
        throw new Error(`Backend request failed (${response.status})${detail}`);
      }

      setDispatchStatus(`Dispatch sent: nearest ${serviceType} requested.`);
    } catch (error) {
      setDispatchStatus(`Dispatch failed: ${error.message}`);
    } finally {
      setIsDispatching(false);
    }
  };

  return (
    <div className="staff-page">
      <header className="staff-header">
        <div className="staff-header-inner">
          <h1 className="staff-title">Staff Center</h1>
        </div>
      </header>

      <main className="staff-main">
        <section className="staff-panel">
          <h2 className="panel-title">Singapore Live Map</h2>
          <div className="map-and-system">
            <div ref={mapContainerRef} className="map-box" />
            <aside className="system-panel" aria-label="System Module">
              <h3 className="system-title">System Module</h3>
              <div className="system-metric-grid">
                <div className="system-metric-card">
                  <p className="system-metric-label">Working Cameras</p>
                  <p className="system-metric-value">
                    {systemMetrics.workingCameras ?? '--'}
                  </p>
                </div>
                <div className="system-metric-card">
                  <p className="system-metric-label">Total Users</p>
                  <p className="system-metric-value">
                    {systemMetrics.totalUsers ?? '--'}
                  </p>
                </div>
              </div>
              <p className="system-status">{systemStatus}</p>
              <p className="system-status">
                Last update:{' '}
                {systemMetrics.generatedAt
                  ? new Date(systemMetrics.generatedAt).toLocaleTimeString()
                  : '--'}
              </p>
              <div className="dispatch-panel">
                <h4 className="dispatch-title">Emergency Dispatch</h4>
                <button
                  type="button"
                  className={`dispatch-mode-btn ${dispatchMode ? 'dispatch-mode-on' : ''}`}
                  onClick={() => {
                    setDispatchMode((prev) => {
                      const next = !prev;
                      setDispatchStatus(
                        next
                          ? 'Dispatch Mode enabled. Click map to place a pin.'
                          : 'Dispatch Mode disabled. Camera clicks will only open preview.'
                      );
                      return next;
                    });
                  }}
                >
                  {dispatchMode ? 'Dispatch Mode: ON' : 'Dispatch Mode: OFF'}
                </button>
                <p className="dispatch-text">
                  Pin: {selectedPin ? `${selectedPin.lat.toFixed(5)}, ${selectedPin.lng.toFixed(5)}` : '--'}
                </p>
                <div className="dispatch-actions">
                  <button
                    type="button"
                    className="dispatch-btn dispatch-police"
                    disabled={!selectedPin || isDispatching}
                    onClick={() => handleDispatch('police')}
                  >
                    Dispatch Nearest Police Unit
                  </button>
                  <button
                    type="button"
                    className="dispatch-btn dispatch-fire"
                    disabled={!selectedPin || isDispatching}
                    onClick={() => handleDispatch('firefighter')}
                  >
                    Dispatch Nearest Fire Crew
                  </button>
                  <button
                    type="button"
                    className="dispatch-btn dispatch-ambulance"
                    disabled={!selectedPin || isDispatching}
                    onClick={() => handleDispatch('ambulance')}
                  >
                    Dispatch Nearest Ambulance
                  </button>
                </div>
                <p className="dispatch-text">{dispatchStatus}</p>
              </div>
            </aside>
          </div>
          <div className="legend-row">
            <span className="legend-item"><span className="legend-badge legend-badge-police">🧢</span>Police</span>
            <span className="legend-item"><span className="legend-badge legend-badge-fire">⛑</span>Fire</span>
            <span className="legend-item"><span className="legend-badge legend-badge-hospital">✚</span>Hospital</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#367098' }} />Administrative Boundary</span>
            {ENABLE_MOCK_CROWD_HEAT && (
              <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#b91c1c' }} />Crowd Alert (Zoom out)</span>
            )}
            {ENABLE_MOCK_CROWD_HEAT && (
              <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#f97316' }} />Crowd Heat (Zoom in)</span>
            )}
            <span className="legend-item"><span className="legend-badge legend-badge-camera">📹</span>Traffic Camera</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#ef4444' }} />Mobile Presence Heat</span>
          </div>
          <p className="status-text">{trafficStatus}</p>
          <p className="status-text">{presenceStatus}</p>
          {Object.keys(debugMessages).length > 0 && (
            <details className="debug-panel">
              <summary className="debug-summary">Debug details ({Object.keys(debugMessages).length})</summary>
              <ul className="debug-list">
                {Object.entries(debugMessages).map(([scope, message]) => (
                  <li key={scope}>
                    <strong>{scope}:</strong> {message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="camera-explorer">
          <div className="camera-explorer-head">
            <h2 className="camera-explorer-title">Traffic Camera Explorer</h2>
            <p className="camera-explorer-subtitle">
              {`Map zoom ${mapZoom.toFixed(2)}. ${
                mapZoom >= CAMERA_EXPLORER_ZOOM
                  ? 'Showing cameras in current map view.'
                  : 'Pick a region first, then zoom in to browse cameras.'
              }`}
            </p>
          </div>

          {mapZoom < CAMERA_EXPLORER_ZOOM ? (
            <div className="camera-region-grid">
              {CAMERA_REGIONS.map((region) => (
                <button
                  key={region.key}
                  type="button"
                  className="camera-region-btn"
                  onClick={() => {
                    const map = mapRef.current;
                    if (!map) return;
                    map.flyTo(region.center, region.zoom, { duration: 0.85 });
                  }}
                >
                  {region.label}
                </button>
              ))}
            </div>
          ) : visibleTrafficCameras.length === 0 ? (
            <div className="empty-state">
              <h2>No cameras in this view</h2>
              <p>Drag the map a little or zoom out and pick another region.</p>
            </div>
          ) : (
            <div className="camera-card-grid">
              {visibleTrafficCameras.map((camera) => (
                <article key={camera.cameraId} className="camera-card">
                  <img
                    className="camera-card-image"
                    src={camera.imageUrl}
                    alt={`Traffic camera ${camera.cameraId}`}
                  />
                  <div className="camera-card-body">
                    <p className="camera-card-title">Cam {camera.cameraId}</p>
                    <p className="camera-card-count">
                      {camera?.inference?.status === 'ok'
                        ? `Vehicles: ${camera.inference.vehicleCount}`
                        : camera?.inference?.status === 'error'
                          ? 'Infer failed'
                          : 'Infer skipped'}
                    </p>
                    <p className="camera-card-time">
                      {camera.capturedAt
                        ? `Captured: ${new Date(camera.capturedAt).toLocaleString()}`
                        : 'Captured time unavailable'}
                    </p>
                    <button
                      type="button"
                      className="camera-card-open"
                      onClick={() => focusTrafficCamera(camera.cameraId)}
                    >
                      Open on map
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
