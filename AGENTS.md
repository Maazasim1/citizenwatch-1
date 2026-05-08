# AGENTS.md

## Cursor Cloud specific instructions

### Architecture Overview

CitizenWatch is a citizen-driven crime intelligence platform with three services:

| Service | Directory | Port | Technology |
|---------|-----------|------|------------|
| API | `apps/api/` | 3001 | Express 5 + Prisma + Socket.IO |
| Frontend | `web/` | 3000 | Next.js 16 + React 19 + Leaflet |
| CCTV Pipeline (optional) | `apps/cctv-pipeline/` | 3600 | Python Flask + YOLOv8 |

Infrastructure: PostGIS 15 (Docker, port 5433), Redis (Docker, optional/unused).

### Starting Services

1. **Database**: `docker compose up -d db` (from repo root)
2. **API**: `npm run dev` in `apps/api/` (runs `prisma generate` automatically via `predev` script)
3. **Frontend**: `npm run dev` in `web/`

### Key Environment Details

- The Docker PostgreSQL listens on **port 5433** (not 5432) to avoid local conflicts.
- `DATABASE_URL` must be `postgresql://user:password@localhost:5433/citizenwatch-db`
- JWT has a built-in default secret (`citizenwatch_secret_default`); no env var required for dev.
- OTP bypass code `123456` works in development for any user.
- `GEMINI_API_KEY` is optional; the severity scoring has a heuristic fallback.
- The CCTV pipeline is optional; core features work without it.

### Docker in Cloud VM

Docker requires `fuse-overlayfs` storage driver and `iptables-legacy` in the Cloud Agent VM. The daemon must be started with `sudo dockerd` before `docker compose up`. The Docker socket needs permissions fix: `sudo chmod 666 /var/run/docker.sock`.

### Lint / Test / Build

- **Lint (web)**: `npx eslint .` in `web/` — existing codebase has lint warnings/errors (pre-existing, not blocking).
- **Build (web)**: `npm run build` in `web/`
- **Tests**: No automated test suites are configured yet (`npm test` in both packages just echoes an error).
- **TypeScript check**: `npx tsc --noEmit` in `apps/api/` or `web/`

### Gotchas

- The `predev` script in `apps/api/` runs `prisma generate` before starting the dev server. If it fails due to file lock (e.g., another API process running), it continues gracefully.
- The web `dev` script (`scripts/dev-safe.js`) checks if port 3000 is already in use and skips starting a new instance. Kill the existing process if you need a fresh restart.
- `.env` file in `apps/api/` and `.env.local` in `web/` are gitignored; they must be created on fresh setup.
- The package manager is **npm** (package-lock.json files present in root, `apps/api/`, and `web/`).
