'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertOctagon, Eye, CheckCircle, History, Gavel, RefreshCw } from 'lucide-react';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

interface Report {
    id: string;
    title: string;
    description: string;
    type: string;
    status: string;
    severity: number | null;
    severityConfidence: number | null;
    latitude: number;
    longitude: number;
    createdAt: string;
    isResolved?: boolean;
    resolutionTag?: string | null;
    resolvedAt?: string | null;
    author: { email: string | null; phone: string | null };
    multimedia: { url: string; type: string }[];
}

interface HistoryRow {
    id: string;
    action: string;
    tag: string | null;
    notes: string | null;
    createdAt: string;
    actor: { email: string | null; phone: string | null; role: string };
}

const RESOLUTION_TAGS = [
    { value: 'ARREST_MADE', label: 'Arrest made' },
    { value: 'SUSPECTS_DISPERSED', label: 'Suspects dispersed' },
    { value: 'SITUATION_CLEARED', label: 'Situation cleared' },
    { value: 'FALSE_ALARM', label: 'False alarm' },
    { value: 'DUPLICATE_CONFIRMED', label: 'Duplicate confirmed' },
    { value: 'UNDER_INVESTIGATION', label: 'Under investigation' },
    { value: 'NO_ACTION_TAKEN', label: 'No action taken' },
] as const;

export default function EscalationsPage() {
    const { token, user } = useAuth();
    const [escalatedReports, setEscalatedReports] = useState<Report[]>([]);
    const [verifiedReports, setVerifiedReports] = useState<Report[]>([]);
    const [selected, setSelected] = useState<Report | null>(null);
    const [activeTab, setActiveTab] = useState<'ALL' | 'ESCALATED' | 'VERIFIED'>('ALL');
    const [loading, setLoading] = useState(true);
    const [removeReason, setRemoveReason] = useState('');
    const [removing, setRemoving] = useState(false);
    const [tag, setTag] = useState<string>(RESOLUTION_TAGS[0].value);
    const [notes, setNotes] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [reopenNotes, setReopenNotes] = useState('');
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState('');
    const [history, setHistory] = useState<HistoryRow[]>([]);

    const canView = user?.role === 'ADMIN' || user?.role === 'MODERATOR' || user?.role === 'LAW_ENFORCEMENT';
    const canResolve = user?.role === 'LAW_ENFORCEMENT' || user?.role === 'ADMIN';
    const canReopen = user?.role === 'LAW_ENFORCEMENT';
    const showVerifiedTab = canResolve;

    const loadReports = useCallback(async () => {
        if (!token || !canView) {
            setEscalatedReports([]);
            setVerifiedReports([]);
            return;
        }
        const [escRes, verRes] = await Promise.all([
            authFetch(`${getApiBaseUrl()}/api/reports?status=ESCALATED`, {}, token),
            authFetch(`${getApiBaseUrl()}/api/reports?status=VERIFIED&includeResolved=true&timeRange=all`, {}, token),
        ]);
        const escData = await escRes.json().catch(() => ({}));
        const verData = await verRes.json().catch(() => ({}));
        setEscalatedReports(Array.isArray(escData.reports) ? escData.reports : []);
        setVerifiedReports(Array.isArray(verData.reports) ? verData.reports : []);
    }, [token, canView]);

    useEffect(() => {
        setLoading(true);
        loadReports()
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [loadReports]);

    useEffect(() => {
        setHistory([]);
        setActionError('');
        setNotes('');
        setConfirmed(false);
        setReopenNotes('');
        setTag(RESOLUTION_TAGS[0].value);
        if (!token || !selected || !canResolve) return;
        let cancelled = false;
        (async () => {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/resolution-history`, {}, token);
            const data = await res.json().catch(() => ({}));
            if (!cancelled && res.ok) setHistory(Array.isArray(data.history) ? data.history : []);
        })();
        return () => {
            cancelled = true;
        };
    }, [token, selected?.id, canResolve]);

    const removeEscalation = async () => {
        if (!token || !selected) return;
        setActionError('');
        const reason = removeReason.trim();
        if (reason.length < 10) {
            setActionError('Reason must be at least 10 characters.');
            return;
        }
        const ok = window.confirm('Remove this escalation and move report back to pending?');
        if (!ok) return;

        setRemoving(true);
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/remove-escalation`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setActionError(data.error || 'Failed to remove escalation');
                return;
            }
            await loadReports();
            setSelected(null);
            setRemoveReason('');
        } catch {
            setActionError('Network error while removing escalation.');
        } finally {
            setRemoving(false);
        }
    };

    const resolveReport = async () => {
        if (!token || !selected || !canResolve) return;
        setBusy(true);
        setActionError('');
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag, notes, confirmed }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Resolve failed');
            await loadReports();
            setSelected(null);
        } catch (e: any) {
            setActionError(e?.message || 'Resolve failed');
        } finally {
            setBusy(false);
        }
    };

    const reopenReport = async () => {
        if (!token || !selected || !canReopen) return;
        setBusy(true);
        setActionError('');
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${selected.id}/reopen`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes: reopenNotes }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Reopen failed');
            await loadReports();
            setSelected(null);
        } catch (e: any) {
            setActionError(e?.message || 'Reopen failed');
        } finally {
            setBusy(false);
        }
    };

    const visibleReports = useMemo(() => {
        if (activeTab === 'ESCALATED') return escalatedReports;
        if (activeTab === 'VERIFIED') return verifiedReports;
        const all = [...escalatedReports, ...verifiedReports];
        return all.sort((a, b) => {
            const rank = (r: Report) => {
                if (r.status === 'ESCALATED') return 0;
                if (r.isResolved) return 2;
                return 1;
            };
            const r = rank(a) - rank(b);
            if (r !== 0) return r;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
    }, [activeTab, escalatedReports, verifiedReports]);

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="flex items-center justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <AlertOctagon className="w-6 h-6 text-purple-500" /> Incident Handling Dashboard
                        </h1>
                        <p className="text-slate-400 text-sm mt-1">
                            Handle escalated and verified reports in one inspector workflow.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            setLoading(true);
                            loadReports().finally(() => setLoading(false));
                        }}
                        className="inline-flex items-center gap-2 text-sm bg-slate-800 border border-slate-700 px-3 py-2 rounded-lg hover:bg-slate-700"
                    >
                        <RefreshCw className="w-4 h-4" /> Refresh
                    </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                    <div className="lg:col-span-2 space-y-3 max-h-[calc(100vh-12rem)] overflow-y-auto pr-2">
                        {showVerifiedTab ? (
                            <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 mb-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setActiveTab('ALL');
                                        setSelected(null);
                                    }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                        activeTab === 'ALL' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
                                    }`}
                                >
                                    All ({escalatedReports.length + verifiedReports.length})
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setActiveTab('ESCALATED');
                                        setSelected(null);
                                    }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                        activeTab === 'ESCALATED' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
                                    }`}
                                >
                                    Escalated ({escalatedReports.length})
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setActiveTab('VERIFIED');
                                        setSelected(null);
                                    }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                        activeTab === 'VERIFIED' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                                    }`}
                                >
                                    Verified ({verifiedReports.length})
                                </button>
                            </div>
                        ) : null}

                        <div className="grid grid-cols-12 text-[10px] uppercase tracking-widest text-slate-500 px-2 py-1">
                            <span className="col-span-6">Report</span>
                            <span className="col-span-3">Escalated reports</span>
                            <span className="col-span-3 text-right">Date</span>
                        </div>

                        {!canView ? (
                            <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl px-4">
                                <p className="text-slate-400 font-medium">Not authorized</p>
                            </div>
                        ) : loading ? (
                            <div className="text-slate-500 text-sm text-center py-12">Loading reports...</div>
                        ) : visibleReports.length === 0 ? (
                            <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl">
                                <CheckCircle className="w-10 h-10 text-green-500 mx-auto mb-3 opacity-60" />
                                <p className="text-slate-400 font-medium">No reports in this view</p>
                            </div>
                        ) : (
                            visibleReports.map((report) => (
                                <button
                                    key={report.id}
                                    onClick={() => setSelected(report)}
                                    className={`w-full text-left bg-slate-900 border rounded-xl p-3 transition-all shadow-sm relative overflow-hidden ${selected?.id === report.id ? 'border-purple-500 bg-purple-500/5' : 'border-slate-800 hover:border-slate-700'}`}
                                >
                                    <div className="grid grid-cols-12 items-start gap-2">
                                        <div className="col-span-6">
                                            <p className="font-semibold text-slate-100 text-sm line-clamp-1">{report.title}</p>
                                            <div className="flex items-center gap-2 mt-1">
                                                <span className="text-xs text-slate-500">{report.type.replace(/_/g, ' ')}</span>
                                                {report.multimedia.length > 0 && (
                                                    <span className="text-xs text-indigo-400 flex items-center gap-1">
                                                        <Eye className="w-3 h-3" /> {report.multimedia.length}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="col-span-3">
                                            {report.status === 'ESCALATED' ? (
                                                <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-purple-400 bg-purple-400/10 border-purple-400/20">
                                                    ESCALATED
                                                </span>
                                            ) : report.isResolved ? (
                                                <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-emerald-300 bg-emerald-500/15 border-emerald-500/30">
                                                    RESOLVED
                                                </span>
                                            ) : (
                                                <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-indigo-300 bg-indigo-500/15 border-indigo-500/30">
                                                    VERIFIED
                                                </span>
                                            )}
                                        </div>
                                        <div className="col-span-3 text-right text-xs text-slate-500">
                                            {new Date(report.createdAt).toLocaleDateString()}
                                        </div>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>

                    <div className="lg:col-span-3">
                        {selected ? (
                            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sticky top-24">
                                <div className="flex items-start justify-between mb-6">
                                    <h2 className="text-xl font-bold text-slate-100">{selected.title}</h2>
                                    {selected.status === 'ESCALATED' ? (
                                        <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-purple-400 bg-purple-400/10 border-purple-400/20">
                                            ESCALATED
                                        </span>
                                    ) : selected.isResolved ? (
                                        <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-emerald-300 bg-emerald-500/15 border-emerald-500/30">
                                            RESOLVED
                                        </span>
                                    ) : (
                                        <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-indigo-300 bg-indigo-500/15 border-indigo-500/30">
                                            VERIFIED
                                        </span>
                                    )}
                                </div>
                                <div className="grid grid-cols-2 gap-4 mb-6">
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Crime Type</p>
                                        <p className="text-sm font-medium text-slate-200">{selected.type.replace(/_/g, ' ')}</p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Location</p>
                                        <p className="text-sm font-mono text-slate-200">{selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}</p>
                                    </div>
                                </div>
                                <div className="mb-6">
                                    <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Description</p>
                                    <p className="text-sm text-slate-300 leading-relaxed bg-slate-800/30 rounded-xl p-4 border border-slate-700/50">
                                        {selected.description}
                                    </p>
                                </div>
                                {selected.multimedia.length > 0 && (
                                    <div className="mb-6">
                                        <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Evidence</p>
                                        <div className="flex flex-wrap gap-2">
                                            {selected.multimedia.map((m, i) => (
                                                <a key={i} href={m.url} target="_blank" rel="noopener noreferrer" className="bg-slate-800 border border-slate-700 text-indigo-400 hover:text-indigo-300 px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 transition-colors">
                                                    <Eye className="w-3 h-3" /> View Source #{i + 1}
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {selected.status === 'ESCALATED' ? (
                                    <div className="pt-4 border-t border-slate-800">
                                        <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Remove escalation</p>
                                        <textarea
                                            value={removeReason}
                                            onChange={(e) => setRemoveReason(e.target.value)}
                                            placeholder="Enter reason (minimum 10 characters)"
                                            rows={3}
                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500"
                                        />
                                        <button
                                            type="button"
                                            onClick={removeEscalation}
                                            disabled={removing}
                                            className="mt-3 bg-purple-600/15 hover:bg-purple-600/25 border border-purple-500/35 text-purple-300 px-3 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-60"
                                        >
                                            {removing ? 'Removing…' : 'Remove escalation'}
                                        </button>
                                    </div>
                                ) : null}

                                {canResolve ? (
                                    <div className="pt-4 border-t border-slate-800 mt-4">
                                        <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider flex items-center gap-2">
                                            <Gavel className="w-3.5 h-3.5" /> Resolution actions
                                        </p>
                                        {selected.isResolved ? (
                                            <div className="space-y-3">
                                                <p className="text-sm text-emerald-300">
                                                    Resolved
                                                    {selected.resolutionTag
                                                        ? ` — ${selected.resolutionTag.replace(/_/g, ' ')}`
                                                        : ''}
                                                    {selected.resolvedAt
                                                        ? ` · ${new Date(selected.resolvedAt).toLocaleString()}`
                                                        : ''}
                                                </p>
                                                {canReopen ? (
                                                    <>
                                                        <textarea
                                                            value={reopenNotes}
                                                            onChange={(e) => setReopenNotes(e.target.value.slice(0, 500))}
                                                            rows={2}
                                                            placeholder="Reopen note (optional, internal)"
                                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={reopenReport}
                                                            disabled={busy}
                                                            className="bg-amber-600/15 hover:bg-amber-600/25 border border-amber-500/35 text-amber-300 px-3 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-60"
                                                        >
                                                            {busy ? 'Reopening…' : 'Reopen report'}
                                                        </button>
                                                    </>
                                                ) : (
                                                    <p className="text-xs text-slate-500">
                                                        Only law enforcement accounts can reopen a resolved incident.
                                                    </p>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="space-y-3">
                                                <select
                                                    value={tag}
                                                    onChange={(e) => setTag(e.target.value)}
                                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100"
                                                >
                                                    {RESOLUTION_TAGS.map((o) => (
                                                        <option key={o.value} value={o.value}>
                                                            {o.label}
                                                        </option>
                                                    ))}
                                                </select>
                                                <textarea
                                                    value={notes}
                                                    onChange={(e) => setNotes(e.target.value.slice(0, 500))}
                                                    rows={3}
                                                    placeholder="Internal notes (optional, max 500)"
                                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500"
                                                />
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
                                                    onClick={resolveReport}
                                                    disabled={busy || !confirmed}
                                                    className="bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/35 text-emerald-300 px-3 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-60"
                                                >
                                                    {busy ? 'Resolving…' : 'Resolve report'}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ) : null}

                                {canResolve ? (
                                    <div className="pt-4 border-t border-slate-800 mt-4">
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
                                ) : null}

                                {actionError ? (
                                    <p className="text-xs text-rose-400 mt-3 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5">
                                        {actionError}
                                    </p>
                                ) : null}
                            </div>
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center text-center py-24 border border-dashed border-slate-800 rounded-2xl">
                                <Eye className="w-12 h-12 text-slate-700 mb-4" />
                                <p className="text-slate-400 font-medium">Select a report</p>
                                <p className="text-slate-600 text-sm">
                                    Pick an escalated or verified report from the list to take action.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
