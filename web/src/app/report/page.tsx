'use client';

import { useState } from 'react';
import { MapPin, Camera, Send, CheckCircle } from 'lucide-react';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from 'next/navigation';
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';
import { useEffect } from 'react';

const crimeTypes = [
    'ARMED_ROBBERY',
    'VEHICLE_CRIME',
    'VANDALISM',
    'ASSAULT',
    'THEFT',
    'OTHER',
];

export default function ReportPage() {
    const { user, loading: authLoading } = useAuth();
    const router = useRouter();
    const [form, setForm] = useState({ title: '', description: '', type: '', latitude: '', longitude: '' });
    const [mediaFiles, setMediaFiles] = useState<File[]>([]);
    const [submitted, setSubmitted] = useState(false);
    const [locating, setLocating] = useState(false);
    const [loading, setLoading] = useState(false);
    const [submitError, setSubmitError] = useState('');

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

    const getLocation = () => {
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setForm((f) => ({ ...f, latitude: pos.coords.latitude.toString(), longitude: pos.coords.longitude.toString() }));
                setLocating(false);
            },
            () => {
                // Default to Karachi center if denied
                setForm((f) => ({ ...f, latitude: '24.8607', longitude: '67.0011' }));
                setLocating(false);
            }
        );
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setSubmitError('');
        try {
            const fd = new FormData();
            fd.append('title', form.title);
            fd.append('description', form.description);
            fd.append('type', form.type);
            fd.append('latitude', form.latitude);
            fd.append('longitude', form.longitude);
            for (const f of mediaFiles) {
                fd.append('media', f);
            }

            const res = await fetch(`${API_BASE}/api/reports/anonymous`, {
                method: 'POST',
                body: fd,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setSubmitError(data?.error || 'Failed to submit report. Please try again.');
                return;
            }
            setSubmitted(true);
        } catch {
            setSubmitError('Network error while submitting report. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    if (submitted) {
        return (
            <div className="min-h-screen bg-slate-950 flex items-center justify-center font-sans">
                <div className="text-center max-w-sm px-4">
                    <div className="w-20 h-20 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-6">
                        <CheckCircle className="w-10 h-10 text-green-400" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-100 mb-3">Report Submitted</h2>
                    <p className="text-slate-400 text-sm mb-8 leading-relaxed">
                        Your report has been submitted and is awaiting moderator review. Thank you for helping keep the community safe.
                    </p>
                    <Link href="/" className="bg-rose-600 hover:bg-rose-500 text-white px-8 py-3 rounded-xl font-semibold text-sm transition-all active:scale-95 shadow-lg shadow-rose-600/20">
                        Back to Map
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <main className="max-w-xl mx-auto px-4 py-12">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold mb-2">Submit a Report</h1>
                    <p className="text-slate-400">All reports are reviewed by a moderator before being published. You can report anonymously.</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {/* Title */}
                    <div>
                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Incident Title</label>
                        <input
                            type="text"
                            placeholder="Brief summary of the incident..."
                            value={form.title}
                            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                            required
                            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                    </div>

                    {/* Type */}
                    <div>
                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Crime Type</label>
                        <select
                            value={form.type}
                            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                            required
                            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 transition-colors appearance-none"
                        >
                            <option value="" disabled>Select crime type...</option>
                            {crimeTypes.map((t) => (
                                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                            ))}
                        </select>
                    </div>

                    {/* Description */}
                    <div>
                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Description</label>
                        <textarea
                            placeholder="Describe what happened, suspect descriptions, direction of travel..."
                            value={form.description}
                            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                            required
                            rows={4}
                            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors resize-none"
                        />
                    </div>

                    {/* Location */}
                    <div>
                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Incident Location</label>
                        <div className="flex gap-3">
                            <input
                                type="text"
                                placeholder="Latitude"
                                value={form.latitude}
                                onChange={(e) => setForm((f) => ({ ...f, latitude: e.target.value }))}
                                required
                                className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                            />
                            <input
                                type="text"
                                placeholder="Longitude"
                                value={form.longitude}
                                onChange={(e) => setForm((f) => ({ ...f, longitude: e.target.value }))}
                                required
                                className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                            />
                            <button
                                type="button"
                                onClick={getLocation}
                                disabled={locating}
                                className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white px-4 py-3 rounded-xl text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                                <MapPin className="w-4 h-4" />
                                {locating ? '...' : 'Use GPS'}
                            </button>
                        </div>
                    </div>

                    {/* Evidence Upload placeholder */}
                    <div className="border border-dashed border-slate-700 rounded-xl p-6 text-center hover:border-indigo-500 transition-colors cursor-pointer group">
                        <label className="block cursor-pointer">
                            <Camera className="w-8 h-8 text-slate-600 group-hover:text-indigo-400 mx-auto mb-2 transition-colors" />
                            <p className="text-sm text-slate-500 group-hover:text-slate-400 transition-colors">Attach photos or video (optional)</p>
                            <p className="text-xs text-slate-600 mt-1">JPG, PNG, MP4 · Max 100MB per file</p>

                            <input
                                type="file"
                                accept="image/*,video/*"
                                multiple
                                className="hidden"
                                onChange={(e) => {
                                    const list = e.target.files ? Array.from(e.target.files) : [];
                                    setMediaFiles(list);
                                }}
                            />
                        </label>

                        {mediaFiles.length > 0 ? (
                            <div className="mt-3 text-xs text-slate-400">
                                {mediaFiles.length} file(s) selected
                            </div>
                        ) : null}
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-rose-600 hover:bg-rose-500 text-white px-6 py-3.5 rounded-xl font-semibold text-sm transition-all active:scale-95 shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                        <Send className="w-4 h-4" />
                        {loading ? 'Submitting...' : 'Submit Report'}
                    </button>
                    {submitError ? (
                        <p className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                            {submitError}
                        </p>
                    ) : null}

                    <p className="text-xs text-slate-600 text-center leading-relaxed">
                        Reports are anonymous by default. Your IP address is not logged. All submissions are reviewed by a human moderator.
                    </p>
                </form>
            </main>
        </div>
    );
}
