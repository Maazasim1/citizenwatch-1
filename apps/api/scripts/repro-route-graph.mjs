/**
 * Standalone reproduction: same k-NN + maxEdgeKm rules as routes.ts (no DB).
 * Proves A* cannot reach `end` when start–end distance >> maxEdgeKm and no waypoint chain exists.
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

function buildNeighbors(nodes, k = 8, maxEdgeKm = 20) {
    const neighbors = new Map();
    for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const dists = nodes
            .map((b) => ({ id: b.id, d: haversineKm(a.lat, a.lng, b.lat, b.lng) }))
            .filter((x) => x.id !== a.id && x.d <= maxEdgeKm)
            .sort((x, y) => x.d - y.d)
            .slice(0, k);
        neighbors.set(a.id, dists.map((x) => x.id));
    }
    return neighbors;
}

function canReachEnd(neighbors) {
    const seen = new Set(['start']);
    const q = ['start'];
    while (q.length) {
        const cur = q.pop();
        if (cur === 'end') return true;
        for (const nb of neighbors.get(cur) || []) {
            if (!seen.has(nb)) {
                seen.add(nb);
                q.push(nb);
            }
        }
    }
    return false;
}

// Karachi-local trip (seed-like coords): should be fully connected if start/end are mutual neighbors or bridged.
const local = [
    { id: 'start', lat: 24.8607, lng: 67.0011 },
    { id: 'w0', lat: 24.865, lng: 67.015 },
    { id: 'end', lat: 24.8715, lng: 67.0305 },
];

// Long trip: incidents only near start (simulate 3 waypoints clustered at start; none near end).
const longTrip = [
    { id: 'start', lat: 24.86, lng: 67.0 },
    { id: 'w0', lat: 24.861, lng: 67.002 },
    { id: 'w1', lat: 24.862, lng: 67.004 },
    { id: 'w2', lat: 24.863, lng: 67.006 },
    { id: 'end', lat: 26.0, lng: 68.5 },
];

for (const name of ['local', 'longTrip']) {
    const nodes = (name === 'local' ? local : longTrip).map((n) => ({ ...n }));
    const nbr = buildNeighbors(nodes);
    const ok = canReachEnd(nbr);
    const dStartEnd = haversineKm(nodes[0].lat, nodes[0].lng, nodes.at(-1).lat, nodes.at(-1).lng);
    console.log(name, 'start-end km=', dStartEnd.toFixed(1), 'reachable_end=', ok, 'neighbors(end)=', nbr.get('end')?.length ?? 0, nbr.get('end'));
}
