import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';
import jwt from 'jsonwebtoken';

import authRoutes from './routes/auth';
import hotspotRoutes from './routes/hotspots';
import routeRoutes from './routes/routes';
import geocodeRoutes from './routes/geocode';
import notificationRoutes from './routes/notifications';
import cctvRoutes, { processRecognitionResult, persistLiveFrameSnapshot } from './routes/cctv';
import profileRoutes from './routes/profile';
import { prisma } from './db';
import reportRoutes, { registerReportIo } from './routes/reports';
import { runCredibilityInactivityDecay } from './services/credibility';
import { recognizeFrame as recognizeFrameViaPipeline } from './services/cctvStream';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3001;

// ── HTTP + WebSocket server ────────────────────────────────────────
const server = http.createServer(app);

// Lazy-init socket.io so we don't break if the package isn't installed yet
let io: any = null;
try {
    const { Server } = require('socket.io');
    io = new Server(server, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    io.on('connection', (socket: any) => {
        console.log(`[ws] Client connected: ${socket.id}`);
        socket.on('disconnect', () => {
            console.log(`[ws] Client disconnected: ${socket.id}`);
        });
    });

    // ── /cctv-stream namespace: per-frame WebSocket bridge to the Python pipeline ──
    const cctvNs = io.of('/cctv-stream');

    /** Server-side registry of active cameras (one entry per producer socket). */
    type CameraState = {
        id: string;
        name: string;
        socketId: string;
        userId: string | null;
        latitude: number | null;
        longitude: number | null;
        firstSeenAt: number;
        lastFrameAt: number;
        framesProcessed: number;
        matchesAllTime: number;
        lastMeta: any | null;
    };
    const cameras = new Map<string, CameraState>();
    const CAMERA_STALE_MS = 15_000;
    const MONITOR_ROOM = 'monitors';

    const cameraSummary = (c: CameraState) => ({
        id: c.id,
        name: c.name,
        latitude: c.latitude,
        longitude: c.longitude,
        firstSeenAt: c.firstSeenAt,
        lastFrameAt: c.lastFrameAt,
        framesProcessed: c.framesProcessed,
        matchesAllTime: c.matchesAllTime,
        online: Date.now() - c.lastFrameAt <= CAMERA_STALE_MS,
        face_count: c.lastMeta?.face_count ?? 0,
        match_count: c.lastMeta?.match_count ?? 0,
        api_elapsed_ms: c.lastMeta?.api_elapsed_ms ?? null,
        pipeline_elapsed_ms: c.lastMeta?.pipeline_elapsed_ms ?? null,
    });

    const broadcastCameraList = () => {
        const list = Array.from(cameras.values()).map(cameraSummary);
        cctvNs.to(MONITOR_ROOM).emit('cctv:cameras', list);
    };

    // Periodic eviction of disconnected cameras + heartbeat to monitors.
    setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const [id, cam] of cameras) {
            if (now - cam.lastFrameAt > CAMERA_STALE_MS * 2) {
                cameras.delete(id);
                cctvNs.to(MONITOR_ROOM).emit('cctv:camera-removed', { id });
                changed = true;
            }
        }
        if (changed || cameras.size > 0) broadcastCameraList();
    }, 5_000).unref?.();

    cctvNs.use(async (socket: any, next: any) => {
        try {
            const token =
                socket.handshake.auth?.token ||
                socket.handshake.query?.token ||
                (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
            if (!token) return next(new Error('No token'));

            const decoded = jwt.verify(
                token,
                process.env.JWT_SECRET || 'citizenwatch_secret_default',
            ) as any;
            const tokenId = decoded?.tokenId as string | undefined;
            if (!tokenId) return next(new Error('Invalid token'));

            const session = await prisma.session.findUnique({
                where: { tokenId },
                select: { lastActivityAt: true, revokedAt: true },
            });
            if (!session || session.revokedAt) return next(new Error('Session revoked'));

            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
            if (session.lastActivityAt < cutoff) return next(new Error('Session expired'));

            const role = decoded?.role;
            if (!['MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'].includes(role)) {
                return next(new Error('Insufficient permissions'));
            }

            (socket as any).user = decoded;
            await prisma.session.update({
                where: { tokenId },
                data: { lastActivityAt: new Date() },
            });
            next();
        } catch (err: any) {
            next(new Error(err?.message || 'Auth failed'));
        }
    });

    cctvNs.on('connection', (socket: any) => {
        console.log(`[ws/cctv-stream] connected: ${socket.id} user=${socket.user?.userId}`);

        // Track which camera (if any) this socket is producing frames for.
        let producerCameraId: string | null = null;

        socket.on('cctv:join-monitor', () => {
            socket.join(MONITOR_ROOM);
            socket.emit('cctv:cameras', Array.from(cameras.values()).map(cameraSummary));
        });

        socket.on('cctv:leave-monitor', () => {
            socket.leave(MONITOR_ROOM);
        });

        socket.on('cctv:frame', async (payload: any, ack: (response: any) => void) => {
            const t0 = Date.now();
            try {
                const rawJpeg = payload?.jpeg;
                if (!rawJpeg) {
                    ack?.({ error: 'missing jpeg' });
                    return;
                }

                let jpegBuf: Buffer;
                if (Buffer.isBuffer(rawJpeg)) {
                    jpegBuf = rawJpeg;
                } else if (rawJpeg instanceof ArrayBuffer) {
                    jpegBuf = Buffer.from(rawJpeg);
                } else if (ArrayBuffer.isView(rawJpeg)) {
                    jpegBuf = Buffer.from(rawJpeg.buffer, rawJpeg.byteOffset, rawJpeg.byteLength);
                } else if (typeof rawJpeg === 'string') {
                    const cleaned = rawJpeg.replace(/^data:image\/\w+;base64,/i, '');
                    jpegBuf = Buffer.from(cleaned, 'base64');
                } else {
                    ack?.({ error: 'unsupported jpeg payload type' });
                    return;
                }

                const cameraLat = payload?.camera_latitude != null
                    ? parseFloat(String(payload.camera_latitude))
                    : null;
                const cameraLng = payload?.camera_longitude != null
                    ? parseFloat(String(payload.camera_longitude))
                    : null;

                // Per-frame camera identity. Stable IDs from the client are preferred so the
                // dashboard can survive page reloads; fall back to socket id.
                const cameraId = String(payload?.camera_id || socket.id);
                const cameraName = String(payload?.camera_name || `Camera ${cameraId.slice(0, 6)}`);
                producerCameraId = cameraId;

                const existing = cameras.get(cameraId);
                const camState: CameraState = existing || {
                    id: cameraId,
                    name: cameraName,
                    socketId: socket.id,
                    userId: socket.user?.userId ?? null,
                    latitude: Number.isFinite(cameraLat) ? cameraLat : null,
                    longitude: Number.isFinite(cameraLng) ? cameraLng : null,
                    firstSeenAt: Date.now(),
                    lastFrameAt: Date.now(),
                    framesProcessed: 0,
                    matchesAllTime: 0,
                    lastMeta: null,
                };
                if (existing) {
                    existing.name = cameraName;
                    existing.socketId = socket.id;
                    if (Number.isFinite(cameraLat)) existing.latitude = cameraLat;
                    if (Number.isFinite(cameraLng)) existing.longitude = cameraLng;
                } else {
                    cameras.set(cameraId, camState);
                    broadcastCameraList();
                }

                const pipelineResp = await recognizeFrameViaPipeline(jpegBuf, {
                    camera_latitude: cameraLat,
                    camera_longitude: cameraLng,
                    camera_id: cameraId,
                    camera_name: cameraName,
                });

                const willMaybeMatch = Array.isArray(pipelineResp.meta?.faces)
                    && pipelineResp.meta.faces.some((f: any) => f?.is_match || (f?.identity_embeddings?.length ?? 0) > 0);
                let frameSnapshotUrl: string | null = null;
                if (willMaybeMatch && pipelineResp.jpeg.length > 0) {
                    frameSnapshotUrl = await persistLiveFrameSnapshot(pipelineResp.jpeg, 'jpg');
                }

                const enriched = await processRecognitionResult({
                    pipelineResult: pipelineResp.meta,
                    frameSnapshotUrl,
                    cameraLat: Number.isFinite(cameraLat) ? cameraLat : null,
                    cameraLng: Number.isFinite(cameraLng) ? cameraLng : null,
                    cameraId,
                });

                const apiElapsed = Date.now() - t0;
                const meta = {
                    ...enriched,
                    camera_id: cameraId,
                    camera_name: cameraName,
                    api_elapsed_ms: apiElapsed,
                    pipeline_elapsed_ms: pipelineResp.meta?.elapsed_ms,
                };

                // Update camera state for monitor consumers.
                camState.lastFrameAt = Date.now();
                camState.framesProcessed += 1;
                camState.matchesAllTime += Number(enriched?.match_count || (enriched?.matches?.length ?? 0)) || 0;
                camState.lastMeta = {
                    face_count: enriched?.face_count ?? (Array.isArray(enriched?.faces) ? enriched.faces.length : 0),
                    match_count: enriched?.match_count ?? (Array.isArray(enriched?.matches) ? enriched.matches.length : 0),
                    api_elapsed_ms: apiElapsed,
                    pipeline_elapsed_ms: pipelineResp.meta?.elapsed_ms,
                };

                // Fan annotated frame out to dashboard viewers.
                cctvNs.to(MONITOR_ROOM).emit('cctv:annotated', {
                    cameraId,
                    cameraName,
                    meta,
                    jpeg: pipelineResp.jpeg,
                });

                ack?.({ meta, jpeg: pipelineResp.jpeg });
            } catch (err: any) {
                console.warn('[ws/cctv-stream] frame error', err?.message || err);
                ack?.({ error: err?.message || 'Recognition failed' });
            }
        });

        socket.on('disconnect', (reason: any) => {
            console.log(`[ws/cctv-stream] disconnected: ${socket.id} (${reason})`);
            if (producerCameraId) {
                const cam = cameras.get(producerCameraId);
                // Only evict if no newer socket has taken over this camera id.
                if (cam && cam.socketId === socket.id) {
                    cameras.delete(producerCameraId);
                    cctvNs.to(MONITOR_ROOM).emit('cctv:camera-removed', { id: producerCameraId });
                    broadcastCameraList();
                }
            }
        });
    });
} catch (e) {
    console.warn('[ws] socket.io not installed — real-time updates disabled', e);
}

export { io };

registerReportIo(io);

// Local pilot storage for uploaded media.
// PRD calls for S3-compatible object storage later; for now we serve files from ./uploads.
const uploadDir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

export { prisma };

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/hotspots', hotspotRoutes);
app.use('/api/routes', routeRoutes);
app.use('/api/geocode', geocodeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/cctv', cctvRoutes);
app.use('/api/profile', profileRoutes);

// Serve CCTV pipeline detection crops (for the frontend to display)
const cctvDetectionsDir = path.join(process.cwd(), '..', 'cctv-pipeline', 'detections');
fs.mkdirSync(cctvDetectionsDir, { recursive: true });
app.use('/cctv-detections', express.static(cctvDetectionsDir));

// Serve criminal DB mugshots and face crops
const cctvCriminalDir = path.join(process.cwd(), '..', 'cctv-pipeline', 'criminal_db');
fs.mkdirSync(cctvCriminalDir, { recursive: true });
app.use('/cctv-criminal-db', express.static(cctvCriminalDir));
const cctvFaceSamplesDir = path.join(process.cwd(), '..', 'cctv-pipeline', 'face_samples');
fs.mkdirSync(cctvFaceSamplesDir, { recursive: true });
app.use('/cctv-face-samples', express.static(cctvFaceSamplesDir));

// Basic health check route
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        websocket: io ? 'enabled' : 'disabled',
    });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start server (use `server.listen` instead of `app.listen` for WebSocket support)
const CREDIBILITY_INACTIVITY_CRON_MS = (() => {
    const n = parseInt(
        String(process.env.CREDIBILITY_INACTIVITY_CRON_MS ?? process.env.STALENESS_CRON_MS ?? ''),
        10,
    );
    if (Number.isFinite(n) && n >= 60_000) return n;
    return 30 * 60 * 1000;
})();

server.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
    if (io) console.log(`[ws]: WebSocket server ready`);
    console.log(
        `[credibility]: Inactivity decay cron every ${Math.round(CREDIBILITY_INACTIVITY_CRON_MS / 60000)} min`,
    );
    void runCredibilityInactivityDecay().catch((e: any) => {
        console.warn('[credibility] initial inactivity decay tick failed', e);
    });
    setInterval(() => {
        void runCredibilityInactivityDecay().catch((e) =>
            console.warn('[credibility] inactivity decay cron failed', e),
        );
    }, CREDIBILITY_INACTIVITY_CRON_MS);
});

export default app;

