# CitizenWatch CCTV/Pipeline Documentation

This document covers the complete CCTV feature stack: browser stream, API bridge, Python pipeline, identity matching, and demo/ops usage.

## 1) Architecture Overview

- `web` (`web/src/app/cctv/page.tsx`, `web/src/app/cctv/dashboard/page.tsx`) captures webcam frames and sends them to the Node API over Socket.IO namespace `/cctv-stream`.
- `apps/api` (`apps/api/src/index.ts`) receives `cctv:frame`, forwards frame bytes to Python via persistent binary WebSocket client (`apps/api/src/services/cctvStream.ts`), then returns annotated frame + metadata to browser.
- `apps/cctv-pipeline` runs:
  - Flask HTTP API on `CCTV_PORT` (default `3600`) via `server.py`
  - Binary WebSocket pipeline server on `CCTV_WS_PORT` (default `3601`) via `ws_server.py`
- API persists match intelligence to PostgreSQL (Prisma models), dedupes alerts, and emits events (`criminal:matched`) to authenticated clients.

## 2) Data Flow (Live Surveillance)

1. User opens `http://localhost:3000/cctv` and starts stream.
2. Browser:
   - grabs a frame from webcam,
   - JPEG-encodes,
   - emits `cctv:frame` with frame bytes + camera metadata.
3. API:
   - validates/authenticates Socket.IO client,
   - forwards frame to pipeline (`recognizeFrame()`),
   - enriches result (`processRecognitionResult()`),
   - emits annotated payload to monitor room and returns ACK to sender.
4. Pipeline:
   - runs person detect + face detect + identity vote logic,
   - returns annotated frame bytes + metadata (`faces`, `match_count`, timings).
5. Browser updates preview/match panel.

## 3) Main Components

### Web (`web/src/app/cctv/page.tsx`)
- Role-gated live CCTV UI.
- Uses backpressured stream loop (`sendNextFrame`) with in-flight guard.
- Uses `authFetch` for authenticated HTTP actions.
- Uses Socket.IO with JWT auth (`auth: { token }`).
- Recent hardening:
  - bounds outgoing frame size to reduce unstable inference paths,
  - ACK guard to avoid silent "loading forever".

### API (`apps/api`)
- `src/index.ts`
  - Socket.IO namespace `/cctv-stream`
  - per-camera state + monitor broadcast (`cctv:cameras`, `cctv:annotated`)
  - auth/session validation for socket clients
- `src/services/cctvStream.ts`
  - persistent binary ws client to pipeline (`ws://localhost:3601`)
  - frame timeout configurable (`CCTV_PIPELINE_WS_TIMEOUT_MS`, default currently 45000)
- `src/routes/cctv.ts`
  - upload mode endpoints, criminal registration, DB synchronization
  - persistence and alert generation

### Pipeline (`apps/cctv-pipeline`)
- `server.py`: Flask API entrypoint (detect, match, register samples, status, health)
- `ws_server.py`: binary websocket server for low-latency frame recognition
- `face_engine.py`: identity logic (ArcFace face embeddings + OSNet ReID + vote-based track locking)
- `person_motion_tracker.py`: ByteTrack per-camera motion track IDs
- `tracker.py`: vote history and lock/unlock identity state by track ID

## 4) Recognition Logic Summary

For each frame:
- Detect persons (YOLO) and faces (ArcFace/fallback).
- Track persons with ByteTrack (stable motion IDs).
- For each track:
  - face vote candidate (ArcFace),
  - body vote candidate (OSNet ReID),
  - optional global-reid fallback cache.
- Votes are weighted and accumulated in sliding history.
- Track locks only after sufficient weighted confidence.
- Match alert eligibility additionally requires:
  - min track age,
  - min locked confidence,
  - min face vote frames.

## 5) Criminal Registration Behavior (Current)

### Important change
- The previous "minimum 5 images" requirement has been removed.
- New enrollment now accepts **at least 1 valid face sample**.

Changed in:
- `apps/api/src/routes/cctv.ts` (removed API-side minimum gate)
- `apps/cctv-pipeline/face_engine.py` (minimum now defaults to 1 and no hard rejection block)

## 6) Endpoints

### API (Node, `localhost:3001`)
- `GET /health`
- `POST /api/cctv/upload`
- `GET /api/cctv/recognition-status`
- `POST /api/cctv/register-criminal-samples`
- `POST /api/cctv/criminal-db/:id/add-samples`
- Socket.IO namespace: `/cctv-stream`

### Pipeline (Python, `localhost:3600` + `3601`)
- `GET /health`
- `POST /detect`
- `POST /detect-faces`
- `POST /match-face`
- `POST /register-samples`
- `GET /recognition-status`
- Binary WebSocket server on `ws://127.0.0.1:3601`

## 7) Environment Variables

### API `.env` (typical)
- `DATABASE_URL`
- `JWT_SECRET`
- `CCTV_PIPELINE_URL` (default `http://localhost:3600`)
- `CCTV_PIPELINE_WS_URL` (default `ws://localhost:3601`)
- `CCTV_PIPELINE_WS_TIMEOUT_MS` (optional; default in code is 45000)

### Pipeline runtime
- `CCTV_HOST` (default `127.0.0.1`)
- `CCTV_PORT` (default `3600`)
- `CCTV_WS_HOST` (default `127.0.0.1`)
- `CCTV_WS_PORT` (default `3601`)
- `CCTV_USE_WAITRESS` (`1` recommended)
- identity thresholds (ArcFace/ReID/tracker lock related vars in `face_engine.py`)

## 8) Runbook

## Start order
1. Python pipeline
2. Node API
3. Web app

### Pipeline command (PowerShell)
```powershell
Set-Location "C:\Users\Elite\Documents\citizenwatch-1\apps\cctv-pipeline"
$env:FACE_MODEL_PROVIDER='CUDAExecutionProvider'
$env:FACE_MODEL_CTX_ID='0'
$env:REID_DEVICE='cuda'
$env:YOLO_DEVICE='0'
$env:FACE_MODEL_DET_SIZE='320'
$env:PYTHONUNBUFFERED='1'
$env:CCTV_USE_WAITRESS='1'
.\venv\Scripts\python -u server.py
```

### API command
```powershell
Set-Location "C:\Users\Elite\Documents\citizenwatch-1\apps\api"
$env:DATABASE_URL='postgresql://user:password@localhost:5433/citizenwatch-db'
npm run start
```

### Web command
```powershell
Set-Location "C:\Users\Elite\Documents\citizenwatch-1\web"
npm run dev
```

### Health checks
```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3600/health
Invoke-WebRequest -UseBasicParsing http://localhost:3001/health
```

## 9) Troubleshooting

### Symptom: CCTV page loads forever
- Check API logs for `Pipeline timeout after ...`.
- Check pipeline logs for deadlock/stalls.
- Ensure ports are listening: `3000`, `3001`, `3600`, `3601`.
- Restart pipeline first, then API, then refresh web page.

### Symptom: 401 on CCTV/auth routes
- Token/session invalid or expired.
- Re-login; app now auto-logs-out on 401 in authenticated flows.

### Symptom: false identity matches
- Raise ArcFace threshold and margin.
- Raise tracker lock min confidence.
- Require face-backed frames before `is_match` display.

## 10) Demo

For a quick live pipeline demo script:

```powershell
Set-Location "C:\Users\Elite\Documents\citizenwatch-1\apps\cctv-pipeline"
$env:DEMO_N='10'
.\venv\Scripts\python demo_agent.py
```

`demo_agent.py` sends frames from a sample image in `criminal_db/original_samples` to `ws://127.0.0.1:3601` and prints top identity result per frame with RTT/pipeline timing.

