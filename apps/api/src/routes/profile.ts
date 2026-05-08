import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { prisma } from '../db';
import { authenticate } from '../middleware/authSession';

const router = Router();

type Role = 'CITIZEN' | 'MODERATOR' | 'LAW_ENFORCEMENT' | 'ADMIN';
type Sex = 'MALE' | 'FEMALE' | 'UNDISCLOSED';

const ALLOWED_PREFS: Record<Role, string[]> = {
    CITIZEN: ['receiveCrimeResolutionNotifications', 'receiveSafeRouteAlerts'],
    MODERATOR: ['receiveNewReportQueueNotifications', 'receiveEscalationAlerts', 'receiveCrimeResolutionNotifications'],
    LAW_ENFORCEMENT: ['receiveCctvMatchAlerts', 'receiveHotspotSpikeAlerts', 'receiveEscalationAlerts'],
    ADMIN: [
        'receiveCrimeResolutionNotifications',
        'receiveSafeRouteAlerts',
        'receiveNewReportQueueNotifications',
        'receiveEscalationAlerts',
        'receiveCctvMatchAlerts',
        'receiveHotspotSpikeAlerts',
    ],
};

const DEFAULT_PREFS: Record<string, boolean> = {
    receiveCrimeResolutionNotifications: true,
    receiveSafeRouteAlerts: true,
    receiveNewReportQueueNotifications: true,
    receiveEscalationAlerts: true,
    receiveCctvMatchAlerts: true,
    receiveHotspotSpikeAlerts: true,
};

const toPrefsForRole = (raw: unknown, role: Role) => {
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const allowed = ALLOWED_PREFS[role] ?? [];
    const out: Record<string, boolean> = {};
    for (const key of allowed) {
        const v = source[key];
        out[key] = typeof v === 'boolean' ? v : DEFAULT_PREFS[key] ?? false;
    }
    return out;
};

const isMissingColumnError = (err: unknown, colIncludes: string) => {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as { code?: string; meta?: { column?: string } };
    return anyErr.code === 'P2022' && String(anyErr.meta?.column || '').includes(colIncludes);
};

const avatarDir = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (_req, file, cb) => {
        const ext = (path.extname(file.originalname) || '').toLowerCase();
        const safeExt = ext === '.png' ? '.png' : '.jpg';
        cb(null, `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}${safeExt}`);
    },
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const mt = (file.mimetype || '').toLowerCase();
        if (mt === 'image/jpeg' || mt === 'image/jpg' || mt === 'image/png') return cb(null, true);
        return cb(new Error('Only JPG or PNG images are allowed.'));
    },
});

router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId as string;
        let profile:
            | {
                  id: string;
                  role: string;
                  email: string | null;
                  phone: string | null;
                  fullName: string | null;
                  age: number | null;
                  sex: string | null;
                  avatarUrl: string | null;
                  notificationPrefs: unknown;
                  witnessNotificationsEnabled: boolean | null;
                  witnessAlertLatitude: number | null;
                  witnessAlertLongitude: number | null;
              }
            | null = null;
        try {
            profile = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    role: true,
                    email: true,
                    phone: true,
                    fullName: true,
                    age: true,
                    sex: true,
                    avatarUrl: true,
                    notificationPrefs: true,
                    witnessNotificationsEnabled: true,
                    witnessAlertLatitude: true,
                    witnessAlertLongitude: true,
                },
            });
        } catch (err) {
            if (!isMissingColumnError(err, 'User.')) throw err;
            const legacy = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    role: true,
                    email: true,
                    phone: true,
                    witnessNotificationsEnabled: true,
                    witnessAlertLatitude: true,
                    witnessAlertLongitude: true,
                },
            });
            profile = legacy
                ? {
                      ...legacy,
                      fullName: null,
                      age: null,
                      sex: null,
                      avatarUrl: null,
                      notificationPrefs: null,
                  }
                : null;
        }
        if (!profile) return res.status(404).json({ error: 'User not found' });
        const role = profile.role as Role;
        res.json({
            profile: {
                ...profile,
                notificationPrefs: toPrefsForRole(profile.notificationPrefs, role),
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

router.patch('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId as string;
        const actorRole = String((req as any).user.role || 'CITIZEN') as Role;
        const { fullName, age, sex, notificationPrefs, witnessNotificationsEnabled, witnessAlertLatitude, witnessAlertLongitude } =
            req.body as {
                fullName?: unknown;
                age?: unknown;
                sex?: unknown;
                notificationPrefs?: unknown;
                witnessNotificationsEnabled?: unknown;
                witnessAlertLatitude?: unknown;
                witnessAlertLongitude?: unknown;
            };

        const data: Record<string, unknown> = {};

        if (fullName !== undefined) {
            const name = String(fullName ?? '').trim();
            if (name.length > 120) return res.status(400).json({ error: 'Full name must be at most 120 characters.' });
            data.fullName = name || null;
        }

        if (age !== undefined) {
            if (age === null || String(age).trim() === '') {
                data.age = null;
            } else {
                const n = Number(age);
                if (!Number.isInteger(n) || n < 0 || n > 120) {
                    return res.status(400).json({ error: 'Age must be an integer between 0 and 120.' });
                }
                data.age = n;
            }
        }

        if (sex !== undefined) {
            const v = String(sex).toUpperCase() as Sex;
            if (!['MALE', 'FEMALE', 'UNDISCLOSED'].includes(v)) {
                return res.status(400).json({ error: 'sex must be MALE, FEMALE, or UNDISCLOSED.' });
            }
            data.sex = v;
        }

        if (typeof notificationPrefs === 'object' && notificationPrefs !== null) {
            try {
                const current = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { notificationPrefs: true, role: true },
                });
                if (!current) return res.status(404).json({ error: 'User not found' });
                const base = {
                    ...(current.notificationPrefs && typeof current.notificationPrefs === 'object'
                        ? (current.notificationPrefs as Record<string, unknown>)
                        : {}),
                };
                for (const key of ALLOWED_PREFS[actorRole] ?? []) {
                    const incoming = (notificationPrefs as Record<string, unknown>)[key];
                    if (typeof incoming === 'boolean') base[key] = incoming;
                }
                data.notificationPrefs = base;
            } catch (err) {
                if (!isMissingColumnError(err, 'User.notificationPrefs')) throw err;
            }
        }

        // Keep existing witness-profile compatibility fields editable for now.
        if (typeof witnessNotificationsEnabled === 'boolean') {
            data.witnessNotificationsEnabled = witnessNotificationsEnabled;
        }
        if (witnessAlertLatitude === null && witnessAlertLongitude === null) {
            data.witnessAlertLatitude = null;
            data.witnessAlertLongitude = null;
        } else if (witnessAlertLatitude !== undefined && witnessAlertLongitude !== undefined) {
            const la = parseFloat(String(witnessAlertLatitude));
            const lo = parseFloat(String(witnessAlertLongitude));
            if ([la, lo].some((n) => Number.isNaN(n))) {
                return res.status(400).json({ error: 'Invalid witness coordinates' });
            }
            if (la < -90 || la > 90 || lo < -180 || lo > 180) {
                return res.status(400).json({ error: 'Witness coordinates out of range' });
            }
            data.witnessAlertLatitude = la;
            data.witnessAlertLongitude = lo;
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        let safeData = { ...data };
        let updated: {
            id: string;
            role: string;
            email: string | null;
            phone: string | null;
            fullName: string | null;
            age: number | null;
            sex: string | null;
            avatarUrl: string | null;
            notificationPrefs: unknown;
            witnessNotificationsEnabled: boolean | null;
            witnessAlertLatitude: number | null;
            witnessAlertLongitude: number | null;
        };
        try {
            updated = await prisma.user.update({
                where: { id: userId },
                data: safeData,
                select: {
                    id: true,
                    role: true,
                    email: true,
                    phone: true,
                    fullName: true,
                    age: true,
                    sex: true,
                    avatarUrl: true,
                    notificationPrefs: true,
                    witnessNotificationsEnabled: true,
                    witnessAlertLatitude: true,
                    witnessAlertLongitude: true,
                },
            });
        } catch (err) {
            if (!isMissingColumnError(err, 'User.')) throw err;
            delete safeData.fullName;
            delete safeData.age;
            delete safeData.sex;
            delete safeData.notificationPrefs;
            if (Object.keys(safeData).length === 0) {
                return res.status(400).json({ error: 'No compatible fields to update for current database schema' });
            }
            const legacyUpdated = await prisma.user.update({
                where: { id: userId },
                data: safeData,
                select: {
                    id: true,
                    role: true,
                    email: true,
                    phone: true,
                    witnessNotificationsEnabled: true,
                    witnessAlertLatitude: true,
                    witnessAlertLongitude: true,
                },
            });
            updated = {
                ...legacyUpdated,
                fullName: null,
                age: null,
                sex: null,
                avatarUrl: null,
                notificationPrefs: null,
            };
        }

        res.json({
            profile: {
                ...updated,
                notificationPrefs: toPrefsForRole(updated.notificationPrefs, updated.role as Role),
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

router.post('/avatar', authenticate, (req: Request, res: Response) => {
    avatarUpload.single('avatar')(req, res, async (err: any) => {
        if (err) {
            const msg = String(err?.message || err || 'Avatar upload failed');
            if (msg.toLowerCase().includes('file too large')) {
                return res.status(400).json({ error: 'Avatar must be 2MB or smaller.' });
            }
            return res.status(400).json({ error: msg });
        }
        try {
            const userId = (req as any).user.userId as string;
            const file = req.file;
            if (!file) return res.status(400).json({ error: 'No avatar file uploaded.' });
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const avatarUrl = `${baseUrl}/uploads/avatars/${file.filename}`;
            const updated = await prisma.user.update({
                where: { id: userId },
                data: { avatarUrl },
                select: { id: true, avatarUrl: true },
            });
            return res.json({ user: updated });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to save avatar' });
        }
    });
});

export default router;
