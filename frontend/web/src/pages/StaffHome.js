import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { WebSocketClient } from '../api/websocket';
import './StaffHome.css';

const POI_TYPES = [
  { key: 'police', label: 'Police Station', query: 'Police Station', color: '#2563eb' },
  { key: 'fire', label: 'Fire Station', query: 'Fire Station', color: '#dc2626' },
  { key: 'hospital', label: 'Hospital', query: 'Hospital', color: '#16a34a' }
];

const BACKEND_BASE_URL = (process.env.REACT_APP_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const DISPATCH_ENDPOINT = process.env.REACT_APP_DISPATCH_ENDPOINT || '/dispatch/request';
const PLANNING_AREA_YEAR = process.env.REACT_APP_PLANNING_AREA_YEAR || '2019';
const CROWD_DETAIL_ZOOM = 13.5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

export default function StaffHome() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [poiStatus, setPoiStatus] = useState('Loading police, fire and hospital markers...');
  const [adminStatus, setAdminStatus] = useState('Loading planning area boundaries...');
  const [crowdStatus, setCrowdStatus] = useState('Loading crowd heat from backend...');
  const [systemMetrics, setSystemMetrics] = useState({
    workingCameras: null,
    totalUsers: null,
    generatedAt: null
  });
  const [systemStatus, setSystemStatus] = useState('Loading system metrics from backend...');
  const [selectedPin, setSelectedPin] = useState(null);
  const [dispatchStatus, setDispatchStatus] = useState('Click the map to pin a location.');
  const [isDispatching, setIsDispatching] = useState(false);
  const wsRef = useRef(null);
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const dispatchPinLayerRef = useRef(null);

  useEffect(() => {
    if (!localStorage.getItem('staffAuth')) {
      window.location.href = '/';
      return;
    }

    const ws = new WebSocketClient();
    wsRef.current = ws;

    ws.on('connect', () => {
      setIsLoading(false);
    });

    ws.on('assist_request', (event) => {
      setAssistRequests((prev) => [...prev, event.payload]);
    });

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
        setSystemStatus('System metrics synced from backend.');
      } catch (error) {
        if (isCancelled) return;
        setSystemStatus(`Failed to load system metrics: ${error.message}`);
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
    const crowdAreaLayer = L.layerGroup().addTo(map);
    const crowdHeatLayer = L.layerGroup().addTo(map);
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
            const marker = L.circleMarker(latLng, {
              radius: 6,
              color: poiType.color,
              fillColor: poiType.color,
              fillOpacity: 0.9,
              weight: 1
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
        setPoiStatus('Markers loaded from OneMap search API');
      } catch (error) {
        setPoiStatus(`Failed to load some markers: ${error.message}`);
      }
    };

    const loadCrowdHeat = async () => {
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
      } catch (error) {
        setCrowdStatus(`Failed to load crowd heat: ${error.message}`);
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

        drawCrowdAreaLayer();
        toggleCrowdViewByZoom();
        setAdminStatus(
          drawn > 0
            ? `Planning area boundaries loaded (${drawn} polygons, year ${PLANNING_AREA_YEAR}).`
            : `Planning area API returned no polygon geometry (year ${PLANNING_AREA_YEAR}).`
        );
      } catch (error) {
        setAdminStatus(`Failed to load administrative boundaries: ${error.message}`);
      }
    };

    map.on('zoomend', toggleCrowdViewByZoom);
    map.on('click', (event) => {
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
    mapRef.current = map;

    return () => {
      map.off('zoomend', toggleCrowdViewByZoom);
      map.off('click');
      map.remove();
      mapRef.current = null;
      dispatchPinLayerRef.current = null;
    };
  }, []);

  const handleDispatch = async (serviceType) => {
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

  const handleAccept = (requestId) => {
    wsRef.current?.send({
      type: 'assist_response',
      payload: {
        requestId,
        action: 'accept'
      }
    });

    setAssistRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  };

  const handleDecline = (requestId) => {
    wsRef.current?.send({
      type: 'assist_response',
      payload: {
        requestId,
        action: 'decline'
      }
    });

    setAssistRequests((prev) => prev.filter((r) => r.requestId !== requestId));
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
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#2563eb' }} />Police</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#dc2626' }} />Fire</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#16a34a' }} />Hospital</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#367098' }} />Administrative Boundary</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#b91c1c' }} />Crowd Alert (Zoom out)</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#f97316' }} />Crowd Heat (Zoom in)</span>
          </div>
          <p className="status-text">{poiStatus}</p>
          <p className="status-text">{adminStatus}</p>
          <p className="status-text">{crowdStatus}</p>
          <p className="source-text">
            Powered by OneMap API (
            <a href="https://www.onemap.gov.sg/" target="_blank" rel="noreferrer">
              onemap.gov.sg
            </a>
            )
          </p>
        </section>

        {isLoading ? (
          <div className="empty-state">Loading...</div>
        ) : assistRequests.length === 0 ? (
          <div className="empty-state">
            <h2>No pending requests</h2>
            <p>Waiting for new assist requests...</p>
          </div>
        ) : (
          <div className="request-list">
            {assistRequests.map((request) => (
              <div key={request.requestId} className="request-card">
                <div className="request-head">
                  <h3>Assist Request</h3>
                  <span
                    className={`severity-badge ${
                      request.severity === 'critical'
                        ? 'severity-critical'
                        : 'severity-warning'
                    }`}
                  >
                    {request.severity === 'critical' ? 'Critical' : 'Warning'}
                  </span>
                </div>

                <p className="request-text">
                  {request.message || 'Assist request'}{request.loc?.zoneId ? ` (Zone ${request.loc.zoneId})` : ''}
                </p>

                <div className="request-actions">
                  <button
                    onClick={() => handleAccept(request.requestId)}
                    className="btn btn-accept"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleDecline(request.requestId)}
                    className="btn btn-decline"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
