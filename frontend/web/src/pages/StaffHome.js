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
const PLANNING_AREA_YEAR = process.env.REACT_APP_PLANNING_AREA_YEAR || '2019';

function normalizeText(value) {
  return String(value || '').toLowerCase();
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

export default function StaffHome() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [poiStatus, setPoiStatus] = useState('Loading police, fire and hospital markers...');
  const [adminStatus, setAdminStatus] = useState('Loading planning area boundaries...');
  const wsRef = useRef(null);
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);

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
    if (mapRef.current || !mapContainerRef.current) {
      return;
    }

    const singaporeCenter = [1.3521, 103.8198];
    const map = L.map(mapContainerRef.current, {
      center: singaporeCenter,
      zoom: 11,
      minZoom: 11,
      maxZoom: 18
    });

    L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png', {
      attribution: 'Map data (c) OpenStreetMap contributors, OneMap, Singapore Land Authority'
    }).addTo(map);

    const poiLayers = {};
    POI_TYPES.forEach((poiType) => {
      poiLayers[poiType.key] = L.layerGroup().addTo(map);
    });
    const adminBoundaryLayer = L.layerGroup().addTo(map);

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
            marker.addTo(poiLayers[poiType.key]);
          });
        }
        setPoiStatus('Markers loaded from OneMap search API');
      } catch (error) {
        setPoiStatus(`Failed to load some markers: ${error.message}`);
      }
    };

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
        throw new Error(`Backend OneMap proxy failed (${response.status})${detail}`);
      }
      return response.json();
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
          for (const path of paths) {
            L.polygon(path, {
              color: '#367098',
              weight: 2,
              fillOpacity: 0.06
            })
              .bindTooltip(row?.pln_area_n || 'Planning Area')
              .addTo(adminBoundaryLayer);
            drawn += 1;
          }
        }

        setAdminStatus(
          drawn > 0
            ? `Planning area boundaries loaded (${drawn} polygons, year ${PLANNING_AREA_YEAR}).`
            : `Planning area API returned no polygon geometry (year ${PLANNING_AREA_YEAR}).`
        );
      } catch (error) {
        setAdminStatus(`Failed to load administrative boundaries: ${error.message}`);
      }
    };

    loadPoiMarkers();
    loadAdministrativeBoundaries();
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

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
          <div ref={mapContainerRef} className="map-box" />
          <div className="legend-row">
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#2563eb' }} />Police</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#dc2626' }} />Fire</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#16a34a' }} />Hospital</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#367098' }} />Administrative Boundary</span>
          </div>
          <p className="status-text">{poiStatus}</p>
          <p className="status-text">{adminStatus}</p>
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
                  {request.type === 'fall' ? 'Fall detected' : 'Abnormal zone'} at {request.zoneId}
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
