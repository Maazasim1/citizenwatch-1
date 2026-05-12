'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { io as ioClient, Socket } from 'socket.io-client';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { Camera, Upload, AlertCircle, User, LocateFixed, Radio, VideoOff, Scan, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch, isSocketAuthErrorMessage, notifySessionInvalid } from '@/lib/authFetch';

interface RecognizedFace {
    name: string;
    confidence: number;
    bounding_box: { x: number; y: number; w: number; h: number };
    is_match: boolean;
}

export default function CCTVDashboard() {
    const { token, user, loading } = useAuth();
    const router = useRouter();

    // Mode toggle
    const [mode, setMode] = useState<'live' | 'upload'>('live');

    // ── Live surveillance state ──
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [annotatedFrame, setAnnotatedFrame] = useState<string | null>(null);
    const [detectedFaces, setDetectedFaces] = useState<RecognizedFace[]>([]);
    const [matchHistory, setMatchHistory] = useState<Array<RecognizedFace & { timestamp: string }>>([]);
    const [liveError, setLiveError] = useState('');
    const streamRef = useRef<MediaStream | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [recognitionStatus, setRecognitionStatus] = useState<any>(null);
    const [frameCount, setFrameCount] = useState(0);
    const [cameraLocation, setCameraLocation] = useState<{ lat: number; lng: number } | null>(null);
    const cameraLocationRef = useRef<{ lat: number; lng: number } | null>(null);
    const streamHealthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── WebSocket frame channel ──
    const cctvSocketRef = useRef<Socket | null>(null);
    const [wsConnected, setWsConnected] = useState(false);
    const inFlightRef = useRef(false);
    const isStreamingRef = useRef(false);
    const annotatedUrlRef = useRef<string | null>(null);
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [pipelineMs, setPipelineMs] = useState<number | null>(null);

    // ── Multi-camera identity ──
    const [cameraName, setCameraName] = useState<string>('');
    const [cameraId, setCameraId] = useState<string>('');
    useEffect(() => {
        if (typeof window === 'undefined') return;
        let id = window.localStorage.getItem('cctv.cameraId');
        if (!id) {
            id = `cam-${Math.random().toString(36).slice(2, 10)}`;
            window.localStorage.setItem('cctv.cameraId', id);
        }
        setCameraId(id);
        const name = window.localStorage.getItem('cctv.cameraName') || `Camera ${id.slice(4, 8).toUpperCase()}`;
        setCameraName(name);
    }, []);
    const updateCameraName = useCallback((name: string) => {
        setCameraName(name);
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('cctv.cameraName', name);
        }
    }, []);

    // ── Webcam device picker ──
    const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

    const refreshVideoDevices = useCallback(async () => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cams = devices.filter((d) => d.kind === 'videoinput');
            setVideoDevices(cams);
            // If the currently-selected id is gone (camera unplugged), fall back.
            setSelectedDeviceId((prev) => {
                if (prev && cams.some((c) => c.deviceId === prev)) return prev;
                const stored = window.localStorage.getItem('cctv.deviceId') || '';
                if (stored && cams.some((c) => c.deviceId === stored)) return stored;
                return cams[0]?.deviceId || '';
            });
        } catch (err) {
            console.warn('[cctv] enumerateDevices failed', err);
        }
    }, []);

    useEffect(() => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
        refreshVideoDevices();
        navigator.mediaDevices.addEventListener?.('devicechange', refreshVideoDevices);
        return () => {
            navigator.mediaDevices.removeEventListener?.('devicechange', refreshVideoDevices);
        };
    }, [refreshVideoDevices]);

    const updateSelectedDevice = useCallback((deviceId: string) => {
        setSelectedDeviceId(deviceId);
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('cctv.deviceId', deviceId);
        }
    }, []);

    // ── File upload state (existing) ──
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<any>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!loading && (!user || (user.role !== 'ADMIN' && user.role !== 'LAW_ENFORCEMENT' && user.role !== 'MODERATOR'))) {
            router.push('/');
        }
    }, [user, loading, router]);

    // Fetch recognition status
    useEffect(() => {
        if (!token) return;
        authFetch(`${getApiBaseUrl()}/api/cctv/recognition-status`, {}, token)
            .then(r => r.json())
            .then(data => setRecognitionStatus(data))
            .catch(() => {});
    }, [token]);

    // Open / close the CCTV stream WebSocket alongside the auth token lifecycle.
    useEffect(() => {
        if (!token) return;
        const socket = ioClient(`${getApiBaseUrl()}/cctv-stream`, {
            auth: { token },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
        });
        cctvSocketRef.current = socket;

        socket.on('connect', () => setWsConnected(true));
        socket.on('disconnect', () => setWsConnected(false));
        socket.on('connect_error', (err) => {
            const msg = err?.message || '';
            if (token && isSocketAuthErrorMessage(msg)) {
                notifySessionInvalid();
                return;
            }
            setLiveError(`Stream socket: ${err.message}`);
            setWsConnected(false);
        });

        return () => {
            socket.disconnect();
            cctvSocketRef.current = null;
            setWsConnected(false);
        };
    }, [token]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopStream();
        };
    }, []);

    const startStream = useCallback(async () => {
        setLiveError('');
        try {
            const baseVideo: MediaTrackConstraints = { width: 640, height: 480 };
            const wantedDeviceId = selectedDeviceId
                || (typeof window !== 'undefined' ? window.localStorage.getItem('cctv.deviceId') : '')
                || '';

            let stream: MediaStream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: wantedDeviceId
                        ? { ...baseVideo, deviceId: { exact: wantedDeviceId } }
                        : { ...baseVideo, facingMode: 'user' },
                });
            } catch (primaryErr) {
                // Fallback: requested device unavailable / over-constrained — try any camera.
                console.warn('[cctv] primary getUserMedia failed, falling back', primaryErr);
                stream = await navigator.mediaDevices.getUserMedia({ video: true });
            }
            streamRef.current = stream;

            // Labels are only populated after a permission grant; re-enumerate so the
            // dropdown shows real names ("Logitech BRIO", "OBS Virtual Camera", …).
            refreshVideoDevices();

            // Reflect what we actually got into the picker selection.
            const trackSettings = stream.getVideoTracks()[0]?.getSettings?.();
            if (trackSettings?.deviceId) {
                updateSelectedDevice(trackSettings.deviceId);
            }
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setIsStreaming(true);
            if (streamHealthTimeoutRef.current) clearTimeout(streamHealthTimeoutRef.current);
            streamHealthTimeoutRef.current = setTimeout(() => {
                const videoEl = videoRef.current;
                if (videoEl && videoEl.readyState < 2) {
                    setLiveError('Camera stream did not initialize. Retrying may fix it.');
                    if (intervalRef.current) {
                        clearInterval(intervalRef.current);
                        intervalRef.current = null;
                    }
                    if (streamRef.current) {
                        streamRef.current.getTracks().forEach(t => t.stop());
                        streamRef.current = null;
                    }
                    if (videoRef.current) {
                        videoRef.current.srcObject = null;
                    }
                    setIsStreaming(false);
                }
            }, 5000);

            // Get camera/device location for match reports
            try {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                        cameraLocationRef.current = loc;
                        setCameraLocation(loc);
                    },
                    () => {
                        cameraLocationRef.current = null;
                        setCameraLocation(null);
                    },
                    { enableHighAccuracy: true, timeout: 10000 }
                );
            } catch {
                cameraLocationRef.current = null;
                setCameraLocation(null);
            }

            // Backpressured WS streaming: send next frame as soon as the previous result returns.
            isStreamingRef.current = true;
            sendNextFrame();
        } catch (err: any) {
            setLiveError(err?.message || 'Failed to access webcam. Please allow camera permissions.');
        }
    }, [token]);

    const stopStream = useCallback(() => {
        isStreamingRef.current = false;
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (streamHealthTimeoutRef.current) {
            clearTimeout(streamHealthTimeoutRef.current);
            streamHealthTimeoutRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        if (annotatedUrlRef.current) {
            URL.revokeObjectURL(annotatedUrlRef.current);
            annotatedUrlRef.current = null;
        }
        setIsStreaming(false);
        setAnnotatedFrame(null);
        inFlightRef.current = false;
    }, []);

    const sendNextFrame = useCallback(async () => {
        if (!isStreamingRef.current) return;
        if (inFlightRef.current) return;
        const socket = cctvSocketRef.current;
        if (!socket || !socket.connected) {
            // Retry shortly while the socket comes up.
            setTimeout(sendNextFrame, 100);
            return;
        }
        if (!videoRef.current || !canvasRef.current) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video.videoWidth || !video.videoHeight) {
            setTimeout(sendNextFrame, 50);
            return;
        }

        // Keep frame size bounded so pipeline inference latency stays stable.
        // Some webcams ignore requested constraints and deliver very large frames.
        const maxW = 640;
        const maxH = 360;
        const srcW = video.videoWidth;
        const srcH = video.videoHeight;
        const scale = Math.min(maxW / srcW, maxH / srcH, 1);
        canvas.width = Math.max(1, Math.round(srcW * scale));
        canvas.height = Math.max(1, Math.round(srcH * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);

        const blob: Blob | null = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', 0.7),
        );
        if (!blob) return;

        const arrayBuffer = await blob.arrayBuffer();
        inFlightRef.current = true;
        const sentAt = performance.now();

        const ackGuard = setTimeout(() => {
            if (!isStreamingRef.current) return;
            inFlightRef.current = false;
            setLiveError('Live frame processing is slow. Retrying with reduced frame size...');
            requestAnimationFrame(() => sendNextFrame());
        }, 20000);

        socket.emit(
            'cctv:frame',
            {
                jpeg: arrayBuffer,
                camera_id: cameraId || undefined,
                camera_name: cameraName || undefined,
                camera_latitude: cameraLocationRef.current?.lat ?? null,
                camera_longitude: cameraLocationRef.current?.lng ?? null,
            },
            (response: any) => {
                clearTimeout(ackGuard);
                inFlightRef.current = false;
                const rtt = performance.now() - sentAt;
                setLatencyMs(Math.round(rtt));

                if (!response || response.error) {
                    if (response?.error) console.warn('[cctv-stream] error:', response.error);
                } else {
                    const meta = response.meta || {};
                    setPipelineMs(typeof meta.pipeline_elapsed_ms === 'number' ? meta.pipeline_elapsed_ms : null);
                    setDetectedFaces(meta.faces || []);
                    setFrameCount((prev) => prev + 1);

                    const annotatedJpeg: ArrayBuffer | null = response.jpeg || null;
                    if (annotatedJpeg && annotatedJpeg.byteLength > 0) {
                        const annotatedBlob = new Blob([annotatedJpeg], { type: 'image/jpeg' });
                        const url = URL.createObjectURL(annotatedBlob);
                        if (annotatedUrlRef.current) {
                            URL.revokeObjectURL(annotatedUrlRef.current);
                        }
                        annotatedUrlRef.current = url;
                        setAnnotatedFrame(url);
                    }

                    const newMatches = (meta.matches || []) as RecognizedFace[];
                    if (newMatches.length > 0) {
                        const now = new Date().toLocaleTimeString();
                        setMatchHistory((prev) =>
                            [...newMatches.map((m) => ({ ...m, timestamp: now })), ...prev].slice(0, 50),
                        );
                    }
                }

                // Immediately request the next frame for end-to-end backpressure.
                if (isStreamingRef.current) {
                    requestAnimationFrame(() => sendNextFrame());
                }
            },
        );
    }, [cameraId, cameraName]);

    // ── File upload handlers (existing) ──
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0] || null;
        setFile(f);
        if (f) {
            const objectUrl = URL.createObjectURL(f);
            setPreview(objectUrl);
        } else {
            setPreview(null);
        }
        setResult(null);
        setError('');
    };

    const handleUpload = async () => {
        if (!file) return;
        setSubmitting(true);
        setError('');

        try {
            const fd = new FormData();
            fd.append('file', file);

            const res = await authFetch(`${getApiBaseUrl()}/api/cctv/upload`, {
                method: 'POST',
                body: fd,
            }, token);

            const data = await res.json();
            if (!res.ok) {
                setError(data.error || 'Failed to process CCTV feed');
            } else {
                setResult(data);
            }
        } catch {
            setError('An error occurred during CCTV processing.');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading || !user) return <div className="min-h-screen bg-slate-950" />;

    const isVideo = file?.type.startsWith('video/');
    const matchCount = detectedFaces.filter(f => f.is_match).length;
    const toMatchPercent = (confidence: number) => {
        if (!Number.isFinite(confidence)) return 0;
        if (confidence >= 0 && confidence <= 1) return confidence * 100;
        // Defensive fallback for legacy LBPH distance values.
        return Math.max(0, Math.min(100, ((90 - confidence) / 30) * 100));
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
            <Navbar />

            <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                {/* Left: Feed View */}
                <div className="flex-1 border-r border-slate-800 bg-slate-950 p-6 flex flex-col">
                    {/* Header + Mode Toggle */}
                    <div className="flex justify-between items-center mb-4">
                        <div>
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                <Camera className="w-6 h-6 text-indigo-400" />
                                CCTV Surveillance
                            </h1>
                            <p className="text-sm text-slate-400 mt-1">Real-time face detection & criminal identification</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Link href="/cctv/dashboard" className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2">
                                <Scan className="w-3.5 h-3.5" /> Camera Grid
                            </Link>
                            <Link href="/cctv/criminals" className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2">
                                <User className="w-3.5 h-3.5" /> Criminal DB
                            </Link>
                        </div>
                    </div>

                    {/* Mode Tabs */}
                    <div className="flex gap-1 mb-4 bg-slate-900 border border-slate-800 rounded-xl p-1 w-fit">
                        <button
                            onClick={() => { setMode('live'); stopStream(); }}
                            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${mode === 'live' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-400 hover:text-white'}`}
                        >
                            <Radio className="w-3.5 h-3.5" /> Live Surveillance
                        </button>
                        <button
                            onClick={() => { setMode('upload'); stopStream(); }}
                            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${mode === 'upload' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-400 hover:text-white'}`}
                        >
                            <Upload className="w-3.5 h-3.5" /> File Analysis
                        </button>
                    </div>

                    {/* Live Surveillance Mode */}
                    {mode === 'live' && (
                        <>
                            <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden">
                                {/* Hidden elements for capture */}
                                <video ref={videoRef} className="hidden" muted playsInline />
                                <canvas ref={canvasRef} className="hidden" />

                                {!isStreaming && !annotatedFrame ? (
                                    <div className="text-center p-8">
                                        <Scan className="w-16 h-16 text-slate-700 mx-auto mb-4" />
                                        <h3 className="text-lg font-medium text-slate-300">Surveillance Inactive</h3>
                                        <p className="text-slate-500 text-sm mt-2 max-w-sm">
                                            Start the camera to begin real-time facial recognition.
                                            {recognitionStatus && (
                                                <span className="block mt-2 text-indigo-400">
                                                    Model: {recognitionStatus.total_subjects || 0} subjects registered
                                                </span>
                                            )}
                                        </p>
                                    </div>
                                ) : annotatedFrame ? (
                                    <div className="w-full h-full relative flex items-center justify-center bg-black">
                                        <img src={annotatedFrame} alt="Live Feed" className="max-w-full max-h-full object-contain" />

                                        {/* Live overlay indicators */}
                                        <div className="absolute top-4 left-4 bg-black/60 backdrop-blur border border-white/10 px-3 py-1.5 rounded text-xs font-mono flex items-center gap-2">
                                            <div className={`w-2 h-2 rounded-full ${matchCount > 0 ? 'bg-red-500' : 'bg-green-500'} animate-pulse`} />
                                            {matchCount > 0 ? 'ALERT' : 'SCANNING'}
                                        </div>

                                        <div className="absolute top-4 right-4 bg-black/60 backdrop-blur border border-white/10 px-3 py-1.5 rounded text-xs font-mono">
                                            Frames: {frameCount}
                                        </div>

                                        {matchCount > 0 && (
                                            <div className="absolute bottom-4 left-4 right-4 bg-red-900/80 backdrop-blur border border-red-500/50 px-4 py-3 rounded-xl flex items-center gap-3 animate-pulse">
                                                <ShieldAlert className="w-5 h-5 text-red-400" />
                                                <span className="text-sm font-bold text-red-200">
                                                    {matchCount} CRIMINAL{matchCount > 1 ? 'S' : ''} IDENTIFIED
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-center p-8">
                                        <div className="w-10 h-10 rounded-full border-4 border-slate-800 border-t-indigo-500 animate-spin mx-auto mb-4" />
                                        <p className="text-slate-400 text-sm">Initializing camera...</p>
                                    </div>
                                )}
                            </div>

                            {/* Live controls */}
                            <div className="mt-4 flex flex-col sm:flex-row gap-3 sm:items-center flex-wrap">
                                <div className="flex items-center gap-2">
                                    <label className="text-xs text-slate-400 uppercase tracking-wide">Camera</label>
                                    <input
                                        value={cameraName}
                                        onChange={(e) => updateCameraName(e.target.value)}
                                        placeholder="Camera name"
                                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 min-w-[180px]"
                                        disabled={isStreaming}
                                    />
                                    <span className="text-[10px] font-mono text-slate-500" title="Stable camera id">{cameraId.slice(0, 10)}</span>
                                </div>

                                <div className="flex items-center gap-2">
                                    <label className="text-xs text-slate-400 uppercase tracking-wide">Webcam</label>
                                    <select
                                        value={selectedDeviceId}
                                        onChange={(e) => {
                                            const id = e.target.value;
                                            updateSelectedDevice(id);
                                            // If currently streaming, hot-swap to the chosen device.
                                            if (isStreaming) {
                                                stopStream();
                                                setTimeout(() => startStream(), 50);
                                            }
                                        }}
                                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 min-w-[220px] max-w-[320px]"
                                    >
                                        {videoDevices.length === 0 && (
                                            <option value="">No webcams detected</option>
                                        )}
                                        {videoDevices.map((d, i) => (
                                            <option key={d.deviceId || i} value={d.deviceId}>
                                                {d.label || `Camera ${i + 1}`}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={refreshVideoDevices}
                                        title="Refresh device list"
                                        className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded border border-slate-700 hover:border-slate-500"
                                    >
                                        ↻
                                    </button>
                                </div>
                                <button
                                    onClick={isStreaming ? stopStream : startStream}
                                    className={`px-8 py-3 rounded-xl font-semibold text-sm transition-all shadow-lg flex items-center gap-2 ${
                                        isStreaming
                                            ? 'bg-red-600 hover:bg-red-500 text-white shadow-red-600/20'
                                            : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20'
                                    }`}
                                >
                                    {isStreaming ? (
                                        <><VideoOff className="w-4 h-4" /> Stop Surveillance</>
                                    ) : (
                                        <><Radio className="w-4 h-4" /> Start Surveillance</>
                                    )}
                                </button>

                                {isStreaming && (
                                    <div className="flex items-center gap-2 text-xs text-slate-400">
                                        <div className={`w-2 h-2 rounded-full animate-pulse ${wsConnected ? 'bg-green-500' : 'bg-amber-500'}`} />
                                        Camera Active · {detectedFaces.length} face{detectedFaces.length !== 1 ? 's' : ''} detected
                                        <span className={wsConnected ? 'text-emerald-400' : 'text-amber-400'}>
                                            · {wsConnected ? 'WS' : 'WS reconnecting'}
                                        </span>
                                        {latencyMs != null && (
                                            <span className="text-slate-500">
                                                · {latencyMs} ms RTT{pipelineMs != null ? ` (pipeline ${pipelineMs} ms)` : ''}
                                            </span>
                                        )}
                                        {cameraLocation ? (
                                            <span className="text-emerald-400">· location attached</span>
                                        ) : (
                                            <span className="text-slate-500">· location unavailable</span>
                                        )}
                                    </div>
                                )}
                            </div>

                            {liveError && (
                                <div className="mt-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                                    <AlertCircle className="w-4 h-4 flex-shrink-0" /> {liveError}
                                </div>
                            )}
                        </>
                    )}

                    {/* File Upload Mode (existing) */}
                    {mode === 'upload' && (
                        <>
                            <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden group">
                                {!preview ? (
                                    <div className="text-center p-8">
                                        <LocateFixed className="w-16 h-16 text-slate-700 mx-auto mb-4" />
                                        <h3 className="text-lg font-medium text-slate-300">No Feed Active</h3>
                                        <p className="text-slate-500 text-sm mt-2 max-w-sm">Upload a video or image to run the inference pipeline. The system will auto-match detected persons against the criminal database.</p>
                                    </div>
                                ) : (
                                    <div className="w-full h-full relative flex items-center justify-center bg-black">
                                        {isVideo ? (
                                            <video src={preview} controls className="max-w-full max-h-full object-contain" />
                                        ) : (
                                            <img src={preview} alt="Feed" className="max-w-full max-h-full object-contain" />
                                        )}
                                        <div className="absolute top-4 left-4 bg-black/60 backdrop-blur border border-white/10 px-3 py-1.5 rounded text-xs font-mono flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                            REC
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="mt-6 flex flex-col sm:flex-row gap-4 bg-slate-900 p-4 rounded-xl border border-slate-800">
                                <label className="flex-1 border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl flex items-center justify-center cursor-pointer transition-colors px-4 py-3 bg-slate-950">
                                    <Upload className="w-5 h-5 text-indigo-400 mr-2" />
                                    <span className="text-sm font-medium text-slate-300 truncate max-w-[200px]">
                                        {file ? file.name : 'Select Video / Image'}
                                    </span>
                                    <input type="file" accept="video/*,image/*" className="hidden" onChange={handleFileChange} />
                                </label>

                                <button onClick={handleUpload} disabled={!file || submitting}
                                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-xl font-semibold text-sm transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50 whitespace-nowrap">
                                    {submitting ? 'Analyzing...' : 'Run Analysis'}
                                </button>
                            </div>

                            {error && (
                                <div className="mt-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                                    <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Right: Detections Panel */}
                <div className="w-full lg:w-96 bg-slate-900 flex flex-col h-full lg:max-h-[calc(100vh-64px)] overflow-hidden">
                    <div className="p-4 border-b border-slate-800 bg-slate-900 z-10">
                        <h2 className="font-bold text-slate-200">
                            {mode === 'live' ? 'Live Identifications' : 'Detections'}
                        </h2>
                        <div className="flex gap-2 mt-2 text-xs font-mono">
                            {mode === 'live' ? (
                                <>
                                    <div className="bg-slate-800 px-2 py-1 rounded text-slate-400">
                                        Faces: <span className="text-white font-bold">{detectedFaces.length}</span>
                                    </div>
                                    <div className={`px-2 py-1 rounded font-bold ${matchCount > 0 ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-slate-800 text-slate-400'}`}>
                                        Matches: <span className="text-white">{matchCount}</span>
                                    </div>
                                </>
                            ) : (
                                <div className="bg-slate-800 px-2 py-1 rounded text-slate-400">
                                    Total Persons: <span className="text-white font-bold">{result?.totalPersons || 0}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {mode === 'live' ? (
                            matchHistory.length === 0 ? (
                                <div className="text-center py-12 text-slate-500 text-sm">
                                    {isStreaming ? 'Scanning for known criminals...' : 'Start surveillance to begin scanning.'}
                                </div>
                            ) : (
                                matchHistory.map((match, idx) => (
                                    <div key={idx} className="bg-slate-950 border border-red-500/20 rounded-xl overflow-hidden shadow-sm p-3">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <ShieldAlert className="w-4 h-4 text-red-400" />
                                                <span className="font-bold text-sm text-red-300">{match.name}</span>
                                            </div>
                                            <span className="text-[10px] text-slate-500 font-mono">{match.timestamp}</span>
                                        </div>
                                        <div className="flex items-center gap-3 text-xs">
                                            <span className={`px-2 py-0.5 rounded font-bold ${
                                                toMatchPercent(match.confidence) >= 70 ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'
                                            }`}>
                                                {toMatchPercent(match.confidence).toFixed(0)}% match
                                            </span>
                                            <span className="text-slate-500">
                                                Box: {match.bounding_box.x},{match.bounding_box.y}
                                            </span>
                                        </div>
                                    </div>
                                ))
                            )
                        ) : (
                            !result ? (
                                <div className="text-center py-12 text-slate-500 text-sm">Awaiting analysis results...</div>
                            ) : result.detections?.length === 0 ? (
                                <div className="text-center py-12 text-slate-500 text-sm">No persons detected in the feed.</div>
                            ) : (
                                result.detections.map((det: any, idx: number) => (
                                    <div key={idx} className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-sm flex">
                                        <div className="w-24 h-24 bg-black flex-shrink-0 relative">
                                            <img src={`${getApiBaseUrl()}/cctv-detections/${det.personCrop}`} className="w-full h-full object-cover" alt="Crop" />
                                            <div className="absolute top-1 left-1 bg-black/70 text-[10px] text-white px-1.5 py-0.5 rounded font-mono">
                                                {(det.confidence * 100).toFixed(0)}%
                                            </div>
                                        </div>
                                        <div className="p-3 flex-1 flex flex-col justify-center">
                                            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mb-1">
                                                <User className="w-3.5 h-3.5 text-slate-500" />
                                                Person Detected
                                            </div>
                                            <p className="text-[10px] text-slate-500 font-mono break-all leading-tight">
                                                ID: {det.id.split('-')[0]}...
                                            </p>
                                            <div className="mt-2 text-[10px] font-semibold text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded w-fit">
                                                Auto-Matched
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
