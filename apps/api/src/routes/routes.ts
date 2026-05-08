import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import jwt from 'jsonwebtoken';

const router = Router();

type LatLng = { latitude: number; longitude: number };
type RiskPoint = { lat: number; lng: number; severity: number };

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

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const baseSeverityByType: Record<string, number> = {
    ARMED_ROBBERY: 9,
    VEHICLE_CRIME: 6,
    VANDALISM: 3,
    ASSAULT: 8,
    THEFT: 5,
    OTHER: 4,
};

const riskAt = (lat: number, lng: number, points: RiskPoint[]) => {
    // Smooth risk field from nearby verified points.
    // sigma ~ neighborhood radius; smaller -> more localized.
    const sigmaKm = 1.1;
    const denom = 2 * sigmaKm * sigmaKm;

    let risk = 0;
    for (const p of points) {
        const dKm = haversineKm(lat, lng, p.lat, p.lng);
        const w = Math.exp(-(dKm * dKm) / denom);
        risk += p.severity * w;
    }

    return risk; // unnormalized, used as additive cost term
};

const sampleRiskAlongSegment = (a: LatLng, b: LatLng, points: RiskPoint[], samples = 8) => {
    let sum = 0;
    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const lat = a.latitude + (b.latitude - a.latitude) * t;
        const lng = a.longitude + (b.longitude - a.longitude) * t;
        sum += riskAt(lat, lng, points);
    }
    return sum / (samples + 1);
};

// Simple greedy clustering to generate a small set of “risk waypoints” for A*.
// We cluster by epsilonKm using distance between points.
const clusterRiskWaypoints = (
    points: RiskPoint[],
    epsilonKm: number,
    maxCenters: number,
) => {
    const remaining = [...points];
    const centers: Array<{ latitude: number; longitude: number; severity: number; weight: number }> = [];

    while (remaining.length > 0 && centers.length < maxCenters) {
        const seed = remaining.pop()!;
        const cluster: typeof remaining = [seed];

        // Expand by grabbing points close to the seed (pilot heuristic).
        for (let i = remaining.length - 1; i >= 0; i--) {
            const p = remaining[i];
            const d = haversineKm(seed.lat, seed.lng, p.lat, p.lng);
            if (d <= epsilonKm) {
                cluster.push(p);
                remaining.splice(i, 1);
            }
        }

        // Weighted center by severity so “hotter” areas dominate.
        const weightSum = cluster.reduce((s, p) => s + p.severity, 0) || 1;
        const latitude = cluster.reduce((s, p) => s + p.lat * p.severity, 0) / weightSum;
        const longitude = cluster.reduce((s, p) => s + p.lng * p.severity, 0) / weightSum;
        const severity = cluster.reduce((s, p) => s + p.severity, 0) / cluster.length;
        const weight = cluster.reduce((s, p) => s + p.severity, 0);

        centers.push({ latitude, longitude, severity, weight });
    }

    // Sort by weight so the graph includes the most relevant risk areas first.
    centers.sort((a, b) => b.weight - a.weight);
    return centers.slice(0, maxCenters);
};

const reconstructPath = (cameFrom: Map<string, string>, currentKey: string) => {
    const path: string[] = [currentKey];
    while (cameFrom.has(currentKey)) {
        const prev = cameFrom.get(currentKey)!;
        path.push(prev);
        currentKey = prev;
    }
    return path.reverse();
};

type OsrmLeg = {
    distanceKm: number;
    geometry: LatLng[];
};

const osrmLegCache = new Map<string, OsrmLeg | null>();

const osrmLegKey = (a: LatLng, b: LatLng) => {
    // Round to reduce cache fragmentation from float noise.
    const ra = `${a.latitude.toFixed(5)},${a.longitude.toFixed(5)}`;
    const rb = `${b.latitude.toFixed(5)},${b.longitude.toFixed(5)}`;
    return `${ra}|${rb}`;
};

const fetchOsrmLeg = async (a: LatLng, b: LatLng): Promise<OsrmLeg | null> => {
    const key = osrmLegKey(a, b);
    if (osrmLegCache.has(key)) return osrmLegCache.get(key)!;

    // OSRM public demo service. If it fails (no network / rate limits), we fallback to straight segments.
    const baseUrl = 'https://router.project-osrm.org/route/v1/driving';
    // OSRM demo server supports `overview` + `geometries` but not `steps=false` (varies by build).
    const url = `${baseUrl}/${a.longitude},${a.latitude};${b.longitude},${b.latitude}?overview=full&geometries=geojson`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);

    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
        const data = (await resp.json()) as any;
        const routeDbg = process.env.ROUTE_DEBUG;
        if (routeDbg === '1' || routeDbg === 'full') {
            const rt0 = data?.routes?.[0];
            const n = rt0?.geometry?.coordinates?.length;
            console.log('[OSRM]', { ok: resp.ok, code: data?.code, routes: data?.routes?.length, distance_m: rt0?.distance, nCoords: n });
            if (routeDbg === 'full' && rt0?.geometry?.coordinates) {
                console.log('[OSRM full] keys', Object.keys(data || {}), 'route0 keys', rt0 && Object.keys(rt0));
            }
        }
        const route = data?.routes?.[0];
        if (!route?.geometry?.coordinates || !Array.isArray(route.geometry.coordinates)) {
            osrmLegCache.set(key, null);
            return null;
        }

        const geometry: LatLng[] = route.geometry.coordinates.map((c: [number, number]) => ({
            latitude: c[1],
            longitude: c[0],
        }));

        const distanceKm = typeof route.distance === 'number' ? route.distance / 1000 : 0;
        const leg: OsrmLeg = { distanceKm, geometry };
        osrmLegCache.set(key, leg);
        return leg;
    } catch {
        osrmLegCache.set(key, null);
        return null;
    } finally {
        clearTimeout(t);
    }
};

const placeLabelCache = new Map<string, string>();

const reverseGeocodePlaceLabel = async (lat: number, lng: number): Promise<string> => {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = placeLabelCache.get(key);
    if (cached) return cached;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=0`;
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'citizenwatch-demo/1.0',
                'Accept-Language': 'en',
            },
        });

        if (!resp.ok) throw new Error(`nominatim ${resp.status}`);
        const data = (await resp.json()) as any;
        const displayName = String(data?.display_name ?? '').trim();
        // Keep it short-ish for the demo.
        const parts = displayName ? displayName.split(',').map((p) => p.trim()).filter(Boolean) : [];
        const label = parts.slice(0, 3).join(', ') || displayName || `Hotspot (${lat.toFixed(3)}, ${lng.toFixed(3)})`;

        placeLabelCache.set(key, label);
        return label;
    } catch {
        const fallback = `Hotspot (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
        placeLabelCache.set(key, fallback);
        return fallback;
    } finally {
        clearTimeout(timeout);
    }
};

const exposureForSegments = (segments: Array<{ start: LatLng; end: LatLng; risk: number }>, center: LatLng) => {
    // Exposure = weighted sum of segment risks, decayed by distance to the segment midpoint.
    const sigmaKm = 2.0;
    const denom = 2 * sigmaKm * sigmaKm;
    let sum = 0;
    for (const seg of segments) {
        const midLat = (seg.start.latitude + seg.end.latitude) / 2;
        const midLng = (seg.start.longitude + seg.end.longitude) / 2;
        const dKm = haversineKm(midLat, midLng, center.latitude, center.longitude);
        const w = Math.exp(-(dKm * dKm) / denom);
        sum += seg.risk * w;
    }
    return sum;
};

const buildRoadRouteFromNodePath = async (
    nodePath: LatLng[],
    points: RiskPoint[],
    maxSegments = 40,
) => {
    let totalDistanceKm = 0;
    const combinedPath: LatLng[] = [];
    const combinedSegments: Array<{ start: LatLng; end: LatLng; risk: number }> = [];

    for (let i = 0; i < nodePath.length - 1; i++) {
        const a = nodePath[i];
        const b = nodePath[i + 1];

        const leg = await fetchOsrmLeg(a, b);
        const geometry = leg?.geometry ?? [a, b];
        const distanceKm = leg?.distanceKm ?? haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);

        totalDistanceKm += distanceKm;

        // Downsample polyline so we don't render hundreds of segments on the demo UI.
        if (geometry.length >= 2) {
            const segCount = Math.min(maxSegments, Math.max(1, geometry.length - 1));
            const step = Math.max(1, Math.floor((geometry.length - 1) / segCount));

            const sampled: LatLng[] = [];
            for (let idx = 0; idx < geometry.length; idx += step) sampled.push(geometry[idx]);
            if (sampled.length < 2 || sampled[sampled.length - 1] !== geometry[geometry.length - 1]) {
                sampled.push(geometry[geometry.length - 1]);
            }

            // Stitch into combined path, removing duplicate join points.
            for (let pIdx = 0; pIdx < sampled.length; pIdx++) {
                const pt = sampled[pIdx];
                const last = combinedPath[combinedPath.length - 1];
                if (pIdx === 0 && last && Math.abs(last.latitude - pt.latitude) < 1e-9 && Math.abs(last.longitude - pt.longitude) < 1e-9) {
                    continue;
                }
                combinedPath.push(pt);
            }

            for (let sIdx = 0; sIdx < sampled.length - 1; sIdx++) {
                const sStart = sampled[sIdx];
                const sEnd = sampled[sIdx + 1];
                const segRisk = points.length > 0 ? sampleRiskAlongSegment(sStart, sEnd, points, 6) : 0;
                combinedSegments.push({ start: sStart, end: sEnd, risk: segRisk });
            }
        }
    }

    const riskAvg =
        combinedSegments.length > 0 ? combinedSegments.reduce((sum, s) => sum + s.risk, 0) / combinedSegments.length : 0;

    return {
        path: combinedPath.length >= 2 ? combinedPath : nodePath,
        segments: combinedSegments,
        distanceKm: totalDistanceKm,
        riskAvg,
    };
};

const buildDetourCandidates = (start: LatLng, end: LatLng): LatLng[] => {
    // Generate synthetic midpoint detours on both sides of the direct corridor.
    const midLat = (start.latitude + end.latitude) / 2;
    const midLng = (start.longitude + end.longitude) / 2;
    const dx = end.longitude - start.longitude;
    const dy = end.latitude - start.latitude;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // perpendicular unit vector (lng space)
    const ny = dx / len; // perpendicular unit vector (lat space)

    const kmToLat = (km: number) => km / 111;
    const kmToLng = (km: number, atLat: number) =>
        km / (111 * Math.max(0.2, Math.cos((atLat * Math.PI) / 180)));

    const offsetsKm = [1.2, 2.2, 3.0];
    const candidates: LatLng[] = [];
    for (const km of offsetsKm) {
        const latOffset = ny * kmToLat(km);
        const lngOffset = nx * kmToLng(km, midLat);
        candidates.push(
            { latitude: midLat + latOffset, longitude: midLng + lngOffset },
            { latitude: midLat - latOffset, longitude: midLng - lngOffset },
        );
    }
    return candidates;
};

const keyFor = (i: number, j: number) => `${i},${j}`;

const decodeKey = (k: string) => {
    const [i, j] = k.split(',').map((x) => Number(x));
    return { i, j };
};

const resolveAuthRole = async (req: Request): Promise<string | null> => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'citizenwatch_secret_default') as any;
        const tokenId = decoded?.tokenId as string | undefined;
        if (!tokenId) return null;
        const session = await prisma.session.findUnique({
            where: { tokenId },
            select: { revokedAt: true, lastActivityAt: true },
        });
        if (!session || session.revokedAt) return null;
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (session.lastActivityAt < cutoff) return null;
        return String(decoded?.role ?? '');
    } catch {
        return null;
    }
};

router.post('/compute', async (req: Request, res: Response) => {
    try {
        const role = await resolveAuthRole(req);
        if (role === 'MODERATOR' || role === 'LAW_ENFORCEMENT') {
            return res.status(403).json({ error: 'This feature is for citizens only.' });
        }
        const { start, end } = req.body as { start: LatLng; end: LatLng };
        if (!start || !end) return res.status(400).json({ error: 'Missing start/end' });

        const startLat = Number(start.latitude);
        const startLng = Number(start.longitude);
        const endLat = Number(end.latitude);
        const endLng = Number(end.longitude);
        if ([startLat, startLng, endLat, endLng].some((n) => Number.isNaN(n))) {
            return res.status(400).json({ error: 'Invalid coordinates' });
        }
        const inLatRange = (lat: number) => lat >= -90 && lat <= 90;
        const inLngRange = (lng: number) => lng >= -180 && lng <= 180;
        if (!inLatRange(startLat) || !inLatRange(endLat) || !inLngRange(startLng) || !inLngRange(endLng)) {
            return res.status(400).json({ error: 'Coordinates out of range' });
        }

        // Expand search area by margin degrees so waypoints cover possible detours.
        const lineDistKm = haversineKm(startLat, startLng, endLat, endLng);
        const margin = clamp(0.01 + lineDistKm * 0.002, 0.02, 0.06);

        const minLat = Math.min(startLat, endLat) - margin;
        const maxLat = Math.max(startLat, endLat) + margin;
        const minLng = Math.min(startLng, endLng) - margin;
        const maxLng = Math.max(startLng, endLng) + margin;

        // Routing risk should come from verified incidents only.
        const routeRiskReports = await prisma.report.findMany({
            where: {
                status: 'VERIFIED',
                latitude: { gte: minLat, lte: maxLat },
                longitude: { gte: minLng, lte: maxLng },
                isResolved: false,
            },
            select: {
                latitude: true,
                longitude: true,
                severity: true,
                type: true,
                status: true,
            },
            take: 180,
        });

        const points: RiskPoint[] = routeRiskReports.map((p) => {
            const base = p.severity ?? baseSeverityByType[p.type] ?? 4;
            const weightedSeverity = clamp(base, 0, 10);
            return { lat: p.latitude, lng: p.longitude, severity: weightedSeverity };
        });

        // Build risk waypoints (cluster centers) to create a sparse graph for A*.
        const waypointCenters = clusterRiskWaypoints(points, 1.6, 22);

        type Node = { id: string; p: LatLng };
        const nodes: Node[] = [
            { id: 'start', p: { latitude: startLat, longitude: startLng } },
            { id: 'end', p: { latitude: endLat, longitude: endLng } },
            ...waypointCenters.map((c, idx) => ({ id: `w${idx}`, p: { latitude: c.latitude, longitude: c.longitude } })),
        ];

        const directRiskAvg = points.length ? sampleRiskAlongSegment(start, end, points, 10) : 0;

        // Only force detours if a simple 2-hop via at least one waypoint center improves risk.
        // This avoids a negative "safe vs shortest" comparison in the pilot UI.
        const waypointNodes = nodes.filter((n) => n.id !== 'start' && n.id !== 'end');
        let bestTwoHopRiskAvg = Infinity;
        let bestTwoHopNode: Node | null = null;
        for (const w of waypointNodes) {
            if (points.length === 0) break;
            const r1 = sampleRiskAlongSegment(start, w.p, points, 8);
            const r2 = sampleRiskAlongSegment(w.p, end, points, 8);
            const avg = (r1 + r2) / 2;
            if (avg < bestTwoHopRiskAvg) {
                bestTwoHopRiskAvg = avg;
                bestTwoHopNode = w;
            }
        }

        // Precompute neighbors: k-nearest within threshold distance.
        const k = 8;
        const maxEdgeKm = 20;
        const neighbors = new Map<string, string[]>();
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            const dists = nodes
                .map((b) => ({ id: b.id, d: haversineKm(a.p.latitude, a.p.longitude, b.p.latitude, b.p.longitude) }))
                .filter((x) => x.id !== a.id && x.d <= maxEdgeKm)
                .sort((x, y) => x.d - y.d)
                .slice(0, k);
            neighbors.set(a.id, dists.map((x) => x.id));
        }

        // k-NN + maxEdgeKm can omit start↔end on long trips; A* would return null without this edge.
        const ensureUndirectedEdge = (aId: string, bId: string) => {
            const aList = neighbors.get(aId);
            const bList = neighbors.get(bId);
            if (!aList || !bList) return;
            if (!aList.includes(bId)) neighbors.set(aId, [...aList, bId]);
            if (!bList.includes(aId)) neighbors.set(bId, [...bList, aId]);
        };
        ensureUndirectedEdge('start', 'end');

        const reconstruct = (cameFrom: Map<string, string>, current: string) => {
            const out: string[] = [current];
            while (cameFrom.has(current)) {
                const prev = cameFrom.get(current)!;
                out.push(prev);
                current = prev;
            }
            out.reverse();
            return out;
        };

        const nodeById = new Map(nodes.map((n) => [n.id, n]));

        const runAStar = (riskWeight: number, disableDirectEdge: boolean) => {
            const startId = 'start';
            const endId = 'end';

            const open = new Set<string>([startId]);
            const cameFrom = new Map<string, string>();
            const gScore = new Map<string, number>([[startId, 0]]);
            const fScore = new Map<string, number>([[startId, haversineKm(startLat, startLng, endLat, endLng)]]);

            const heuristic = (id: string) => {
                const n = nodeById.get(id)!;
                return haversineKm(n.p.latitude, n.p.longitude, endLat, endLng);
            };

            const edgeCost = (fromId: string, toId: string) => {
                const a = nodeById.get(fromId)!.p;
                const b = nodeById.get(toId)!.p;
                const dist = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);

                if (riskWeight <= 0 || points.length === 0) return dist;

                // Risk-integrated along the edge (sampled).
                const avgRisk = sampleRiskAlongSegment(a, b, points, 6);
                // Stronger risk penalty so the safe route prefers lower-risk detours.
                const riskCost = riskWeight * avgRisk;
                // Make risk dominate distance so the planner aligns with our "riskAvg" metric.
                return dist * (1 + riskCost / 1.8);
            };

            while (open.size > 0) {
                // Pick node with lowest fScore.
                let current: string | null = null;
                let bestF = Infinity;
                for (const id of open) {
                    const f = fScore.get(id) ?? Infinity;
                    if (f < bestF) {
                        bestF = f;
                        current = id;
                    }
                }

                if (!current) break;
                if (current === endId) {
                    const keys = reconstruct(cameFrom, current);
                    const path = keys.map((id) => nodeById.get(id)!.p);

                    const segments: Array<{ start: LatLng; end: LatLng; risk: number }> = [];
                    let totalDistanceKm = 0;
                    let riskSum = 0;

                    for (let i = 0; i < path.length - 1; i++) {
                        const a = path[i];
                        const b = path[i + 1];
                        const dist = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
                        // Keep risk sampling aligned with edge cost sampling so metrics match.
                        const segRisk = points.length > 0 ? sampleRiskAlongSegment(a, b, points, 6) : 0;
                        segments.push({ start: a, end: b, risk: segRisk });
                        totalDistanceKm += dist;
                        riskSum += segRisk;
                    }

                    const avgRisk = segments.length > 0 ? riskSum / segments.length : 0;
                    return { path, segments, distanceKm: totalDistanceKm, riskAvg: avgRisk };
                }

                open.delete(current);
                const neigh = neighbors.get(current) ?? [];

                for (const nb of neigh) {
                    // If the straight shot is risky, force detours so the safe route is meaningful.
                    if (disableDirectEdge && current === startId && nb === endId) continue;

                    const tentativeG = (gScore.get(current) ?? Infinity) + edgeCost(current, nb);
                    if (tentativeG < (gScore.get(nb) ?? Infinity)) {
                        cameFrom.set(nb, current);
                        gScore.set(nb, tentativeG);
                        fScore.set(nb, tentativeG + heuristic(nb));
                        open.add(nb);
                    }
                }
            }

            return null;
        };

        // “Shortest path” = distance-only A* on the waypoint graph.
        const shortestAStar = runAStar(0, false);
        const shortest = shortestAStar ?? {
            path: [start, end],
            segments: [{ start, end, risk: points.length ? sampleRiskAlongSegment(start, end, points, 6) : 0 }],
            distanceKm: haversineKm(startLat, startLng, endLat, endLng),
            riskAvg: points.length ? sampleRiskAlongSegment(start, end, points, 6) : 0,
        };

        // “Safe route” = risk-aware A*.
        const riskWeight = 6.5;
        const safeDisableDirectEdge = riskWeight > 0 && bestTwoHopRiskAvg < directRiskAvg;
        let safeAStar = runAStar(riskWeight, safeDisableDirectEdge);
        if (!safeAStar && safeDisableDirectEdge) {
            safeAStar = runAStar(riskWeight, false);
        }
        const safe = safeAStar ?? {
            path: [start, end],
            segments: [{ start, end, risk: points.length ? sampleRiskAlongSegment(start, end, points, 6) : 0 }],
            distanceKm: haversineKm(startLat, startLng, endLat, endLng),
            riskAvg: points.length ? sampleRiskAlongSegment(start, end, points, 6) : 0,
        };

        if (process.env.ROUTE_DEBUG === '1') {
            console.log('[route A*]', {
                nodes: nodes.length,
                shortestAStar: !!shortestAStar,
                safeAStar: !!safeAStar,
                safeDisableDirectEdge,
                shortestPathLen: shortest.path.length,
                safePathLen: safe.path.length,
                shortestRiskAvg: shortest.riskAvg,
                safeRiskAvg: safe.riskAvg,
            });
        }

        // Pilot fallback: ensure "safe" is not risk-worse than "shortest".
        // If A* ends up with higher risk than the distance-only planner,
        // use the best 2-hop waypoint detour (risk metric) instead.
        let safeRoute = safe;
        let safeFallbackUsed = false;
        if (safe.riskAvg > shortest.riskAvg && bestTwoHopNode) {
            const seg1Risk = points.length ? sampleRiskAlongSegment(start, bestTwoHopNode.p, points, 6) : 0;
            const seg2Risk = points.length ? sampleRiskAlongSegment(bestTwoHopNode.p, end, points, 6) : 0;
            const dist1 = haversineKm(startLat, startLng, bestTwoHopNode.p.latitude, bestTwoHopNode.p.longitude);
            const dist2 = haversineKm(bestTwoHopNode.p.latitude, bestTwoHopNode.p.longitude, endLat, endLng);

            safeRoute = {
                path: [start, bestTwoHopNode.p, end],
                segments: [
                    { start, end: bestTwoHopNode.p, risk: seg1Risk },
                    { start: bestTwoHopNode.p, end, risk: seg2Risk },
                ],
                distanceKm: dist1 + dist2,
                riskAvg: (seg1Risk + seg2Risk) / 2,
            };
            safeFallbackUsed = true;
        }

        // Upgrade the output path to follow real roads using OSRM between consecutive nodes.
        // This makes the UI feel like "real directions" instead of a straight-line pilot.
        const shortestRoad = await buildRoadRouteFromNodePath(shortest.path, points, 35);
        let safeRoad = await buildRoadRouteFromNodePath(safeRoute.path, points, 35);

        let safeFallbackUsedRoad = safeFallbackUsed;
        if (safeRoad.riskAvg > shortestRoad.riskAvg && bestTwoHopNode) {
            safeRoad = await buildRoadRouteFromNodePath([start, bestTwoHopNode.p, end], points, 35);
            safeFallbackUsedRoad = true;
        }

        // If safe and shortest are still effectively identical, attempt synthetic detours.
        const pathsEffectivelySame =
            shortestRoad.path.length === safeRoad.path.length &&
            shortestRoad.path.every((p, idx) => {
                const s = safeRoad.path[idx];
                return (
                    !!s &&
                    Math.abs(p.latitude - s.latitude) < 1e-5 &&
                    Math.abs(p.longitude - s.longitude) < 1e-5
                );
            });
        const noMeaningfulRiskGain = safeRoad.riskAvg >= shortestRoad.riskAvg - 0.01;

        if (points.length > 0 && (pathsEffectivelySame || noMeaningfulRiskGain)) {
            const detours = buildDetourCandidates(start, end);
            let bestDetour: typeof safeRoad | null = null;

            for (const waypoint of detours) {
                const candidate = await buildRoadRouteFromNodePath([start, waypoint, end], points, 35);
                if (candidate.path.length < 3) continue;
                // Keep realistic alternatives for UX: avoid extreme detours.
                if (candidate.distanceKm > shortestRoad.distanceKm * 1.9) continue;
                if (!bestDetour) {
                    bestDetour = candidate;
                    continue;
                }
                if (
                    candidate.riskAvg < bestDetour.riskAvg - 0.01 ||
                    (Math.abs(candidate.riskAvg - bestDetour.riskAvg) <= 0.01 &&
                        candidate.distanceKm < bestDetour.distanceKm)
                ) {
                    bestDetour = candidate;
                }
            }

            if (bestDetour && bestDetour.riskAvg < shortestRoad.riskAvg - 0.01) {
                safeRoad = bestDetour;
                safeFallbackUsedRoad = true;
            }
        }

        const riskReductionPct =
            shortestRoad.riskAvg > 0
                ? clamp(((shortestRoad.riskAvg - safeRoad.riskAvg) / shortestRoad.riskAvg) * 100, -100, 100)
                : 0;

        if (process.env.ROUTE_DEBUG === '1') {
            console.log('[route roads]', {
                shortestRoadKm: shortestRoad.distanceKm,
                safeRoadKm: safeRoad.distanceKm,
                shortestRoadRisk: shortestRoad.riskAvg,
                safeRoadRisk: safeRoad.riskAvg,
                shortestPathPts: shortestRoad.path.length,
                safePathPts: safeRoad.path.length,
                nSegmentsShortest: shortestRoad.segments.length,
                nSegmentsSafe: safeRoad.segments.length,
                riskReductionPct,
            });
        }

        // Danger-zone analysis + segment place labeling.
        // We treat the top risk waypoint centers as candidate "places" and compute exposure reduction.
        const placeCenters = waypointCenters.slice(0, 8);
        const labeledCenters = await Promise.all(
            placeCenters.map(async (c, idx) => {
                const label = await reverseGeocodePlaceLabel(c.latitude, c.longitude);
                return { ...c, label, idx };
            }),
        );

        const avoidedPlacesRaw = labeledCenters
            .map((c) => {
                const center = { latitude: c.latitude, longitude: c.longitude };
                const shortExp = exposureForSegments(shortestRoad.segments, center);
                const safeExp = exposureForSegments(safeRoad.segments, center);
                const diff = shortExp - safeExp;
                return { label: c.label, diff, shortExp, safeExp, center };
            })
            .sort((a, b) => b.diff - a.diff);

        const avoidedPlaces = avoidedPlacesRaw.slice(0, 5).map((x) => ({ label: x.label, diff: x.diff }));

        const annotateSegmentsWithPlaces = (
            segments: Array<{ start: LatLng; end: LatLng; risk: number }>,
        ) => {
            const sigmaKm = 3.0;
            const denom = 2 * sigmaKm * sigmaKm;
            return segments.map((s) => {
                const mid = { latitude: (s.start.latitude + s.end.latitude) / 2, longitude: (s.start.longitude + s.end.longitude) / 2 };
                let best = labeledCenters[0];
                let bestScore = -Infinity;
                for (const c of labeledCenters) {
                    const dKm = haversineKm(mid.latitude, mid.longitude, c.latitude, c.longitude);
                    const score = Math.exp(-(dKm * dKm) / denom);
                    if (score > bestScore) {
                        bestScore = score;
                        best = c;
                    }
                }
                const placeLabel = bestScore > 0.15 ? best.label : undefined;
                return { ...s, placeLabel };
            });
        };

        const safeSegmentsWithPlaces = annotateSegmentsWithPlaces(safeRoad.segments);
        const shortestSegmentsWithPlaces = annotateSegmentsWithPlaces(shortestRoad.segments);

        return res.json({
            shortest: {
                distanceKm: shortestRoad.distanceKm,
                riskAvg: shortestRoad.riskAvg,
                path: shortestRoad.path,
                segments: shortestSegmentsWithPlaces,
            },
            safe: {
                distanceKm: safeRoad.distanceKm,
                riskAvg: safeRoad.riskAvg,
                riskReductionPct,
                path: safeRoad.path,
                segments: safeSegmentsWithPlaces,
            },
            meta: {
                margin,
                waypointCenters: waypointCenters.length,
                verifiedPoints: points.length,
                consideredReports: routeRiskReports.length,
                riskWeight,
                directRiskAvg,
                bestTwoHopRiskAvg,
                safeDisableDirectEdge,
                safeFallbackUsed,
                avoidedPlaces,
                safeFallbackUsedRoad,
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to compute route' });
    }
});

export default router;

