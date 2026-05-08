import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';

/** JWT + session inactivity (24h), updates lastActivityAt. */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'citizenwatch_secret_default') as any;
        const tokenId = decoded?.tokenId as string | undefined;
        if (!tokenId) return res.status(401).json({ error: 'Invalid token session' });

        const now = new Date();
        const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const session = await prisma.session.findUnique({
            where: { tokenId },
            select: { lastActivityAt: true, revokedAt: true },
        });

        if (!session || session.revokedAt) {
            return res.status(401).json({ error: 'Session revoked' });
        }
        if (session.lastActivityAt < cutoff) {
            return res.status(401).json({ error: 'Session expired due to inactivity' });
        }

        await prisma.session.update({
            where: { tokenId },
            data: { lastActivityAt: now },
        });

        (req as any).user = decoded;
        return next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};
