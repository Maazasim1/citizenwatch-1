import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';

import authRoutes from './routes/auth';
import hotspotRoutes from './routes/hotspots';
import routeRoutes from './routes/routes';
import geocodeRoutes from './routes/geocode';
import notificationRoutes from './routes/notifications';
import cctvRoutes from './routes/cctv';
import profileRoutes from './routes/profile';
import { prisma } from './db';
import reportRoutes, { registerReportIo } from './routes/reports';
import { runCredibilityInactivityDecay } from './services/credibility';

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
} catch (e) {
    console.warn('[ws] socket.io not installed — real-time updates disabled');
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

