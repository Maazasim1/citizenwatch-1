'use client';

import { useEffect, useState } from 'react';
import { UserSearch, ShieldCheck, Send, Archive, Eye, AlertTriangle, CheckCircle } from 'lucide-react';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';

const API = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';

interface SuspectReview {
    id: string;
    reportId: string;
    multimediaId: string;
    isolatedPath: string;
    status: string;
    reviewedById: string | null;
    matchResults: string | null;
    createdAt: string;
    report: {
        id: string;
        title: string;
        description: string;
        type: string;
        latitude: number;
        longitude: number;
        createdAt: string;
        author: { email: string | null; phone: string | null };
        multimedia: { id: string; url: string; type: string }[];
    };
}

const statusConfig: Record<string, { label: string; cls: string }> = {
    PENDING_REVIEW: { label: 'Pending Review', cls: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
    SUBMITTED_FOR_MATCHING: { label: 'Matching...', cls: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
    MATCHED: { label: 'Match Found', cls: 'text-rose-400 bg-rose-400/10 border-rose-400/20' },
    NO_MATCH: { label: 'No Match', cls: 'text-green-400 bg-green-400/10 border-green-400/20' },
    ARCHIVED: { label: 'Archived', cls: 'text-slate-400 bg-slate-800 border-slate-700' },
};

export default function SuspectReviewPage() {
    const { token, user } = useAuth();
    const [reviews, setReviews] = useState<SuspectReview[]>([]);
    const [selected, setSelected] = useState<SuspectReview | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    const canAccess = user?.role === 'MODERATOR' || user?.role === 'LAW_ENFORCEMENT' || user?.role === 'ADMIN';
    const headers = { Authorization: `Bearer ${token}` };

    const fetchReviews = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API}/api/cctv/suspect-reviews`, { headers });
            const data = await res.json();
            if (data.reviews) setReviews(data.reviews);
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    useEffect(() => {
        if (!token || !canAccess) return;
        fetchReviews();
    }, [token, canAccess]);

    const handleSubmitForMatching = async (reviewId: string) => {
        setSubmitting(true);
        try {
            const res = await fetch(`${API}/api/cctv/suspect-reviews/${reviewId}/submit-for-matching`, {
                method: 'POST',
                headers,
            });
            const data = await res.json();
            if (res.ok) {
                fetchReviews();
                if (data.matches?.length > 0) {
                    setSelected((prev) => prev ? { ...prev, status: 'MATCHED', matchResults: JSON.stringify(data.matches) } : prev);
                } else {
                    setSelected((prev) => prev ? { ...prev, status: 'NO_MATCH' } : prev);
                }
            }
        } catch (e) { console.error(e); }
        setSubmitting(false);
    };

    const handleArchive = async (reviewId: string) => {
        try {
            await fetch(`${API}/api/cctv/suspect-reviews/${reviewId}/archive`, {
                method: 'POST',
                headers,
            });
            fetchReviews();
            setSelected(null);
        } catch (e) { console.error(e); }
    };

    if (!canAccess) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
                <Navbar />
                <div className="flex items-center justify-center h-[60vh]">
                    <div className="text-center">
                        <UserSearch className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-400">Suspect Photo Review is restricted to authorized personnel.</p>
                    </div>
                </div>
            </div>
        );
    }

    const pendingCount = reviews.filter(r => r.status === 'PENDING_REVIEW').length;
    const matchedCount = reviews.filter(r => r.status === 'MATCHED').length;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
                        <UserSearch className="w-5 h-5 text-rose-400" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold">Suspect Photo Review</h1>
                        <p className="text-slate-400 text-sm">
                            Auto-flagged citizen photos containing human faces · Secluded moderator review
                        </p>
                    </div>
                    <div className="ml-auto flex gap-2 items-center">
                        <span className="text-xs bg-amber-500/10 text-amber-400 px-3 py-1.5 rounded-full border border-amber-500/20 font-semibold">
                            {pendingCount} Pending
                        </span>
                        {matchedCount > 0 && (
                            <span className="text-xs bg-rose-500/10 text-rose-400 px-3 py-1.5 rounded-full border border-rose-500/20 font-semibold">
                                {matchedCount} Matched
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={fetchReviews}
                            className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-full font-semibold transition-all"
                        >
                            Refresh
                        </button>
                    </div>
                </div>

                {/* Isolation notice */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-slate-400 leading-relaxed">
                        These photos are stored in an <span className="text-slate-200 font-semibold">isolated evidence store</span> — 
                        they are never surfaced to other users or the public database. 
                        All match results are advisory and require human confirmation (PRD FR-56).
                    </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                    {/* Review Queue */}
                    <div className="lg:col-span-2 space-y-3 max-h-[calc(100vh-14rem)] overflow-y-auto pr-2">
                        {loading ? (
                            <div className="text-slate-500 text-sm text-center py-12">Loading...</div>
                        ) : reviews.length === 0 ? (
                            <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl">
                                <CheckCircle className="w-10 h-10 text-green-500 mx-auto mb-3 opacity-60" />
                                <p className="text-slate-400 font-medium">No flagged photos</p>
                                <p className="text-slate-500 text-sm">Only citizen report images where a face is detected are queued here.</p>
                            </div>
                        ) : (
                            reviews.map((review) => {
                                const sc = statusConfig[review.status] || statusConfig.PENDING_REVIEW;
                                return (
                                    <button
                                        key={review.id}
                                        onClick={() => setSelected(review)}
                                        className={`w-full text-left bg-slate-900 border rounded-xl p-4 transition-all shadow-sm relative overflow-hidden ${
                                            selected?.id === review.id ? 'border-rose-500 bg-rose-500/5' : 'border-slate-800 hover:border-slate-700'
                                        }`}
                                    >
                                        <div className={`absolute left-0 top-0 bottom-0 w-1 ${review.status === 'MATCHED' ? 'bg-rose-500' : review.status === 'PENDING_REVIEW' ? 'bg-amber-500' : 'bg-slate-700'}`} />
                                        <div className="pl-3">
                                            <div className="flex justify-between items-start mb-1">
                                                <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${sc.cls}`}>
                                                    {sc.label}
                                                </span>
                                                <span className="text-xs text-slate-500">
                                                    {new Date(review.createdAt).toLocaleDateString()}
                                                </span>
                                            </div>
                                            <p className="font-semibold text-slate-100 text-sm mt-2">{review.report.title}</p>
                                            <p className="text-xs text-slate-400 mt-1">{review.report.type.replace(/_/g, ' ')}</p>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </div>

                    {/* Detail Panel */}
                    <div className="lg:col-span-3">
                        {selected ? (
                            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sticky top-24">
                                <div className="flex items-start justify-between mb-6">
                                    <div>
                                        <h2 className="text-xl font-bold text-slate-100">{selected.report.title}</h2>
                                        <p className="text-sm text-slate-400 mt-1">
                                            Submitted by: {selected.report.author?.email || selected.report.author?.phone || 'Anonymous'}
                                        </p>
                                    </div>
                                    <span className={`text-xs px-3 py-1 rounded-full border font-semibold ${statusConfig[selected.status]?.cls}`}>
                                        {statusConfig[selected.status]?.label}
                                    </span>
                                </div>

                                <div className="grid grid-cols-2 gap-4 mb-6">
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Crime Type</p>
                                        <p className="text-sm font-medium text-slate-200">{selected.report.type.replace(/_/g, ' ')}</p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Location</p>
                                        <p className="text-sm font-mono text-slate-200">{selected.report.latitude.toFixed(4)}, {selected.report.longitude.toFixed(4)}</p>
                                    </div>
                                </div>

                                <div className="mb-6">
                                    <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Description</p>
                                    <p className="text-sm text-slate-300 leading-relaxed bg-slate-800/30 rounded-xl p-4 border border-slate-700/50">
                                        {selected.report.description}
                                    </p>
                                </div>

                                {/* Flagged photo */}
                                <div className="mb-6">
                                    <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider flex items-center gap-1">
                                        <Eye className="w-3 h-3" /> Flagged Photo (Isolated)
                                    </p>
                                    {selected.report.multimedia.map((m, i) => (
                                        m.type === 'IMAGE' && (
                                            <div key={i} className="bg-slate-950 border border-slate-700 rounded-xl overflow-hidden max-w-sm">
                                                <img src={m.url} alt="Flagged" className="w-full max-h-64 object-contain" />
                                            </div>
                                        )
                                    ))}
                                </div>

                                {/* Match results */}
                                {selected.matchResults && (
                                    <div className="mb-6">
                                        <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Match Results</p>
                                        <div className="space-y-2">
                                            {JSON.parse(selected.matchResults).map((m: any, i: number) => (
                                                <div key={i} className="bg-rose-500/5 border border-rose-500/20 rounded-xl px-4 py-3 flex items-center justify-between">
                                                    <div>
                                                        <span className="text-sm font-semibold text-rose-300">{m.criminal_name}</span>
                                                        {m.fir_number && <span className="text-xs text-slate-400 ml-2">FIR: {m.fir_number}</span>}
                                                    </div>
                                                    <span className="text-sm font-bold text-rose-400">{(m.confidence * 100).toFixed(1)}%</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Action buttons */}
                                {selected.status === 'PENDING_REVIEW' && (
                                    <div className="flex gap-3 pt-4 border-t border-slate-800">
                                        <button
                                            onClick={() => handleSubmitForMatching(selected.id)}
                                            disabled={submitting}
                                            className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-60"
                                        >
                                            <Send className="w-4 h-4" /> {submitting ? 'Matching...' : 'Submit for Criminal DB Match'}
                                        </button>
                                        <button
                                            onClick={() => handleArchive(selected.id)}
                                            className="flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                                        >
                                            <Archive className="w-4 h-4" /> Archive
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center text-center py-24 border border-dashed border-slate-800 rounded-2xl">
                                <UserSearch className="w-12 h-12 text-slate-700 mb-4" />
                                <p className="text-slate-400 font-medium">Select a flagged report</p>
                                <p className="text-slate-600 text-sm">Click any item from the queue to review it</p>
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
