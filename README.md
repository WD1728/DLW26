# SafeFlow (DLW26)

SafeFlow is a multi-service project for crowd awareness and emergency response experiments in Singapore scenarios.

This repository contains:
- `ml-service`: Python Flask service for traffic camera vehicle inference (YOLO-based).
- `backend`: Node.js/TypeScript API and realtime coordination server.
- `frontend/web`: React web staff dashboard (`/staff`).
- `frontend/mobile`: Expo React Native mobile client with GPS reporting.

## Current Features

- Live OneMap-based map view.
- POI overlays with custom icons:
- Police stations (blue police cap)
- Fire stations (red safety helmet)
- Hospitals (red cross)
- Traffic cameras (camera icon)
- Traffic camera ingestion from Data.gov.sg with optional per-camera ML vehicle inference.
- Vehicle detections rendered in the web popup with bounding boxes.
- Live mobile GPS presence ingestion and map visualization.
- Presence heatmap on web (absolute-density style, grid-aggregated).
- Presence simulator for multi-user load and movement patterns:
- Random wandering
- Converge to target
- Disperse then converge
- Singapore commute-like mode (residential -> destination -> home)
- Routing/risk core modules and websocket event publisher in backend.
- Mobile app GPS auto-center and periodic backend sync.

## Repository Layout

- `ml-service/` Python ML inference service and model assets.
- `backend/` Express + Socket.IO server and simulators.
- `frontend/web/` React CRA web app.
- `frontend/mobile/` Expo mobile app.
- `shared/` shared schemas/contracts used across services.

## Ports and Service Topology

- ML service: `http://127.0.0.1:8099`
- Backend API: `http://127.0.0.1:8080`
- Web frontend: `http://127.0.0.1:3000`
- Mobile Expo dev server: `http://127.0.0.1:8090` (dev tooling)

Backend calls ML service at:
- `ML_SERVICE_BASE_URL` (default `http://127.0.0.1:8099`)
- endpoint: `/infer/traffic-camera`

## Prerequisites

- Node.js 18+ (recommended 20 LTS).
- npm 9+.
- Python 3.10-3.12 recommended for `ml-service`.
- On Windows, if `opencv-python` install fails on Python 3.13/ARM64, use Python 3.12 x64.

## Environment Variables

Backend (`backend/.env`):
- `ONEMAP_API_TOKEN=<your_token>` required for protected OneMap endpoints used by planning area APIs.
- `ML_SERVICE_BASE_URL=http://127.0.0.1:8099` optional override.

Web (`frontend/web/.env`, optional):
- `REACT_APP_API_BASE_URL=http://localhost:8080`
- `REACT_APP_WS_BASE_URL=ws://localhost:8080`
- `REACT_APP_DISPATCH_ENDPOINT=/dispatch/request` (only if you provide that endpoint externally)

Mobile (`frontend/mobile/.env` from `.env.example`):
- `EXPO_PUBLIC_API_BASE_URL=http://<YOUR_LAN_IP>:8080`
- `EXPO_PUBLIC_WS_BASE_URL=ws://<YOUR_LAN_IP>:8080`

ML service (optional env vars):
- `ML_BIND_HOST` default `127.0.0.1`
- `ML_BIND_PORT` default `8099`
- `ML_DEVICE` default `auto`
- `ML_PERSON_MODEL` default `ml-service/models/yolov8n.pt`
- `ML_VEHICLE_MODEL` default `ml-service/models/vehicle_best.pt`

## Run All Services (PowerShell, 4 Terminals)

### 1) Start `ml-service`

```powershell
cd C:\Users\User\Documents\IDEProjects\DLW26\ml-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
python service\server.py
```

Health check:

```powershell
curl http://127.0.0.1:8099/health
```

### 2) Start `backend`

```powershell
cd C:\Users\User\Documents\IDEProjects\DLW26\backend
npm install
npm run dev
```

Health check:

```powershell
curl http://127.0.0.1:8080/health
```

### 3) Start `frontend/web`

```powershell
cd C:\Users\User\Documents\IDEProjects\DLW26\frontend\web
npm install
npm start
```

Open:
- `http://localhost:3000`
- Sign in with any non-empty username/password (current login is local gate, not full auth).
- You will be routed to `/staff`.

### 4) Start `frontend/mobile`

```powershell
cd C:\Users\User\Documents\IDEProjects\DLW26\frontend\mobile
npm install
npx expo start --port 8090
```

If `expo` command is not found, always use `npx expo ...` instead of `expo ...`.

## Presence Simulation

Run from `backend/`:

```powershell
npm run simulate:presence -- --users 120 --interval-ms 1200 --duration-sec 300 --mode sg-commute --cycle-sec 180 --drift-m 40 --cluster-radius-m 220
```

Useful modes:
- `--mode random`
- `--mode converge --target-lat 1.3048 --target-lng 103.8318`
- `--mode disperse-converge --cycle-sec 120 --disperse-ratio 0.45`
- `--mode sg-commute` (residential -> destination -> home loop)

If simulator shows `ok=0 fail=N`, check backend is actually running on `127.0.0.1:8080`.

## Key Backend Endpoints

- `GET /health`
- `POST /presence/register`
- `POST /presence/update`
- `POST /presence/offline`
- `GET /presence/users`
- `GET /system/metrics`
- `GET /onemap/search`
- `GET /onemap/planning-areas`
- `GET /traffic/cameras`
- `GET /traffic/cameras/enriched?withInfer=1`

## ML Service Endpoints

- `GET /health`
- `POST /infer/traffic-camera`

`/infer/traffic-camera` expects:
- `cameraId`
- `imageBase64` (data URL or raw base64 string)
- optional `imageUrl`
- optional `capturedAt`

## Troubleshooting

- `ModuleNotFoundError: No module named 'ml'`
- Run `python service\server.py` from inside `ml-service` directory.
- `opencv-python` build failures on Windows
- Prefer Python 3.12 x64 and recreate virtualenv.
- Mobile cannot reach backend
- Use LAN IP in `frontend/mobile/.env` (`EXPO_PUBLIC_API_BASE_URL`), not `localhost`.
- OneMap planning area request fails
- Ensure `ONEMAP_API_TOKEN` is valid in `backend/.env`.

## Notes

- `frontend/web` includes additional pages: `/staff-ntu`, `/staff-stadium`, `/map-debug`.
- Dispatch button in `StaffHome` is configurable by `REACT_APP_DISPATCH_ENDPOINT`; ensure a handler exists if you need real dispatch actions.
