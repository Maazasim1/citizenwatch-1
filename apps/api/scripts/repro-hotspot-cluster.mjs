/**
 * Mirrors hotspots.ts clusterPoints (minPts=1: singletons still become a cluster).
 */
const R = 6371;
const toRad = (x) => (x * Math.PI) / 180;
const haversineKm = (lat1, lon1, lat2, lon2) => {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

function clusterPoints(points, epsilonKm = 4, minPts = 1) {
    const visited = new Array(points.length).fill(false);
    const clusters = [];
    const neighborsOf = (i) => {
        const p = points[i];
        const out = [];
        for (let j = 0; j < points.length; j++) {
            if (j === i) continue;
            const q = points[j];
            const d = haversineKm(p.lat, p.lng, q.lat, q.lng);
            if (d <= epsilonKm) out.push(j);
        }
        return out;
    };
    for (let i = 0; i < points.length; i++) {
        if (visited[i]) continue;
        visited[i] = true;
        const seedNeighbors = neighborsOf(i);
        if (seedNeighbors.length + 1 < minPts) continue;
        const clusterIdxs = new Set([i, ...seedNeighbors]);
        clusters.push({ indices: Array.from(clusterIdxs), count: clusterIdxs.size });
    }
    return clusters;
}

const oneVerified = [{ lat: 24.86, lng: 67.0, severity: 8 }];
console.log('1 isolated VERIFIED point (minPts=1) → cluster count', clusterPoints(oneVerified).length, '(expect 1)');
