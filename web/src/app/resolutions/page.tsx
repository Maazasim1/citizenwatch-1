'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';
type TF = '24h' | '7d' | '30d' | 'all';
type ReportFeedRow = {
    id: string;
    title: string;
    type: string;
    latitude: number;
    longitude: number;
    verifiedAt: string;
    resolvedAt: string;
    resolutionTag: string | null;
    resolvedBy?: { fullName?: string | null; email?: string | null; phone?: string | null } | null;
};

type DashboardData = {
    summary: {
        totalVerified: number;
        totalResolved: number;
        resolutionRatePct: number;
        avgTimeToResolveHours: number;
        openCount: number;
    };
    feed: { page: number; pageSize: number; total: number; items: ReportFeedRow[] };
    breakdown: {
        byIncidentType: Array<{ type: string; count: number }>;
        byResolutionTag: Array<{ tag: string; count: number }>;
        topDistricts: Array<{ district: string; totalVerified: number; resolved: number; resolutionRatePct: number }>;
    };
};

const TAG_COLORS: Record<string, string> = {
    ARREST_MADE: 'text-green-300 bg-green-500/15 border-green-500/30',
    FALSE_ALARM: 'text-slate-300 bg-slate-500/15 border-slate-500/30',
    SITUATION_CLEARED: 'text-blue-300 bg-blue-500/15 border-blue-500/30',
};

const tagClass = (tag?: string | null) =>
    TAG_COLORS[String(tag || '')] || 'text-amber-300 bg-amber-500/15 border-amber-500/30';

const fmtDuration = (start?: string | null, end?: string | null) => {
    if (!start || !end) return '—';
    const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
    const h = Math.floor(ms / (60 * 60 * 1000));
    const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    return `Resolved in ${h}h ${m}m`;
};

export default function ResolutionsPage() {
    const { token, user, loading } = useAuth();
    const router = useRouter();
    const canAccess = user?.role === 'LAW_ENFORCEMENT' || user?.role === 'ADMIN' || user?.role === 'MODERATOR';
    const canReopen = user?.role === 'LAW_ENFORCEMENT' || user?.role === 'ADMIN';

    const [timeFilter, setTimeFilter] = useState<TF>('30d');
    const [page, setPage] = useState(1);
    const [data, setData] = useState<DashboardData | null>(null);
    const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

    const [loadingData, setLoadingData] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [msg, setMsg] = useState('');

    useEffect(() => {
        if (!loading && !canAccess) router.push('/');
    }, [loading, canAccess, router]);

    const load = useCallback(async () => {
        if (!token || !canAccess) return;
        setLoadingData(true);
        setMsg('');
        try {
            const params = new URLSearchParams({ timeFilter, page: String(page) });
            const res = await fetch(`${API}/api/reports/resolutions-dashboard?${params.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const d = (await res.json().catch(() => ({}))) as Partial<DashboardData> & { error?: string };
            if (!res.ok) throw new Error(d.error || 'Failed to load dashboard');
            setData(d as DashboardData);
        } catch (e: unknown) {
            setMsg(errMsg(e, 'Failed to load dashboard'));
        } finally {
            setLoadingData(false);
        }
    }, [token, canAccess, timeFilter, page]);

    useEffect(() => {
        void load();
    }, [load]);

    const reopen = async (id: string) => {
        if (!token || !canReopen) return;
        const notes = window.prompt('Optional reopen note (max 500 chars):') ?? '';
        setBusyId(id);
        setMsg('');
        try {
            const res = await fetch(`${API}/api/reports/${id}/reopen`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ notes: notes.slice(0, 500) }),
            });
            const d = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(d.error || 'Reopen failed');
            setMsg('Report reopened.');
            void load();
        } catch (e: unknown) {
            setMsg(errMsg(e, 'Reopen failed'));
        } finally {
            setBusyId(null);
        }
    };

    const feed = data?.feed?.items ?? [];
    const total = Number(data?.feed?.total ?? 0);
    const pageSize = Number(data?.feed?.pageSize ?? 20);
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

    const maxType = useMemo(
        () =>
            Math.max(
                1,
                ...(data?.breakdown?.byIncidentType ?? []).map((x: { type: string; count: number }) => Number(x.count || 0)),
            ),
        [data],
    );
    const maxTag = useMemo(
        () =>
            Math.max(
                1,
                ...(data?.breakdown?.byResolutionTag ?? []).map((x: { tag: string; count: number }) => Number(x.count || 0)),
            ),
        [data],
    );

    if (!canAccess) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100">
                <Navbar />
                <div className="p-8 text-center text-slate-500">Checking access…</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />
            <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
                <div className="flex items-center justify-between gap-4">
                    <h1 className="text-2xl font-bold">Resolution tracking dashboard</h1>
                    <div className="flex items-center gap-2">
                        {(['24h', '7d', '30d', 'all'] as TF[]).map((tf) => (
                            <button
                                key={tf}
                                type="button"
                                onClick={() => {
                                    setTimeFilter(tf);
                                    setPage(1);
                                }}
                                className={`px-2.5 py-1.5 rounded text-xs font-semibold border ${
                                    timeFilter === tf
                                        ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                                        : 'bg-slate-900 border-slate-700 text-slate-300'
                                }`}
                            >
                                {tf === 'all' ? 'all-time' : tf}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                        <p className="text-[11px] text-slate-500">Total verified</p>
                        <p className="text-xl font-bold">{data?.summary?.totalVerified ?? 0}</p>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                        <p className="text-[11px] text-slate-500">Total resolved</p>
                        <p className="text-xl font-bold">{data?.summary?.totalResolved ?? 0}</p>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                        <p className="text-[11px] text-slate-500">Resolution rate</p>
                        <p className="text-xl font-bold">{data?.summary?.resolutionRatePct ?? 0}%</p>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                        <p className="text-[11px] text-slate-500">Avg resolve time</p>
                        <p className="text-xl font-bold">{data?.summary?.avgTimeToResolveHours ?? 0}h</p>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                        <p className="text-[11px] text-slate-500">Open count</p>
                        <p className="text-xl font-bold">{data?.summary?.openCount ?? 0}</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-4">
                        <h2 className="text-sm font-semibold text-slate-300 mb-3">Resolution feed</h2>
                        {loadingData ? (
                            <p className="text-slate-500 text-sm">Loading…</p>
                        ) : feed.length === 0 ? (
                            <p className="text-slate-500 text-sm">No resolved reports for this filter.</p>
                        ) : (
                            <div className="space-y-3">
                                {feed.map((r: ReportFeedRow) => (
                                    <div key={r.id} className="border border-slate-800 rounded-xl p-3 bg-slate-950/40">
                                        <div className="flex items-start justify-between gap-2">
                                            <div>
                                                <p className="font-semibold text-slate-100">{r.title}</p>
                                                <p className="text-xs text-slate-500 mt-0.5">
                                                    {r.type?.replace(/_/g, ' ')} · {r.latitude?.toFixed?.(3)},{' '}
                                                    {r.longitude?.toFixed?.(3)}
                                                </p>
                                            </div>
                                            <span className={`text-[10px] uppercase tracking-wider border rounded px-2 py-0.5 ${tagClass(r.resolutionTag)}`}>
                                                {String(r.resolutionTag || 'NO_ACTION_TAKEN').replace(/_/g, ' ')}
                                            </span>
                                        </div>
                                        <p className="text-xs text-slate-400 mt-2">
                                            {new Date(r.verifiedAt).toLocaleString()} → {new Date(r.resolvedAt).toLocaleString()} ·{' '}
                                            {fmtDuration(r.verifiedAt, r.resolvedAt)}
                                        </p>
                                        <p className="text-xs text-slate-500 mt-1">
                                            Resolved by:{' '}
                                            {r.resolvedBy?.fullName || r.resolvedBy?.email || r.resolvedBy?.phone || 'Unknown'}
                                        </p>
                                        <div className="mt-2">
                                            {canReopen ? (
                                                <button
                                                    type="button"
                                                    disabled={busyId === r.id}
                                                    onClick={() => void reopen(r.id)}
                                                    className="text-xs font-semibold px-2.5 py-1.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300"
                                                >
                                                    {busyId === r.id ? 'Reopening…' : 'Reopen'}
                                                </button>
                                            ) : (
                                                <span className="text-xs text-slate-500">Read-only (no reopen)</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                <div className="flex items-center justify-between pt-2">
                                    <button
                                        type="button"
                                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                                        disabled={page <= 1}
                                        className="text-xs px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
                                    >
                                        Prev
                                    </button>
                                    <span className="text-xs text-slate-500">
                                        Page {page} / {totalPages}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                        disabled={page >= totalPages}
                                        className="text-xs px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="space-y-4">
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                            <h3 className="text-sm font-semibold text-slate-300 mb-2">By incident type</h3>
                            <div className="space-y-2">
                                {(data?.breakdown?.byIncidentType ?? []).map((x: { type: string; count: number }) => (
                                    <div key={x.type}>
                                        <div className="flex justify-between text-xs text-slate-400 mb-1">
                                            <span>{String(x.type).replace(/_/g, ' ')}</span>
                                            <span>{x.count}</span>
                                        </div>
                                        <div className="h-2 rounded bg-slate-800 overflow-hidden">
                                            <div
                                                className="h-full bg-indigo-400"
                                                style={{ width: `${Math.max(4, Math.round((Number(x.count) / maxType) * 100))}%` }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                            <h3 className="text-sm font-semibold text-slate-300 mb-2">By resolution tag</h3>
                            <div className="space-y-2">
                                {(data?.breakdown?.byResolutionTag ?? []).map((x: { tag: string; count: number }) => (
                                    <div key={x.tag}>
                                        <div className="flex justify-between text-xs text-slate-400 mb-1">
                                            <span>{String(x.tag).replace(/_/g, ' ')}</span>
                                            <span>{x.count}</span>
                                        </div>
                                        <div className="h-2 rounded bg-slate-800 overflow-hidden">
                                            <div
                                                className="h-full bg-emerald-400"
                                                style={{ width: `${Math.max(4, Math.round((Number(x.count) / maxTag) * 100))}%` }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                            <h3 className="text-sm font-semibold text-slate-300 mb-2">Top 5 districts by resolution rate</h3>
                            <div className="space-y-1 text-xs">
                                {(data?.breakdown?.topDistricts ?? []).map(
                                    (d: {
                                        district: string;
                                        totalVerified: number;
                                        resolved: number;
                                        resolutionRatePct: number;
                                    }) => (
                                    <div key={d.district} className="flex items-center justify-between border-b border-slate-800 py-1">
                                        <span className="text-slate-400 font-mono">{d.district}</span>
                                        <span className="text-slate-200">
                                            {d.resolutionRatePct}% ({d.resolved}/{d.totalVerified})
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
                {msg ? <p className="text-sm text-slate-400">{msg}</p> : null}
            </div>
        </div>
    );
}
