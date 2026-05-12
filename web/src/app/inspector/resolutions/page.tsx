'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Navbar from '../../../components/Navbar';
import { useAuth } from '../../../context/AuthContext';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Gavel, History, RefreshCw } from 'lucide-react';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

const RESOLUTION_TAGS = [
    { value: 'ARREST_MADE', label: 'Arrest made' },
    { value: 'SUSPECTS_DISPERSED', label: 'Suspects dispersed' },
    { value: 'SITUATION_CLEARED', label: 'Situation cleared' },
    { value: 'FALSE_ALARM', label: 'False alarm' },
    { value: 'DUPLICATE_CONFIRMED', label: 'Duplicate confirmed' },
    { value: 'UNDER_INVESTIGATION', label: 'Under investigation' },
    { value: 'NO_ACTION_TAKEN', label: 'No action taken' },
] as const;

interface MapReport {
    id: string;
    title: string;
    type: string;
    status: string;
    isResolved?: boolean;
    resolutionTag?: string | null;
    resolvedAt?: string | null;
    createdAt: string;
}

interface HistoryRow {
    id: string;
    action: string;
    tag: string | null;
    notes: string | null;
    createdAt: string;
    actor: { email: string | null; phone: string | null; role: string };
}

export default function InspectorResolutionsPage() {
    const { token, user, loading } = useAuth();
    const router = useRouter();
    const canAccess = user?.role === 'LAW_ENFORCEMENT' || user?.role === 'ADMIN';
    const canReopen = user?.role === 'LAW_ENFORCEMENT';

    const [reports, setReports] = useState<MapReport[]>([]);
    const [stats, setStats] = useState<any>(null);
    const [loadingData, setLoadingData] = useState(true);
    const [selected, setSelected] = useState<MapReport | null>(null);
    const [history, setHistory] = useState<HistoryRow[]>([]);
    const [tag, setTag] = useState<string>(RESOLUTION_TAGS[0].value);
    const [notes, setNotes] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [reopenNotes, setReopenNotes] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    useEffect(() => {
        if (!loading && !canAccess) router.push('/');
    }, [loading, canAccess, router]);

    const loadStats = useCallback(async () => {
        if (!token || !canAccess) return;
        const res = await authFetch(`${getApiBaseUrl()}/api/reports/resolution-stats`, {}, token);
        const data = await res.json().catch(() => ({}));
        if (res.ok) setStats(data);
    }, [token, canAccess]);

    const loadReports = useCallback(async () => {
        if (!token || !canAccess) return;
        const params = new URLSearchParams({
            status: 'VERIFIED',
            includeResolved: 'true',
            timeRange: 'all',
        });
        const res = await authFetch(`${getApiBaseUrl()}/api/reports?${params}`, {}, token);
        const data = await res.json().catch(() => ({}));
        if (res.ok) setReports(Array.isArray(data.reports) ? data.reports : []);
    }, [token, canAccess]);

    const loadAll = useCallback(async () => {
        setLoadingData(true);
        try {
            await Promise.all([loadStats(), loadReports()]);
        } finally {
            setLoadingData(false);
        }
    }, [loadStats, loadReports]);

    useEffect(() => {
        void loadAll();
    }, [loadAll]);

    useEffect(() => {
        setHistory([]);
        setMsg('');
        setNotes('');
        setConfirmed(false);
        setReopenNotes('');
        setTag(RESOLUTION_TAGS[0].value);
        if (!token || !selected) return;
        let cancelled = false;
        (async () => {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/resolution-history`, {}, token);
            const data = await res.json().catch(() => ({}));
            if (!cancelled && res.ok) setHistory(Array.isArray(data.history) ? data.history : []);
        })();
        return () => {
            cancelled = true;
        };
    }, [token, selected?.id]);

    const resolveReport = async () => {
        if (!token || !selected) return;
        setBusy(true);
        setMsg('');
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag, notes, confirmed }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Resolve failed');
            setMsg('Marked resolved.');
            setSelected(null);
            await loadAll();
        } catch (e: any) {
            setMsg(e?.message || 'Failed');
        } finally {
            setBusy(false);
        }
    };

    const reopenReport = async () => {
        if (!token || !selected) return;
        setBusy(true);
        setMsg('');
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/reopen`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes: reopenNotes }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Reopen failed');
            setMsg('Reopened.');
            setSelected(null);
            await loadAll();
        } catch (e: any) {
            setMsg(e?.message || 'Failed');
        } finally {
            setBusy(false);
        }
    };

    const pct = stats?.summary?.pctResolvedWithin48h;
    const trend = Array.isArray(stats?.trend) ? stats.trend : [];
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
            <div className="max-w-7xl mx-auto px-4 py-8">
                <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <Gavel className="w-7 h-7 text-indigo-400" />
                            Report resolutions
                        </h1>
                        <p className="text-slate-400 text-sm mt-1">
                            Law enforcement and admins only. Internal notes are never shown on the public map or community
                            pages.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void loadAll()}
                        className="inline-flex items-center gap-2 text-sm bg-slate-800 border border-slate-700 px-3 py-2 rounded-lg hover:bg-slate-700"
                    >
                        <RefreshCw className="w-4 h-4" /> Refresh
                    </button>
                </div>

                {loadingData ? (
                    <p className="text-slate-500 text-sm">Loading…</p>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5">
                            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
                                Last 30 days — resolved within 48h of verification
                            </h2>
                            <p className="text-3xl font-bold text-emerald-400">
                                {pct != null ? `${pct}%` : '—'}
                                <span className="text-sm font-normal text-slate-500 ml-2">
                                    ({stats?.summary?.resolvedWithin48h ?? 0} / {stats?.summary?.resolvedInWindow ?? 0}{' '}
                                    resolved in window)
                                </span>
                            </p>
                            <p className="text-xs text-slate-500 mt-2">
                                Verified in window: {stats?.summary?.verifiedInWindow ?? 0}. Districts are coarse 0.25°
                                buckets for trend breakdown.
                            </p>
                            <div className="mt-4 flex gap-0.5 items-end h-28">
                                {trend.slice(-30).map((t: any) => {
                                    const pctBar =
                                        t.pctWithin48h != null && t.verifiedCount > 0
                                            ? Math.max(6, Math.min(100, t.pctWithin48h))
                                            : 6;
                                    return (
                                        <div
                                            key={t.date}
                                            className="flex-1 min-w-0 flex flex-col justify-end h-full"
                                            title={`${t.date}: ${t.pctWithin48h ?? '—'}% (${t.resolvedWithin48hCount}/${t.verifiedCount} verified that day)`}
                                        >
                                            <div
                                                className="w-full bg-emerald-500/85 rounded-t min-h-[4px]"
                                                style={{ height: `${pctBar}%` }}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="text-[10px] text-slate-600 mt-1">
                                Daily bar height ≈ % of verifications from that UTC day resolved within 48h.
                            </p>
                        </div>
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-sm">
                            <h3 className="font-semibold text-slate-300 mb-2">By type</h3>
                            <ul className="space-y-1 text-slate-400 max-h-40 overflow-y-auto">
                                {stats?.byType &&
                                    Object.entries(stats.byType).map(([k, v]: [string, any]) => (
                                        <li key={k} className="flex justify-between gap-2">
                                            <span className="truncate">{k.replace(/_/g, ' ')}</span>
                                            <span className="text-emerald-400 font-mono shrink-0">
                                                {v.within48h}/{v.resolved}
                                            </span>
                                        </li>
                                    ))}
                            </ul>
                            <h3 className="font-semibold text-slate-300 mt-4 mb-2">By district (0.25°)</h3>
                            <ul className="space-y-1 text-slate-400 max-h-32 overflow-y-auto text-xs font-mono">
                                {stats?.byDistrict &&
                                    Object.entries(stats.byDistrict)
                                        .slice(0, 12)
                                        .map(([k, v]: [string, any]) => (
                                            <li key={k} className="flex justify-between gap-2">
                                                <span className="truncate">{k}</span>
                                                <span className="text-emerald-400 shrink-0">
                                                    {v.within48h}/{v.resolved}
                                                </span>
                                            </li>
                                        ))}
                            </ul>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                    <div className="lg:col-span-2 space-y-2 max-h-[70vh] overflow-y-auto pr-1">
                        <h2 className="text-sm font-semibold text-slate-400 mb-2">Verified reports</h2>
                        {reports.length === 0 ? (
                            <p className="text-slate-500 text-sm">No verified reports.</p>
                        ) : (
                            reports.map((r) => (
                                <button
                                    key={r.id}
                                    type="button"
                                    onClick={() => setSelected(r)}
                                    className={`w-full text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                                        selected?.id === r.id
                                            ? 'border-indigo-500 bg-indigo-500/10'
                                            : 'border-slate-800 bg-slate-900 hover:border-slate-700'
                                    }`}
                                >
                                    <div className="flex justify-between gap-2">
                                        <span className="font-medium text-slate-200 line-clamp-1">{r.title}</span>
                                        {r.isResolved ? (
                                            <span className="text-[10px] uppercase text-emerald-400 shrink-0">Resolved</span>
                                        ) : (
                                            <span className="text-[10px] uppercase text-amber-400 shrink-0">Open</span>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500 mt-0.5">{r.type.replace(/_/g, ' ')}</p>
                                </button>
                            ))
                        )}
                    </div>

                    <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-6">
                        {!selected ? (
                            <p className="text-slate-500 text-sm">Select a verified report.</p>
                        ) : (
                            <div className="space-y-6">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-100">{selected.title}</h3>
                                    <p className="text-xs text-slate-500 mt-1">
                                        ID {selected.id.slice(0, 8)}… · {selected.type.replace(/_/g, ' ')}
                                    </p>
                                </div>

                                {selected.isResolved ? (
                                    <div className="space-y-4">
                                        <p className="text-sm text-emerald-300">
                                            Resolved
                                            {selected.resolutionTag
                                                ? ` — ${selected.resolutionTag.replace(/_/g, ' ')}`
                                                : ''}
                                            {selected.resolvedAt ? ` · ${new Date(selected.resolvedAt).toLocaleString()}` : ''}
                                        </p>
                                        {canReopen ? (
                                            <>
                                                <div>
                                                    <label className="text-xs text-slate-500">
                                                        Reopen note (optional, internal)
                                                    </label>
                                                    <textarea
                                                        value={reopenNotes}
                                                        onChange={(e) => setReopenNotes(e.target.value.slice(0, 500))}
                                                        rows={2}
                                                        className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                                                    />
                                                </div>
                                                <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() => void reopenReport()}
                                                    className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
                                                >
                                                    <History className="w-4 h-4" />
                                                    Reopen (active on map again)
                                                </button>
                                            </>
                                        ) : (
                                            <p className="text-xs text-slate-500">
                                                Only law enforcement accounts can reopen a resolved incident.
                                            </p>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        <div>
                                            <label className="text-xs font-semibold text-slate-400 uppercase">Resolution tag</label>
                                            <select
                                                value={tag}
                                                onChange={(e) => setTag(e.target.value)}
                                                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                                            >
                                                {RESOLUTION_TAGS.map((o) => (
                                                    <option key={o.value} value={o.value}>
                                                        {o.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-xs font-semibold text-slate-400 uppercase">
                                                Internal notes (optional, max 500)
                                            </label>
                                            <textarea
                                                value={notes}
                                                onChange={(e) => setNotes(e.target.value.slice(0, 500))}
                                                rows={3}
                                                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                                                placeholder="For inspector audit only — not visible to citizens"
                                            />
                                            <p className="text-[10px] text-slate-600 mt-1">{notes.length}/500</p>
                                        </div>
                                        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={confirmed}
                                                onChange={(e) => setConfirmed(e.target.checked)}
                                                className="rounded border-slate-600 text-indigo-600"
                                            />
                                            I confirm this resolution is accurate
                                        </label>
                                        <button
                                            type="button"
                                            disabled={busy || !confirmed}
                                            onClick={() => void resolveReport()}
                                            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
                                        >
                                            <CheckCircle2 className="w-4 h-4" />
                                            Resolve report
                                        </button>
                                    </div>
                                )}

                                {msg ? <p className="text-sm text-slate-400">{msg}</p> : null}

                                <div className="border-t border-slate-800 pt-4">
                                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                                        <History className="w-3.5 h-3.5" /> Resolution history
                                    </h4>
                                    <ul className="space-y-2 text-xs text-slate-400 max-h-48 overflow-y-auto">
                                        {history.length === 0 ? (
                                            <li>No history yet.</li>
                                        ) : (
                                            history.map((h) => (
                                                <li key={h.id} className="border border-slate-800 rounded-lg p-2">
                                                    <span className="text-indigo-300 font-semibold">{h.action}</span>
                                                    {h.tag ? ` · ${h.tag.replace(/_/g, ' ')}` : ''} ·{' '}
                                                    {new Date(h.createdAt).toLocaleString()}
                                                    <div className="text-slate-500 mt-1">
                                                        {h.actor.email || h.actor.phone || h.actor.role}
                                                    </div>
                                                    {h.notes ? (
                                                        <p className="text-slate-500 mt-1 whitespace-pre-wrap">{h.notes}</p>
                                                    ) : null}
                                                </li>
                                            ))
                                        )}
                                    </ul>
                                </div>

                                <Link href="/" className="text-xs text-indigo-400 hover:text-indigo-300">
                                    ← Back to map
                                </Link>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
