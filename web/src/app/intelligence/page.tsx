'use client';

import { useState, useEffect } from 'react';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from 'next/navigation';
import { io } from 'socket.io-client';
import dynamic from 'next/dynamic';
import {
    Shield, ShieldAlert, Eye, CheckCircle, XCircle, Clock,
    User, MapPin, Camera, TrendingUp, Search, Trash2
} from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';
const MiniLocationMap = dynamic(() => import('../../components/MiniLocationMap'), {
    ssr: false,
});

interface FaceMatchRecord {
    id: string;
    criminalId: string;
    criminal: {
        id: string;
        name: string;
        firNumber: string | null;
        mugshotUrl: string | null;
        sampleCount: number;
    };
    detectionId: string | null;
    detection: any | null;
    detectionSource: string;
    confidence: number;
    latitude: number | null;
    longitude: number | null;
    spottedAt: string | null;
    frameSnapshot: string | null;
    reviewStatus: string;
    reviewedById: string | null;
    reviewNote: string | null;
    createdAt: string;
}

interface Stats {
    totalMatches: number;
    confirmedMatches: number;
    pendingMatches: number;
    totalCriminals: number;
}

const reviewStatusConfig: Record<string, { label: string; cls: string; icon: any }> = {
    PENDING_REVIEW: { label: 'Pending', cls: 'text-amber-400 bg-amber-400/10 border-amber-400/20', icon: Clock },
    CONFIRMED: { label: 'Confirmed', cls: 'text-green-400 bg-green-400/10 border-green-400/20', icon: CheckCircle },
    DISMISSED: { label: 'Dismissed', cls: 'text-slate-400 bg-slate-800 border-slate-700', icon: XCircle },
};

export default function IntelligencePage() {
    const { token, user, loading } = useAuth();
    const router = useRouter();
    const [matches, setMatches] = useState<FaceMatchRecord[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [selected, setSelected] = useState<FaceMatchRecord | null>(null);
    const [filterStatus, setFilterStatus] = useState<string>('ALL');
    const [liveAlerts, setLiveAlerts] = useState<any[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedLocationIds, setExpandedLocationIds] = useState<Record<string, boolean>>({});

    const canAccess = user?.role === 'LAW_ENFORCEMENT' || user?.role === 'ADMIN';

    useEffect(() => {
        if (!loading && !canAccess) {
            router.push('/');
        }
    }, [user, loading, router, canAccess]);

    useEffect(() => {
        if (!token || !canAccess) return;
        fetchIntelligence();
    }, [token, canAccess]);

    // WebSocket for live alerts
    useEffect(() => {
        if (!user || !canAccess) return;
        const socket = io(API);
        socket.on('criminal:matched', (data: any) => {
            setLiveAlerts(prev => [data, ...prev].slice(0, 10));
            // Refresh intelligence feed
            fetchIntelligence();
        });
        return () => { socket.disconnect(); };
    }, [user, canAccess]);

    const fetchIntelligence = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`${API}/api/cctv/intelligence-feed`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setMatches(data.matches || []);
                setStats(data.stats || null);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleReview = async (matchId: string, status: 'CONFIRMED' | 'DISMISSED') => {
        try {
            const res = await fetch(`${API}/api/cctv/matches/${matchId}/review`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ status }),
            });
            if (res.ok) {
                fetchIntelligence();
                setSelected(prev => prev?.id === matchId ? { ...prev, reviewStatus: status } : prev);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleDeleteMatch = async (matchId: string) => {
        try {
            const res = await fetch(`${API}/api/cctv/matches/${matchId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                setMatches(prev => prev.filter(m => m.id !== matchId));
                setSelected(prev => (prev?.id === matchId ? null : prev));
                fetchIntelligence();
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleClearMatches = async () => {
        try {
            const res = await fetch(`${API}/api/cctv/matches`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                setMatches([]);
                setSelected(null);
                setLiveAlerts([]);
                fetchIntelligence();
            }
        } catch (e) {
            console.error(e);
        }
    };

    if (loading || !user) return <div className="min-h-screen bg-slate-950" />;

    if (!canAccess) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
                <Navbar />
                <div className="flex items-center justify-center h-[60vh]">
                    <div className="text-center">
                        <Shield className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-400">Intelligence Dashboard is restricted to authorized personnel.</p>
                    </div>
                </div>
            </div>
        );
    }

    const filteredMatches = matches.filter(m => {
        if (filterStatus !== 'ALL' && m.reviewStatus !== filterStatus) return false;
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            return m.criminal.name.toLowerCase().includes(q) ||
                (m.criminal.firNumber || '').toLowerCase().includes(q);
        }
        return true;
    });

    const getLocationLabel = (match: FaceMatchRecord) => {
        const sourceLabel = String(match?.detection?.sourceFile || '').trim();
        if (sourceLabel) return sourceLabel;
        if (match.latitude != null && match.longitude != null) {
            return `Camera @ ${match.latitude.toFixed(4)}, ${match.longitude.toFixed(4)}`;
        }
        return 'Location not set for this camera';
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Header */}
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                        <Shield className="w-5 h-5 text-indigo-400" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold">Intelligence Dashboard</h1>
                        <p className="text-slate-400 text-sm">
                            Real-time criminal identification feed & match review
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleClearMatches}
                        className="ml-auto bg-rose-600/10 hover:bg-rose-600/20 border border-rose-500/30 text-rose-300 px-3 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear Matches
                    </button>
                </div>

                {/* Stats Bar */}
                {stats && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                                <TrendingUp className="w-3.5 h-3.5" /> Total Identifications
                            </div>
                            <p className="text-2xl font-bold text-slate-100">{stats.totalMatches}</p>
                        </div>
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                            <div className="flex items-center gap-2 text-xs text-green-400 mb-1">
                                <CheckCircle className="w-3.5 h-3.5" /> Confirmed
                            </div>
                            <p className="text-2xl font-bold text-green-400">{stats.confirmedMatches}</p>
                        </div>
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                            <div className="flex items-center gap-2 text-xs text-amber-400 mb-1">
                                <Clock className="w-3.5 h-3.5" /> Pending Review
                            </div>
                            <p className="text-2xl font-bold text-amber-400">{stats.pendingMatches}</p>
                        </div>
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                                <User className="w-3.5 h-3.5" /> Registered Criminals
                            </div>
                            <p className="text-2xl font-bold text-slate-100">{stats.totalCriminals}</p>
                        </div>
                    </div>
                )}

                {/* Live Alert Strip */}
                {liveAlerts.length > 0 && (
                    <div className="mb-6 bg-red-900/20 border border-red-500/30 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                            <ShieldAlert className="w-4 h-4 text-red-400 animate-pulse" />
                            <span className="text-sm font-bold text-red-300 uppercase tracking-wider">Live Alerts</span>
                        </div>
                        <div className="flex gap-3 overflow-x-auto pb-1">
                            {liveAlerts.map((alert, i) => (
                                <div key={i} className="bg-slate-900 border border-red-500/20 rounded-xl p-3 flex items-center gap-3 flex-shrink-0 min-w-[240px]">
                                    {alert.mugshotUrl ? (
                                        <img src={alert.mugshotUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-slate-700" />
                                    ) : (
                                        <div className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
                                            <User className="w-5 h-5 text-slate-500" />
                                        </div>
                                    )}
                                    <div>
                                        <p className="font-bold text-sm text-red-300">{alert.criminalName}</p>
                                        <p className="text-[10px] text-slate-400">
                                            {alert.source} · {typeof alert.confidence === 'number' ? `${(alert.confidence * 100).toFixed(0)}%` : 'N/A'}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-3 mb-6">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                        <input
                            type="text"
                            placeholder="Search by criminal name or FIR..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:border-indigo-500 outline-none"
                        />
                    </div>
                    <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1">
                        {['ALL', 'PENDING_REVIEW', 'CONFIRMED', 'DISMISSED'].map(status => (
                            <button
                                key={status}
                                onClick={() => setFilterStatus(status)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${filterStatus === status ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
                            >
                                {status === 'ALL' ? 'All' : status === 'PENDING_REVIEW' ? 'Pending' : status === 'CONFIRMED' ? 'Confirmed' : 'Dismissed'}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Content */}
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                    {/* Match List */}
                    <div className="lg:col-span-2 space-y-3 max-h-[calc(100vh-20rem)] overflow-y-auto pr-2">
                        {isLoading ? (
                            <div className="text-slate-500 text-sm text-center py-12">Loading intelligence data...</div>
                        ) : filteredMatches.length === 0 ? (
                            <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl">
                                <Shield className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                                <p className="text-slate-400 font-medium">No identifications found</p>
                                <p className="text-slate-600 text-sm mt-1">Criminal matches from CCTV and reports will appear here.</p>
                            </div>
                        ) : (
                            filteredMatches.map(match => {
                                const sc = reviewStatusConfig[match.reviewStatus] || reviewStatusConfig.PENDING_REVIEW;
                                const StatusIcon = sc.icon;
                                return (
                                    <div
                                        key={match.id}
                                        onClick={() => setSelected(match)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                setSelected(match);
                                            }
                                        }}
                                        role="button"
                                        tabIndex={0}
                                        className={`w-full text-left bg-slate-900 border rounded-xl p-4 transition-all shadow-sm relative overflow-hidden ${selected?.id === match.id ? 'border-indigo-500 bg-indigo-500/5' : 'border-slate-800 hover:border-slate-700'}`}
                                    >
                                        <div className={`absolute left-0 top-0 bottom-0 w-1 ${match.reviewStatus === 'CONFIRMED' ? 'bg-green-500' : match.reviewStatus === 'PENDING_REVIEW' ? 'bg-amber-500' : 'bg-slate-700'}`} />
                                        <div className="pl-3">
                                            <div className="flex justify-between items-start mb-2">
                                                <div className="flex items-center gap-2">
                                                    {match.criminal.mugshotUrl ? (
                                                        <img src={match.criminal.mugshotUrl} alt="" className="w-8 h-8 rounded-lg object-cover border border-slate-700" />
                                                    ) : (
                                                        <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center">
                                                            <User className="w-4 h-4 text-slate-500" />
                                                        </div>
                                                    )}
                                                    <div>
                                                        <p className="font-bold text-sm text-slate-100">{match.criminal.name}</p>
                                                        <p className="text-[10px] text-slate-500 font-mono">{match.criminal.firNumber || 'No FIR'}</p>
                                                    </div>
                                                </div>
                                                <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border flex items-center gap-1 ${sc.cls}`}>
                                                    <StatusIcon className="w-3 h-3" /> {sc.label}
                                                </span>
                                            </div>

                                            <div className="flex items-center gap-3 text-xs text-slate-400">
                                                <span className="flex items-center gap-1">
                                                    <Camera className="w-3 h-3" />
                                                    {match.detectionSource === 'CCTV' ? 'CCTV' : 'Citizen'}
                                                </span>
                                                <span className="font-mono font-bold text-indigo-400">
                                                    {(match.confidence * 100).toFixed(0)}%
                                                </span>
                                                <span className="text-slate-500">
                                                    {new Date(match.spottedAt || match.createdAt).toLocaleDateString()}
                                                    {' '}
                                                    {new Date(match.spottedAt || match.createdAt).toLocaleTimeString()}
                                                </span>
                                            </div>
                                            {match.frameSnapshot ? (
                                                <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950 overflow-hidden">
                                                    <img
                                                        src={match.frameSnapshot}
                                                        alt={`Captured frame for ${match.criminal.name}`}
                                                        className="w-full h-28 object-cover"
                                                    />
                                                </div>
                                            ) : null}
                                            <div className="mt-3">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setExpandedLocationIds((prev) => ({
                                                            ...prev,
                                                            [match.id]: !prev[match.id],
                                                        }));
                                                    }}
                                                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/20 transition-colors"
                                                >
                                                    📍 View location: {getLocationLabel(match)}
                                                </button>
                                                {expandedLocationIds[match.id] ? (
                                                    match.latitude != null && match.longitude != null ? (
                                                        <MiniLocationMap
                                                            latitude={match.latitude}
                                                            longitude={match.longitude}
                                                            locationLabel={getLocationLabel(match)}
                                                            detectedAt={match.spottedAt || match.createdAt}
                                                        />
                                                    ) : (
                                                        <p className="mt-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-2">
                                                            Location not set for this camera
                                                        </p>
                                                    )
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    {/* Detail Panel */}
                    <div className="lg:col-span-3">
                        {selected ? (
                            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sticky top-24">
                                {/* Criminal Info */}
                                <div className="flex items-start gap-4 mb-6">
                                    {selected.criminal.mugshotUrl ? (
                                        <img src={selected.criminal.mugshotUrl} alt={selected.criminal.name}
                                            className="w-20 h-20 rounded-xl object-cover border-2 border-slate-700" />
                                    ) : (
                                        <div className="w-20 h-20 rounded-xl bg-slate-800 border-2 border-slate-700 flex items-center justify-center">
                                            <User className="w-10 h-10 text-slate-500" />
                                        </div>
                                    )}
                                    <div className="flex-1">
                                        <h2 className="text-xl font-bold text-slate-100">{selected.criminal.name}</h2>
                                        {selected.criminal.firNumber && (
                                            <p className="text-sm text-slate-400 font-mono mt-1">FIR: {selected.criminal.firNumber}</p>
                                        )}
                                        <div className="flex gap-2 mt-2">
                                            <span className={`text-xs px-3 py-1 rounded-full border font-semibold ${reviewStatusConfig[selected.reviewStatus]?.cls}`}>
                                                {reviewStatusConfig[selected.reviewStatus]?.label}
                                            </span>
                                            {selected.criminal.sampleCount > 0 && (
                                                <span className="text-xs px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-300">
                                                    {selected.criminal.sampleCount} training samples
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Match Details */}
                                <div className="grid grid-cols-2 gap-4 mb-6">
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Confidence</p>
                                        <p className="text-lg font-bold text-indigo-400">{(selected.confidence * 100).toFixed(1)}%</p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Source</p>
                                        <p className="text-sm font-medium text-slate-200 flex items-center gap-1.5">
                                            <Camera className="w-3.5 h-3.5" />
                                            {selected.detectionSource === 'CCTV' ? 'CCTV Surveillance' : 'Citizen Photo'}
                                        </p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Spotted At</p>
                                        <p className="text-sm font-mono text-slate-200">
                                            {selected.spottedAt
                                                ? new Date(selected.spottedAt).toLocaleString()
                                                : new Date(selected.createdAt).toLocaleString()}
                                        </p>
                                    </div>
                                    <div className="bg-slate-800/50 rounded-xl p-3">
                                        <p className="text-xs text-slate-500 mb-1">Location</p>
                                        <p className="text-sm font-mono text-slate-200 flex items-center gap-1">
                                            <MapPin className="w-3.5 h-3.5" />
                                            {selected.latitude !== null && selected.longitude !== null
                                                ? `${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)}`
                                                : 'No location data'}
                                        </p>
                                    </div>
                                </div>

                                <div className="mb-6">
                                    <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Captured Frame</p>
                                    {selected.frameSnapshot ? (
                                        <a
                                            href={selected.frameSnapshot}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block rounded-xl overflow-hidden border border-slate-700 bg-slate-950 hover:border-indigo-500/40 transition-colors"
                                        >
                                            <img
                                                src={selected.frameSnapshot}
                                                alt={`Captured frame for ${selected.criminal.name}`}
                                                className="w-full max-h-72 object-contain bg-black"
                                            />
                                        </a>
                                    ) : (
                                        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950 px-4 py-8 text-center text-sm text-slate-500">
                                            No captured frame attached for this match.
                                        </div>
                                    )}
                                </div>

                                {/* Review Actions */}
                                {selected.reviewStatus === 'PENDING_REVIEW' && (
                                    <div className="flex gap-3 pt-4 border-t border-slate-800">
                                        <button
                                            onClick={() => handleReview(selected.id, 'CONFIRMED')}
                                            className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                                        >
                                            <CheckCircle className="w-4 h-4" /> Confirm Match
                                        </button>
                                        <button
                                            onClick={() => handleReview(selected.id, 'DISMISSED')}
                                            className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                                        >
                                            <XCircle className="w-4 h-4" /> Dismiss
                                        </button>
                                    </div>
                                )}
                                <div className="pt-4 border-t border-slate-800 mt-4">
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteMatch(selected.id)}
                                        className="w-full bg-rose-600/10 hover:bg-rose-600/20 border border-rose-500/30 text-rose-300 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Delete This Match
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center text-center py-24 border border-dashed border-slate-800 rounded-2xl">
                                <Eye className="w-12 h-12 text-slate-700 mb-4" />
                                <p className="text-slate-400 font-medium">Select an identification</p>
                                <p className="text-slate-600 text-sm">Click any match from the list to review details</p>
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
