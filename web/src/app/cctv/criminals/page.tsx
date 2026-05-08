'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Navbar from '../../../components/Navbar';
import { useAuth } from '../../../context/AuthContext';
import { Plus, User, Search, Upload, FileText, CheckCircle, XCircle, Camera, Video, Aperture, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';

interface Criminal {
    id: string;
    name: string;
    firNumber: string | null;
    mugshotUrl: string | null;
    notes: string | null;
    sampleCount: number;
    createdAt: string;
}

export default function CriminalDBPage() {
    const { token, user, loading } = useAuth();
    const router = useRouter();
    const [criminals, setCriminals] = useState<Criminal[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [regMode, setRegMode] = useState<'webcam' | 'upload'>('webcam');

    // Form state
    const [name, setName] = useState('');
    const [firNumber, setFirNumber] = useState('');
    const [notes, setNotes] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    // Webcam capture state
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [isCamActive, setIsCamActive] = useState(false);
    const [capturedSamples, setCapturedSamples] = useState<string[]>([]);
    const [captureCount, setCaptureCount] = useState(0);

    // Recognition status
    const [recStatus, setRecStatus] = useState<any>(null);
    const [selectedCriminal, setSelectedCriminal] = useState<Criminal | null>(null);
    const [selectedSamples, setSelectedSamples] = useState<string[]>([]);
    const [loadingSamples, setLoadingSamples] = useState(false);
    const [addSampleFiles, setAddSampleFiles] = useState<File[]>([]);
    const [addingSamples, setAddingSamples] = useState(false);

    useEffect(() => {
        if (!loading && (!user || (user.role !== 'ADMIN' && user.role !== 'LAW_ENFORCEMENT'))) {
            router.push('/');
        }
    }, [user, loading, router]);

    useEffect(() => {
        if (!token) return;
        fetchCriminals();
        fetchRecStatus();
    }, [token]);

    // Cleanup webcam on unmount
    useEffect(() => {
        return () => { stopCam(); };
    }, []);

    const fetchCriminals = async () => {
        setIsLoading(true);
        setError('');
        try {
            let res: Response | null = null;
            let lastErr: unknown = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    res = await fetch(`${API}/api/cctv/criminal-db`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    break;
                } catch (err) {
                    lastErr = err;
                    await new Promise((r) => setTimeout(r, 250));
                }
            }
            if (!res) throw lastErr ?? new Error('Failed to fetch criminal records');
            if (res.ok) {
                const data = await res.json();
                setCriminals(data.criminals || []);
            } else {
                setCriminals([]);
                setError('Unable to load Criminal DB. Please login again or restart API server.');
            }
        } catch {
            setCriminals([]);
            setError('Cannot reach API server at http://localhost:3001. Start/restart backend and refresh.');
        } finally {
            setIsLoading(false);
        }
    };

    const fetchRecStatus = async () => {
        try {
            const res = await fetch(`${API}/api/cctv/recognition-status`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setRecStatus(data);
            }
        } catch { }
    };

    // ── Webcam Methods ──
    const startCam = async () => {
        try {
            let stream: MediaStream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 640, height: 480, facingMode: 'user' },
                });
            } catch {
                // Fallback: try without specific constraints
                stream = await navigator.mediaDevices.getUserMedia({ video: true });
            }
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setIsCamActive(true);
        } catch (err: any) {
            setError(err?.message || 'Cannot access webcam. Ensure no other app is using the camera.');
        }
    };

    const stopCam = () => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        setIsCamActive(false);
    };

    const captureSample = useCallback(() => {
        if (!videoRef.current || !canvasRef.current) return;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setCapturedSamples(prev => [...prev, dataUrl]);
        setCaptureCount(prev => prev + 1);
    }, []);

    const resetCapture = () => {
        setCapturedSamples([]);
        setCaptureCount(0);
    };

    // ── Submit Handlers ──
    const handleWebcamSubmit = async () => {
        setError('');
        setSuccess(false);
        if (!name.trim()) { setError('Name is required.'); return; }
        if (capturedSamples.length < 1) { setError('Capture at least 1 face sample.'); return; }

        setSubmitting(true);
        try {
            const fd = new FormData();
            const normalizedName = name.trim();
            fd.append('name', normalizedName);
            // Defensive aliases for backend compatibility.
            fd.append('fullName', normalizedName);
            fd.append('criminalName', normalizedName);
            fd.append('firNumber', firNumber);
            fd.append('notes', notes);
            fd.append('base64_samples', JSON.stringify(capturedSamples));

            const res = await fetch(`${API}/api/cctv/register-criminal-samples?name=${encodeURIComponent(normalizedName)}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: fd,
            });

            const data = await res.json();
            if (!res.ok) {
                setError(data.error || 'Registration failed');
            } else {
                setSuccess(true);
                setName('');
                setFirNumber('');
                setNotes('');
                setCapturedSamples([]);
                setCaptureCount(0);
                stopCam();
                setShowForm(false);
                fetchCriminals();
                fetchRecStatus();
            }
        } catch {
            setError('An error occurred during registration.');
        } finally {
            setSubmitting(false);
        }
    };

    const handleMugshotSubmit = async () => {
        setError('');
        setSuccess(false);

        if (!name.trim() || files.length === 0) {
            setError('Name and at least 1 mugshot image are required.');
            return;
        }

        setSubmitting(true);
        try {
            const fd = new FormData();
            fd.append('name', name.trim());
            fd.append('firNumber', firNumber);
            fd.append('notes', notes);
            for (const f of files) {
                fd.append('samples', f);
            }

            const res = await fetch(`${API}/api/cctv/register-criminal-samples?name=${encodeURIComponent(name.trim())}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: fd,
            });

            const data = await res.json();
            if (!res.ok) {
                setError(data.error || 'Failed to upload criminal record');
            } else {
                setSuccess(true);
                setName('');
                setFirNumber('');
                setNotes('');
                setFiles([]);
                setShowForm(false);
                fetchCriminals();
                fetchRecStatus();
            }
        } catch {
            setError('An error occurred during upload.');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDeleteCriminal = async (criminalId: string) => {
        try {
            const res = await fetch(`${API}/api/cctv/criminal-db/${criminalId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                setCriminals(prev => prev.filter(c => c.id !== criminalId));
            }
        } catch (e) {
            console.error(e);
        }
    };

    const openCriminalDetails = async (criminal: Criminal) => {
        setSelectedCriminal(criminal);
        setSelectedSamples([]);
        setAddSampleFiles([]);
        setLoadingSamples(true);
        try {
            const res = await fetch(`${API}/api/cctv/criminal-db/${criminal.id}/samples`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) setSelectedSamples(Array.isArray(data.samples) ? data.samples : []);
        } catch {
            // ignore transient sample-load errors
        } finally {
            setLoadingSamples(false);
        }
    };

    const handleAddSamples = async () => {
        if (!selectedCriminal || addSampleFiles.length === 0) return;
        setAddingSamples(true);
        setError('');
        try {
            const fd = new FormData();
            for (const f of addSampleFiles) fd.append('samples', f);
            const res = await fetch(`${API}/api/cctv/criminal-db/${selectedCriminal.id}/add-samples`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: fd,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.error || 'Failed to add images.');
                return;
            }
            setAddSampleFiles([]);
            await fetchCriminals();
            await openCriminalDetails(selectedCriminal);
        } catch {
            setError('Failed to add images.');
        } finally {
            setAddingSamples(false);
        }
    };

    if (loading || !user) return <div className="min-h-screen bg-slate-950" />;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Header */}
                <div className="flex justify-between items-center mb-6">
                    <div>
                        <h1 className="text-3xl font-bold mb-2">Criminal Database</h1>
                        <p className="text-slate-400">Verified intelligence database for face matching operations.</p>
                    </div>
                    <div className="flex gap-3 items-center">
                        {recStatus && (
                            <div className={`text-xs px-3 py-1.5 rounded-full border font-mono ${recStatus.model_trained ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                                {recStatus.model_trained ? `Model Active · ${recStatus.total_subjects} subjects` : 'Model Not Trained'}
                            </div>
                        )}
                        <button
                            onClick={() => { setShowForm(!showForm); setError(''); setSuccess(false); }}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-indigo-600/20 flex items-center gap-2"
                        >
                            {showForm ? <XCircle className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                            {showForm ? 'Cancel' : 'Register Criminal'}
                        </button>
                    </div>
                </div>

                {/* Success toast */}
                {success && (
                    <div className="mb-6 bg-green-500/10 border border-green-500/20 text-green-400 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                        <CheckCircle className="w-4 h-4" /> Criminal registered successfully. LBPH model retrained.
                    </div>
                )}

                {/* Registration Form */}
                {showForm && (
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-8 shadow-xl">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-xl font-bold flex items-center gap-2">
                                <User className="w-5 h-5 text-indigo-400" />
                                New Criminal Record
                            </h2>
                            {/* Mode Toggle */}
                            <div className="flex gap-1 bg-slate-800 border border-slate-700 rounded-xl p-1">
                                <button onClick={() => setRegMode('webcam')}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${regMode === 'webcam' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                                    <Camera className="w-3 h-3" /> Webcam Capture
                                </button>
                                <button onClick={() => setRegMode('upload')}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${regMode === 'upload' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                                    <Upload className="w-3 h-3" /> Mugshot Upload
                                </button>
                            </div>
                        </div>

                        {error && (
                            <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-3 rounded-xl text-sm mb-6 flex items-center gap-2">
                                <XCircle className="w-4 h-4" /> {error}
                            </div>
                        )}

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {/* Left: Form Fields */}
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Full Name *</label>
                                    <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-500 outline-none" required />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">FIR Number</label>
                                    <input type="text" value={firNumber} onChange={(e) => setFirNumber(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-500 outline-none font-mono" />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Notes</label>
                                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-500 outline-none resize-none h-24" />
                                </div>
                            </div>

                            {/* Right: Capture Area */}
                            <div className="flex flex-col">
                                {regMode === 'webcam' ? (
                                    <>
                                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
                                            Face Samples ({captureCount} captured)
                                        </label>

                                        {/* Webcam Preview */}
                                        <div className="flex-1 bg-slate-950 border border-slate-700 rounded-2xl overflow-hidden relative min-h-[240px] flex items-center justify-center">
                                            <video ref={videoRef} className={isCamActive ? 'w-full h-full object-cover' : 'hidden'} muted playsInline />
                                            <canvas ref={canvasRef} className="hidden" />

                                            {!isCamActive && (
                                                <div className="text-center p-6">
                                                    <Video className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                                                    <p className="text-sm text-slate-500">Camera not started</p>
                                                </div>
                                            )}

                                            {isCamActive && captureCount > 0 && (
                                                <div className="absolute top-3 right-3 bg-black/60 backdrop-blur text-xs text-white px-2 py-1 rounded-lg font-mono">
                                                    {captureCount} captured
                                                </div>
                                            )}
                                        </div>

                                        {/* Webcam controls */}
                                        <div className="mt-3 flex gap-2">
                                            {!isCamActive ? (
                                                <button onClick={startCam} type="button"
                                                    className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all">
                                                    <Camera className="w-4 h-4" /> Start Camera
                                                </button>
                                            ) : (
                                                <>
                                                    <button onClick={captureSample} type="button"
                                                        className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all active:scale-95">
                                                        <Aperture className="w-4 h-4" /> Capture ({captureCount})
                                                    </button>
                                                    <button onClick={resetCapture} type="button"
                                                        className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-2.5 rounded-xl text-sm transition-all"
                                                        title="Reset captures">
                                                        <RefreshCw className="w-4 h-4" />
                                                    </button>
                                                    <button onClick={stopCam} type="button"
                                                        className="bg-red-600/20 hover:bg-red-600/30 border border-red-500/20 text-red-400 px-3 py-2.5 rounded-xl text-sm transition-all"
                                                        title="Stop camera">
                                                        <XCircle className="w-4 h-4" />
                                                    </button>
                                                </>
                                            )}
                                        </div>

                                        {/* Thumbnail strip */}
                                        {capturedSamples.length > 0 && (
                                            <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
                                                {capturedSamples.slice(-8).map((s, i) => (
                                                    <img key={i} src={s} alt={`Sample ${i + 1}`}
                                                        className="w-10 h-10 rounded-lg object-cover border border-slate-700 flex-shrink-0" />
                                                ))}
                                                {capturedSamples.length > 8 && (
                                                    <div className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-[10px] text-slate-400 font-mono flex-shrink-0">
                                                        +{capturedSamples.length - 8}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block">Mugshots (1 or more clear face photos) *</label>
                                        <label className={`flex-1 border-2 border-dashed ${files.length > 0 ? 'border-indigo-500 bg-indigo-500/5' : 'border-slate-700 hover:border-slate-500'} rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-colors p-6 text-center min-h-[240px]`}>
                                            <Upload className={`w-8 h-8 mb-3 ${files.length > 0 ? 'text-indigo-400' : 'text-slate-500'}`} />
                                            {files.length > 0 ? (
                                                <div className="text-sm font-medium text-slate-200">
                                                    {files.length} image{files.length > 1 ? 's' : ''} selected
                                                </div>
                                            ) : (
                                                <>
                                                    <p className="text-sm text-slate-400">Click or drag images to upload</p>
                                                    <p className="text-xs text-slate-600 mt-2">Use multiple angles (front/left/right/up/down) for better matching</p>
                                                </>
                                            )}
                                            <input
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                className="hidden"
                                                onChange={(e) => setFiles(Array.from(e.target.files || []))}
                                            />
                                        </label>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Submit */}
                        <div className="pt-6 mt-6 border-t border-slate-800 flex justify-end">
                            <button
                                type="button"
                                onClick={regMode === 'webcam' ? handleWebcamSubmit : handleMugshotSubmit}
                                disabled={submitting}
                                className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50 flex items-center gap-2"
                            >
                                {submitting ? (
                                    <><RefreshCw className="w-4 h-4 animate-spin" /> Processing...</>
                                ) : regMode === 'webcam' ? (
                                    <><CheckCircle className="w-4 h-4" /> Register & Train Model</>
                                ) : (
                                    'Save to Database'
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* Criminal Grid */}
                {isLoading ? (
                    <div className="flex justify-center py-20">
                        <div className="w-8 h-8 rounded-full border-4 border-slate-800 border-t-indigo-500 animate-spin" />
                    </div>
                ) : criminals.length === 0 ? (
                    <div className="text-center py-20 border border-slate-800 border-dashed rounded-2xl">
                        <Search className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-slate-300">No criminal records found</h3>
                        <p className="text-slate-500 text-sm mt-1">Add a suspect to start building the database.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {criminals.map((criminal) => (
                            <div
                                key={criminal.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                    void openCriminalDetails(criminal);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        void openCriminalDetails(criminal);
                                    }
                                }}
                                className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-slate-700 transition-colors group cursor-pointer"
                            >
                                <div className="aspect-square bg-slate-950 relative overflow-hidden">
                                    {criminal.mugshotUrl ? (
                                        <img
                                            src={criminal.mugshotUrl}
                                            alt={criminal.name}
                                            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <User className="w-12 h-12 text-slate-800" />
                                        </div>
                                    )}
                                    {criminal.sampleCount > 0 && (
                                        <div className="absolute top-2 right-2 bg-green-500/90 text-[10px] text-white px-2 py-0.5 rounded-full font-bold">
                                            {criminal.sampleCount} samples
                                        </div>
                                    )}
                                </div>
                                <div className="p-5">
                                    <h3 className="font-bold text-lg text-slate-100 mb-1 truncate">{criminal.name}</h3>
                                    <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-3">
                                        <FileText className="w-3.5 h-3.5" />
                                        <span className="font-mono">{criminal.firNumber || 'No FIR Data'}</span>
                                    </div>
                                    {criminal.notes && (
                                        <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{criminal.notes}</p>
                                    )}
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void handleDeleteCriminal(criminal.id);
                                        }}
                                        className="mt-4 w-full bg-rose-600/10 hover:bg-rose-600/20 border border-rose-500/30 text-rose-300 px-3 py-2 rounded-lg text-xs font-semibold transition-all"
                                    >
                                        Delete Record
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {selectedCriminal ? (
                    <div className="fixed inset-0 z-[2200] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4">
                        <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
                            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-100">{selectedCriminal.name}</h3>
                                    <p className="text-xs text-slate-400 font-mono">{selectedCriminal.firNumber || 'No FIR data'}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSelectedCriminal(null)}
                                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-300 hover:text-white"
                                >
                                    Close
                                </button>
                            </div>

                            <div className="p-5 space-y-4">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
                                        Uploaded/Captured Photos
                                    </p>
                                    {loadingSamples ? (
                                        <div className="text-sm text-slate-400">Loading photos...</div>
                                    ) : selectedSamples.length === 0 ? (
                                        <div className="text-sm text-slate-500">No sample photos stored for this record yet.</div>
                                    ) : (
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                            {selectedSamples.map((src, idx) => (
                                                <a key={src} href={src} target="_blank" rel="noreferrer" className="block">
                                                    <img
                                                        src={src}
                                                        alt={`Sample ${idx + 1}`}
                                                        className="w-full h-28 object-cover rounded-xl border border-slate-700 hover:border-indigo-500 transition-colors"
                                                    />
                                                </a>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="border-t border-slate-800 pt-4">
                                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
                                        Add More Pictures
                                    </p>
                                    <div className="flex flex-col sm:flex-row gap-3">
                                        <input
                                            type="file"
                                            accept="image/*"
                                            multiple
                                            onChange={(e) => setAddSampleFiles(Array.from(e.target.files || []))}
                                            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200"
                                        />
                                        <button
                                            type="button"
                                            onClick={handleAddSamples}
                                            disabled={addingSamples || addSampleFiles.length === 0}
                                            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold"
                                        >
                                            {addingSamples ? 'Adding...' : 'Add Pictures'}
                                        </button>
                                    </div>
                                    {addSampleFiles.length > 0 ? (
                                        <p className="text-xs text-slate-400 mt-2">{addSampleFiles.length} image(s) selected</p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}
            </main>
        </div>
    );
}
