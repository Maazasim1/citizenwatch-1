import type { CredibilityTier } from '@prisma/client';
import { prisma } from '../db';

const MAX_SCORE = 100;
const MIN_SCORE = 0;
const INACTIVITY_FLOOR = 30;

export const DAILY_REPORT_LIMIT_RESTRICTED = 2;
export const APPEAL_COOLDOWN_DAYS = 30;

export const isSeniorModeratorRole = (role: unknown) => role === 'ADMIN';

export const clampCredibility = (score: number) =>
    Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));

export const tierForScore = (score: number): CredibilityTier => {
    if (score >= 75) return 'TRUSTED';
    if (score >= 40) return 'STANDARD';
    if (score >= 20) return 'FLAGGED';
    return 'RESTRICTED';
};

export const duplicateRadiusForTierMeters = (tier: CredibilityTier | null | undefined) => {
    if (tier === 'TRUSTED') return 100;
    return 200;
};

export const startOfUtcDay = (d = new Date()) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));

export const nextUtcDay = (d = new Date()) => new Date(startOfUtcDay(d).getTime() + 24 * 60 * 60 * 1000);

export async function applyCredibilityDelta(params: {
    userId: string;
    delta: number;
    reason: string;
    triggeredByReportId?: string | null;
    floor?: number;
}) {
    const { userId, delta, reason, triggeredByReportId = null, floor = MIN_SCORE } = params;
    return prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
            where: { id: userId },
            select: { credibilityScore: true },
        });
        if (!user) return null;
        const boundedFloor = Math.max(MIN_SCORE, Math.min(MAX_SCORE, floor));
        const nextScore = Math.max(boundedFloor, clampCredibility(user.credibilityScore + delta));
        const nextTier = tierForScore(nextScore);

        const updated = await tx.user.update({
            where: { id: userId },
            data: {
                credibilityScore: nextScore,
                credibilityTier: nextTier,
                lastActivityAt: new Date(),
            },
            select: { id: true, credibilityScore: true, credibilityTier: true },
        });

        await tx.credibilityEvent.create({
            data: {
                userId,
                delta,
                reason,
                triggeredByReportId,
            },
        });

        return updated;
    });
}

/** Weekly inactivity penalty after 30d inactivity: -1/week, floor 30. */
export async function runCredibilityInactivityDecay() {
    const now = new Date();
    const inactiveCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const users = await prisma.user.findMany({
        where: {
            role: { not: 'ADMIN' },
            lastActivityAt: { not: null, lt: inactiveCutoff },
            credibilityScore: { gt: INACTIVITY_FLOOR },
        },
        select: { id: true, credibilityScore: true, lastActivityAt: true },
    });

    let affected = 0;
    for (const u of users) {
        const inactiveDays = Math.floor((now.getTime() - u.lastActivityAt!.getTime()) / (24 * 60 * 60 * 1000));
        const weeksBeyond30 = Math.floor((inactiveDays - 30) / 7);
        if (weeksBeyond30 <= 0) continue;

        const priorInactivityEvents = await prisma.credibilityEvent.count({
            where: {
                userId: u.id,
                reason: { startsWith: 'INACTIVITY_DECAY' },
            },
        });
        const pendingPenalty = weeksBeyond30 - priorInactivityEvents;
        if (pendingPenalty <= 0) continue;

        const delta = -pendingPenalty;
        await applyCredibilityDelta({
            userId: u.id,
            delta,
            reason: `INACTIVITY_DECAY:${pendingPenalty}w`,
            floor: INACTIVITY_FLOOR,
        });
        affected++;
    }

    if (affected > 0) {
        console.log(`[credibility] inactivity decay updated ${affected} user(s)`);
    }
}

