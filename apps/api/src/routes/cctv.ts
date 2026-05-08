import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import {
    IdentityEmbeddingPayload,
    matchIdentityEmbeddings,
    removeIdentityEmbeddings,
    storeIdentityEmbeddings,
    stripIdentityEmbeddings,
} from '../services/identityEmbeddings';

const router = Router();

const CCTV_PIPELINE_URL = process.env.CCTV_PIPELINE_URL || 'http://localhost:3600';
const DEBUG_RUN_ID = `criminal-db-${Date.now()}`;
const LIVE_LBPH_THRESHOLD = 90;
const LIVE_DEDUP_WINDOW_MS = 2 * 60 * 1000;
const SAME_LOCATION_EPSILON = 0.0005; // ~55m at equator
const cctvCriminalDir = path.join(process.cwd(), '..', 'cctv-pipeline', 'criminal_db');
const originalSamplesRoot = path.join(cctvCriminalDir, 'original_samples');
const faceSamplesRoot = path.join(process.cwd(), '..', 'cctv-pipeline', 'face_samples');

const normalizeLiveConfidence = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    // If already in 0..1 range, keep it.
    if (n >= 0 && n <= 1) return n;
    // LBPH distance (lower is better) to 0..1 confidence.
    return Math.max(0, Math.min(1, (LIVE_LBPH_THRESHOLD - n) / 30));
};

const normalizeSubjectName = (name: string): string =>
    String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9 _-]/g, '')
        .replace(/\s+/g, '_');

const queryIdentityEmbeddingsForFile = async (filePath: string): Promise<IdentityEmbeddingPayload[]> => {
    const result = await forwardFileToPipeline(filePath, '/extract-identity');
    return Array.isArray((result as any)?.identity_embeddings)
        ? (result as any).identity_embeddings
        : [];
};

const matchFileWithPgvector = async (
    filePath: string,
    threshold = 0.65,
) => {
    const embeddings = await queryIdentityEmbeddingsForFile(filePath);
    return matchIdentityEmbeddings(embeddings, { faceThreshold: threshold });
};

const syncPipelineSubjectsWithDb = async () => {
    const current = await prisma.criminalRecord.findMany({
        select: { name: true },
    });
    const names = current.map((c) => c.name).filter(Boolean);
    try {
        const resp = await fetch(`${CCTV_PIPELINE_URL}/sync-subjects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names }),
        });
        if (!resp.ok) {
            console.warn(`[CCTV] Pipeline sync-subjects returned ${resp.status}`);
        }
    } catch (e) {
        console.warn('[CCTV] Failed to sync subjects with pipeline', e);
    }
};

// Upload storage for CCTV footage
const cctvUploadDir = path.join(process.cwd(), 'uploads', 'cctv');
fs.mkdirSync(cctvUploadDir, { recursive: true });
const liveMatchSnapshotsDir = path.join(cctvUploadDir, 'matches');
fs.mkdirSync(liveMatchSnapshotsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, cctvUploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        cb(null, `${unique}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for video
});

// Authenticate + authorize for law enforcement / moderator / admin
const authenticate = async (req: Request, res: Response, next: Function) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'citizenwatch_secret_default') as any;
        const tokenId = decoded?.tokenId as string | undefined;
        if (!tokenId) return res.status(401).json({ error: 'Invalid token' });

        const session = await prisma.session.findUnique({
            where: { tokenId },
            select: { lastActivityAt: true, revokedAt: true },
        });

        if (!session || session.revokedAt) return res.status(401).json({ error: 'Session revoked' });

        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (session.lastActivityAt < cutoff) return res.status(401).json({ error: 'Session expired' });

        await prisma.session.update({ where: { tokenId }, data: { lastActivityAt: new Date() } });
        (req as any).user = decoded;
        return next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const requireRole = (...roles: string[]) => (req: Request, res: Response, next: Function) => {
    const role = (req as any).user?.role;
    if (!roles.includes(role)) return res.status(403).json({ error: 'Insufficient permissions' });
    return next();
};

const saveLiveFrameSnapshot = async (frameBase64: string, req: Request): Promise<string | null> => {
    if (typeof frameBase64 !== 'string') return null;

    const match = frameBase64.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
    if (!match) return null;

    const ext = (match[1] || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';
    const payload = match[2];
    if (!payload) return null;

    try {
        const buffer = Buffer.from(payload, 'base64');
        const filename = `live-match-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
        const filePath = path.join(liveMatchSnapshotsDir, filename);
        await fs.promises.writeFile(filePath, buffer);
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        return `${baseUrl}/uploads/cctv/matches/${filename}`;
    } catch (e) {
        console.warn('[CCTV] Failed to persist live frame snapshot', e);
        return null;
    }
};

// Helper to forward a file to the Python pipeline
const forwardFileToPipeline = async (
    filePath: string,
    endpoint: string,
    extraFields?: Record<string, string>,
) => {
    const formData = new FormData();
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileBlob = new Blob([fileBuffer], { type: 'application/octet-stream' });
    formData.append('file', fileBlob, path.basename(filePath));

    if (extraFields) {
        for (const [key, val] of Object.entries(extraFields)) {
            formData.append(key, val);
        }
    }

    const resp = await fetch(`${CCTV_PIPELINE_URL}${endpoint}`, {
        method: 'POST',
        body: formData as any,
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Pipeline error: ${resp.status} ${text}`);
    }

    return resp.json();
};

// ── CCTV Upload & Detection (Feature 2) ─────────────────────────────

router.post('/upload', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), upload.single('file'), async (req: Request, res: Response) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        const latitude = req.body.latitude ? parseFloat(req.body.latitude) : null;
        const longitude = req.body.longitude ? parseFloat(req.body.longitude) : null;

        // Forward to Python pipeline for person detection
        let pipelineResult: any;
        try {
            pipelineResult = await forwardFileToPipeline(file.path, '/detect', {
                confidence: req.body.confidence || '0.4',
            });
        } catch (err: any) {
            return res.status(502).json({
                error: 'CCTV pipeline unavailable. Ensure the Python server is running and CCTV_PIPELINE_URL is correct.',
                details: err?.message,
            });
        }

        // Store detections in database and auto-match
        const { io } = await import('../index');
        const detections = [];
        for (const det of pipelineResult.detections || []) {
            const record = await prisma.cctvDetection.create({
                data: {
                    sourceFile: file.filename,
                    frameIndex: det.frame_index ?? null,
                    personCrop: det.crop_filename,
                    confidence: det.confidence,
                    boundingBox: JSON.stringify(det.bounding_box),
                    latitude,
                    longitude,
                },
            });
            detections.push(record);

            // ── Auto-Match CCTV Crop with Criminal DB ──
            try {
                const cropPath = path.join(process.cwd(), '..', 'cctv-pipeline', 'detections', det.crop_filename);
                if (fs.existsSync(cropPath)) {
                    const matches = await matchFileWithPgvector(cropPath, 0.65);
                    for (const m of matches) {
                        const faceMatch = await prisma.faceMatch.create({
                            data: {
                                criminalId: m.criminalId,
                                detectionId: record.id,
                                detectionSource: 'CCTV',
                                confidence: m.confidence,
                                latitude,
                                longitude,
                            },
                        });

                        if (io) {
                            io.emit('criminal:matched', {
                                matchId: faceMatch.id,
                                criminalName: m.name,
                                firNumber: m.firNumber,
                                confidence: m.confidence,
                                latitude,
                                longitude,
                                source: 'CCTV',
                                mugshotUrl: m.mugshotUrl,
                                method: m.method,
                                identityBackend: m.identity_backend,
                            });
                        }
                    }
                }
            } catch (matchErr) {
                console.warn('[CCTV] Auto-match failed for crop', matchErr);
            }
        }

        res.json({
            source: file.filename,
            totalPersons: pipelineResult.total_persons ?? 0,
            detections,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to process CCTV upload' });
    }
});

router.get('/detections', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const detections = await prisma.cctvDetection.findMany({
            orderBy: { detectedAt: 'desc' },
            take: 100,
            include: { faceMatches: true },
        });
        res.json({ detections });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch detections' });
    }
});

// ── Criminal Database (Feature 3) ──────────────────────────────────

router.post('/criminal-db', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), upload.single('mugshot'), async (req: Request, res: Response) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'Mugshot image required' });
        }

        const { name, firNumber, notes } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

        // Forward mugshot to Python pipeline
        let pipelineResult: any;
        try {
            const formData = new FormData();
            const mugshotBuffer = await fs.promises.readFile(file.path);
            const mugshotBlob = new Blob([mugshotBuffer], {
                type: file.mimetype || 'application/octet-stream',
            });
            formData.append('mugshot', mugshotBlob, file.originalname || 'mugshot.jpg');
            formData.append('name', name.trim());
            formData.append('fir_number', firNumber || '');

            const resp = await fetch(`${CCTV_PIPELINE_URL}/criminal-db`, {
                method: 'POST',
                body: formData as any,
            });
            if (!resp.ok) {
                const errData = await resp.json().catch(() => ({}));
                return res.status(resp.status).json({ error: (errData as any)?.error || 'Pipeline registration failed' });
            }
            pipelineResult = await resp.json();
        } catch (err: any) {
            return res.status(502).json({
                error: 'CCTV pipeline unavailable',
                details: err?.message,
            });
        }

        const baseUrl = `${req.protocol}://${req.get('host')}`;

        // Store in Prisma
        const record = await prisma.criminalRecord.create({
            data: {
                name: name.trim(),
                firNumber: firNumber || null,
                mugshotUrl: `${baseUrl}/uploads/cctv/${file.filename}`,
                embeddingId: pipelineResult.criminal?.id || null,
                notes: notes || null,
                addedById: (req as any).user?.userId || null,
            },
        });
        await storeIdentityEmbeddings(record.id, pipelineResult.criminal?.identity_embeddings, { replace: true });

        res.status(201).json({ criminal: record });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add criminal record' });
    }
});

router.get('/criminal-db', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const criminals = await prisma.criminalRecord.findMany({
            orderBy: { createdAt: 'desc' },
        });
        const normalized = criminals.map((c) => {
            const safeName = c.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_') || 'unknown_subject';
            const originalsDir = path.join(originalSamplesRoot, safeName);
            let count = c.sampleCount;
            if (fs.existsSync(originalsDir)) {
                count = fs
                    .readdirSync(originalsDir)
                    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).length;
            } else if (c.sampleCount > 0 && c.sampleCount % 2 === 0) {
                // Legacy records before this fix counted each sample twice.
                count = Math.floor(c.sampleCount / 2);
            }
            return { ...c, sampleCount: count };
        });
        res.json({ criminals: normalized });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch criminal records' });
    }
});

router.get('/criminal-db/:id/samples', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const criminal = await prisma.criminalRecord.findUnique({ where: { id } });
        if (!criminal) return res.status(404).json({ error: 'Criminal not found' });

        const safeName = criminal.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_') || 'unknown_subject';
        const originalsDir = path.join(originalSamplesRoot, safeName);
        const legacyFaceDir = path.join(faceSamplesRoot, safeName);
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const originals = fs.existsSync(originalsDir)
            ? fs
                  .readdirSync(originalsDir)
                  .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
                  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                  .map((f) => `${baseUrl}/cctv-criminal-db/original_samples/${encodeURIComponent(safeName)}/${encodeURIComponent(f)}`)
            : [];
        const legacy = fs.existsSync(legacyFaceDir)
            ? fs
                  .readdirSync(legacyFaceDir)
                  .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
                  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                  .map((f) => `${baseUrl}/cctv-face-samples/${encodeURIComponent(safeName)}/${encodeURIComponent(f)}`)
            : [];
        const samples = originals.length > 0 ? originals : legacy;

        res.json({ samples, count: samples.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch sample images' });
    }
});

router.delete('/criminal-db/:id', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });

        const criminal = await prisma.criminalRecord.findUnique({ where: { id } });
        if (!criminal) return res.status(404).json({ error: 'Criminal not found' });

        // Forward deletion to Python pipeline if it has an embedding
        if (criminal.embeddingId) {
            try {
                const resp = await fetch(`${CCTV_PIPELINE_URL}/criminal-db/${criminal.embeddingId}`, {
                    method: 'DELETE',
                });
                if (!resp.ok) {
                    console.warn(`[CCTV] Pipeline DELETE returned ${resp.status}`);
                }
            } catch (e) {
                console.warn('[CCTV] Failed to delete from python pipeline', e);
            }
        }

        // Always enforce delete-by-name in pipeline for LBPH/face_samples registrations.
        try {
            const respByName = await fetch(
                `${CCTV_PIPELINE_URL}/criminal-db/by-name/${encodeURIComponent(criminal.name)}`,
                { method: 'DELETE' },
            );
            if (!respByName.ok && respByName.status !== 404) {
                console.warn(`[CCTV] Pipeline DELETE by-name returned ${respByName.status}`);
            }
        } catch (e) {
            console.warn('[CCTV] Failed to delete by name from python pipeline', e);
        }

        // Delete the mugshot file from disk
        if (criminal.mugshotUrl) {
            try {
                const urlPath = new URL(criminal.mugshotUrl).pathname;
                const filename = path.basename(urlPath);
                // Try uploads/cctv/ (mugshot upload path)
                const filePath = path.join(cctvUploadDir, filename);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                // Also try cctv-pipeline/criminal_db/mugshots/ (webcam registration path)
                const pipelineMugshotPath = path.join(process.cwd(), '..', 'cctv-pipeline', 'criminal_db', 'mugshots', filename);
                if (fs.existsSync(pipelineMugshotPath)) fs.unlinkSync(pipelineMugshotPath);
            } catch (fileErr) {
                console.warn('[CCTV] Failed to delete mugshot file from disk:', fileErr);
            }
        }

        // Also delete face matches to maintain integrity if onDelete Cascade isn't set
        await prisma.faceMatch.deleteMany({ where: { criminalId: id } });
        await removeIdentityEmbeddings(id);
        await prisma.criminalRecord.delete({ where: { id } });
        await syncPipelineSubjectsWithDb();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete criminal record' });
    }
});


// ── Face Match Review (Feature 3) ──────────────────────────────────

router.get('/matches', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const statusFilter = req.query.status as string | undefined;
        const matches = await prisma.faceMatch.findMany({
            where: statusFilter ? { reviewStatus: statusFilter as any } : undefined,
            include: { criminal: true, detection: true },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        res.json({ matches });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

router.post('/matches/:id/review', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const { status, note } = req.body as { status: 'CONFIRMED' | 'DISMISSED'; note?: string };

        if (!['CONFIRMED', 'DISMISSED'].includes(status)) {
            return res.status(400).json({ error: 'Invalid review status' });
        }

        const match = await prisma.faceMatch.update({
            where: { id },
            data: {
                reviewStatus: status,
                reviewedById: (req as any).user?.userId,
                reviewedAt: new Date(),
                reviewNote: note || null,
            },
            include: { criminal: true },
        });

        res.json({ match });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to review match' });
    }
});

router.delete('/matches/:id', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        await prisma.faceMatch.delete({ where: { id } });
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete match' });
    }
});

router.delete('/matches', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const result = await prisma.faceMatch.deleteMany({});
        res.json({ success: true, deletedCount: result.count });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to clear matches' });
    }
});

// Run face matching on a detection against criminal DB
router.post('/detections/:id/match', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const detection = await prisma.cctvDetection.findUnique({ where: { id } });
        if (!detection) return res.status(404).json({ error: 'Detection not found' });

        // Build the crop file path
        const cropPath = path.join(process.cwd(), '..', 'cctv-pipeline', 'detections', detection.personCrop);
        if (!fs.existsSync(cropPath)) {
            return res.status(404).json({ error: 'Detection crop file not found' });
        }

        let matches: Awaited<ReturnType<typeof matchFileWithPgvector>>;
        try {
            matches = await matchFileWithPgvector(cropPath, Number(req.body.threshold || '0.65'));
        } catch (err: any) {
            return res.status(502).json({ error: 'Pipeline unavailable', details: err?.message });
        }

        // Store matches in DB
        const stored = [];
        for (const m of matches) {
            const faceMatch = await prisma.faceMatch.create({
                data: {
                    criminalId: m.criminalId,
                    detectionId: detection.id,
                    detectionSource: 'CCTV',
                    confidence: m.confidence,
                    latitude: detection.latitude,
                    longitude: detection.longitude,
                },
            });
            stored.push(faceMatch);
        }

        res.json({
            detectionId: id,
            matchCount: stored.length,
            matches: stored,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to run face matching' });
    }
});

// ── Suspect Photo Review (Feature 4) ──────────────────────────────

router.get('/suspect-reviews', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const reviews = await prisma.suspectPhotoReview.findMany({
            include: { report: { include: { multimedia: true, author: { select: { email: true, phone: true } } } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        res.json({ reviews });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch suspect reviews' });
    }
});

router.post('/suspect-reviews/:id/submit-for-matching', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const review = await prisma.suspectPhotoReview.findUnique({ where: { id } });
        if (!review) return res.status(404).json({ error: 'Review not found' });

        // Forward the isolated photo for face matching
        if (!fs.existsSync(review.isolatedPath)) {
            return res.status(404).json({ error: 'Isolated photo file not found' });
        }

        let matches: Awaited<ReturnType<typeof matchFileWithPgvector>>;
        try {
            matches = await matchFileWithPgvector(review.isolatedPath, 0.65);
        } catch (err: any) {
            return res.status(502).json({ error: 'Pipeline unavailable', details: err?.message });
        }

        const hasMatches = matches.length > 0;

        const updated = await prisma.suspectPhotoReview.update({
            where: { id },
            data: {
                status: hasMatches ? 'MATCHED' : 'NO_MATCH',
                matchResults: JSON.stringify(matches),
                reviewedById: (req as any).user?.userId,
                reviewedAt: new Date(),
            },
        });

        // If matches found, create FaceMatch records
        if (hasMatches) {
            for (const m of matches) {
                await prisma.faceMatch.create({
                    data: {
                        criminalId: m.criminalId,
                        detectionSource: 'CITIZEN_PHOTO',
                        confidence: m.confidence,
                    },
                });
            }
        }

        res.json({ review: updated, matches });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to submit for matching' });
    }
});

router.post('/suspect-reviews/:id/archive', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const updated = await prisma.suspectPhotoReview.update({
            where: { id },
            data: {
                status: 'ARCHIVED',
                reviewedById: (req as any).user?.userId,
                reviewedAt: new Date(),
            },
        });
        res.json({ review: updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to archive review' });
    }
});

// ── Live Recognition & Multi-Sample Registration (New) ────────────

router.post('/register-criminal-samples', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), upload.array('samples', 30), async (req: Request, res: Response) => {
    try {
        const files = req.files as Express.Multer.File[];
        const body = (req.body ?? {}) as Record<string, any>;
        const rawName =
            body.name ??
            body.fullName ??
            body.criminalName ??
            body.criminal_name ??
            body['name[]'] ??
            req.query.name ??
            '';
        const normalizedName = String(rawName).trim();
        const firNumber = body.firNumber ?? body.fir_number ?? '';
        const notes = body.notes ?? '';
        const base64_samples = body.base64_samples ?? body.base64Samples ?? '';
        const finalName = normalizedName || `Unknown-${Date.now()}`;
        const appendMode = String(body.append ?? req.query.append ?? '').toLowerCase() === 'true';

        // Forward to Python pipeline
        const formData = new FormData();
        formData.append('name', finalName);
        // Alias for defensive compatibility.
        formData.append('fullName', finalName);
        formData.append('fir_number', firNumber || '');
        if (appendMode) formData.append('append', 'true');

        let totalForwardedSamples = 0;

        if (files && files.length > 0) {
            for (const file of files) {
                const sampleBuffer = await fs.promises.readFile(file.path);
                const sampleBlob = new Blob([sampleBuffer], {
                    type: file.mimetype || 'application/octet-stream',
                });
                formData.append('samples', sampleBlob, file.originalname || `sample-${Date.now()}.jpg`);
                totalForwardedSamples += 1;
            }
        }

        if (base64_samples) {
            try {
                const parsed = JSON.parse(String(base64_samples));
                if (Array.isArray(parsed)) {
                    for (let i = 0; i < parsed.length; i++) {
                        const raw = String(parsed[i] ?? '');
                        if (!raw) continue;
                        const parts = raw.includes(',') ? raw.split(',', 2) : ['', raw];
                        const b64 = parts[1] || '';
                        if (!b64) continue;
                        const imgBuffer = Buffer.from(b64, 'base64');
                        if (!imgBuffer.length) continue;
                        const imgBlob = new Blob([imgBuffer], { type: 'image/jpeg' });
                        formData.append('samples', imgBlob, `webcam-${i + 1}.jpg`);
                        totalForwardedSamples += 1;
                    }
                }
            } catch {
                // Keep backward compatibility: forward raw payload if JSON parsing fails.
                formData.append('base64_samples', String(base64_samples));
            }
        }

        if (totalForwardedSamples === 0) {
            return res.status(400).json({
                error: 'No valid sample images were provided. Capture at least 1 webcam image or upload at least 1 file.',
            });
        }

        let pipelineResult: any;
        try {
            const resp = await fetch(`${CCTV_PIPELINE_URL}/register-samples`, {
                method: 'POST',
                body: formData as any,
            });
            if (!resp.ok) {
                const errData = await resp.json().catch(() => ({}));
                return res.status(resp.status).json({ error: (errData as any)?.error || 'Pipeline registration failed' });
            }
            pipelineResult = await resp.json();
        } catch (err: any) {
            return res.status(502).json({
                error: 'CCTV pipeline unavailable',
                details: err?.message,
            });
        }

        const registration = (pipelineResult as any)?.registration;

        // Build mugshot URL
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const mugshotUrl = registration?.profile_image
            ? `${baseUrl}/cctv-criminal-db/mugshots/${registration.profile_image}`
            : '';

        // Store in Prisma
        let record;
        if (appendMode) {
            record = await prisma.criminalRecord.findFirst({ where: { name: finalName } });
            if (!record) {
                return res.status(404).json({ error: 'Criminal record not found for append.' });
            }
            record = await prisma.criminalRecord.update({
                where: { id: record.id },
                data: {
                    sampleCount: Number(registration?.sample_count ?? record.sampleCount),
                    embeddingId: registration?.embedding_id || record.embeddingId,
                    notes: notes || record.notes,
                },
            });
        } else {
            record = await prisma.criminalRecord.create({
                data: {
                    name: finalName,
                    firNumber: firNumber || null,
                    mugshotUrl,
                    notes: notes || null,
                    sampleCount: registration?.sample_count || 0,
                    embeddingId: registration?.embedding_id || null,
                    addedById: (req as any).user?.userId || null,
                },
            });
        }
        await storeIdentityEmbeddings(record.id, registration?.identity_embeddings, { replace: true });

        res.status(201).json({ criminal: record, registration });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to register criminal samples' });
    }
});

router.post('/criminal-db/:id/add-samples', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), upload.array('samples', 30), async (req: Request, res: Response) => {
    try {
        const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const criminal = await prisma.criminalRecord.findUnique({ where: { id } });
        if (!criminal) return res.status(404).json({ error: 'Criminal not found' });

        const files = (req.files as Express.Multer.File[]) || [];
        if (files.length === 0) return res.status(400).json({ error: 'Upload at least 1 image.' });

        const fd = new FormData();
        fd.append('name', criminal.name);
        fd.append('fir_number', criminal.firNumber || '');
        fd.append('append', 'true');
        for (const file of files) {
            const sampleBuffer = await fs.promises.readFile(file.path);
            const sampleBlob = new Blob([sampleBuffer], { type: file.mimetype || 'application/octet-stream' });
            fd.append('samples', sampleBlob, file.originalname || `sample-${Date.now()}.jpg`);
        }

        const resp = await fetch(`${CCTV_PIPELINE_URL}/register-samples`, {
            method: 'POST',
            body: fd as any,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return res.status(resp.status).json({ error: (data as any)?.error || 'Failed to append samples' });

        const sampleCount = Number((data as any)?.registration?.sample_count ?? criminal.sampleCount);
        const updated = await prisma.criminalRecord.update({
            where: { id: criminal.id },
            data: {
                sampleCount,
                embeddingId: (data as any)?.registration?.embedding_id || criminal.embeddingId,
            },
        });
        await storeIdentityEmbeddings(updated.id, (data as any)?.registration?.identity_embeddings, { replace: true });
        res.json({ criminal: updated, registration: (data as any)?.registration ?? null });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add samples' });
    }
});

router.post('/recognize-frame', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const { frame_base64, camera_latitude, camera_longitude } = req.body;
        if (!frame_base64) return res.status(400).json({ error: 'No frame provided' });
        const frameSnapshotUrl = await saveLiveFrameSnapshot(frame_base64, req);

        const cameraLat = camera_latitude != null ? parseFloat(String(camera_latitude)) : null;
        const cameraLng = camera_longitude != null ? parseFloat(String(camera_longitude)) : null;
        const hasValidLocation = cameraLat != null && !isNaN(cameraLat) && cameraLng != null && !isNaN(cameraLng);

        // Forward to Python pipeline
        let pipelineResult: any;
        try {
            const resp = await fetch(`${CCTV_PIPELINE_URL}/recognize-frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frame_base64 }),
            });
            if (!resp.ok) throw new Error(`Pipeline: ${resp.status}`);
            pipelineResult = await resp.json();
        } catch (err: any) {
            return res.status(502).json({
                error: 'CCTV pipeline unavailable',
                details: err?.message,
            });
        }

        const activeCriminals = await prisma.criminalRecord.findMany({
            select: { id: true, name: true, firNumber: true, mugshotUrl: true },
        });
        const criminalsByNorm = new Map<string, (typeof activeCriminals)[number]>();
        const criminalsById = new Map<string, (typeof activeCriminals)[number]>();
        for (const c of activeCriminals) {
            criminalsByNorm.set(normalizeSubjectName(c.name), c);
            criminalsById.set(c.id, c);
        }

        const normalizedFaces = [];
        for (const f of Array.isArray((pipelineResult as any)?.faces) ? (pipelineResult as any).faces : []) {
            const cleanFace = stripIdentityEmbeddings(f as any);
            const vectorMatches = await matchIdentityEmbeddings((f as any)?.identity_embeddings, { faceThreshold: 0.65 });
            const best = vectorMatches[0];
            if (best) {
                normalizedFaces.push({
                    ...cleanFace,
                    name: best.name,
                    confidence: best.confidence,
                    is_match: true,
                    method: best.method,
                    identity_backend: best.identity_backend,
                    criminalId: best.criminalId,
                });
            } else {
                normalizedFaces.push({
                    ...cleanFace,
                    name: 'Unknown',
                    confidence: normalizeLiveConfidence(cleanFace?.confidence),
                    is_match: false,
                });
            }
        }
        const normalizedMatches = normalizedFaces.filter((f: any) => f?.is_match);

        // If matches found, create FaceMatch records and emit WebSocket alerts
        const matchResults = normalizedMatches.length > 0 ? normalizedMatches : ((pipelineResult as any)?.matches || []);
        if (matchResults.length > 0) {
            const { io } = await import('../index');

            for (const m of matchResults) {
                // Find criminal using normalized subject names (space/underscore safe).
                const criminal = criminalsById.get(String(m?.criminalId ?? '')) ||
                    criminalsByNorm.get(normalizeSubjectName(String(m?.name ?? '')));
                if (!criminal) continue;

                // Convert LBPH distance (lower is better) to a 0..1 score for UI/notifications.
                // Distances near threshold should be low confidence, very low distances high confidence.
                const normalizedConfidence = Number(m.confidence) >= 0 && Number(m.confidence) <= 1
                    ? Number(m.confidence)
                    : normalizeLiveConfidence(m.confidence);
                // Dedup check: skip repeated alerts for same criminal at same location in the time window.
                const recentMatches = await prisma.faceMatch.findMany({
                    where: {
                        criminalId: criminal.id,
                        detectionSource: 'CCTV',
                        createdAt: { gte: new Date(Date.now() - LIVE_DEDUP_WINDOW_MS) },
                    },
                    select: { id: true, latitude: true, longitude: true },
                });
                const duplicateAtSameLocation = recentMatches.some((rm) => {
                    if (!hasValidLocation) return true;
                    if (rm.latitude == null || rm.longitude == null) return true;
                    return (
                        Math.abs(rm.latitude - cameraLat!) <= SAME_LOCATION_EPSILON &&
                        Math.abs(rm.longitude - cameraLng!) <= SAME_LOCATION_EPSILON
                    );
                });
                if (duplicateAtSameLocation) continue;

                const faceMatch = await prisma.faceMatch.create({
                    data: {
                        criminalId: criminal.id,
                        detectionSource: 'CCTV',
                        confidence: normalizedConfidence,
                        spottedAt: new Date(),
                        latitude: hasValidLocation ? cameraLat : null,
                        longitude: hasValidLocation ? cameraLng : null,
                        frameSnapshot: frameSnapshotUrl,
                    },
                });

                // Emit WebSocket alert
                if (io) {
                    io.emit('criminal:matched', {
                        matchId: faceMatch.id,
                        criminalName: criminal.name,
                        firNumber: criminal.firNumber,
                        confidence: faceMatch.confidence,
                        source: 'LIVE_SURVEILLANCE',
                        mugshotUrl: criminal.mugshotUrl,
                        frameSnapshot: faceMatch.frameSnapshot,
                        spottedAt: faceMatch.spottedAt,
                        latitude: hasValidLocation ? cameraLat : null,
                        longitude: hasValidLocation ? cameraLng : null,
                        method: m.method,
                        identityBackend: m.identity_backend,
                    });
                }

                // Create notification for all LAW_ENFORCEMENT users
                try {
                    const locationStr = hasValidLocation
                        ? ` at location (${cameraLat!.toFixed(4)}, ${cameraLng!.toFixed(4)})`
                        : '';
                    const lawEnforcementUsers = await prisma.user.findMany({
                        where: { role: { in: ['LAW_ENFORCEMENT', 'ADMIN'] } },
                        select: { id: true },
                    });
                    for (const u of lawEnforcementUsers) {
                        await prisma.notification.create({
                            data: {
                                userId: u.id,
                                message: `Criminal "${criminal.name}" (FIR: ${criminal.firNumber || 'N/A'}) identified in live surveillance with ${(faceMatch.confidence * 100).toFixed(0)}% confidence${locationStr}.`,
                                type: 'GENERAL',
                            },
                        });
                    }
                } catch (notifErr) {
                    console.warn('[CCTV] Failed to create match notifications', notifErr);
                }
            }
        }

        res.json({
            ...(pipelineResult as any),
            faces: normalizedFaces,
            matches: normalizedMatches.length > 0
                ? normalizedMatches
                : (((pipelineResult as any)?.matches || []).map((m: any) => stripIdentityEmbeddings({
                    ...m,
                    confidence: normalizeLiveConfidence(m?.confidence),
                }))),
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to process recognition frame' });
    }
});

router.get('/intelligence-feed', authenticate, requireRole('LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        const matches = await prisma.faceMatch.findMany({
            include: {
                criminal: true,
                detection: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
        });

        // Get aggregate stats
        const totalMatches = await prisma.faceMatch.count();
        const confirmedMatches = await prisma.faceMatch.count({ where: { reviewStatus: 'CONFIRMED' } });
        const pendingMatches = await prisma.faceMatch.count({ where: { reviewStatus: 'PENDING_REVIEW' } });
        const totalCriminals = await prisma.criminalRecord.count();

        res.json({
            matches,
            stats: {
                totalMatches,
                confirmedMatches,
                pendingMatches,
                totalCriminals,
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch intelligence feed' });
    }
});

router.get('/recognition-status', authenticate, requireRole('MODERATOR', 'LAW_ENFORCEMENT', 'ADMIN'), async (req: Request, res: Response) => {
    try {
        // Keep pipeline model state aligned with current DB before reporting status.
        await syncPipelineSubjectsWithDb();
        const resp = await fetch(`${CCTV_PIPELINE_URL}/recognition-status`);
        if (!resp.ok) throw new Error(`Pipeline: ${resp.status}`);
        const data = await resp.json();
        res.json(data);
    } catch (err: any) {
        res.status(502).json({ error: 'CCTV pipeline unavailable', details: err?.message });
    }
});

export default router;
