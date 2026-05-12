'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Map, Navigation } from 'lucide-react';
import dynamic from 'next/dynamic';
import { io, Socket } from 'socket.io-client';
import Navbar from '../components/Navbar';
import type { HotspotCluster } from '../components/MapComponent';
import { getApiBaseUrl } from '@/lib/apiBase';

const MapComponent = dynamic(() => import('../components/MapComponent'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center bg-slate-900 animate-pulse">
            <Map className="w-8 h-8 text-indigo-400 opacity-50" />
        </div>
    ),
});

interface Report {
    id: string;
    title: string;
    description: string;
    severity: number | null;
    createdAt: string;
    latitude: number;
    longitude: number;
    type: string;
    status: string;
    isResolved?: boolean;
    resolutionTag?: string | null;
    resolvedAt?: string | null;
}

export default function Home() {
    const [reports, setReports] = useState<Report[]>([]);
    const [clusters, setClusters] = useState<HotspotCluster[]>([]);
    const [timeRange, setTimeRange] = useState('all');
    const [crimeType, setCrimeType] = useState('');
    const [activeLocation, setActiveLocation] = useState<[number, number] | null>(null);
    const [feedError, setFeedError] = useState<string | null>(null);
    const [showResolved, setShowResolved] = useState(false);

    const loadMapData = useCallback(async () => {
        setFeedError(null);
        const params = new URLSearchParams({ timeRange });
        if (crimeType) params.set('type', crimeType);
        if (showResolved) {
            params.set('includeResolved', 'true');
            params.set('resolvedOnly', 'true');
        }

        try {
            const [repRes, hotRes] = await Promise.all([
                fetch(`${getApiBaseUrl()}/api/reports?${params.toString()}`),
                fetch(`${getApiBaseUrl()}/api/hotspots?${params.toString()}`),
            ]);

            if (!repRes.ok) {
                setReports([]);
                setClusters([]);
                setFeedError('Could not load incidents. Check that the API is running.');
                return;
            }

            const repData = await repRes.json();
            setReports(Array.isArray(repData.reports) ? repData.reports : []);

            if (hotRes.ok) {
                const hotData = await hotRes.json();
                setClusters(Array.isArray(hotData.clusters) ? hotData.clusters : []);
            } else {
                setClusters([]);
            }
        } catch {
            setReports([]);
            setClusters([]);
            setFeedError('Network error while loading map data.');
        }
    }, [timeRange, crimeType, showResolved]);

    useEffect(() => {
        void loadMapData();
    }, [loadMapData]);

    useEffect(() => {
        const socket: Socket = io(getApiBaseUrl());

        socket.on('report:new', () => {
            void loadMapData();
        });

        socket.on('report:moderated', () => {
            void loadMapData();
        });
        socket.on('report:resolved', () => {
            void loadMapData();
        });
        socket.on('report:reopened', () => {
            void loadMapData();
        });

        return () => {
            socket.disconnect();
        };
    }, [loadMapData]);

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-rose-500/30 font-sans">
            <Navbar />

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 h-[calc(100vh-4rem)]">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
                    <div className="lg:col-span-1 flex flex-col space-y-4 h-full overflow-hidden">
                        <div className="flex items-center justify-between shrink-0 mb-2">
                            <h2 className="text-lg font-semibold flex items-center gap-2">
                                <AlertTriangle className="w-5 h-5 text-amber-500" />
                                Live Intelligence
                            </h2>
                            <span className="text-xs bg-rose-500/10 text-rose-400 px-3 py-1 rounded-full border border-rose-500/20 font-medium">
                                {reports.length} Active
                            </span>
                        </div>

                        {feedError ? (
                            <div className="text-amber-300 text-xs bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 shrink-0">
                                {feedError}
                            </div>
                        ) : null}

                        <div className="flex gap-2 shrink-0 pb-2 border-b border-slate-800">
                            <select
                                value={timeRange}
                                onChange={(e) => setTimeRange(e.target.value)}
                                className="bg-slate-900 border border-slate-800 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500"
                            >
                                <option value="24h">Last 24 Hours</option>
                                <option value="7d">Last 7 Days</option>
                                <option value="30d">Last 30 Days</option>
                                <option value="all">All Time</option>
                            </select>
                            <select
                                value={crimeType}
                                onChange={(e) => setCrimeType(e.target.value)}
                                className="bg-slate-900 border border-slate-800 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500 flex-1"
                            >
                                <option value="">All Incident Types</option>
                                <option value="ARMED_ROBBERY">Armed Robbery</option>
                                <option value="VEHICLE_CRIME">Vehicle Crime</option>
                                <option value="VANDALISM">Vandalism</option>
                                <option value="ASSAULT">Assault</option>
                                <option value="THEFT">Theft</option>
                                <option value="OTHER">Other</option>
                            </select>
                            <label className="flex items-center gap-1.5 text-xs text-slate-400 shrink-0 cursor-pointer select-none whitespace-nowrap">
                                <input
                                    type="checkbox"
                                    checked={showResolved}
                                    onChange={(e) => setShowResolved(e.target.checked)}
                                    className="rounded border-slate-600 text-emerald-600 focus:ring-emerald-500"
                                />
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" aria-hidden />
                                Show resolved
                            </label>
                        </div>

                        <div className="flex-1 overflow-y-auto pr-1 space-y-3 pb-4">
                            {reports.length === 0 ? (
                                <div className="text-slate-500 text-sm text-center py-8 border border-dashed border-slate-800 rounded-xl">
                                    No active reports
                                </div>
                            ) : (
                                reports.map((report) => (
                                    <div
                                        key={report.id}
                                        className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 hover:border-slate-700 hover:bg-slate-800/80 transition-all group cursor-pointer shadow-sm relative overflow-hidden"
                                    >
                                        <div
                                            className={`absolute left-0 top-0 bottom-0 w-1 ${(report.severity ?? 0) > 5 ? 'bg-rose-500' : 'bg-amber-500'}`}
                                        />
                                        <div className="flex justify-between items-start mb-2 pl-3">
                                            <div className="flex flex-wrap gap-1.5 items-center">
                                                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-800 px-2 py-0.5 rounded-sm">
                                                    {report.type.replace(/_/g, ' ')}
                                                </span>
                                                {report.status === 'VERIFIED' && report.isResolved ? (
                                                    <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded-sm">
                                                        Resolved
                                                    </span>
                                                ) : null}
                                            </div>
                                            <span className="text-xs text-slate-500">
                                                {new Date(report.createdAt).toLocaleTimeString([], {
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                })}
                                            </span>
                                        </div>
                                        <h3 className="font-semibold text-slate-100 mb-1 pl-3 text-sm">{report.title}</h3>
                                        <p className="text-xs text-slate-400 line-clamp-2 mb-3 pl-3 leading-relaxed">
                                            {report.description}
                                        </p>
                                        <div className="flex items-center justify-between pl-3">
                                            <div className="flex items-center gap-1.5">
                                                <div
                                                    className={`w-2 h-2 rounded-full ${(report.severity ?? 0) > 5 ? 'bg-rose-500 animate-pulse' : 'bg-amber-500'}`}
                                                />
                                                <span className="text-xs text-slate-300 font-medium">
                                                    Severity {report.severity ?? '—'}/10
                                                </span>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActiveLocation([report.latitude, report.longitude]);
                                                }}
                                                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1 bg-indigo-500/10 px-2 py-1 rounded-md"
                                            >
                                                Locate <Navigation className="w-3 h-3" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl h-[400px] lg:h-auto relative">
                        {activeLocation && (
                            <button
                                type="button"
                                onClick={() => setActiveLocation(null)}
                                className="absolute top-4 right-4 z-[1000] bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-sm transition-colors shadow-lg border border-slate-700"
                            >
                                Clear Focus
                            </button>
                        )}
                        <MapComponent
                            reports={reports}
                            clusters={clusters}
                            activeLocation={activeLocation}
                            showResolvedHeat={showResolved}
                        />
                    </div>
                </div>
            </main>
        </div>
    );
}
