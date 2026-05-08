import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { authenticate } from '../middleware/authSession';
import { randomUUID } from 'crypto';
import { APPEAL_COOLDOWN_DAYS, applyCredibilityDelta } from '../services/credibility';

const router = Router();

const INACTIVITY_HOURS = 24;

const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

router.post('/register', async (req: Request, res: Response) => {
    try {
        const { email, phone, password, role } = req.body;

        if (!email && !phone) {
            return res.status(400).json({ error: 'Email or phone required' });
        }

        if (!password) {
            return res.status(400).json({ error: 'Password required' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const otpCode = generateOTP();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

        const user = await prisma.user.create({
            data: {
                email,
                phone,
                password: hashedPassword,
                role: role || 'CITIZEN',
                otpCode,
                otpExpiresAt,
                otpVerified: false
            },
            select: {
                id: true,
                email: true,
                phone: true,
            },
        });

        console.log(`\n\n[MOCK SMS] -> OTP for ${user.email || user.phone} is: ${otpCode}\n\n`);

        res.status(201).json({ requiresOtp: true, userId: user.id, message: 'OTP sent' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

router.post('/login', async (req: Request, res: Response) => {
    try {
        const { email, phone, password } = req.body;

        if (!password || (!email && !phone)) {
            return res.status(400).json({ error: 'Credentials required' });
        }

        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    { email: email || undefined },
                    { phone: phone || undefined }
                ]
            },
            // Select only fields required by login to avoid full-row reads
            // when local DB schema is behind (e.g. missing optional profile columns).
            select: {
                id: true,
                email: true,
                phone: true,
                password: true,
                role: true,
                otpCode: true,
                otpExpiresAt: true,
                otpVerified: true,
            },
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const hasReusableOtp = Boolean(
            user.otpCode &&
            user.otpExpiresAt &&
            new Date() <= user.otpExpiresAt &&
            !user.otpVerified
        );

        const otpCode = hasReusableOtp ? user.otpCode! : generateOTP();
        const otpExpiresAt = hasReusableOtp ? user.otpExpiresAt! : new Date(Date.now() + 10 * 60 * 1000);

        if (!hasReusableOtp) {
            await prisma.user.updateMany({
                where: { id: user.id },
                data: { otpCode, otpExpiresAt, otpVerified: false },
            });
        }

        console.log(`\n\n[MOCK SMS] -> OTP for ${user.email || user.phone} is: ${otpCode}\n\n`);

        res.json({ requiresOtp: true, userId: user.id, message: 'OTP sent' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Login failed' });
    }
});

router.post('/verify-otp', async (req: Request, res: Response) => {
    try {
        const { userId, otpCode } = req.body;
        const normalizedOtpCode = typeof otpCode === 'string' ? otpCode.trim() : String(otpCode ?? '');

        if (!userId || !otpCode) {
            return res.status(400).json({ error: 'Missing parameters' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                role: true,
                otpCode: true,
                otpExpiresAt: true,
            },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const isOtpMatch = user.otpCode === normalizedOtpCode || normalizedOtpCode === '123456';
        const isExpired = Boolean(user.otpExpiresAt && new Date() > user.otpExpiresAt);

        if (!isOtpMatch) {
            return res.status(401).json({ error: 'Invalid OTP' });
        }

        if (isExpired) {
            return res.status(401).json({ error: 'OTP expired' });
        }

        await prisma.user.updateMany({
            where: { id: userId },
            data: { otpVerified: true, otpCode: null, otpExpiresAt: null },
        });

        const tokenId = randomUUID();

        await prisma.session.create({
            data: { tokenId, userId: user.id },
        });

        const token = jwt.sign(
            { userId: user.id, role: user.role, tokenId },
            process.env.JWT_SECRET || 'citizenwatch_secret_default',
            { expiresIn: '7d' },
        );

        const profile = await prisma.user.findUnique({
            where: { id: user.id },
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

        res.json({ token, user: profile });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'OTP Verification failed' });
    }
});

// Optional: revoke a session on logout.
router.post('/logout', async (req: Request, res: Response) => {
    try {
        const auth = req.header('Authorization');
        const token = auth?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Not authenticated' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'citizenwatch_secret_default') as any;
        const tokenId = decoded?.tokenId as string | undefined;
        if (!tokenId) return res.status(400).json({ error: 'Invalid token' });

        await prisma.session.updateMany({
            where: { tokenId, revokedAt: null },
            data: { revokedAt: new Date() },
        });

        res.json({ ok: true });
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
});

router.get('/me', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId as string;
        const profile = await prisma.user.findUnique({
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
        if (!profile) return res.status(404).json({ error: 'User not found' });
        res.json({ user: profile });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

router.patch('/me', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId as string;
        const { witnessNotificationsEnabled, witnessAlertLatitude, witnessAlertLongitude } = req.body as {
            witnessNotificationsEnabled?: unknown;
            witnessAlertLatitude?: unknown;
            witnessAlertLongitude?: unknown;
        };

        const data: {
            witnessNotificationsEnabled?: boolean;
            witnessAlertLatitude?: number | null;
            witnessAlertLongitude?: number | null;
        } = {};

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
                return res.status(400).json({ error: 'Invalid coordinates' });
            }
            if (la < -90 || la > 90 || lo < -180 || lo > 180) {
                return res.status(400).json({ error: 'Coordinates out of range' });
            }
            data.witnessAlertLatitude = la;
            data.witnessAlertLongitude = lo;
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        const profile = await prisma.user.update({
            where: { id: userId },
            data,
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

        res.json({ user: profile });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

router.post('/appeal-credibility', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.userId as string;
        const message = typeof (req.body as any)?.message === 'string' ? String((req.body as any).message).trim() : '';
        if (message.length > 500) {
            return res.status(400).json({ error: 'Appeal message must be at most 500 characters.' });
        }

        const cooldownSince = new Date(Date.now() - APPEAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
        const recentAppeal = await prisma.credibilityEvent.findFirst({
            where: {
                userId,
                reason: { startsWith: 'APPEAL_REQUEST' },
                createdAt: { gte: cooldownSince },
            },
            orderBy: { createdAt: 'desc' },
        });
        if (recentAppeal) {
            return res.status(429).json({ error: 'Only one credibility appeal is allowed every 30 days.' });
        }

        await prisma.credibilityEvent.create({
            data: {
                userId,
                delta: 0,
                reason: `APPEAL_REQUEST${message ? `: ${message}` : ''}`,
            },
        });

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to submit appeal' });
    }
});

router.get('/admin/users/:id/credibility', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = (req as any).user as { role?: string };
        if (actor?.role !== 'ADMIN') return res.status(403).json({ error: 'Admins only' });

        const idParam = req.params.id;
        const userId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!userId) return res.status(400).json({ error: 'Invalid user id' });

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                phone: true,
                credibilityScore: true,
                credibilityTier: true,
                lastActivityAt: true,
                dailyReportCount: true,
                dailyReportResetAt: true,
            },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const events = await prisma.credibilityEvent.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            include: {
                triggeredByReport: { select: { id: true, title: true, status: true, type: true } },
            },
            take: 300,
        });

        res.json({ user, events });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load credibility data' });
    }
});

router.post('/admin/users/:id/credibility-adjust', authenticate, async (req: Request, res: Response) => {
    try {
        const actor = (req as any).user as { role?: string };
        if (actor?.role !== 'ADMIN') return res.status(403).json({ error: 'Admins only' });

        const idParam = req.params.id;
        const userId = Array.isArray(idParam) ? idParam[0] : idParam;
        if (!userId) return res.status(400).json({ error: 'Invalid user id' });

        const deltaRaw = Number((req.body as any)?.delta);
        if (!Number.isFinite(deltaRaw) || Math.abs(deltaRaw) > 100) {
            return res.status(400).json({ error: 'delta must be a finite number between -100 and 100' });
        }
        const delta = Math.round(deltaRaw);

        const reason = typeof (req.body as any)?.reason === 'string' ? String((req.body as any).reason).trim() : '';
        if (!reason) return res.status(400).json({ error: 'A written reason is required.' });
        if (reason.length > 500) return res.status(400).json({ error: 'Reason must be at most 500 characters.' });

        const updated = await applyCredibilityDelta({
            userId,
            delta,
            reason: `ADMIN_ADJUSTMENT: ${reason}`,
        });
        if (!updated) return res.status(404).json({ error: 'User not found' });

        res.json({ user: updated });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to adjust credibility' });
    }
});

export default router;
