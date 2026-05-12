'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import Navbar from '../../../components/Navbar';
import { useAuth } from '../../../context/AuthContext';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

type InviteState =
    | { loading: true }
    | { loading: false; error: string }
    | {
          loading: false;
          hasInvite: false;
      }
    | {
          loading: false;
          hasInvite: true;
          canRespond: boolean;
          expiresAt: string;
          incidentType: string;
      };

export default function WitnessRespondPage() {
    const params = useParams();
    const reportId = typeof params?.reportId === 'string' ? params.reportId : '';
    const { token, loading: authLoading } = useAuth();

    const [invite, setInvite] = useState<InviteState>({ loading: true });
    const [note, setNote] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [doneMessage, setDoneMessage] = useState('');

    useEffect(() => {
        if (authLoading) return;
        if (!token) {
            setInvite({ loading: false, error: 'Sign in to respond to witness prompts.' });
            return;
        }
        if (!reportId) {
            setInvite({ loading: false, error: 'Invalid link.' });
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${getApiBaseUrl()}/api/reports/${reportId}/witness-invite`, {}, token);
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'Failed to load invite');
                if (cancelled) return;
                if (!data.hasInvite) {
                    setInvite({ loading: false, hasInvite: false });
                    return;
                }
                setInvite({
                    loading: false,
                    hasInvite: true,
                    canRespond: Boolean(data.canRespond),
                    expiresAt: data.expiresAt,
                    incidentType: String(data.incidentType ?? 'INCIDENT'),
                });
            } catch (e: any) {
                if (!cancelled) setInvite({ loading: false, error: e?.message || 'Failed to load' });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [authLoading, token, reportId]);

    const submit = async (response: 'CORROBORATED' | 'DISPUTED') => {
        if (!token || !reportId) return;
        setSubmitting(true);
        setDoneMessage('');
        try {
            const res = await authFetch(`${getApiBaseUrl()}/api/reports/${reportId}/witness-respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    response,
                    note: response === 'CORROBORATED' ? note : undefined,
                }),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not save your response');
            setInvite((prev) =>
                prev.loading || !('hasInvite' in prev) || !prev.hasInvite
                    ? prev
                    : { ...prev, canRespond: false },
            );
            setDoneMessage('Thank you. Your response was recorded.');
        } catch (e: any) {
            setDoneMessage(e?.message || 'Something went wrong');
        } finally {
            setSubmitting(false);
        }
    };

    const formatType = (t: string) => t.replace(/_/g, ' ');

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />
            <div className="max-w-lg mx-auto px-4 py-12">
                <h1 className="text-xl font-bold text-slate-100 mb-2">Witness check-in</h1>
                <p className="text-sm text-slate-400 mb-8">
                    An incident was reported near you. Did you witness anything? Your answer helps the community verify
                    reports. We never show who filed the report.
                </p>

                {invite.loading ? (
                    <p className="text-slate-500 text-sm">Loading…</p>
                ) : 'error' in invite ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                        {invite.error}
                        {!token ? (
                            <Link href="/login" className="block mt-3 text-indigo-400 font-semibold hover:text-indigo-300">
                                Sign in
                            </Link>
                        ) : null}
                    </div>
                ) : !invite.hasInvite ? (
                    <p className="text-slate-400 text-sm">
                        There is no witness prompt for this report on your account. It may have gone to another user or
                        the link may be invalid.
                    </p>
                ) : (
                    <div className="space-y-6">
                        <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
                            <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Category</p>
                            <p className="text-lg font-medium text-slate-200 mt-1">{formatType(invite.incidentType)}</p>
                            <p className="text-xs text-slate-500 mt-3">
                                Respond by {new Date(invite.expiresAt).toLocaleString()} or this prompt expires with no
                                vote recorded.
                            </p>
                        </div>

                        {!invite.canRespond ? (
                            <p
                                className={`text-sm ${
                                    doneMessage?.includes('Thank you') ? 'text-emerald-400 font-medium' : 'text-slate-400'
                                }`}
                            >
                                {doneMessage?.includes('Thank you')
                                    ? doneMessage
                                    : doneMessage || 'This prompt is no longer open (expired or already answered).'}
                            </p>
                        ) : (
                            <>
                                <div>
                                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                        Optional note (if you saw something, max 200 characters)
                                    </label>
                                    <textarea
                                        value={note}
                                        onChange={(e) => setNote(e.target.value.slice(0, 200))}
                                        rows={3}
                                        className="mt-2 w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                                        placeholder="What did you observe?"
                                    />
                                    <p className="text-xs text-slate-500 mt-1">{note.length} / 200</p>
                                </div>

                                <div className="flex flex-col sm:flex-row gap-3">
                                    <button
                                        type="button"
                                        disabled={submitting}
                                        onClick={() => void submit('CORROBORATED')}
                                        className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold"
                                    >
                                        Yes, I saw something
                                    </button>
                                    <button
                                        type="button"
                                        disabled={submitting}
                                        onClick={() => void submit('DISPUTED')}
                                        className="flex-1 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-sm font-semibold"
                                    >
                                        Nothing unusual
                                    </button>
                                </div>
                            </>
                        )}

                        {invite.canRespond && doneMessage && !doneMessage.includes('Thank you') ? (
                            <p className="text-rose-400 text-sm">{doneMessage}</p>
                        ) : null}

                        <Link href="/community" className="inline-block text-sm text-indigo-400 hover:text-indigo-300">
                            ← Back to community votes
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
