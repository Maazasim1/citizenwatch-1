'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { io as ioClient, Socket } from 'socket.io-client';
import Link from 'next/link';
import Navbar from '../../../components/Navbar';
import { useAuth } from '../../../context/AuthContext';
import { useRouter } from 'next/navigation';
import { Camera, Scan, ShieldAlert, Radio, AlertCircle } from 'lucide-react';
import { getApiBaseUrl } from '@/lib/apiBase';
import { isSocketAuthErrorMessage, notifySessionInvalid } from '@/lib/authFetch';

interface CameraSummary {
    id: string;
    name: string;
    latitude: number | null;
    longitude: number | null;
    firstSeenAt: number;
    lastFrameAt: number;
    framesProcessed: number;
    matchesAllTime: number;
    online: boolean;
    face_count: number;
    match_count: number;
    api_elapsed_ms: number | null;
    pipeline_elapsed_ms: number | null;
}

interface AnnotatedFramePayload {
    cameraId: string;
    cameraName: string;
    meta: any;
    jpeg: ArrayBuffer | Buffer | Uint8Array;
}

interface CameraTileState {
    summary: CameraSummary;
    annotatedUrl: string | null;
    lastFrameAt: number;
    matches: Array<{ name: string; confidence: number; method?: string }>;
}

export default function CCTVDashboardPage() {
    const { token, user, loading } = useAuth();
    const router = useRouter();

    const [error, setError] = useState('');
    const [connected, setConnected] = useState(false);
    const [tiles, setTiles] = useState<Map<string, CameraTileState>>(new Map());
    const tilesRef = useRef(tiles);
    tilesRef.current = tiles;

    const objectUrlsRef = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        if (!loading && (!user || (user.role !== 'ADMIN' && user.role !== 'LAW_ENFORCEMENT' && user.role !== 'MODERATOR'))) {
            router.push('/');
        }
    }, [user, loading, router]);

    useEffect(() => {
        if (!token) return;

        const socket: Socket = ioClient(`${getApiBaseUrl()}/cctv-stream`, {
            auth: { token },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
        });

        socket.on('connect', () => {
            setConnected(true);
            setError('');
            socket.emit('cctv:join-monitor');
        });
        socket.on('disconnect', () => setConnected(false));
        socket.on('connect_error', (err) => {
            const msg = err?.message || '';
            if (token && isSocketAuthErrorMessage(msg)) {
                notifySessionInvalid();
                return;
            }
            setError(`Stream socket: ${err.message}`);
            setConnected(false);
        });

        socket.on('cctv:cameras', (list: CameraSummary[]) => {
            setTiles((prev) => {
                const next = new Map(prev);
                const seen = new Set<string>();
                for (const summary of list) {
                    seen.add(summary.id);
                    const existing = next.get(summary.id);
                    next.set(summary.id, {
                        summary,
                        annotatedUrl: existing?.annotatedUrl ?? null,
                        lastFrameAt: existing?.lastFrameAt ?? summary.lastFrameAt,
                        matches: existing?.matches ?? [],
                    });
                }
                // Drop tiles for cameras the server didn't include.
                for (const id of Array.from(next.keys())) {
                    if (!seen.has(id)) {
                        const url = objectUrlsRef.current.get(id);
                        if (url) URL.revokeObjectURL(url);
                        objectUrlsRef.current.delete(id);
                        next.delete(id);
                    }
                }
                return next;
            });
        });

        socket.on('cctv:camera-removed', ({ id }: { id: string }) => {
            setTiles((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Map(prev);
                const url = objectUrlsRef.current.get(id);
                if (url) URL.revokeObjectURL(url);
                objectUrlsRef.current.delete(id);
                next.delete(id);
                return next;
            });
        });

        socket.on('cctv:annotated', (payload: AnnotatedFramePayload) => {
            const { cameraId, cameraName, meta } = payload;
            const buffer: ArrayBuffer | null = (() => {
                const j = payload.jpeg as any;
                if (!j) return null;
                if (j instanceof ArrayBuffer) return j;
                if (ArrayBuffer.isView(j)) return j.buffer.slice(j.byteOffset, j.byteOffset + j.byteLength);
                if (j?.data) return new Uint8Array(j.data).buffer;
                return null;
            })();

            let url: string | null = null;
            if (buffer && buffer.byteLength > 0) {
                const blob = new Blob([buffer], { type: 'image/jpeg' });
                url = URL.createObjectURL(blob);
            }

            setTiles((prev) => {
                const existing = prev.get(cameraId);
                const prevSummary: CameraSummary = existing?.summary || {
                    id: cameraId,
                    name: cameraName,
                    latitude: null,
                    longitude: null,
                    firstSeenAt: Date.now(),
                    lastFrameAt: Date.now(),
                    framesProcessed: 0,
                    matchesAllTime: 0,
                    online: true,
                    face_count: 0,
                    match_count: 0,
                    api_elapsed_ms: null,
                    pipeline_elapsed_ms: null,
                };
                const newSummary: CameraSummary = {
                    ...prevSummary,
                    id: cameraId,
                    name: cameraName || prevSummary.name,
                    online: true,
                    lastFrameAt: Date.now(),
                    framesProcessed: prevSummary.framesProcessed + 1,
                    matchesAllTime: prevSummary.matchesAllTime + (Number(meta?.match_count) || 0),
                    face_count: Number(meta?.face_count) || 0,
                    match_count: Number(meta?.match_count) || 0,
                    api_elapsed_ms: typeof meta?.api_elapsed_ms === 'number' ? meta.api_elapsed_ms : null,
                    pipeline_elapsed_ms:
                        typeof meta?.pipeline_elapsed_ms === 'number' ? meta.pipeline_elapsed_ms : null,
                    latitude:
                        meta?.faces && Array.isArray(meta?.faces) && prevSummary.latitude == null
                            ? prevSummary.latitude
                            : prevSummary.latitude,
                    longitude:
                        meta?.faces && Array.isArray(meta?.faces) && prevSummary.longitude == null
                            ? prevSummary.longitude
                            : prevSummary.longitude,
                };

                const next = new Map(prev);
                const oldUrl = existing?.annotatedUrl ?? null;
                if (oldUrl) URL.revokeObjectURL(oldUrl);
                if (url) {
                    objectUrlsRef.current.set(cameraId, url);
                }
                next.set(cameraId, {
                    summary: newSummary,
                    annotatedUrl: url,
                    lastFrameAt: Date.now(),
                    matches: Array.isArray(meta?.matches)
                        ? meta.matches.slice(0, 5).map((m: any) => ({
                              name: String(m?.name ?? 'Unknown'),
                              confidence: Number(m?.confidence ?? 0),
                              method: m?.method,
                          }))
                        : existing?.matches ?? [],
                });
                return next;
            });
        });

        return () => {
            socket.emit('cctv:leave-monitor');
            socket.disconnect();
            for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
            objectUrlsRef.current.clear();
        };
    }, [token]);

    const sortedTiles = useMemo(() => {
        return Array.from(tiles.values()).sort((a, b) => {
            if (a.summary.match_count !== b.summary.match_count) {
                return b.summary.match_count - a.summary.match_count;
            }
            return a.summary.name.localeCompare(b.summary.name);
        });
    }, [tiles]);

    const totals = useMemo(() => {
        let online = 0;
        let frames = 0;
        let matches = 0;
        for (const t of tiles.values()) {
            if (t.summary.online) online += 1;
            frames += t.summary.framesProcessed;
            matches += t.summary.matchesAllTime;
        }
        return { online, frames, matches, total: tiles.size };
    }, [tiles]);

    if (loading || !user) return <div className="min-h-screen bg-slate-950" />;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
            <Navbar />

            <main className="flex-1 p-6 overflow-auto">
                <div className="flex justify-between items-center mb-6">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <Scan className="w-6 h-6 text-indigo-400" /> Camera Grid
                        </h1>
                        <p className="text-sm text-slate-400 mt-1">
                            Live multi-camera surveillance feeds &middot; {totals.online}/{totals.total} online &middot;{' '}
                            {totals.frames.toLocaleString()} frames &middot; {totals.matches} alerts
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <span
                            className={`text-xs font-mono px-2 py-1 rounded ${
                                connected
                                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                            }`}
                        >
                            {connected ? 'WS LIVE' : 'WS OFFLINE'}
                        </span>
                        <Link
                            href="/cctv"
                            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2"
                        >
                            <Camera className="w-3.5 h-3.5" /> Producer
                        </Link>
                    </div>
                </div>

                {error && (
                    <div className="mb-4 bg-rose-500/10 border border-rose-500/20 text-rose-300 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" /> {error}
                    </div>
                )}

                {sortedTiles.length === 0 ? (
                    <div className="border border-dashed border-slate-800 rounded-2xl py-24 text-center">
                        <Radio className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-400 text-sm">No active cameras yet.</p>
                        <p className="text-slate-500 text-xs mt-2">
                            Open <Link href="/cctv" className="text-indigo-400 underline">/cctv</Link> on this or any
                            other device, name the camera and start streaming. It will show up here.
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                        {sortedTiles.map((tile) => (
                            <CameraTile key={tile.summary.id} tile={tile} />
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
}

function CameraTile({ tile }: { tile: CameraTileState }) {
    const { summary, annotatedUrl, matches } = tile;
    const ageMs = Date.now() - summary.lastFrameAt;
    const stale = ageMs > 4000;
    const alerted = summary.match_count > 0;

    return (
        <div
            className={`relative rounded-2xl overflow-hidden border ${
                alerted ? 'border-red-500/50' : 'border-slate-800'
            } bg-slate-900`}
        >
            <div className="aspect-video bg-black flex items-center justify-center">
                {annotatedUrl ? (
                    <img src={annotatedUrl} alt={summary.name} className="w-full h-full object-cover" />
                ) : (
                    <div className="text-slate-600 text-xs">Waiting for first frame…</div>
                )}
            </div>

            <div className="absolute top-2 left-2 right-2 flex items-center justify-between text-[11px] font-mono">
                <div className="flex items-center gap-2">
                    <span
                        className={`px-2 py-0.5 rounded ${
                            summary.online && !stale
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-slate-800/80 text-slate-300 border border-slate-700'
                        }`}
                    >
                        {summary.online && !stale ? 'LIVE' : 'STALE'}
                    </span>
                    <span className="text-slate-200">{summary.name}</span>
                </div>
                <span className="text-slate-400">{summary.id.slice(0, 8)}</span>
            </div>

            {alerted && (
                <div className="absolute bottom-12 left-2 right-2 bg-red-900/80 backdrop-blur border border-red-500/50 px-3 py-2 rounded-xl flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 text-red-300 mt-0.5 flex-shrink-0" />
                    <div className="text-[11px] text-red-100 leading-tight">
                        <div className="font-bold">
                            {matches.length || summary.match_count} criminal
                            {(matches.length || summary.match_count) > 1 ? 's' : ''} identified
                        </div>
                        {matches.slice(0, 2).map((m, i) => (
                            <div key={i} className="text-red-200/80">
                                {m.name} · {(m.confidence * 100).toFixed(0)}%
                                {m.method ? ` · ${m.method}` : ''}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="px-3 py-2 bg-slate-950/60 backdrop-blur-sm border-t border-slate-800 text-[10px] font-mono text-slate-400 flex justify-between items-center">
                <span>
                    {summary.face_count} face{summary.face_count !== 1 ? 's' : ''} · {summary.framesProcessed} frames
                </span>
                <span>
                    {summary.api_elapsed_ms ?? '?'} ms api
                    {summary.pipeline_elapsed_ms != null ? ` · ${summary.pipeline_elapsed_ms} ms pipe` : ''}
                </span>
            </div>
        </div>
    );
}
