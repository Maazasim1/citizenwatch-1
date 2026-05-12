# CitizenWatch Project Context

This file is a handoff context for future chats, especially for continuing CCTV/AI upgrades and final FYP polishing.

## 1) Project Overview

CitizenWatch is a role-based public safety platform with 3 primary user roles:

- Citizen
- Moderator
- Inspector (LAW_ENFORCEMENT)

Core capabilities:

- Incident reporting and moderation workflow
- Live map with verified reports and hotspot clusters
- Community vote corroboration
- Escalation and resolution handling
- Safe routing (shortest + safer alternative)
- CCTV live/file analysis with criminal matching
- Notifications and intelligence dashboard

## 2) Current Tech Stack

- Frontend: Next.js + React + Tailwind + Leaflet
- API: Node.js + Express + Prisma
- DB: PostgreSQL
- Realtime: Socket.IO
- CCTV pipeline: Python Flask + OpenCV
- Auth: JWT + session tracking

## 3) High-Level Architecture

1. Frontend dashboards call API routes.
2. API persists state in PostgreSQL and emits realtime events.
3. API forwards media/recognition tasks to Python CCTV pipeline.
4. CCTV pipeline returns detections/matches; API stores and fans out alerts.

Important directories:

- `web/` -> Next.js frontend
- `apps/api/` -> Express + Prisma backend
- `apps/cctv-pipeline/` -> Flask + CV pipeline

## 4) Role Workflows (Stabilized)

### Citizen

- Can submit reports with location/media
- Can view verified live map + hotspots
- Can vote/unvote in community flow
- Profile persistence fixed
- Safe route analytics and conditional alternative improved

### Moderator

- Moderation queue verifies/rejects reports
- Verified reports propagate to map/community/hotspots
- Read-only community signals visible
- Profile persistence and notification flow validated

### Inspector

- Escalation + resolution handling unified in escalation workflow
- Resolved report behavior integrated
- Live intelligence and CCTV alerts with location/frame linkage
- Read-only community signals visible

## 5) Major Fixes Already Applied

### Map / Hotspots / UI

- Improved popup readability and dark-themed consistency
- Removed unwanted hover-only cluster popup behavior
- Added resolved-only filtering behavior (show only resolved when requested)
- Improved hotspot metadata display quality

### Routing

- Safe route logic improved so alternatives appear when meaningfully safer
- Safer and shortest route style differentiation refined

### Community / Realtime

- Realtime propagation fixes for moderated/verified updates
- Better synchronization between dashboards and map views

### CCTV + Criminal DB

- Fixed unrealistic match percentage display normalization
- Multi-image mugshot registration enabled
- Webcam sample requirement relaxed (minimum 1)
- Name parsing made robust across form aliases/query fallback
- Records made clickable with detail modal and add-more-images action
- Sample count logic corrected toward real user samples (not augmentation artifacts)
- Legacy sample display fallback added for older webcam records

### Fairness-Critical Delete/Model Sync

Problem addressed: deleting criminal records while model still recognized deleted subjects.

Fixes added:

- Delete-by-name cleanup path in pipeline
- API deletion now calls pipeline cleanup even when embeddingId is absent
- Added pipeline subject synchronization endpoint
- API syncs pipeline subjects with DB names after delete and before recognition-status
- Goal enforced: DB empty => model subjects should become 0 after sync/restart

## 6) Important Endpoints (Reference)

### API (Node/Express)

- `GET /api/cctv/criminal-db`
- `GET /api/cctv/criminal-db/:id/samples`
- `POST /api/cctv/criminal-db/:id/add-samples`
- `DELETE /api/cctv/criminal-db/:id`
- `GET /api/cctv/recognition-status`
- `POST /api/cctv/register-criminal-samples`
- `POST /api/cctv/recognize-frame`

### Pipeline (Flask)

- `POST /register-samples`
- `POST /recognize-frame`
- `POST /match-face`
- `DELETE /criminal-db/<criminal_id>`
- `DELETE /criminal-db/by-name/<name>`
- `POST /sync-subjects`
- `GET /recognition-status`

## 7) Known Operational Notes

1. Restart both services after CCTV/pipeline changes:
   - API (`apps/api`)
   - CCTV pipeline (`apps/cctv-pipeline`)
2. During nodemon restarts, frontend can transiently show fetch failures.
3. Ensure frontend env uses:
   - `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`
4. Keep criminal deletion strict: app DB and pipeline model must stay synchronized.

## 8) CCTV Upgrade Roadmap (Next Chat Priority)

Current approach is OpenCV/LBPH-era friendly but limited under pose/lighting/camera diversity.

Recommended phased upgrade:

### Phase 1 (Highest ROI)

- Replace LBPH identity matching with deep face embeddings (ArcFace / InsightFace)
- Keep existing API response format to avoid frontend breakage

### Phase 2

- Add robust tracking (ByteTrack/BoT-SORT) in live stream
- Perform identity decision at track level instead of frame level

### Phase 3

- Add person ReID fallback (OSNet/FastReID) for non-frontal/no-face cases
- Fuse Face + ReID + temporal consistency into final alert confidence

### Phase 4

- Multi-camera identity stitching and calibration
- Better explainability in intelligence dashboard (why matched, confidence factors)

## 9) Metrics to Track (FYP + Engineering)

- Face verification: TAR@FAR, ROC-AUC
- ReID: Rank-1, mAP
- Tracking: IDF1, MOTA
- End-to-end ops: false alerts/hour, detection latency, alert precision/recall

## 10) Suggested Next-Chat Prompt

Use this in a new chat for continuity:

"Read `project-context.md` and continue from the CCTV upgrade roadmap. Start Phase 1 by replacing LBPH with ArcFace embeddings while preserving existing API response shapes (`/recognize-frame`, `/register-samples`, `/match-face`) and minimizing frontend changes."

## 11) Advanced + Feasible Upgrade Blueprint (CCTV + Safe Route)

Goal: adopt modern, more accurate technology without breaking current app behavior or APIs.

### A) CCTV Detection/Identification (Most Accurate Feasible Path)

#### Target stack (incremental, non-disruptive)

1. Face embedding model: InsightFace (ArcFace) as primary identity signal.
2. Tracking: ByteTrack for stable per-person identity across frames.
3. ReID fallback: OSNet (or FastReID later) when face is weak/non-frontal.
4. Decision layer: score fusion (face + reid + temporal consistency).
5. Keep response contracts unchanged:
   - `/recognize-frame`
   - `/register-samples`
   - `/match-face`

#### Why this is feasible now

- Your pipeline is already Python-based and modular (`apps/cctv-pipeline`).
- You already support multi-image registration and have API-side guardrails.
- Upgrade can be done behind existing endpoints so frontend disruption is minimal.

#### Practical implementation commands (Windows/PowerShell)

Run in `apps/cctv-pipeline`:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
python -m pip install --upgrade pip
pip install insightface onnxruntime opencv-python numpy scipy scikit-learn
pip install ultralytics
```

Optional GPU path (if CUDA available):

```powershell
pip uninstall onnxruntime -y
pip install onnxruntime-gpu
```

Tracker integration (feasible option):

```powershell
pip install supervision
```

Run pipeline:

```powershell
python server.py
```

Run API:

```powershell
cd ..\api
npm run dev
```

Quick health checks:

```powershell
curl.exe http://localhost:3600/health
curl.exe http://localhost:3001/health
```

#### Recommended thresholds (starting point)

- ArcFace cosine match: 0.45 to 0.60 (calibrate on your own data).
- ReID cosine threshold: 0.55 to 0.70.
- Temporal confirm: require 3 to 5 consecutive positive frames before alert.
- Ambiguity margin: top1 - top2 >= 0.03.

#### Evaluation metrics to log

- Face verification: TAR@FAR (1%, 0.1%)
- Alert precision/recall at event-level (not frame-level)
- False alerts per hour
- Identity switch rate in multi-person scenes

---

### B) Safe Route Computation + Analytics (Most Accurate Feasible Path)

#### Target stack (incremental, non-disruptive)

1. Convert risk from point-only to road-segment risk weighting.
2. Add time-decay + confidence weighting:
   - recent incidents weigh more
   - disputed/low-confidence incidents weigh less
3. Multi-objective scoring:
   - distance + risk + uncertainty
4. Return same response shape from `/api/routes/compute` so frontend keeps working.

#### Why this is feasible now

- Existing route engine already has A*, OSRM legs, and risk sampling.
- Improvement can be parameter/model upgrades in `apps/api/src/routes/routes.ts`.
- No required frontend rewrite if fields remain compatible.

#### Practical implementation commands (Windows/PowerShell)

Run API:

```powershell
cd apps\api
npm run dev
```

Set debug env for calibration:

```powershell
$env:ROUTE_DEBUG="1"
npm run dev
```

Manual compute test:

```powershell
curl.exe -X POST "http://localhost:3001/api/routes/compute" `
  -H "Content-Type: application/json" `
  -d "{\"start\":{\"latitude\":24.8607,\"longitude\":67.0011},\"end\":{\"latitude\":24.8715,\"longitude\":67.0305}}"
```

#### Tuning targets (starting values)

- Risk decay sigma:
  - dense urban: 0.5 to 0.8 km
  - mixed urban: 0.8 to 1.2 km
- Dynamic segment sampling:
  - short edges: 8
  - medium: 12
  - long: 16+
- Risk weight in A*:
  - start with 3.5 to 4.5 (current logic is aggressive)
- Safer-route eligibility:
  - show alternative only if
    - risk reduction >= 8% to 12%
    - extra distance <= 25% to 35%

#### Analytics to add (high value)

- Expected exposure score (segment-weighted)
- Route uncertainty band (low/medium/high confidence)
- Avoided danger zones count and top 3 named places
- Why-this-route text with quantifiable factors

---

### C) Non-breaking migration policy (for both modules)

1. Preserve existing API response keys first.
2. Add new keys as optional fields.
3. Keep old fallback logic behind feature flags until validated.
4. Validate with A/B mode:
   - legacy algorithm
   - upgraded algorithm
5. Promote upgraded mode after measured improvements.

Suggested feature flags:

- `CCTV_MODE=legacy|hybrid|arcface_reid`
- `ROUTE_MODE=legacy|segment_risk_v2`

Example run command (PowerShell):

```powershell
$env:CCTV_MODE="hybrid"
$env:ROUTE_MODE="segment_risk_v2"
```

### D) Suggested next-chat prompt (advanced execution)

"Read `project-context.md` section 11 and implement CCTV Phase 1 (ArcFace embedding backend) and Route Phase 1 (segment-risk calibration) behind feature flags, without breaking existing API response contracts."

## 12) Direct Prompt Pack (Give This File Only)

Use this section when starting a new chat.  
You can paste one prompt at a time, or ask the agent to execute them in order.

### Prompt 0 — Bootstrap / Read Context

```text
You are working on CitizenWatch. Read `project-context.md` fully and treat it as the source of truth. Then:
1) Summarize current architecture and known constraints in 10 bullet points.
2) List all endpoints that must remain backward compatible.
3) Propose an execution order for upgrades with smallest risk first.
Do not edit anything yet.
```

### Prompt 1 — Safety Guardrails Before Coding

```text
Before implementing upgrades, create a safe rollout plan using feature flags:
- CCTV_MODE=legacy|hybrid|arcface_reid
- ROUTE_MODE=legacy|segment_risk_v2
Requirements:
1) Keep all existing API response keys unchanged.
2) Add new keys only as optional.
3) Keep old behavior available via legacy mode.
4) Add clear fallback path if new model/service fails.
Then implement this plan.
```

### Prompt 2 — CCTV Phase 1 (ArcFace, Non-Breaking)

```text
Implement CCTV Phase 1 from `project-context.md`:
Goal: add ArcFace embedding matching as primary/parallel signal while preserving current endpoints:
- /recognize-frame
- /register-samples
- /match-face
Requirements:
1) Keep request/response contracts stable.
2) Preserve current LBPH fallback under feature flag.
3) Cross-reference all images per criminal record.
4) Add ambiguity handling (top1-top2 margin) and temporal confirmation option.
5) Add threshold constants in one place for easy tuning.
6) Add robust logging for match decisions (accepted/rejected reason).
After implementation, run syntax/lint checks and provide exact test steps.
```

### Prompt 3 — CCTV Multi-Person Identity Stability

```text
Improve multi-person CCTV recognition:
1) Ensure each detected face/person is handled independently per frame.
2) Add short temporal smoothing (track memory) to reduce identity jitter.
3) Prevent duplicate spam notifications for same person within a short window and same location.
4) Keep fairness rule: deleted criminal must never appear as matched.
Do not break current UI expectations for live identifications panel.
Provide before/after behavior summary.
```

### Prompt 4 — Safe Route Phase 1 (Segment Risk v2)

```text
Implement Safe Route Phase 1 from `project-context.md`:
1) Move from pure point risk to road-segment weighted risk (while keeping current endpoint /api/routes/compute).
2) Add recency decay and confidence weighting to incident risk.
3) Tune A* risk weighting to avoid unrealistic detours.
4) Keep shortest + safe outputs in same JSON shape expected by frontend.
5) Add route explainability fields (optional) for analytics panel.
After coding, provide calibration defaults and where they are defined.
```

### Prompt 5 — Safe Route Calibration Sweep

```text
Run a calibration sweep for route parameters and report best candidate settings.
Use a small matrix over:
- sigmaKm
- riskWeight
- safe-route eligibility thresholds
For each setting:
1) Compare shortest vs safe for multiple start/end pairs.
2) Report risk reduction %, distance overhead %, and whether route remains practical.
Choose recommended defaults for Karachi-like urban environment and update code accordingly.
```

### Prompt 6 — End-to-End Verification (Roles)

```text
Perform end-to-end verification after upgrades for:
- Citizen
- Moderator
- Inspector
Checklist:
1) Existing core workflows still pass (no regressions).
2) CCTV still registers and matches correctly.
3) Deleting criminal removes from recognition model and UI results.
4) Safe route still returns valid shortest/safe paths and analytics.
5) Realtime updates and notifications still function.
Return a pass/fail report with evidence-oriented notes.
```

### Prompt 7 — One-Shot “Do Everything” Prompt

```text
Read `project-context.md` and execute sections 11 and 12 in order:
1) Implement non-breaking feature-flag rollout.
2) Upgrade CCTV to hybrid ArcFace-capable matching with LBPH fallback.
3) Improve multi-person identity stability and anti-jitter behavior.
4) Upgrade safe routing to segment-risk v2 with calibrated parameters.
5) Preserve backward compatibility for existing frontend/API contracts.
6) Run validation and provide a final regression report.
Do the full task end-to-end and do not stop at planning.
```

### Prompt 8 — Bug Investigation Template (Reusable)

```text
Investigate this issue using the current codebase and `project-context.md`:
1) Reproduce and isolate root cause.
2) Identify whether cause is frontend, API, pipeline, data, or thresholding.
3) Implement minimal-risk fix without breaking contracts.
4) Add guardrails to prevent recurrence.
5) Validate with targeted tests.
Return:
- root cause
- code changes
- validation steps
- residual risk
```

