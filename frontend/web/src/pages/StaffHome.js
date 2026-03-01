import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { WebSocketClient } from '../api/websocket';

const POI_TYPES = [
  { key: 'police', label: 'Police Station', query: 'Police Station', color: '#2563eb' },
  { key: 'fire', label: 'Fire Station', query: 'Fire Station', color: '#dc2626' },
  { key: 'hospital', label: 'Hospital', query: 'Hospital', color: '#16a34a' }
];

export default function StaffHome() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [poiStatus, setPoiStatus] = useState('Loading police, fire and hospital markers...');
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
        const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
          searchVal
        )}&returnGeom=Y&getAddrDetails=Y&pageNum=${pageNum}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`OneMap search failed (${response.status})`);
        }
        const data = await response.json();
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

    loadPoiMarkers();
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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">Staff Center</h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <section className="bg-white rounded-lg shadow-md p-4 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-3">Singapore Live Map</h2>
          <div ref={mapContainerRef} style={{ height: '380px', width: '100%', borderRadius: '8px' }} />
          <div className="mt-3 flex items-center gap-4 text-sm text-gray-700">
            <span className="inline-flex items-center gap-2"><span style={{ width: '10px', height: '10px', borderRadius: '9999px', backgroundColor: '#2563eb', display: 'inline-block' }} />Police</span>
            <span className="inline-flex items-center gap-2"><span style={{ width: '10px', height: '10px', borderRadius: '9999px', backgroundColor: '#dc2626', display: 'inline-block' }} />Fire</span>
            <span className="inline-flex items-center gap-2"><span style={{ width: '10px', height: '10px', borderRadius: '9999px', backgroundColor: '#16a34a', display: 'inline-block' }} />Hospital</span>
          </div>
          <p className="mt-2 text-sm text-gray-600">{poiStatus}</p>
          <p className="mt-2 text-sm text-gray-500">
            Powered by OneMap API (
            <a href="https://www.onemap.gov.sg/" target="_blank" rel="noreferrer">
              onemap.gov.sg
            </a>
            )
          </p>
        </section>

        {isLoading ? (
          <div className="text-center py-12">Loading...</div>
        ) : assistRequests.length === 0 ? (
          <div className="text-center py-12">
            <h2 className="text-2xl font-semibold text-gray-900">No pending requests</h2>
            <p className="mt-1 text-gray-500">Waiting for new assist requests...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {assistRequests.map((request) => (
              <div key={request.requestId} className="bg-white rounded-lg shadow-md p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-medium text-gray-900">Assist Request</h3>
                  <span
                    className={`px-2 py-1 text-xs font-semibold rounded-full ${
                      request.severity === 'critical'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {request.severity === 'critical' ? 'Critical' : 'Warning'}
                  </span>
                </div>

                <p className="mt-2 text-gray-600">
                  {request.type === 'fall' ? 'Fall detected' : 'Abnormal zone'} at {request.zoneId}
                </p>

                <div className="mt-4 flex space-x-3">
                  <button
                    onClick={() => handleAccept(request.requestId)}
                    className="flex-1 bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 transition duration-150"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleDecline(request.requestId)}
                    className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700 transition duration-150"
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
