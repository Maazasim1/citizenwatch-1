import { Router, Request, Response } from 'express';
import { prisma } from '../db';

const router = Router();

type TimeRange = '24h' | '7d' | '30d' | 'all';

const parseTimeRange = (raw: unknown): TimeRange => {
    const v = String(raw ?? '').toLowerCase();
    if (v === '24h') return '24h';
    if (v === '7d' || v === '7day' || v === '7days') return '7d';
    if (v === '30d' || v === '30day' || v === '30days') return '30d';
    return 'all';
};

// Haversine distance in kilometers
const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const toRad = (x: number) => (x * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// Simple DBSCAN-like clustering (radius-based + minimum points).
const clusterPoints = (
    points: Array<{ lat: number; lng: number; severity: number; type: string; title: string }>,
) => {
    // Neighborhood radius used for clustering.
    // Seeded demo points are spread across a few kilometers, so keep this fairly wide for the pilot demo.
    const epsilonKm = 4.0; // ~4km neighborhood
    // minPts=1 so an isolated verified incident still produces a cluster marker (DBSCAN noise otherwise).
    const minPts = 1;

    const visited = new Array(points.length).fill(false);
    const inCluster = new Array(points.length).fill(false);

    const clusters: Array<{
        indices: number[];
        centerLat: number;
        centerLng: number;
        count: number;
        avgSeverity: number;
        maxSeverity: number;
        weightSum: number;
        topTypes: Array<{ type: string; count: number }>;
        sampleReports: string[];
    }> = [];

    const neighborsOf = (i: number) => {
        const p = points[i];
        const out: number[] = [];
        for (let j = 0; j < points.length; j++) {
            if (j === i) continue;
            const q = points[j];
            const d = haversineKm(p.lat, p.lng, q.lat, q.lng);
            if (d <= epsilonKm) out.push(j);
        }
        return out;
    };

    const getClusterStats = (indices: number[]) => {
        let weightSum = 0;
        let latSum = 0;
        let lngSum = 0;
        let maxSeverity = 0;
        const typeCounts = new Map<string, number>();
        const sampleReports: string[] = [];

        for (const idx of indices) {
            const p = points[idx];
            const w = p.severity;
            weightSum += w;
            latSum += p.lat * w;
            lngSum += p.lng * w;
            maxSeverity = Math.max(maxSeverity, p.severity);
            typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
            if (sampleReports.length < 3) sampleReports.push(p.title);
        }

        const count = indices.length;
        const centerLat = weightSum > 0 ? latSum / weightSum : points[indices[0]].lat;
        const centerLng = weightSum > 0 ? lngSum / weightSum : points[indices[0]].lng;
        const avgSeverity = count > 0 ? weightSum / count : 0;

        const topTypes = Array.from(typeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([type, count]) => ({ type, count }));

        return { centerLat, centerLng, count, avgSeverity, maxSeverity, weightSum, topTypes, sampleReports };
    };

    for (let i = 0; i < points.length; i++) {
        if (visited[i]) continue;
        visited[i] = true;

        const seedNeighbors = neighborsOf(i);
        if (seedNeighbors.length + 1 < minPts) continue; // noise

        // Create new cluster; expand like DBSCAN.
        const clusterIdxs = new Set<number>([i]);
        const toProcess: number[] = [...seedNeighbors];

        for (const n of toProcess) {
            if (!visited[n]) {
                visited[n] = true;
                const nbrs = neighborsOf(n);
                if (nbrs.length + 1 >= minPts) {
                    for (const x of nbrs) clusterIdxs.add(x);
                }
            }
            inCluster[n] = true;
            clusterIdxs.add(n);
        }

        const indices = Array.from(clusterIdxs);
        for (const idx of indices) inCluster[idx] = true;

        clusters.push({
            indices,
            ...getClusterStats(indices),
        });
    }

    // Sort by “heat” so the most relevant clusters show first.
    clusters.sort((a, b) => b.weightSum - a.weightSum);
    return clusters;
};

router.get('/', async (req: Request, res: Response) => {
    try {
        const timeRange = parseTimeRange(req.query.timeRange);
        const type = req.query.type ? String(req.query.type) : undefined;
        const incRaw = String(req.query.includeResolved ?? '').toLowerCase();
        const includeResolved = incRaw === '1' || incRaw === 'true' || incRaw === 'yes';
        const resolvedOnlyRaw = String(req.query.resolvedOnly ?? '').toLowerCase();
        const resolvedOnly =
            resolvedOnlyRaw === '1' || resolvedOnlyRaw === 'true' || resolvedOnlyRaw === 'yes';

        const now = new Date();
        let from: Date | undefined;
        if (timeRange === '24h') from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        if (timeRange === '7d') from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (timeRange === '30d') from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const verifiedReports = await prisma.report.findMany({
            where: {
                status: 'VERIFIED',
                ...(resolvedOnly ? { isResolved: true } : includeResolved ? {} : { isResolved: false }),
                ...(from ? { createdAt: { gte: from } } : {}),
                ...(type ? { type } : {}),
                severity: { not: null },
            },
            select: {
                id: true,
                latitude: true,
                longitude: true,
                severity: true,
                type: true,
                title: true,
            },
        });

        const points = verifiedReports
            .filter((r) => r.severity !== null)
            .map((r) => ({
                lat: r.latitude,
                lng: r.longitude,
                severity: r.severity as number,
                type: r.type,
                title: r.title,
            }));

        const clusters = clusterPoints(points).map((c) => ({
            center: { latitude: c.centerLat, longitude: c.centerLng },
            count: c.count,
            avgSeverity: c.avgSeverity,
            maxSeverity: c.maxSeverity,
            weight: c.weightSum,
            topTypes: c.topTypes,
            sampleReports: c.sampleReports,
        }));

        res.json({
            clusters,
            generatedAt: now.toISOString(),
            filters: { timeRange, type: type ?? null, includeResolved, resolvedOnly },
            points: points.length,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to compute hotspots' });
    }
});

export default router;

