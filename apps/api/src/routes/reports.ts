import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../db';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { computeSeverityLLM } from '../services/llmSeverity';
import { authenticate } from '../middleware/authSession';
import {
    applyCredibilityDelta,
    DAILY_REPORT_LIMIT_RESTRICTED,
    duplicateRadiusForTierMeters,
    isSeniorModeratorRole,
    nextUtcDay,
    startOfUtcDay,
} from '../services/credibility';

let reportIo: any = null;
export function registerReportIo(io: any) {
    reportIo = io;
}

const router = Router();

// Local pilot storage for uploads (served as `/uploads/...` by the API server).
const uploadDir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        cb(null, `${unique}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    fileFilter: (req, file, cb) => {
        const mt = file.mimetype || '';
        if (mt.startsWith('image/') || mt.startsWith('video/')) return cb(null, true);
        return cb(new Error('Only image/* and video/* are allowed'));
    },
});

const roleAllowsModeration = (role: unknown) => {
    return role === 'MODERATOR' || role === 'ADMIN';
};

const roleAllowsResolution = (role: unknown) => role === 'LAW_ENFORCEMENT' || role === 'ADMIN';
const roleAllowsReopen = (role: unknown) => role === 'LAW_ENFORCEMENT';
const roleAllowsResolutionDashboard = (role: unknown) =>
    role === 'LAW_ENFORCEMENT' || role === 'ADMIN' || role === 'MODERATOR';

const RESOLUTION_TAGS = [
    'ARREST_MADE',
    'SUSPECTS_DISPERSED',
    'SITUATION_CLEARED',
    'FALSE_ALARM',
    'DUPLICATE_CONFIRMED',
    'UNDER_INVESTIGATION',
    'NO_ACTION_TAKEN',
] as const;

const districtKey = (lat: number, lng: number) => {
    const step = 0.25;
    const g = (n: number) => Math.round(n / step) * step;
    return `${g(lat).toFixed(2)},${g(lng).toFixed(2)}`;
};

const RESTRICTED_DAILY_LIMIT_MESSAGE = "You've reached your daily report limit.";

const clampSeverity = (n: number) => {
    if (Number.isNaN(n)) return 1;
    return Math.max(1, Math.min(10, Math.round(n)));
};

// Lightweight placeholder severity scoring (to be replaced by the ML model later).
const computeSeverity = (params: {
    type: string;
    createdAt: Date;
    authorId: string;
    existingVerifiedByAuthorCount: number;
}) => {
    const { type, createdAt, existingVerifiedByAuthorCount } = params;

    const baseByType: Record<string, number> = {
        ARMED_ROBBERY: 9,
        VEHICLE_CRIME: 6,
        VANDALISM: 3,
        ASSAULT: 8,
        THEFT: 5,
        OTHER: 4,
    };

    const base = baseByType[type] ?? 4;
    const hour = createdAt.getHours();
    const nightBoost = hour >= 19 || hour <= 5 ? 1 : 0; // simple time-of-day adjustment
    const repeatBoost = Math.min(2, Math.floor(existingVerifiedByAuthorCount / 3)); // ~repeat offender signal

    const severity = clampSeverity(base + nightBoost + repeatBoost);

    // Confidence heuristic: higher when type is known + when repeatBoost is present.
    const typeKnown = Object.prototype.hasOwnProperty.call(baseByType, type);
    const confidence = Math.max(
        0.2,
        Math.min(0.95, 0.55 + (typeKnown ? 0.15 : 0) + severity / 10 * 0.25 + repeatBoost * 0.02),
    );

    return { severity, confidence };
};

const getDistanceFromLatLonInMeters = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3; // Radius of the earth in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
};

const findDuplicate = async (lat: number, lon: number, radiusM = 200): Promise<string | null> => {
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const recentReports = await prisma.report.findMany({
        where: { createdAt: { gte: fifteenMinsAgo } },
        select: { id: true, latitude: true, longitude: true }
    });

    for (const rr of recentReports) {
        const dist = getDistanceFromLatLonInMeters(lat, lon, rr.latitude, rr.longitude);
        if (dist <= radiusM) return rr.id;
    }
    return null;
};

const getCommunityVoteRadiusKm = () => {
    const n = parseFloat(String(process.env.COMMUNITY_VOTE_RADIUS_KM ?? '3'));
    if (!Number.isFinite(n) || n <= 0 || n > 50) return 3;
    return n;
};

const clientIp = (req: Request) => {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
    return req.socket.remoteAddress || (req as any).ip || 'unknown';
};

const MAX_VOTE_ACTIONS_PER_IP_HOUR = 20;
const ABUSE_MIN_VOTES = 10;
const ABUSE_DISPUTE_RATIO = 0.8;

const resolveAuthUser = async (req: Request): Promise<{ userId: string; role: string } | null> => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'citizenwatch_secret_default') as any;
        const tokenId = decoded?.tokenId as string | undefined;
        if (!tokenId || !decoded?.userId) return null;
        const now = new Date();
        const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const session = await prisma.session.findUnique({
            where: { tokenId },
            select: { lastActivityAt: true, revokedAt: true },
        });
        if (!session || session.revokedAt || session.lastActivityAt < cutoff) return null;
        await prisma.session.update({
            where: { tokenId },
            data: { lastActivityAt: now },
        });
        return { userId: decoded.userId as string, role: String(decoded.role ?? 'CITIZEN') };
    } catch {
        return null;
    }
};

const recalcReportVoteAggregates = async (reportId: string, db: any = prisma) => {
    const grouped = await db.reportVote.groupBy({
        by: ['voteType'],
        where: { reportId },
        _count: { _all: true },
    });
    let confirms = 0;
    let disputes = 0;
    for (const g of grouped) {
        if (g.voteType === 'CONFIRM') confirms = g._count._all;
        if (g.voteType === 'DISPUTE') disputes = g._count._all;
    }
    const voteScore = confirms - disputes;
    const communityConfirmed = voteScore >= 10;
    await db.report.update({
        where: { id: reportId },
        data: { voteScore, communityConfirmed },
    });
    return { confirms, disputes, voteScore, communityConfirmed };
};

const maybeFlagVoteAbuse = async (userId: string) => {
    const grouped = await prisma.reportVote.groupBy({
        by: ['voteType'],
        where: { userId },
        _count: { _all: true },
    });
    let total = 0;
    let disputes = 0;
    for (const g of grouped) {
        total += g._count._all;
        if (g.voteType === 'DISPUTE') disputes = g._count._all;
    }
    if (total >= ABUSE_MIN_VOTES && disputes / total > ABUSE_DISPUTE_RATIO) {
        await prisma.user.update({
            where: { id: userId },
            data: { voteAbuseFlaggedAt: new Date() },
        });
    }
};

// Anonymous report submission (no auth required)
router.post('/anonymous', upload.array('media'), async (req: Request, res: Response) => {
    try {
        const { title, description, type, latitude, longitude } = req.body;
        const titleStr = String(title ?? '').trim();
        const descriptionStr = String(description ?? '').trim();
        const typeStr = String(type ?? '').trim().toUpperCase();

        const ALLOWED_TYPES = ['ARMED_ROBBERY', 'VEHICLE_CRIME', 'VANDALISM', 'ASSAULT', 'THEFT', 'OTHER'];
        if (!titleStr || titleStr.length > 160) {
            return res.status(400).json({ error: 'Title is required and must be at most 160 characters.' });
        }
        if (!descriptionStr || descriptionStr.length > 2000) {
            return res.status(400).json({ error: 'Description is required and must be at most 2000 characters.' });
        }
        if (!ALLOWED_TYPES.includes(typeStr)) {
            return res.status(400).json({ error: 'Invalid crime type.' });
        }

        const latitudeNum = parseFloat(String(latitude));
        const longitudeNum = parseFloat(String(longitude));
        if ([latitudeNum, longitudeNum].some((n) => Number.isNaN(n))) {
            return res.status(400).json({ error: 'Invalid latitude/longitude' });
        }
        if (latitudeNum < -90 || latitudeNum > 90 || longitudeNum < -180 || longitudeNum > 180) {
            return res.status(400).json({ error: 'Coordinates out of range' });
        }

        const files = (req.files as Express.Multer.File[]) || [];

        // Find or create anonymous user
        let anonUser = await prisma.user.findFirst({ where: { email: 'anonymous@citizenwatch.internal' } });
        if (!anonUser) {
            const bcrypt = await import('bcryptjs');
            anonUser = await prisma.user.create({
                data: { email: 'anonymous@citizenwatch.internal', password: await bcrypt.hash('anon', 10), role: 'CITIZEN' }
            });
        }

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const multimedia =
            files.length > 0
                ? files.map((f) => ({
                    url: `${baseUrl}/uploads/${f.filename}`,
                    // Prisma expects the MediaType enum literal ('VIDEO' | 'IMAGE').
                    type: f.mimetype.startsWith('video/') ? ('VIDEO' as const) : ('IMAGE' as const),
                }))
                : [];

        const duplicateOfId = await findDuplicate(latitudeNum, longitudeNum);
        const isDuplicate = !!duplicateOfId;

        const report = await prisma.report.create({
            data: {
                title: titleStr,
                description: descriptionStr,
                type: typeStr,
                latitude: latitudeNum,
                longitude: longitudeNum,
                status: 'PENDING',
                authorId: anonUser.id,
                multimedia: multimedia.length > 0 ? { create: multimedia } : undefined,
                isDuplicate,
                duplicateOfId,
            },
            include: { multimedia: true },
        });

        // ── Feature 4: Suspect Photo Isolation ──────────────────────
        // Check each uploaded image for human faces. If detected, flag the
        // report and create isolated review records for moderators.
        const CCTV_PIPELINE_URL = process.env.CCTV_PIPELINE_URL || 'http://localhost:3600';
        const imageFiles = files.filter((f) => f.mimetype.startsWith('image/'));
        let hasSuspectPhoto = false;

        for (const imgFile of imageFiles) {
            try {
                const FormDataModule = await import('form-data');
                const FormData = FormDataModule.default;
                const formData = new FormData();
                formData.append('file', fs.createReadStream(imgFile.path));

                const faceResp = await fetch(`${CCTV_PIPELINE_URL}/check-face-presence`, {
                    method: 'POST',
                    body: formData as any,
                    headers: formData.getHeaders?.() ?? {},
                });

                if (faceResp.ok) {
                    const faceData = await faceResp.json() as any;
                    if (faceData.has_face) {
                        hasSuspectPhoto = true;

                        // Copy to isolated evidence store
                        const isolatedDir = path.join(process.cwd(), 'uploads', 'isolated-evidence');
                        fs.mkdirSync(isolatedDir, { recursive: true });
                        const isolatedPath = path.join(isolatedDir, imgFile.filename);
                        fs.copyFileSync(imgFile.path, isolatedPath);

                        // Find the multimedia record for this file
                        const mm = report.multimedia.find((m) => m.url.includes(imgFile.filename));
                        let reviewStatus = 'PENDING_REVIEW';
                        let matchResultsJson = null;

                        // ── Auto-Match Face with Criminal DB ──
                        try {
                            const FormDataMatch = await import('form-data');
                            const FormDataMatchCls = FormDataMatch.default;
                            const matchFormData = new FormDataMatchCls();
                            matchFormData.append('file', fs.createReadStream(isolatedPath));
                            matchFormData.append('threshold', '0.65');

                            const matchResp = await fetch(`${CCTV_PIPELINE_URL}/match-face`, {
                                method: 'POST',
                                body: matchFormData as any,
                                headers: matchFormData.getHeaders?.() ?? {},
                            });

                            if (matchResp.ok) {
                                const matchResult = await matchResp.json() as any;
                                const matches = matchResult.matches || [];
                                
                                if (matches.length > 0) {
                                    reviewStatus = 'MATCHED';
                                    matchResultsJson = JSON.stringify(matches);
                                    
                                    for (const m of matches) {
                                        const criminal = await prisma.criminalRecord.findFirst({
                                            where: { embeddingId: m.criminal_id },
                                        });
                                        if (!criminal) continue;

                                        const faceMatch = await prisma.faceMatch.create({
                                            data: {
                                                criminalId: criminal.id,
                                                detectionSource: 'CITIZEN_PHOTO',
                                                confidence: m.confidence,
                                                latitude: report.latitude,
                                                longitude: report.longitude,
                                            },
                                            include: { criminal: true }
                                        });
                                        
                                        // Emit event to admins
                                        if (reportIo) {
                                            reportIo.emit('criminal:matched', {
                                                matchId: faceMatch.id,
                                                criminalName: criminal.name,
                                                firNumber: criminal.firNumber,
                                                confidence: m.confidence,
                                                latitude: report.latitude,
                                                longitude: report.longitude,
                                                source: 'CITIZEN_PHOTO',
                                                mugshotUrl: criminal.mugshotUrl
                                            });
                                        }
                                    }
                                }
                            }
                        } catch (matchErr) {
                            console.warn('[SuspectPhoto] Auto-match failed', matchErr);
                        }

                        if (mm) {
                            await prisma.suspectPhotoReview.create({
                                data: {
                                    reportId: report.id,
                                    multimediaId: mm.id,
                                    isolatedPath,
                                    status: reviewStatus as any,
                                    matchResults: matchResultsJson,
                                },
                            });
                        }
                    }
                }
            } catch (faceErr) {
                // Pipeline may not be running — log but don't block report creation
                console.warn('[SuspectPhoto] Face check failed for', imgFile.filename, faceErr);
            }
        }

        if (hasSuspectPhoto) {
            await prisma.report.update({
                where: { id: report.id },
                data: { hasSuspectPhoto: true },
            });
        }

        res.status(201).json({ report: { ...report, hasSuspectPhoto } });
        if (reportIo) {
            reportIo.emit('report:new', { report: { ...report, hasSuspectPhoto } });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create report' });
    }
});

// Authenticated report submission
router.post('/', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = (req as any).user as { userId?: string; role?: string };
        if (actor?.role === 'MODERATOR' || actor?.role === 'LAW_ENFORCEMENT') {
            return res.status(403).json({ error: 'This feature is for citizens only.' });
        }
        const { title, description, type, latitude, longitude, media } = req.body;
        const userId = actor.userId;
        
        const latitudeNum = parseFloat(String(latitude));
        const longitudeNum = parseFloat(String(longitude));

        const now = new Date();
        const todayStart = startOfUtcDay(now);

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                credibilityTier: true,
                dailyReportCount: true,
                dailyReportResetAt: true,
            },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const mustResetDaily =
            !user.dailyReportResetAt || user.dailyReportResetAt.getTime() < todayStart.getTime();
        const dailyCount = mustResetDaily ? 0 : user.dailyReportCount;

        if (user.credibilityTier === 'RESTRICTED' && dailyCount >= DAILY_REPORT_LIMIT_RESTRICTED) {
            return res.status(429).json({ error: RESTRICTED_DAILY_LIMIT_MESSAGE });
        }

        const duplicateRadiusM = duplicateRadiusForTierMeters(user.credibilityTier);
        const duplicateOfId = await findDuplicate(latitudeNum, longitudeNum, duplicateRadiusM);
        const isDuplicate = !!duplicateOfId;

        const report = await prisma.report.create({
            data: {
                title, description, type, latitude: latitudeNum, longitude: longitudeNum, status: 'PENDING', authorId: userId,
                multimedia: { create: media?.map((m: any) => ({ url: m.url, type: m.type })) || [] },
                isDuplicate,
                duplicateOfId
            },
            include: { multimedia: true }
        });

        await prisma.user.update({
            where: { id: userId },
            data: {
                dailyReportCount: mustResetDaily ? 1 : { increment: 1 },
                dailyReportResetAt: mustResetDaily ? nextUtcDay(now) : undefined,
                lastActivityAt: now,
            },
        });

        if (user.credibilityTier === 'RESTRICTED') {
            const admins = await prisma.user.findMany({
                where: { role: 'ADMIN' },
                select: { id: true },
            });
            await Promise.all(
                admins.map((a) =>
                    prisma.notification.create({
                        data: {
                            userId: a.id,
                            reportId: report.id,
                            type: 'GENERAL',
                            message: `Restricted reporter submitted a new report (${report.title}).`,
                        },
                    }),
                ),
            );
        }

        res.status(201).json({ report });
        if (reportIo) {
            reportIo.emit('report:new', { report });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create report' });
    }
});

// Get all reports (with optional filters)
router.get('/', async (req: Request, res: Response) => {
    try {
        const { status, type, timeRange } = req.query;
        const whereClause: any = {};
        // Live map/feed callers use this endpoint without a status filter.
        // Enforce verified-only by default; explicit `status` still works for other views (e.g. escalations).
        whereClause.status = status ? (status as string) : 'VERIFIED';
        if (type) whereClause.type = type as string;

        const v = String(timeRange ?? '').toLowerCase();
        let from: Date | undefined;
        const now = new Date();
        if (v === '24h') from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        else if (v === '7d' || v === '7day' || v === '7days') from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        else if (v === '30d' || v === '30day' || v === '30days') from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        if (from) whereClause.createdAt = { gte: from };

        const incRaw = String(req.query.includeResolved ?? '').toLowerCase();
        const includeResolved = incRaw === '1' || incRaw === 'true' || incRaw === 'yes';
        const resolvedOnlyRaw = String(req.query.resolvedOnly ?? '').toLowerCase();
        const resolvedOnly =
            resolvedOnlyRaw === '1' || resolvedOnlyRaw === 'true' || resolvedOnlyRaw === 'yes';

        if (resolvedOnly) {
            whereClause.status = 'VERIFIED';
            whereClause.isResolved = true;
        } else {
            const hideVerified: Record<string, unknown>[] = [];
            if (!includeResolved) hideVerified.push({ isResolved: true });
            if (hideVerified.length > 0) {
                whereClause.NOT = {
                    AND: [
                        { status: 'VERIFIED' },
                        hideVerified.length === 1 ? hideVerified[0] : { OR: hideVerified },
                    ],
                };
            }
        }

        const reports = await prisma.report.findMany({
            where: whereClause,
            include: { multimedia: true, author: { select: { email: true, phone: true } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ reports });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

const communityReportSelect = {
    id: true,
    title: true,
    description: true,
    type: true,
    latitude: true,
    longitude: true,
    status: true,
    severity: true,
    createdAt: true,
    voteScore: true,
    communityConfirmed: true,
    authorId: true,
    isResolved: true,
    resolutionTag: true,
    resolvedAt: true,
} as const;

// Public community dashboard: verified (left) + pending (right), sorted by net vote score desc.
router.get('/community-dashboard', async (req: Request, res: Response) => {
    try {
        const viewer = await resolveAuthUser(req);
        const radiusKm = getCommunityVoteRadiusKm();

        const [verified, pending] = await Promise.all([
            prisma.report.findMany({
                where: { status: 'VERIFIED' },
                select: { ...communityReportSelect },
                orderBy: [{ isResolved: 'asc' }, { voteScore: 'desc' }, { createdAt: 'desc' }],
                take: 80,
            }),
            prisma.report.findMany({
                where: { status: 'PENDING' },
                select: { ...communityReportSelect },
                orderBy: [{ voteScore: 'desc' }, { createdAt: 'desc' }],
                take: 80,
            }),
        ]);

        const allIds = [...verified.map((r) => r.id), ...pending.map((r) => r.id)];
        const countMap = new Map<string, { confirmCount: number; disputeCount: number }>();
        if (allIds.length > 0) {
            const grouped = await prisma.reportVote.groupBy({
                by: ['reportId', 'voteType'],
                where: { reportId: { in: allIds } },
                _count: { _all: true },
            });
            for (const g of grouped) {
                const cur = countMap.get(g.reportId) ?? { confirmCount: 0, disputeCount: 0 };
                if (g.voteType === 'CONFIRM') cur.confirmCount = g._count._all;
                if (g.voteType === 'DISPUTE') cur.disputeCount = g._count._all;
                countMap.set(g.reportId, cur);
            }
        }

        const myVoteMap = new Map<string, 'CONFIRM' | 'DISPUTE'>();
        if (viewer && allIds.length > 0) {
            const mine = await prisma.reportVote.findMany({
                where: { userId: viewer.userId, reportId: { in: allIds } },
                select: { reportId: true, voteType: true },
            });
            for (const m of mine) myVoteMap.set(m.reportId, m.voteType as 'CONFIRM' | 'DISPUTE');
        }

        const mapRow = (r: (typeof verified)[number]) => ({
            ...r,
            confirmCount: countMap.get(r.id)?.confirmCount ?? 0,
            disputeCount: countMap.get(r.id)?.disputeCount ?? 0,
            myVote: myVoteMap.get(r.id) ?? null,
        });

        res.json({
            voteRadiusKm: radiusKm,
            verified: verified.map(mapRow),
            pending: pending.map(mapRow),
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load community dashboard' });
    }
});

// Moderation queue:
// - Pending reports
// - Also include VERIFIED reports with low severity confidence, so they remain reviewable (PRD FR-28).
router.get('/queue', authenticate, async (req: Request, res: Response) => {
    try {
        const rawThreshold = req.query.lowConfidenceThreshold ?? '0.6';
        const threshold = parseFloat(String(rawThreshold));
        const lowConfidence = Number.isNaN(threshold) ? 0.6 : threshold;

        const actor = (req as any).user as { userId?: string; role?: string };
        const actorRole = actor?.role;
        if (!roleAllowsModeration(actorRole)) {
            return res.status(403).json({ error: 'Not authorized to view moderation queue' });
        }

        let reports = await prisma.report.findMany({
            where: {
                OR: [
                    { status: 'PENDING' },
                    {
                        status: 'VERIFIED',
                        severityConfidence: { lt: lowConfidence },
                    },
                ],
            },
            include: {
                multimedia: true,
                author: {
                    select: { email: true, phone: true, credibilityScore: true, credibilityTier: true },
                },
            },
            orderBy: [{ communityConfirmed: 'desc' }, { voteScore: 'desc' }, { createdAt: 'desc' }],
        });

        if (actorRole !== 'ADMIN') {
            // FLAGGED reporters require senior review.
            reports = reports.filter((r) => r.author.credibilityTier !== 'FLAGGED');
        }

        reports = [...reports].sort((a, b) => {
            const rank = (tier: string) => {
                if (tier === 'TRUSTED') return 3;
                if (tier === 'STANDARD') return 2;
                if (tier === 'FLAGGED') return 1;
                return 0; // RESTRICTED at end
            };
            const t = rank(b.author.credibilityTier) - rank(a.author.credibilityTier);
            if (t !== 0) return t;
            return 0;
        });

        const reportIds = reports.map((r) => r.id);
        const witnessRows =
            reportIds.length > 0
                ? await prisma.witnessCorroboration.findMany({
                      where: { reportId: { in: reportIds } },
                      select: { reportId: true, response: true },
                  })
                : [];
        const witnessStats = new Map<string, { notified: number; corroborated: number; disputed: number }>();
        for (const wr of witnessRows) {
            const cur = witnessStats.get(wr.reportId) ?? { notified: 0, corroborated: 0, disputed: 0 };
            cur.notified += 1;
            if (wr.response === 'CORROBORATED') cur.corroborated += 1;
            if (wr.response === 'DISPUTED') cur.disputed += 1;
            witnessStats.set(wr.reportId, cur);
        }

        const enriched = reports.map((r) => ({
            ...r,
            witnessNotified: witnessStats.get(r.id)?.notified ?? 0,
            witnessCorroborated: witnessStats.get(r.id)?.corroborated ?? 0,
            witnessDisputed: witnessStats.get(r.id)?.disputed ?? 0,
        }));

        res.json({ reports: enriched, lowConfidenceThreshold: lowConfidence });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch moderation queue' });
    }
});

// ── Resolution stats (inspectors) — must stay above `/:id` routes ───

router.get('/resolution-stats', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = (req as any).user as { userId?: string; role?: string };
        if (!roleAllowsResolution(actor?.role)) {
            return res.status(403).json({ error: 'Inspectors only' });
        }

        const windowDays = 30;
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const FOURTY_EIGHT_MS = 48 * 60 * 60 * 1000;

        const verifiedReports = await prisma.report.findMany({
            where: {
                status: 'VERIFIED',
                verifiedAt: { not: null, gte: since },
            },
            select: {
                id: true,
                type: true,
                latitude: true,
                longitude: true,
                verifiedAt: true,
                isResolved: true,
                resolvedAt: true,
            },
        });

        const resolvedSubset = verifiedReports.filter((r) => r.isResolved && r.resolvedAt && r.verifiedAt);
        let within48 = 0;
        for (const r of resolvedSubset) {
            const d = r.resolvedAt!.getTime() - r.verifiedAt!.getTime();
            if (d >= 0 && d <= FOURTY_EIGHT_MS) within48++;
        }

        const byType: Record<string, { resolved: number; within48h: number }> = {};
        const byDistrict: Record<string, { resolved: number; within48h: number }> = {};
        for (const r of resolvedSubset) {
            const delta = r.resolvedAt!.getTime() - r.verifiedAt!.getTime();
            const in48 = delta >= 0 && delta <= FOURTY_EIGHT_MS;

            const t = r.type;
            if (!byType[t]) byType[t] = { resolved: 0, within48h: 0 };
            byType[t].resolved++;
            if (in48) byType[t].within48h++;

            const dk = districtKey(r.latitude, r.longitude);
            if (!byDistrict[dk]) byDistrict[dk] = { resolved: 0, within48h: 0 };
            byDistrict[dk].resolved++;
            if (in48) byDistrict[dk].within48h++;
        }

        const trend: {
            date: string;
            verifiedCount: number;
            resolvedWithin48hCount: number;
            pctWithin48h: number | null;
        }[] = [];
        const dayMs = 24 * 60 * 60 * 1000;
        const now = new Date();
        for (let i = windowDays - 1; i >= 0; i--) {
            const dayStart = new Date(
                Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i, 0, 0, 0, 0),
            );
            const nextDay = new Date(dayStart.getTime() + dayMs);
            const dateStr = dayStart.toISOString().slice(0, 10);

            const verifiedThatDay = verifiedReports.filter(
                (r) => r.verifiedAt && r.verifiedAt >= dayStart && r.verifiedAt < nextDay,
            );
            const denom = verifiedThatDay.length;
            let rw48 = 0;
            for (const r of verifiedThatDay) {
                if (!r.isResolved || !r.resolvedAt || !r.verifiedAt) continue;
                const d = r.resolvedAt.getTime() - r.verifiedAt.getTime();
                if (d >= 0 && d <= FOURTY_EIGHT_MS) rw48++;
            }
            trend.push({
                date: dateStr,
                verifiedCount: denom,
                resolvedWithin48hCount: rw48,
                pctWithin48h: denom > 0 ? Math.round((rw48 / denom) * 1000) / 10 : null,
            });
        }

        const pctOverall =
            resolvedSubset.length > 0 ? Math.round((within48 / resolvedSubset.length) * 1000) / 10 : null;

        res.json({
            windowDays,
            summary: {
                verifiedInWindow: verifiedReports.length,
                resolvedInWindow: resolvedSubset.length,
                resolvedWithin48h: within48,
                pctResolvedWithin48h: pctOverall,
            },
            byType,
            byDistrict,
            trend,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load resolution stats' });
    }
});

router.get('/resolutions-dashboard', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = (req as any).user as { role?: string };
        if (!roleAllowsResolutionDashboard(actor?.role)) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const tf = String(req.query.timeFilter ?? '30d').toLowerCase();
        const pageNum = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
        const pageSize = 20;
        const skip = (pageNum - 1) * pageSize;
        const now = new Date();
        let since: Date | undefined;
        if (tf === '24h') since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        else if (tf === '7d') since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        else if (tf === '30d') since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const verifiedWhere: any = {
            status: 'VERIFIED',
            verifiedAt: { not: null },
            ...(since ? { verifiedAt: { gte: since } } : {}),
        };
        const resolvedWhere: any = {
            ...verifiedWhere,
            isResolved: true,
            resolvedAt: { not: null, ...(since ? { gte: since } : {}) },
        };

        const [verifiedReports, resolvedCount, resolvedFeed, resolvedFeedTotal] = await Promise.all([
            prisma.report.findMany({
                where: verifiedWhere,
                select: {
                    id: true,
                    title: true,
                    type: true,
                    latitude: true,
                    longitude: true,
                    verifiedAt: true,
                    isResolved: true,
                    resolvedAt: true,
                    resolutionTag: true,
                    resolvedBy: { select: { fullName: true, email: true, phone: true } },
                },
            }),
            prisma.report.count({ where: { ...verifiedWhere, isResolved: true } }),
            prisma.report.findMany({
                where: resolvedWhere,
                select: {
                    id: true,
                    title: true,
                    type: true,
                    latitude: true,
                    longitude: true,
                    verifiedAt: true,
                    resolvedAt: true,
                    resolutionTag: true,
                    resolvedBy: { select: { fullName: true, email: true, phone: true } },
                },
                orderBy: { resolvedAt: 'desc' },
                skip,
                take: pageSize,
            }),
            prisma.report.count({ where: resolvedWhere }),
        ]);

        const totalVerified = verifiedReports.length;
        const openCount = verifiedReports.filter((r) => !r.isResolved).length;
        const resolutionRatePct = totalVerified > 0 ? Math.round((resolvedCount / totalVerified) * 1000) / 10 : 0;

        const resolvedRows = verifiedReports.filter((r) => r.isResolved && r.resolvedAt && r.verifiedAt);
        const avgHours =
            resolvedRows.length > 0
                ? Math.round(
                      (resolvedRows.reduce((acc, r) => {
                          const ms = r.resolvedAt!.getTime() - r.verifiedAt!.getTime();
                          return acc + Math.max(0, ms);
                      }, 0) /
                          resolvedRows.length /
                          (60 * 60 * 1000)) *
                          100,
                  ) / 100
                : 0;

        const byIncidentTypeMap = new Map<string, number>();
        const byResolutionTagMap = new Map<string, number>();
        const districtAgg = new Map<string, { totalVerified: number; resolved: number }>();

        for (const r of verifiedReports) {
            const dk = districtKey(r.latitude, r.longitude);
            const cur = districtAgg.get(dk) ?? { totalVerified: 0, resolved: 0 };
            cur.totalVerified += 1;
            if (r.isResolved) cur.resolved += 1;
            districtAgg.set(dk, cur);
        }
        for (const r of resolvedRows) {
            byIncidentTypeMap.set(r.type, (byIncidentTypeMap.get(r.type) ?? 0) + 1);
            if (r.resolutionTag) {
                byResolutionTagMap.set(r.resolutionTag, (byResolutionTagMap.get(r.resolutionTag) ?? 0) + 1);
            }
        }

        const byIncidentType = Array.from(byIncidentTypeMap.entries()).map(([type, count]) => ({ type, count }));
        const byResolutionTag = Array.from(byResolutionTagMap.entries()).map(([tag, count]) => ({ tag, count }));
        const topDistricts = Array.from(districtAgg.entries())
            .map(([district, v]) => ({
                district,
                totalVerified: v.totalVerified,
                resolved: v.resolved,
                resolutionRatePct: v.totalVerified > 0 ? Math.round((v.resolved / v.totalVerified) * 1000) / 10 : 0,
            }))
            .sort((a, b) => b.resolutionRatePct - a.resolutionRatePct)
            .slice(0, 5);

        res.json({
            timeFilter: tf,
            summary: {
                totalVerified,
                totalResolved: resolvedCount,
                resolutionRatePct,
                avgTimeToResolveHours: avgHours,
                openCount,
            },
            feed: {
                page: pageNum,
                pageSize,
                total: resolvedFeedTotal,
                items: resolvedFeed,
            },
            breakdown: {
                byIncidentType,
                byResolutionTag,
                topDistricts,
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load resolutions dashboard' });
    }
});

// ── Witness corroboration (invited nearby users only) ───────────────

router.get('/:id/witness-invite', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const userId = (req as any).user.userId as string;
        const invite = await prisma.witnessCorroboration.findUnique({
            where: { reportId_witnessUserId: { reportId, witnessUserId: userId } },
            include: {
                report: { select: { type: true } },
            },
        });

        if (!invite) {
            return res.json({ hasInvite: false });
        }

        const now = new Date();
        const open = !invite.response && invite.expiresAt > now;
        res.json({
            hasInvite: true,
            canRespond: open,
            expiresAt: invite.expiresAt.toISOString(),
            incidentType: invite.report.type,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load witness invite' });
    }
});

router.post('/:id/witness-respond', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const userId = (req as any).user.userId as string;
        const { response, note } = req.body as { response?: string; note?: unknown };

        if (response !== 'CORROBORATED' && response !== 'DISPUTED') {
            return res.status(400).json({ error: 'response must be CORROBORATED or DISPUTED' });
        }

        const noteStr = typeof note === 'string' ? note.trim() : '';
        if (response === 'CORROBORATED' && noteStr.length > 200) {
            return res.status(400).json({ error: 'Note must be at most 200 characters' });
        }

        const witnessUser = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                witnessAlertLatitude: true,
                witnessAlertLongitude: true,
            },
        });
        const voteLat = witnessUser?.witnessAlertLatitude ?? null;
        const voteLng = witnessUser?.witnessAlertLongitude ?? null;
        if (voteLat === null || voteLng === null || [voteLat, voteLng].some((n) => Number.isNaN(n))) {
            return res.status(400).json({
                error: 'Set a witness alert location on your profile before you can respond.',
            });
        }

        const report = await prisma.report.findUnique({ where: { id: reportId } });
        if (!report) return res.status(404).json({ error: 'Report not found' });
        if (report.authorId === userId) {
            return res.status(403).json({ error: 'Invalid witness invite' });
        }
        if (report.status !== 'PENDING' && report.status !== 'VERIFIED') {
            return res.status(403).json({ error: 'Witness responses are closed for this report.' });
        }
        if (report.status === 'VERIFIED' && report.isResolved) {
            return res.status(403).json({ error: 'Witness responses are closed for resolved reports.' });
        }

        const radiusKm = getCommunityVoteRadiusKm();
        const distM = getDistanceFromLatLonInMeters(voteLat, voteLng, report.latitude, report.longitude);
        if (distM > radiusKm * 1000) {
            return res.status(403).json({
                code: 'OUT_OF_RANGE',
                error: `Your saved witness location is outside ${radiusKm} km of this incident.`,
            });
        }

        const ip = clientIp(req);
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

        await prisma.$transaction(async (tx) => {
            const invite = await tx.witnessCorroboration.findUnique({
                where: { reportId_witnessUserId: { reportId, witnessUserId: userId } },
            });
            if (!invite || invite.response) {
                const err = new Error('INVITE_INVALID') as Error & { status: number };
                err.status = 409;
                throw err;
            }
            if (invite.expiresAt <= new Date()) {
                const err = new Error('INVITE_EXPIRED') as Error & { status: number };
                err.status = 410;
                throw err;
            }

            const recentActions = await tx.communityVoteAction.count({
                where: { ip, createdAt: { gte: hourAgo } },
            });
            if (recentActions >= MAX_VOTE_ACTIONS_PER_IP_HOUR) {
                const err = new Error('RATE_LIMIT_IP') as Error & { status: number };
                err.status = 429;
                throw err;
            }
            await tx.communityVoteAction.create({
                data: { id: randomUUID(), ip },
            });

            const voteType = response === 'CORROBORATED' ? 'CONFIRM' : 'DISPUTE';
            await tx.reportVote.upsert({
                where: { reportId_userId: { reportId, userId } },
                create: {
                    reportId,
                    userId,
                    voteType,
                    voteLat,
                    voteLng,
                    voterIp: ip,
                },
                update: {
                    voteType,
                    voteLat,
                    voteLng,
                    voterIp: ip,
                },
            });

            await tx.witnessCorroboration.update({
                where: { id: invite.id },
                data: {
                    response: response as 'CORROBORATED' | 'DISPUTED',
                    note: response === 'CORROBORATED' ? (noteStr || null) : null,
                    respondedAt: new Date(),
                },
            });

            await recalcReportVoteAggregates(reportId, tx);
        });

        await maybeFlagVoteAbuse(userId);

        const updated = await prisma.report.findUnique({
            where: { id: reportId },
            select: { voteScore: true, communityConfirmed: true },
        });
        if (reportIo) {
            reportIo.emit('report:voted', {
                reportId,
                voteScore: updated?.voteScore,
                communityConfirmed: updated?.communityConfirmed,
            });
        }

        res.json({
            ok: true,
            voteScore: updated?.voteScore ?? 0,
            communityConfirmed: updated?.communityConfirmed ?? false,
        });
    } catch (e: any) {
        if (e?.message === 'INVITE_INVALID') {
            return res.status(409).json({ error: 'No open witness invite for this report.' });
        }
        if (e?.message === 'INVITE_EXPIRED') {
            return res.status(410).json({ error: 'This witness prompt has expired (30 minutes).' });
        }
        if (e?.status === 429) {
            return res.status(429).json({
                code: 'RATE_LIMIT_IP',
                error: 'Too many actions from this network in the last hour. Try again later.',
            });
        }
        console.error(e);
        res.status(500).json({ error: 'Failed to record witness response' });
    }
});

// ── Community voting (authenticated; no proximity gate) ───────────

router.post('/:id/vote', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        const userId = actor?.userId as string;
        if (actor?.role === 'MODERATOR' || actor?.role === 'LAW_ENFORCEMENT') {
            return res.status(403).json({ error: 'Voting is available to citizens only' });
        }
        const { voteType } = req.body as { voteType?: string };

        if (voteType !== 'CONFIRM' && voteType !== 'DISPUTE') {
            return res.status(400).json({ error: 'voteType must be CONFIRM or DISPUTE' });
        }

        const report = await prisma.report.findUnique({ where: { id: reportId } });
        if (!report) return res.status(404).json({ error: 'Report not found' });

        if (report.status !== 'PENDING' && report.status !== 'VERIFIED') {
            return res.status(403).json({
                code: 'VOTING_CLOSED',
                error: 'Community voting is only available for pending or verified reports.',
            });
        }

        if (report.status === 'VERIFIED' && report.isResolved) {
            return res.status(403).json({
                code: 'REPORT_RESOLVED',
                error: 'Community voting is closed for resolved incidents.',
            });
        }

        if (report.authorId === userId) {
            return res.status(403).json({
                code: 'OWN_REPORT',
                error: 'You cannot vote on your own report.',
            });
        }

        const ip = clientIp(req);
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        // Community votes are not proximity-gated; voter location is unknown — store null once DB allows it.
        const voteLat: number | null = null;
        const voteLng: number | null = null;

        await prisma.$transaction(async (tx) => {
            const recentActions = await tx.communityVoteAction.count({
                where: { ip, createdAt: { gte: hourAgo } },
            });
            if (recentActions >= MAX_VOTE_ACTIONS_PER_IP_HOUR) {
                const err = new Error('RATE_LIMIT_IP') as Error & { status: number };
                err.status = 429;
                throw err;
            }

            await tx.communityVoteAction.create({
                data: { id: randomUUID(), ip },
            });

            await tx.reportVote.upsert({
                where: { reportId_userId: { reportId, userId } },
                create: {
                    reportId,
                    userId,
                    voteType: voteType as 'CONFIRM' | 'DISPUTE',
                    voteLat,
                    voteLng,
                    voterIp: ip,
                },
                update: {
                    voteType: voteType as 'CONFIRM' | 'DISPUTE',
                    voteLat,
                    voteLng,
                    voterIp: ip,
                },
            });

            await recalcReportVoteAggregates(reportId, tx);
        });

        await maybeFlagVoteAbuse(userId);

        const updated = await prisma.report.findUnique({
            where: { id: reportId },
            select: { voteScore: true, communityConfirmed: true },
        });
        if (reportIo) reportIo.emit('report:voted', { reportId, voteScore: updated?.voteScore, communityConfirmed: updated?.communityConfirmed });

        res.json({
            ok: true,
            voteScore: updated?.voteScore ?? 0,
            communityConfirmed: updated?.communityConfirmed ?? false,
        });
    } catch (e: any) {
        if (e?.status === 429) {
            return res.status(429).json({
                code: 'RATE_LIMIT_IP',
                error: 'Too many vote actions from this network in the last hour. Try again later.',
            });
        }
        console.error(e);
        res.status(500).json({ error: 'Failed to record vote' });
    }
});

router.delete('/:id/vote', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        const userId = actor?.userId as string;
        if (actor?.role === 'MODERATOR' || actor?.role === 'LAW_ENFORCEMENT') {
            return res.status(403).json({ error: 'Voting is available to citizens only' });
        }

        const deleted = await prisma.reportVote.deleteMany({
            where: { reportId, userId },
        });
        if (deleted.count === 0) {
            return res.status(404).json({ error: 'No vote to remove for this report' });
        }

        await recalcReportVoteAggregates(reportId);

        if (reportIo) reportIo.emit('report:voted', { reportId });

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to remove vote' });
    }
});

router.get('/:id/votes', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        if (!roleAllowsModeration(actor?.role)) {
            return res.status(403).json({ error: 'Moderators only' });
        }

        const votes = await prisma.reportVote.findMany({
            where: { reportId },
            orderBy: { createdAt: 'desc' },
            include: {
                user: { select: { id: true, email: true, phone: true, voteAbuseFlaggedAt: true } },
            },
        });

        res.json({ votes });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to list votes' });
    }
});

router.get('/:id/resolution-history', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        if (!roleAllowsResolution(actor?.role)) {
            return res.status(403).json({ error: 'Inspectors only' });
        }

        const rows = await prisma.resolutionHistory.findMany({
            where: { reportId },
            orderBy: { createdAt: 'desc' },
            include: { actor: { select: { id: true, email: true, phone: true, role: true } } },
        });

        res.json({ history: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load resolution history' });
    }
});

router.post('/:id/resolve', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        const actorId = actor?.userId;
        if (!actorId || !roleAllowsResolution(actor?.role)) {
            return res.status(403).json({ error: 'Only law enforcement and admins can resolve reports.' });
        }

        const { tag, notes, confirmed } = req.body as {
            tag?: string;
            notes?: unknown;
            confirmed?: unknown;
        };

        if (confirmed !== true && confirmed !== 'true') {
            return res.status(400).json({ error: 'You must confirm before resolving.' });
        }

        if (!tag || !RESOLUTION_TAGS.includes(tag as (typeof RESOLUTION_TAGS)[number])) {
            return res.status(400).json({ error: 'Invalid or missing resolution tag.' });
        }

        const notesStr = typeof notes === 'string' ? notes.trim() : '';
        if (notesStr.length > 500) {
            return res.status(400).json({ error: 'Internal notes must be at most 500 characters.' });
        }

        const existing = await prisma.report.findUnique({ where: { id: reportId } });
        if (!existing) return res.status(404).json({ error: 'Report not found' });
        if (existing.status !== 'VERIFIED' && existing.status !== 'ESCALATED') {
            return res.status(400).json({ error: 'Only verified or escalated reports can be resolved.' });
        }
        if (existing.isResolved) {
            return res.status(409).json({ error: 'This report is already resolved.' });
        }

        const now = new Date();
        const updated = await prisma.$transaction(async (tx) => {
            await tx.resolutionHistory.create({
                data: {
                    reportId,
                    action: 'RESOLVED',
                    actorId,
                    tag: tag as any,
                    notes: notesStr || null,
                },
            });
            return tx.report.update({
                where: { id: reportId },
                data: {
                    isResolved: true,
                    resolutionTag: tag as any,
                    resolvedAt: now,
                    resolvedById: actorId,
                    resolutionNotes: notesStr || null,
                },
            });
        });

        // Broadcast resolution notification to all citizens + moderators.
        // If notification preferences are unavailable/unset, default to sending.
        const locationDescriptor = `District ${districtKey(existing.latitude, existing.longitude)}`;
        const publicMessage = `A crime has been resolved in ${locationDescriptor}. Type: ${existing.type}. Status: ${tag}.`;
        const recipients = await prisma.user.findMany({
            where: { role: { in: ['CITIZEN', 'MODERATOR'] } },
            select: { id: true, notificationPrefs: true },
        });
        const recipientIds = recipients
            .filter((u: any) => {
                const prefs = u?.notificationPrefs;
                if (!prefs || typeof prefs !== 'object') return true;
                const v = (prefs as Record<string, unknown>).receiveCrimeResolutionNotifications;
                return typeof v === 'boolean' ? v : true;
            })
            .map((u) => u.id);
        if (recipientIds.length > 0) {
            await prisma.notification.createMany({
                data: recipientIds.map((userId) => ({
                    userId,
                    reportId,
                    type: 'GENERAL' as const,
                    message: publicMessage,
                })),
            });
        }

        if (reportIo) reportIo.emit('report:resolved', { reportId });
        res.json({ report: updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to resolve report' });
    }
});

router.post('/:id/reopen', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        const actorId = actor?.userId;
        if (!actorId || !roleAllowsReopen(actor?.role)) {
            return res.status(403).json({ error: 'Only law enforcement officers can reopen resolved reports.' });
        }

        const notesStr = typeof (req.body as any)?.notes === 'string' ? String((req.body as any).notes).trim() : '';
        if (notesStr.length > 500) {
            return res.status(400).json({ error: 'Notes must be at most 500 characters.' });
        }

        const existing = await prisma.report.findUnique({ where: { id: reportId } });
        if (!existing) return res.status(404).json({ error: 'Report not found' });
        if (existing.status !== 'VERIFIED' && existing.status !== 'ESCALATED') {
            return res.status(400).json({ error: 'Only verified or escalated reports can be reopened.' });
        }
        if (!existing.isResolved) {
            return res.status(409).json({ error: 'This report is not resolved.' });
        }

        const updated = await prisma.$transaction(async (tx) => {
            await tx.resolutionHistory.create({
                data: {
                    reportId,
                    action: 'REOPENED',
                    actorId,
                    tag: null,
                    notes: notesStr || null,
                },
            });
            return tx.report.update({
                where: { id: reportId },
                data: {
                    isResolved: false,
                    resolutionTag: null,
                    resolvedAt: null,
                    resolvedById: null,
                    resolutionNotes: null,
                },
            });
        });

        if (reportIo) reportIo.emit('report:reopened', { reportId });
        res.json({ report: updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to reopen report' });
    }
});

// Moderate a report (approve / reject / escalate)
router.post('/:id/moderate', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const id = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!id) {
            return res.status(400).json({ error: 'Invalid report id' });
        }

        const { status, reason } = req.body as {
            status: 'VERIFIED' | 'REJECTED' | 'ESCALATED';
            reason?: string;
        };
        const actor = (req as any).user as { userId?: string; role?: string };
        const actorId = actor?.userId;
        const actorRole = actor?.role;

        if (!actorId || !roleAllowsModeration(actorRole)) {
            return res.status(403).json({ error: 'Not authorized to moderate' });
        }

        if (!['VERIFIED', 'REJECTED', 'ESCALATED'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const trimmedReason = (reason ?? '').trim();
        const auditReason = trimmedReason || `No reason provided by ${actorRole || 'unknown-role'}`;

        // Load report before updating so we can compute severity when VERIFIED.
        const existing = await prisma.report.findUnique({
            where: { id },
            include: { author: { select: { credibilityTier: true, email: true } } },
        });
        if (!existing) return res.status(404).json({ error: 'Report not found' });
        if (existing.status === status) {
            return res.status(409).json({ error: `Report is already ${status.toLowerCase()}.` });
        }

        if (existing.author.credibilityTier === 'FLAGGED' && !isSeniorModeratorRole(actorRole)) {
            return res.status(403).json({ error: 'This report is held for senior moderator review.' });
        }

        const report = await prisma.report.update({
            where: { id },
            data: {
                status,
                ...(status === 'VERIFIED' && existing.status !== 'VERIFIED' ? { verifiedAt: new Date() } : {}),
                severity:
                    status === 'VERIFIED'
                        ? undefined // computed below in a second update for clarity
                        : null,
                severityConfidence: status === 'VERIFIED' ? undefined : null,
            },
        });

        let updated = report;
        if (status === 'VERIFIED') {
            const verifiedByAuthorCount = await prisma.report.count({
                where: {
                    authorId: existing.authorId,
                    status: 'VERIFIED',
                    NOT: { id: existing.id },
                },
            });

            const computed = await computeSeverityLLM({
                title: existing.title,
                description: existing.description,
                type: existing.type,
                createdAt: existing.createdAt,
                existingVerifiedByAuthorCount: verifiedByAuthorCount,
            });

            updated = await prisma.report.update({
                where: { id: existing.id },
                data: {
                    severity: computed.severity,
                    severityConfidence: computed.confidence,
                },
            });
        }

        await prisma.moderationAudit.create({
            data: {
                reportId: existing.id,
                actorId,
                actionStatus: status,
                reason: auditReason,
            },
        });

        if (['VERIFIED', 'REJECTED'].includes(status) && existing.authorId) {
            await prisma.notification.create({
                data: {
                    userId: existing.authorId,
                    reportId: existing.id,
                    type: 'STATUS_UPDATE',
                    message: `Your report "${existing.title}" has been ${status.toLowerCase()}.`
                }
            });
        }

        // Notify LAW_ENFORCEMENT & ADMIN users when a report is escalated
        if (status === 'ESCALATED') {
            try {
                const lawUsers = await prisma.user.findMany({
                    where: { role: { in: ['LAW_ENFORCEMENT', 'ADMIN'] } },
                    select: { id: true },
                });
                for (const u of lawUsers) {
                    await prisma.notification.create({
                        data: {
                            userId: u.id,
                            reportId: existing.id,
                            type: 'STATUS_UPDATE',
                            message: `Report "${existing.title}" (${existing.type.replace(/_/g, ' ')}) has been escalated for inspector review.`,
                        },
                    });
                }
            } catch (notifErr) {
                console.warn('[Escalation] Failed to notify inspectors:', notifErr);
            }
        }

        // Silent credibility scoring for authenticated reporters only.
        if (existing.authorId && existing.author.email !== 'anonymous@citizenwatch.internal') {
            let delta = 0;
            let reasonLabel = '';
            if (status === 'VERIFIED' && existing.status === 'ESCALATED') {
                delta = 8;
                reasonLabel = 'ESCALATED_LATER_VERIFIED';
            } else if (status === 'VERIFIED') {
                delta = 5;
                reasonLabel = 'VERIFIED';
            } else if (status === 'REJECTED' && existing.status === 'ESCALATED') {
                delta = -6;
                reasonLabel = 'ESCALATED_LATER_REJECTED';
            } else if (status === 'REJECTED' && existing.isDuplicate) {
                delta = -3;
                reasonLabel = 'REJECTED_DUPLICATE';
            } else if (status === 'REJECTED') {
                delta = -10;
                reasonLabel = 'REJECTED_FALSE';
            }

            if (delta !== 0) {
                const cred = await applyCredibilityDelta({
                    userId: existing.authorId,
                    delta,
                    reason: reasonLabel,
                    triggeredByReportId: existing.id,
                });

                if (cred?.credibilityTier === 'RESTRICTED') {
                    const admins = await prisma.user.findMany({
                        where: { role: 'ADMIN' },
                        select: { id: true },
                    });
                    await Promise.all(
                        admins.map((a) =>
                            prisma.notification.create({
                                data: {
                                    userId: a.id,
                                    reportId: existing.id,
                                    type: 'GENERAL',
                                    message: `Reporter auto-entered RESTRICTED tier (${existing.authorId.slice(0, 8)}...).`,
                                },
                            }),
                        ),
                    );
                }
            }
        }

        res.json({ report: updated });
        if (reportIo) {
            reportIo.emit('report:moderated', { report: updated });
            if (status === 'ESCALATED') {
                reportIo.emit('report:escalated', { report: updated });
            }
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to moderate report' });
    }
});

// Remove escalation (set status back to PENDING with audit trail)
router.patch('/:id/remove-escalation', authenticate, async (req: Request, res: Response) => {
    try {
        const idParam = req.params.id;
        const reportId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!reportId) return res.status(400).json({ error: 'Invalid report id' });

        const actor = (req as any).user as { userId?: string; role?: string };
        const actorId = actor?.userId;
        const actorRole = actor?.role;
        if (!actorId || !(roleAllowsModeration(actorRole) || roleAllowsResolution(actorRole))) {
            return res.status(403).json({ error: 'Only moderators, inspectors, and admins can remove escalations.' });
        }

        const reasonRaw = typeof (req.body as any)?.reason === 'string' ? String((req.body as any).reason).trim() : '';
        if (reasonRaw.length < 10) {
            return res.status(400).json({ error: 'Reason must be at least 10 characters.' });
        }

        const existing = await prisma.report.findUnique({
            where: { id: reportId },
            select: { id: true, status: true, title: true },
        });
        if (!existing) return res.status(404).json({ error: 'Report not found' });
        if (existing.status !== 'ESCALATED') {
            return res.status(409).json({ error: 'This report is not currently escalated.' });
        }

        if (actorRole === 'MODERATOR') {
            const latestEscalation = await prisma.moderationAudit.findFirst({
                where: { reportId, actionStatus: 'ESCALATED' },
                orderBy: { createdAt: 'desc' },
                select: { actorId: true },
            });
            if (!latestEscalation || latestEscalation.actorId !== actorId) {
                return res.status(403).json({ error: 'Moderators can only remove their own escalations.' });
            }
        }

        const updated = await prisma.$transaction(async (tx) => {
            const report = await tx.report.update({
                where: { id: reportId },
                data: {
                    status: 'PENDING',
                    severity: null,
                    severityConfidence: null,
                },
            });
            await tx.moderationAudit.create({
                data: {
                    reportId,
                    actorId,
                    // Existing schema only supports status-based action enum.
                    // We preserve explicit action intent in the reason payload.
                    actionStatus: 'PENDING',
                    reason: `[ESCALATION_REMOVED] ${reasonRaw}`,
                },
            });
            return report;
        });

        if (reportIo) {
            reportIo.emit('report:moderated', { report: updated });
            reportIo.emit('report:escalation-removed', { report: updated, by: actorId });
        }

        res.json({ report: updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to remove escalation' });
    }
});

export default router;
