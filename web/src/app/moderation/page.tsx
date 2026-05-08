'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert, CheckCircle, XCircle, AlertOctagon, Clock, Eye } from 'lucide-react';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';

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
    author: {
        email: string | null;
        phone: string | null;
        credibilityScore?: number;
        credibilityTier?: 'TRUSTED' | 'STANDARD' | 'FLAGGED' | 'RESTRICTED';
    };
    multimedia: { url: string; type: string }[];
    isDuplicate: boolean;
    duplicateOfId: string | null;
    voteScore?: number;
    communityConfirmed?: boolean;
    witnessNotified?: number;
    witnessCorroborated?: number;
    witnessDisputed?: number;
    isResolved?: boolean;
    resolutionTag?: string | null;
    resolvedAt?: string | null;
}

const statusColors: Record<string, string> = {
    PENDING: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
    VERIFIED: 'text-green-400 bg-green-400/10 border-green-400/20',
    REJECTED: 'text-red-400 bg-red-400/10 border-red-400/20',
    ESCALATED: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
};

export default function ModerationPage() {
    const { token, user } = useAuth();
    const [reports, setReports] = useState<Report[]>([]);
    const [selected, setSelected] = useState<Report | null>(null);
    const [loading, setLoading] = useState(true);
    // Threshold for FR-28 "low-confidence classifications flagged for review".
    // Chosen to make the pilot demo observable with the current heuristic model.
    const LOW_CONFIDENCE_THRESHOLD = 0.8;
    const [moderationReason, setModerationReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [voteLog, setVoteLog] = useState<
        { id: string; voteType: string; voteLat: number; voteLng: number; createdAt: string; user: { id: string; email: string | null; phone: string | null; voteAbuseFlaggedAt: string | null } }[]
        | null
    >(null);
    const [voteLogLoading, setVoteLogLoading] = useState(false);

    const canModerate = user?.role === 'MODERATOR' || user?.role === 'ADMIN';

    const fetchReports = () => {
        setLoading(true);
        if (!token || !canModerate) {
            setReports([]);
            setLoading(false);
            return;
        }

        fetch(`${API_BASE}/api/reports/queue?lowConfidenceThreshold=${LOW_CONFIDENCE_THRESHOLD}`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        })
            .then((res) => res.json())
            .then((data) => { setReports(data.reports || []); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(() => { fetchReports(); }, [token, canModerate]);

    useEffect(() => {
        setVoteLog(null);
    }, [selected?.id]);

    const loadVoteLog = async () => {
        if (!token || !selected || !canModerate) return;
        setVoteLogLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/reports/${selected.id}/votes`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to load votes');
            setVoteLog(Array.isArray(data.votes) ? data.votes : []);
        } catch {
            setVoteLog([]);
        } finally {
            setVoteLogLoading(false);
        }
    };

    const handleAction = async (reportId: string, action: 'VERIFIED' | 'REJECTED' | 'ESCALATED') => {
        try {
            setError('');
            const trimmed = moderationReason.trim();

            if (!token) {
                setError('You must be signed in to moderate.');
                return;
            }

            if (!canModerate) {
                setError('You are not authorized to moderate.');
                return;
            }

            setSubmitting(true);
            const res = await fetch(`${API_BASE}/api/reports/${reportId}/moderate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ status: action, reason: trimmed }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Moderation failed');
            }

            setSelected(null);
            setModerationReason('');
            fetchReports();
        } catch (e: any) {
            setError(e?.message || 'Moderation failed');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="flex items-center gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2"><ShieldAlert className="w-6 h-6 text-indigo-500" /> Moderation Queue</h1>
                        <p className="text-slate-400 text-sm mt-1">Review and verify incoming citizen reports</p>
                    </div>
                    <span className="ml-auto text-sm bg-slate-800 border border-slate-700 text-slate-300 px-4 py-2 rounded-lg">
                        {reports.filter(r => r.status === 'PENDING').length} Pending · {reports.filter(r => r.status === 'VERIFIED' && r.severityConfidence !== null && r.severityConfidence < LOW_CONFIDENCE_THRESHOLD).length} Low-confidence verified
                    </span>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

                    {/* Report Queue */}
                    <div className="lg:col-span-2 space-y-3">
                        {!canModerate ? (
                            <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl px-4">
                                <CheckCircle className="w-10 h-10 text-amber-300 mx-auto mb-3 opacity-80" />
                                <p className="text-slate-400 font-medium">Not authorized</p>
                                <p className="text-slate-500 text-sm mt-2">
                                    Only <span className="text-slate-200 font-semibold">Moderators</span> can review and moderate the queue.
                                </p>
                            </div>
                        ) : loading ? (
                            <div className="text-slate-500 text-sm text-center py-12">Loading queue...</div>
                        ) : reports.length === 0 ? (
                            <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl">
                                <CheckCircle className="w-10 h-10 text-green-500 mx-auto mb-3 opacity-60" />
                                <p className="text-slate-400 font-medium">Queue is clear!</p>
                                <p className="text-slate-500 text-sm">No reports pending review.</p>
                            </div>
                        ) : (
                            reports.map((report) => (
                                <button
                                    key={report.id}
                                    onClick={() => {
                                        setSelected(report);
                                        setModerationReason('');
                                        setError('');
                                    }}
                                    className={`w-full text-left bg-slate-900 border rounded-xl p-4 transition-all shadow-sm relative overflow-hidden ${selected?.id === report.id ? 'border-indigo-500 bg-indigo-500/5' : 'border-slate-800 hover:border-slate-700'}`}
                                >
                                    <div className={`absolute left-0 top-0 bottom-0 w-1 ${report.severity && report.severity > 5 ? 'bg-rose-500' : 'bg-amber-500'}`} />
                                    <div className="pl-3">
                                        <div className="flex justify-between items-start mb-1">
                                            <div className="flex gap-2 items-center">
                                                <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${statusColors[report.status]}`}>
                                                    {report.status}
                                                </span>
                                                {report.isDuplicate && (
                                                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-rose-500 bg-rose-500/10 border-rose-500/20">
                                                        DUPLICATE
                                                    </span>
                                                )}
                                                {report.communityConfirmed ? (
                                                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-emerald-400 bg-emerald-500/10 border-emerald-500/25">
                                                        COMMUNITY
                                                    </span>
                                                ) : null}
                                                {report.author?.credibilityTier === 'TRUSTED' ? (
                                                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-cyan-300 bg-cyan-500/10 border-cyan-500/25">
                                                        TRUSTED REPORTER
                                                    </span>
                                                ) : null}
                                                {report.author?.credibilityTier === 'RESTRICTED' ? (
                                                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-rose-300 bg-rose-500/10 border-rose-500/25">
                                                        RESTRICTED
                                                    </span>
                                                ) : null}
                                            </div>
                                            <span className="text-xs text-slate-500">
                                                {new Date(report.createdAt).toLocaleDateString()}
                                            </span>
                                        </div>
                                        <p className="font-semibold text-slate-100 text-sm mt-2">{report.title}</p>
                                        <p className="text-xs text-slate-400 mt-1 line-clamp-2">{report.description}</p>
                                        <div className="flex items-center gap-2 mt-3">
                                            <span className="text-xs text-slate-500">{report.type.replace(/_/g, ' ')}</span>
                                            {report.multimedia.length > 0 && (
                                                <span className="text-xs text-indigo-400 flex items-center gap-1">
                                                    <Eye className="w-3 h-3" /> {report.multimedia.length} attachment(s)
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>

                    {/* Detail Panel */}
                    <div className="lg:col-span-3">
                        {selected ? (
                            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sticky top-24">
                                <div className="flex items-start justify-between mb-6">
                                    <div>
                                        <h2 className="text-xl font-bold text-slate-100">{selected.title}</h2>
                                        <p className="text-sm text-slate-400 mt-1">
                                            Submitted by: {selected.author?.email || selected.author?.phone || 'Anonymous'}
                                        </p>
                                        <p className="text-xs text-slate-500 mt-1">
                                            Credibility tier: {selected.author?.credibilityTier || 'STANDARD'}
                                            {typeof selected.author?.credibilityScore === 'number'
                                                ? ` (${selected.author.credibilityScore})`
                                                : ''}
                                        </p>
                                    </div>
                                    <span className={`text-xs px-3 py-1 rounded-full border font-semibold ${statusColors[selected.status]}`}>
                                        {selected.status}
                                    </span>
                                </div>

                                {selected.isDuplicate && (
                                    <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 mb-6 flex items-start gap-3">
                                        <ShieldAlert className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                                        <div>
                                            <p className="text-sm font-semibold text-rose-400">Potential Duplicate Detected</p>
                                            <p className="text-xs text-rose-400/80 mt-1">
                                                This report was submitted within 15 minutes and 200 meters of an existing report (ID: {selected.duplicateOfId}). Review carefully before verifying.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {selected.status === 'VERIFIED' ? (
                                    <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4 mb-4">
                                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                                            Law enforcement resolution
                                        </p>
                                        {selected.isResolved ? (
                                            <p className="text-sm text-emerald-300">
                                                Resolved
                                                {selected.resolutionTag
                                                    ? ` — ${selected.resolutionTag.replace(/_/g, ' ')}`
                                                    : ''}
                                                {selected.resolvedAt
                                                    ? ` · ${new Date(selected.resolvedAt).toLocaleString()}`
                                                    : ''}
                                            </p>
                                        ) : (
                                            <p className="text-sm text-slate-400">
                                                Open — inspectors can resolve from the{' '}
                                                <Link href="/inspector/resolutions" className="text-indigo-400 hover:text-indigo-300 font-semibold">
                                                    Resolutions
                                                </Link>{' '}
                                                console.
                                            </p>
                                        )}
                                    </div>
                                ) : null}

                                <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4 mb-4">
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Witness prompts</p>
                                    <p className="text-sm text-slate-200">
                                        Notified:{' '}
                                        <span className="font-mono font-bold">{selected.witnessNotified ?? 0}</span>
                                        <span className="text-slate-500 mx-2">|</span>
                                        Corroborated:{' '}
                                        <span className="font-mono font-bold text-emerald-400">{selected.witnessCorroborated ?? 0}</span>
                                        <span className="text-slate-500 mx-2">|</span>
                                        Disputed:{' '}
                                        <span className="font-mono font-bold text-amber-400">{selected.witnessDisputed ?? 0}</span>
                                    </p>
                                    <p className="text-xs text-slate-500 mt-2">
                                        Nearby users with a saved alert point receive a time-limited prompt; no response does not add a vote.
                                    </p>
                                </div>

                                <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4 mb-6">
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Community votes</p>
                                    <p className="text-sm text-slate-200">
                                        Net score: <span className="font-mono font-bold">{selected.voteScore ?? 0}</span>
                                        {selected.communityConfirmed ? (
                                            <span className="ml-2 text-emerald-400 font-semibold">· Community-confirmed (queue priority)</span>
                                        ) : null}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => void loadVoteLog()}
                                        className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
                                    >
                                        {voteLogLoading ? 'Loading vote log…' : voteLog ? 'Refresh vote log' : 'Load vote log (moderators)'}
                                    </button>
                                    {voteLog && voteLog.length > 0 ? (
                                        <ul className="mt-3 max-h-40 overflow-y-auto text-xs text-slate-400 space-y-1 border-t border-slate-700 pt-2">
                                            {voteLog.map((v) => (
                                                <li key={v.id} className="flex justify-between gap-2">
                                                    <span className={v.voteType === 'CONFIRM' ? 'text-emerald-400' : 'text-amber-400'}>{v.voteType}</span>
                                                    <span className="truncate text-slate-500">
                                                        {v.user.email || v.user.phone || v.user.id.slice(0, 8)}
                                                        {v.user.voteAbuseFlaggedAt ? ' · flagged' : ''}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : voteLog && voteLog.length === 0 ? (
                                        <p className="mt-2 text-xs text-slate-500">No votes yet.</p>
                                    ) : null}
                                </div>

                                <div className="grid grid-cols-2 gap-4 mb-6">
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Crime Type</p>
                                        <p className="text-sm font-medium text-slate-200">{selected.type.replace(/_/g, ' ')}</p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">AI Severity</p>
                                        <p className="text-sm font-medium text-slate-200">
                                            {selected.severity === null ? 'Unscored' : `${selected.severity} / 10`}
                                        </p>

                                        <p className="text-xs text-slate-500 mt-3 mb-1">Confidence</p>
                                        <p className="text-sm font-medium text-slate-200">
                                            {selected.severityConfidence === null
                                                ? 'Unscored'
                                                : `${Math.round((selected.severityConfidence ?? 0) * 100)}%`}
                                        </p>

                                        {selected.status === 'VERIFIED' &&
                                        selected.severityConfidence !== null &&
                                        selected.severityConfidence < LOW_CONFIDENCE_THRESHOLD ? (
                                            <p className="text-xs text-amber-400 mt-2 font-semibold">
                                                Low confidence: review recommended
                                            </p>
                                        ) : null}
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Location</p>
                                        <p className="text-sm font-mono text-slate-200">{selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}</p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Reported At</p>
                                        <p className="text-sm text-slate-200">{new Date(selected.createdAt).toLocaleString()}</p>
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
                                                <a
                                                    key={i}
                                                    href={m.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="bg-slate-800 border border-slate-700 text-indigo-400 hover:text-indigo-300 px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 transition-colors"
                                                >
                                                    <Eye className="w-3 h-3" />
                                                    {m.type === 'VIDEO' ? 'View Video' : 'View Image'} #{i + 1}
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Action Buttons */}
                                {(selected.status === 'PENDING' || (selected.status === 'VERIFIED' && (selected.severityConfidence ?? 1) < LOW_CONFIDENCE_THRESHOLD)) && (
                                    <div className="pt-4 border-t border-slate-800">
                                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">
                                            Moderator Reason
                                        </label>
                                        <textarea
                                            value={moderationReason}
                                            onChange={(e) => setModerationReason(e.target.value)}
                                            placeholder="Add a short reason note for audit trail..."
                                            rows={3}
                                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors resize-none"
                                        />

                                        {error ? (
                                            <div className="mt-3 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl px-4 py-3">
                                                {error}
                                            </div>
                                        ) : null}

                                        <div className="flex gap-3 pt-4">
                                            <button
                                            onClick={() => handleAction(selected.id, 'VERIFIED')}
                                            disabled={submitting}
                                                className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95 shadow-lg shadow-green-600/20"
                                            >
                                                <CheckCircle className="w-4 h-4" /> Approve
                                            </button>
                                            <button
                                            onClick={() => handleAction(selected.id, 'ESCALATED')}
                                            disabled={submitting}
                                                className="flex-1 flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95 shadow-lg shadow-purple-600/20"
                                            >
                                                <AlertOctagon className="w-4 h-4" /> Escalate
                                            </button>
                                            <button
                                            onClick={() => handleAction(selected.id, 'REJECTED')}
                                            disabled={submitting}
                                                className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-red-700 text-slate-200 hover:text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95"
                                            >
                                                <XCircle className="w-4 h-4" /> Reject
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center text-center py-24 border border-dashed border-slate-800 rounded-2xl">
                                <Clock className="w-12 h-12 text-slate-700 mb-4" />
                                <p className="text-slate-400 font-medium">Select a report</p>
                                <p className="text-slate-600 text-sm">Click any report from the queue to review it here</p>
                            </div>
                        )}
                    </div>

                </div>
            </div>
        </div>
    );
}
