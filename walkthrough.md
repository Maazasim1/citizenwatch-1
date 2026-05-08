# CitizenWatch Fix Walkthrough

## What was completed

### 1) Escalation flow (Admin -> Inspector)
- Verified escalation notifications and `report:escalated` socket emit are present in `apps/api/src/routes/reports.ts`.
- Escalated reports endpoint + UI loading is in place on `web/src/app/escalations/page.tsx`.

### 2) Criminal DB image deletion
- Verified mugshot cleanup exists in API delete handler (`apps/api/src/routes/cctv.ts`).
- Verified pipeline-level mugshot cleanup exists in `apps/cctv-pipeline/face_engine.py` (`remove_criminal`).

### 3) False-positive reduction
- Tightened remaining auto-match thresholds to `0.65` in:
  - `apps/api/src/routes/reports.ts`
  - `apps/api/src/routes/cctv.ts` (`/detections/:id/match`, suspect review submit)
- Strengthened face detector fallback in `apps/cctv-pipeline/face_engine.py`:
  - `minNeighbors` increased to `7`
  - CLAHE fallback added in embedding extraction
  - tiny-face LBPH predictions filtered out

### 4) Location + dedup notifications
- Live recognition already accepts camera coordinates.
- Updated dedup logic in `apps/api/src/routes/cctv.ts` to dedupe by:
  - same criminal
  - same source
  - same short time window
  - same (or near-same) camera location
- Prevents frame-by-frame spam while still allowing alerts from different cameras/locations.

### 5) Dark/distant detection
- Confirmed CLAHE and reduced `minSize` paths exist.
- Added extra robustness in embedding detection fallback for dark scenes.

### 6) UI polish / alignment
- Removed navbar notification button alignment artifact (`block`/`mt-1`) in `web/src/components/Navbar.tsx`.
- Escalations icon and key page icons are already wired.

### 7) Upload / webcam / surveillance / file analysis
- Verified webcam submit uses `FormData` for `register-criminal-samples`.
- Verified mugshot submit is click-based and no broken `preventDefault` usage remains.
- Improved live surveillance reliability in `web/src/app/cctv/page.tsx`:
  - camera stream startup health timeout
  - fallback-safe stream teardown on stalled startup
  - camera location now reliably attached to recognition requests
  - location status surfaced in UI

## Notes
- Existing fixes were already partially implemented before this pass; this update focuses on remaining gaps and regressions.
- Dedup location tolerance is intentionally small to treat near-identical camera positions as the same source.
