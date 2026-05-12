'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Navbar from '../../components/Navbar';
import RouteAnalyticsPanel from '../../components/RouteAnalyticsPanel';
import type { HotspotCluster } from '../../components/MapComponent';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '@/lib/apiBase';

const DEFAULT_START = { latitude: 24.8607, longitude: 67.0011 } as const;
const DEFAULT_END = { latitude: 24.8715, longitude: 67.0305 } as const;

type LatLng = { latitude: number; longitude: number };
type Segment = {
    start: LatLng;
    end: LatLng;
    risk: number;
    placeLabel?: string;
};
type ReportHotspotPoint = {
    id: string;
    latitude: number;
    longitude: number;
    severity: number;
    type: string;
    status: string;
};

type Suggestion = {
    label: string;
    latitude: number;
    longitude: number;
    type: string;
};

type MapTimeRange = '24h' | '7d' | '30d' | 'all';

const RouteMap = dynamic(() => import('../../components/RouteMap'), {
    ssr: false,
    loading: () => <div className="w-full h-[420px] bg-slate-900 rounded-2xl animate-pulse" />,
});

export default function RoutePage() {
    const { user, loading: authLoading } = useAuth();
    const router = useRouter();
    const [start, setStart] = useState<LatLng>({ ...DEFAULT_START });
    const [end, setEnd] = useState<LatLng>({ ...DEFAULT_END });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const [shortestPath, setShortestPath] = useState<LatLng[]>([
        { latitude: DEFAULT_START.latitude, longitude: DEFAULT_START.longitude },
        { latitude: DEFAULT_END.latitude, longitude: DEFAULT_END.longitude },
    ]);
    const [safePath, setSafePath] = useState<LatLng[]>([
        { latitude: DEFAULT_START.latitude, longitude: DEFAULT_START.longitude },
        { latitude: DEFAULT_END.latitude, longitude: DEFAULT_END.longitude },
    ]);
    const [safeSegments, setSafeSegments] = useState<Segment[]>([]);
    const [showSafeAlternative, setShowSafeAlternative] = useState(true);
    const [routeDecisionNote, setRouteDecisionNote] = useState('');
    const [pickMode, setPickMode] = useState<'start' | 'end' | null>(null);
    const [avoidedPlaces, setAvoidedPlaces] = useState<Array<{ label: string; diff: number }>>([]);
    const [hotspots, setHotspots] = useState<ReportHotspotPoint[]>([]);
    const [hotspotClusters, setHotspotClusters] = useState<HotspotCluster[]>([]);
    const [mapTimeRange, setMapTimeRange] = useState<MapTimeRange>('24h');

    const [startAddress, setStartAddress] = useState('');
    const [endAddress, setEndAddress] = useState('');
    const [activeAddressField, setActiveAddressField] = useState<'start' | 'end' | null>(null);
    const [startSuggestions, setStartSuggestions] = useState<Suggestion[]>([]);
    const [endSuggestions, setEndSuggestions] = useState<Suggestion[]>([]);

    const [stats, setStats] = useState<{
        shortestDistanceKm: number;
        shortestRiskAvg: number;
        safeDistanceKm: number;
        safeRiskAvg: number;
        riskReductionPct: number;
    } | null>(null);

    useEffect(() => {
        if (authLoading) return;
        if (user?.role === 'MODERATOR') {
            window.alert('This feature is for citizens only.');
            router.replace('/moderation');
            return;
        }
        if (user?.role === 'LAW_ENFORCEMENT') {
            window.alert('This feature is for citizens only.');
            router.replace('/intelligence');
        }
    }, [authLoading, user, router]);

    const computePayload = useMemo(() => {
        return {
            start,
            end,
        };
    }, [start, end]);

    const searchGeocode = async (query: string): Promise<Suggestion[]> => {
        const res = await fetch(`${getApiBaseUrl()}/api/geocode?query=${encodeURIComponent(query)}&limit=6`);
        if (!res.ok) return [];
        const data = await res.json();
        return (data?.results ?? []) as Suggestion[];
    };

    useEffect(() => {
        if (activeAddressField !== 'start') return;
        const q = startAddress.trim();
        if (q.length < 3) {
            setStartSuggestions([]);
            return;
        }

        const t = setTimeout(() => {
            searchGeocode(q)
                .then((results) => setStartSuggestions(results))
                .catch(() => setStartSuggestions([]));
        }, 350);

        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [startAddress, activeAddressField]);

    useEffect(() => {
        if (activeAddressField !== 'end') return;
        const q = endAddress.trim();
        if (q.length < 3) {
            setEndSuggestions([]);
            return;
        }

        const t = setTimeout(() => {
            searchGeocode(q)
                .then((results) => setEndSuggestions(results))
                .catch(() => setEndSuggestions([]));
        }, 350);

        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [endAddress, activeAddressField]);

    useEffect(() => {
        let cancelled = false;
        const loadHotspots = async () => {
            const params = new URLSearchParams({ timeRange: mapTimeRange });
            try {
                const [repRes, hotRes] = await Promise.all([
                    fetch(`${getApiBaseUrl()}/api/reports?${params.toString()}`),
                    fetch(`${getApiBaseUrl()}/api/hotspots?${params.toString()}`),
                ]);
                if (cancelled) return;
                if (repRes.ok) {
                    const data = await repRes.json();
                    const points = Array.isArray(data?.reports)
                        ? data.reports.map((r: any) => ({
                              id: r.id,
                              latitude: r.latitude,
                              longitude: r.longitude,
                              severity:
                                  typeof r.severity === 'number'
                                      ? r.severity
                                      : r.type === 'ARMED_ROBBERY'
                                        ? 9
                                        : r.type === 'ASSAULT'
                                          ? 8
                                          : r.type === 'VEHICLE_CRIME'
                                            ? 6
                                            : r.type === 'THEFT'
                                              ? 5
                                              : r.type === 'VANDALISM'
                                                ? 3
                                                : 4,
                              type: String(r.type || 'OTHER'),
                              status: String(r.status || 'PENDING'),
                          }))
                        : [];
                    setHotspots(points);
                } else {
                    setHotspots([]);
                }
                if (hotRes.ok) {
                    const hotData = await hotRes.json();
                    setHotspotClusters(Array.isArray(hotData?.clusters) ? hotData.clusters : []);
                } else {
                    setHotspotClusters([]);
                }
            } catch {
                if (!cancelled) {
                    setHotspots([]);
                    setHotspotClusters([]);
                }
            }
        };
        void loadHotspots();
        return () => {
            cancelled = true;
        };
    }, [mapTimeRange]);

    const validCoord = (p: LatLng) =>
        Number.isFinite(p.latitude) &&
        Number.isFinite(p.longitude) &&
        p.latitude >= -90 &&
        p.latitude <= 90 &&
        p.longitude >= -180 &&
        p.longitude <= 180;

    const handleCompute = async () => {
        setError('');
        if (!validCoord(start) || !validCoord(end)) {
            setError('Enter valid numeric latitude and longitude (lat −90…90, lng −180…180).');
            return;
        }
        setLoading(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/routes/compute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(computePayload),
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(
                    typeof data?.error === 'string' ? data.error : 'Route computation failed. Is the API running?',
                );
            }

            const fallbackLine: LatLng[] = [start, end];
            const shortPath = Array.isArray(data.shortest?.path) && data.shortest.path.length >= 2 ? data.shortest.path : fallbackLine;
            const safeP = Array.isArray(data.safe?.path) && data.safe.path.length >= 2 ? data.safe.path : fallbackLine;
            const shortestRisk = Number(data.shortest?.riskAvg ?? 0);
            const safeRisk = Number(data.safe?.riskAvg ?? 0);
            const riskReduction = Number(data.safe?.riskReductionPct ?? 0);
            const safeDistance = Number(data.safe?.distanceKm ?? 0);
            const shortestDistance = Number(data.shortest?.distanceKm ?? 0);

            const pathDifferent =
                shortPath.length !== safeP.length ||
                shortPath.some((p: LatLng, idx: number) => {
                    const s = safeP[idx];
                    if (!s) return true;
                    return (
                        Math.abs(p.latitude - s.latitude) > 0.00001 ||
                        Math.abs(p.longitude - s.longitude) > 0.00001
                    );
                });
            const measurablySafer = riskReduction > 0.2 && safeRisk < shortestRisk - 0.01;
            const shouldShowSafeAlternative = measurablySafer && pathDifferent;

            setShortestPath(shortPath);
            setSafePath(safeP);
            setSafeSegments(shouldShowSafeAlternative ? data.safe?.segments ?? [] : []);
            setShowSafeAlternative(shouldShowSafeAlternative);
            if (shouldShowSafeAlternative) {
                const detourPct =
                    shortestDistance > 0
                        ? Math.max(0, ((safeDistance - shortestDistance) / shortestDistance) * 100)
                        : 0;
                setRouteDecisionNote(
                    `Safe alternative shown: ${riskReduction.toFixed(1)}% lower risk with ~${detourPct.toFixed(1)}% extra distance.`,
                );
            } else {
                setRouteDecisionNote(
                    'No measurably safer alternate route found. Showing shortest route only.',
                );
            }
            setAvoidedPlaces(data.meta?.avoidedPlaces ?? []);
            setStats({
                shortestDistanceKm: data.shortest?.distanceKm ?? 0,
                shortestRiskAvg: shortestRisk,
                safeDistanceKm: data.safe?.distanceKm ?? 0,
                safeRiskAvg: safeRisk,
                riskReductionPct: riskReduction,
            });
        } catch (e: any) {
            setError(e?.message || 'Route computation failed');
        } finally {
            setLoading(false);
        }
    };

    const selectSuggestion = (field: 'start' | 'end', s: Suggestion) => {
        if (field === 'start') {
            setStart({ latitude: s.latitude, longitude: s.longitude });
            setStartAddress(s.label);
            setStartSuggestions([]);
        } else {
            setEnd({ latitude: s.latitude, longitude: s.longitude });
            setEndAddress(s.label);
            setEndSuggestions([]);
        }
        setActiveAddressField(null);
        setPickMode(null);
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="flex items-start justify-between gap-6 mb-6">
                    <div>
                        <h1 className="text-2xl font-bold">Safe Route Navigation</h1>
                        <p className="text-slate-400 text-sm mt-1">
                            Risk-aware routing using verified crime reports, hotspot density, and real road networks via OSRM.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-1 space-y-4">
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                            <h2 className="text-sm font-semibold mb-3">Start</h2>
                            <div className="space-y-3 relative">
                                <label className="block text-xs text-slate-400 font-semibold uppercase tracking-widest">
                                    Address (autocomplete)
                                </label>
                                <input
                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                    value={startAddress}
                                    onChange={(e) => {
                                        setStartAddress(e.target.value);
                                        setStartSuggestions([]);
                                    }}
                                    onFocus={() => {
                                        setActiveAddressField('start');
                                        setPickMode(null);
                                    }}
                                    placeholder="Type an address..."
                                />

                                {activeAddressField === 'start' && startSuggestions.length > 0 ? (
                                    <div className="absolute left-0 right-0 mt-2 bg-slate-950 border border-slate-800 rounded-xl z-50 overflow-hidden">
                                        {startSuggestions.map((s, idx) => (
                                            <button
                                                type="button"
                                                key={`${s.label}-${idx}`}
                                                className="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-slate-900 transition-colors border-b border-slate-800 last:border-b-0"
                                                onClick={() => selectSuggestion('start', s)}
                                            >
                                                {s.label}
                                            </button>
                                        ))}
                                    </div>
                                ) : null}

                                <div className="pt-2">
                                    <div className="flex items-center justify-between mb-2">
                                        <label className="block text-xs text-slate-400 font-semibold uppercase tracking-widest">Latitude</label>
                                    </div>
                                    <input
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                        value={String(start.latitude)}
                                        onChange={(e) => {
                                            setStart((s) => ({ ...s, latitude: Number(e.target.value) }));
                                            setStartAddress('');
                                            setStartSuggestions([]);
                                            setActiveAddressField(null);
                                        }}
                                    />
                                    <div className="flex items-center justify-between mb-2 mt-3">
                                        <label className="block text-xs text-slate-400 font-semibold uppercase tracking-widest">Longitude</label>
                                    </div>
                                    <input
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                        value={String(start.longitude)}
                                        onChange={(e) => {
                                            setStart((s) => ({ ...s, longitude: Number(e.target.value) }));
                                            setStartAddress('');
                                            setStartSuggestions([]);
                                            setActiveAddressField(null);
                                        }}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                            <h2 className="text-sm font-semibold mb-3">End</h2>
                            <div className="space-y-3 relative">
                                <label className="block text-xs text-slate-400 font-semibold uppercase tracking-widest">
                                    Address (autocomplete)
                                </label>
                                <input
                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                    value={endAddress}
                                    onChange={(e) => {
                                        setEndAddress(e.target.value);
                                        setEndSuggestions([]);
                                    }}
                                    onFocus={() => {
                                        setActiveAddressField('end');
                                        setPickMode(null);
                                    }}
                                    placeholder="Type an address..."
                                />

                                {activeAddressField === 'end' && endSuggestions.length > 0 ? (
                                    <div className="absolute left-0 right-0 mt-2 bg-slate-950 border border-slate-800 rounded-xl z-50 overflow-hidden">
                                        {endSuggestions.map((s, idx) => (
                                            <button
                                                type="button"
                                                key={`${s.label}-${idx}`}
                                                className="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-slate-900 transition-colors border-b border-slate-800 last:border-b-0"
                                                onClick={() => selectSuggestion('end', s)}
                                            >
                                                {s.label}
                                            </button>
                                        ))}
                                    </div>
                                ) : null}

                                <div className="pt-2">
                                    <div className="flex items-center justify-between mb-2">
                                        <label className="block text-xs text-slate-400 font-semibold uppercase tracking-widest">Latitude</label>
                                    </div>
                                    <input
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                        value={String(end.latitude)}
                                        onChange={(e) => {
                                            setEnd((s) => ({ ...s, latitude: Number(e.target.value) }));
                                            setEndAddress('');
                                            setEndSuggestions([]);
                                            setActiveAddressField(null);
                                        }}
                                    />
                                    <div className="flex items-center justify-between mb-2 mt-3">
                                        <label className="block text-xs text-slate-400 font-semibold uppercase tracking-widest">Longitude</label>
                                    </div>
                                    <input
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                        value={String(end.longitude)}
                                        onChange={(e) => {
                                            setEnd((s) => ({ ...s, longitude: Number(e.target.value) }));
                                            setEndAddress('');
                                            setEndSuggestions([]);
                                            setActiveAddressField(null);
                                        }}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                            <h2 className="text-sm font-semibold mb-3">Pick on Map</h2>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setActiveAddressField(null);
                                        setPickMode('start');
                                    }}
                                    className={`flex-1 px-3 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                                        pickMode === 'start' ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300' : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-white'
                                    }`}
                                >
                                    Set Start
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setActiveAddressField(null);
                                        setPickMode('end');
                                    }}
                                    className={`flex-1 px-3 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                                        pickMode === 'end' ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300' : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-white'
                                    }`}
                                >
                                    Set End
                                </button>
                            </div>
                            {pickMode ? (
                                <div className="text-xs text-amber-300 mt-2">
                                    Map click mode: {pickMode === 'start' ? 'Start' : 'End'} (click a point)
                                </div>
                            ) : (
                                <div className="text-xs text-slate-500 mt-2">Or just type coordinates.</div>
                            )}
                        </div>

                        {error ? (
                            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl px-4 py-3">
                                {error}
                            </div>
                        ) : null}

                        <button
                            type="button"
                            onClick={handleCompute}
                            disabled={loading}
                            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3.5 rounded-xl font-semibold text-sm transition-all active:scale-95 shadow-lg shadow-indigo-600/20 disabled:opacity-60"
                        >
                            {loading ? 'Computing...' : 'Compute Safe Route'}
                        </button>
                    </div>

                    <div className="lg:col-span-2 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-slate-400 font-semibold uppercase tracking-widest">
                                Map overlay (reports + verified clusters)
                            </span>
                            <select
                                value={mapTimeRange}
                                onChange={(e) => setMapTimeRange(e.target.value as MapTimeRange)}
                                className="text-xs bg-slate-900 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg"
                                aria-label="Hotspot time range"
                            >
                                <option value="24h">Last 24h</option>
                                <option value="7d">Last 7d</option>
                                <option value="30d">Last 30d</option>
                                <option value="all">All time</option>
                            </select>
                        </div>
                        <RouteMap
                            start={start}
                            end={end}
                            shortestPath={shortestPath}
                            safePath={showSafeAlternative ? safePath : []}
                            safeSegments={safeSegments}
                            hotspots={hotspots}
                            hotspotClusters={hotspotClusters}
                            selectionMode={pickMode}
                            onSelectPoint={(mode, point) => {
                                if (mode === 'start') {
                                    setStart(point);
                                    setStartAddress('');
                                    setStartSuggestions([]);
                                } else {
                                    setEnd(point);
                                    setEndAddress('');
                                    setEndSuggestions([]);
                                }
                                setActiveAddressField(null);
                                setPickMode(null);
                            }}
                        />

                        {/* Route Comparison Analytics Panel */}
                        {stats && (
                            <>
                                <div
                                    className={`rounded-xl px-3 py-2 text-sm border ${
                                        showSafeAlternative
                                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                                            : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                                    }`}
                                >
                                    {routeDecisionNote}
                                </div>
                                <RouteAnalyticsPanel
                                    stats={stats}
                                    safeSegments={safeSegments}
                                    avoidedPlaces={avoidedPlaces}
                                />
                            </>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}

