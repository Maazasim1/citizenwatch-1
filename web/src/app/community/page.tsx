'use client';

import { useCallback, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { MapPin, ThumbsUp, ThumbsDown, LogIn } from 'lucide-react';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

type VoteType = 'CONFIRM' | 'DISPUTE';

interface DashboardReport {
    id: string;
    title: string;
    description: string;
    type: string;
    latitude: number;
    longitude: number;
    status: string;
    severity: number | null;
    createdAt: string;
    authorId: string;
    voteScore: number;
    communityConfirmed: boolean;
    confirmCount: number;
    disputeCount: number;
    myVote: VoteType | null;
    isResolved?: boolean;
    resolutionTag?: string | null;
    resolvedAt?: string | null;
}

export default function CommunityPage() {
    const { user, token } = useAuth();
    const [verified, setVerified] = useState<DashboardReport[]>([]);
    const [pending, setPending] = useState<DashboardReport[]>([]);
    const [loading, setLoading] = useState(true);
    const [actionError, setActionError] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/community-dashboard`, {}, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to load dashboard');
            setVerified(Array.isArray(data.verified) ? data.verified : []);
            setPending(Array.isArray(data.pending) ? data.pending : []);
        } catch (e) {
            console.error(e);
            setVerified([]);
            setPending([]);
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        const socket: Socket = io(getApiBaseUrl());
        socket.on('report:voted', () => {
            void load();
        });
        socket.on('report:moderated', () => {
            void load();
        });
        socket.on('report:resolved', () => {
            void load();
        });
        socket.on('report:reopened', () => {
            void load();
        });
        return () => {
            socket.disconnect();
        };
    }, [load]);

    const vote = async (reportId: string, voteType: VoteType) => {
        setActionError((prev) => ({ ...prev, [reportId]: '' }));
        if (!token || !user) {
            setActionError((prev) => ({ ...prev, [reportId]: 'Sign in to vote.' }));
            return;
        }
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${reportId}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voteType }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const msg =
                    typeof data.error === 'string'
                        ? data.error
                        : res.status === 429
                          ? 'Too many votes from this network. Try again in a little while.'
                          : 'Vote failed';
                setActionError((prev) => ({ ...prev, [reportId]: msg }));
                return;
            }
            await load();
        } catch {
            setActionError((prev) => ({ ...prev, [reportId]: 'Network error' }));
        }
    };

    const clearVote = async (reportId: string) => {
        setActionError((prev) => ({ ...prev, [reportId]: '' }));
        if (!token) return;
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${reportId}/vote`, { method: 'DELETE' }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setActionError((prev) => ({ ...prev, [reportId]: data.error || 'Could not remove vote' }));
                return;
            }
            await load();
        } catch {
            setActionError((prev) => ({ ...prev, [reportId]: 'Network error' }));
        }
    };

    const ReportCard = ({ r }: { r: DashboardReport }) => {
        const own = user?.id === r.authorId;
        const net = r.confirmCount - r.disputeCount;
        const resolved = Boolean(r.isResolved);
        const tagLabel = r.resolutionTag ? r.resolutionTag.replace(/_/g, ' ') : '';
        const isCitizen = user?.role === 'CITIZEN';
        const isReadOnlyRole = user?.role === 'MODERATOR' || user?.role === 'LAW_ENFORCEMENT';

        return (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
                <div className="flex justify-between items-start gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                        {r.type.replace(/_/g, ' ')}
                    </span>
                    {resolved ? (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded">
                            Resolved
                        </span>
                    ) : r.communityConfirmed ? (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded">
                            Community-confirmed
                        </span>
                    ) : null}
                </div>
                <h3 className="font-semibold text-slate-100 text-sm leading-snug">{r.title}</h3>
                {resolved ? (
                    <div className="mt-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                        {tagLabel ? <p className="font-semibold text-emerald-200">Outcome: {tagLabel}</p> : null}
                        {r.resolvedAt ? (
                            <p className="text-emerald-100/90 mt-1">Resolved {new Date(r.resolvedAt).toLocaleString()}</p>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-xs text-slate-500 mt-1 line-clamp-3">{r.description}</p>
                )}
                <div className="flex flex-wrap gap-2 mt-3 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1">
                        <ThumbsUp className="w-3.5 h-3.5 text-emerald-400" /> {r.confirmCount} witnessed
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <ThumbsDown className="w-3.5 h-3.5 text-amber-400" /> {r.disputeCount} doubted
                    </span>
                    <span className="text-slate-300 font-mono">Net {net}</span>
                </div>
                <p className="text-[10px] text-slate-600 mt-2 flex items-center gap-1">
                    <MapPin className="w-3 h-3 shrink-0" />
                    {r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}
                </p>

                {actionError[r.id] ? (
                    <p className="text-xs text-rose-400 mt-2 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5">{actionError[r.id]}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                    {resolved ? (
                        <p className="text-xs text-slate-500">Voting is closed for this resolved incident.</p>
                    ) : !user ? (
                        <Link
                            href="/login"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200"
                        >
                            <LogIn className="w-3.5 h-3.5" /> Log in to vote
                        </Link>
                    ) : isReadOnlyRole ? (
                        <p className="text-xs text-slate-400">✓ {r.confirmCount} confirmed · ✗ {r.disputeCount} disputed</p>
                    ) : own ? (
                        <p className="text-xs text-slate-500">You can’t vote on your own report.</p>
                    ) : isCitizen ? (
                        <>
                            <button
                                type="button"
                                onClick={() => vote(r.id, 'CONFIRM')}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25"
                            >
                                I witnessed this
                            </button>
                            <button
                                type="button"
                                onClick={() => vote(r.id, 'DISPUTE')}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-200 border border-amber-500/30 hover:bg-amber-500/25"
                            >
                                I doubt this
                            </button>
                            {r.myVote ? (
                                <button
                                    type="button"
                                    onClick={() => clearVote(r.id)}
                                    className="text-xs text-slate-400 hover:text-slate-200 underline"
                                >
                                    Remove my vote
                                </button>
                            ) : null}
                        </>
                    ) : (
                        <p className="text-xs text-slate-500">Voting is available to citizens only.</p>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold">Community voting</h1>
                    <p className="text-slate-400 text-sm mt-1 max-w-2xl">
                        Authenticated users can confirm or dispute reports. At +10 net confirms, a report is tagged{' '}
                        <strong className="text-emerald-300">Community-confirmed</strong> and rises in the moderation queue — it
                        is <strong>not</strong> auto-approved.
                    </p>
                </div>

                {loading ? (
                    <div className="text-slate-500 text-sm py-12 text-center">Loading…</div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        <section>
                            <h2 className="text-lg font-semibold text-emerald-400 mb-3 flex items-center gap-2">
                                Verified <span className="text-slate-500 text-sm font-normal">({verified.length})</span>
                            </h2>
                            <div className="space-y-3">
                                {verified.length === 0 ? (
                                    <p className="text-slate-500 text-sm">No verified reports to show.</p>
                                ) : (
                                    verified.map((r) => <ReportCard key={r.id} r={r} />)
                                )}
                            </div>
                        </section>
                        <section>
                            <h2 className="text-lg font-semibold text-amber-400 mb-3 flex items-center gap-2">
                                Pending <span className="text-slate-500 text-sm font-normal">({pending.length})</span>
                            </h2>
                            <div className="space-y-3">
                                {pending.length === 0 ? (
                                    <p className="text-slate-500 text-sm">No pending reports.</p>
                                ) : (
                                    pending.map((r) => <ReportCard key={r.id} r={r} />)
                                )}
                            </div>
                        </section>
                    </div>
                )}
            </main>
        </div>
    );
}
