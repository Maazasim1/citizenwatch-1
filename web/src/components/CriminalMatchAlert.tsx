'use client';

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { AlertTriangle, X, MapPin, User, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getApiBaseUrl } from '@/lib/apiBase';

interface CriminalMatch {
    matchId: string;
    criminalName: string;
    firNumber: string;
    confidence: number;
    latitude?: number | null;
    longitude?: number | null;
    source: string;
    mugshotUrl?: string;
}

export default function CriminalMatchAlert() {
    const { user } = useAuth();
    const [matches, setMatches] = useState<CriminalMatch[]>([]);

    useEffect(() => {
        // Only admins/moderators/law enforcement should see these alerts
        if (!user || user.role === 'CITIZEN') return;

        const socket = io(getApiBaseUrl());

        socket.on('criminal:matched', (data: CriminalMatch) => {
            setMatches((prev) => [...prev, data]);
            
            // Auto-dismiss after 15 seconds if not interacted with
            setTimeout(() => {
                dismissMatch(data.matchId);
            }, 15000);
        });

        return () => {
            socket.disconnect();
        };
    }, [user]);

    const dismissMatch = (id: string) => {
        setMatches((prev) => prev.filter((m) => m.matchId !== id));
    };

    if (matches.length === 0) return null;

    return (
        <div className="fixed top-20 right-4 z-50 flex flex-col gap-3 max-w-sm w-full">
            {matches.map((match) => (
                <div 
                    key={match.matchId}
                    className="bg-slate-900 border border-rose-500/50 shadow-2xl shadow-rose-900/20 rounded-xl overflow-hidden animate-in slide-in-from-right-8"
                >
                    <div className="bg-rose-500/10 border-b border-rose-500/20 px-4 py-3 flex justify-between items-center">
                        <div className="flex items-center gap-2 text-rose-500 font-bold uppercase tracking-wider text-sm">
                            <ShieldAlert className="w-5 h-5 animate-pulse" />
                            CRIMINAL MATCH ALERT
                        </div>
                        <button 
                            onClick={() => dismissMatch(match.matchId)}
                            className="text-slate-400 hover:text-slate-200 transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    
                    <div className="p-4 flex gap-4 items-start">
                        {match.mugshotUrl ? (
                            <img 
                                src={match.mugshotUrl} 
                                alt={match.criminalName}
                                className="w-16 h-16 rounded-lg object-cover border border-slate-700 bg-slate-800"
                            />
                        ) : (
                            <div className="w-16 h-16 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
                                <User className="w-8 h-8 text-slate-500" />
                            </div>
                        )}
                        
                        <div className="flex-1">
                            <h3 className="font-bold text-slate-100">{match.criminalName}</h3>
                            {match.firNumber && (
                                <p className="text-xs text-slate-400 mb-2">FIR: {match.firNumber}</p>
                            )}
                            
                            <div className="flex items-center gap-1 text-xs font-semibold text-rose-400 bg-rose-500/10 rounded px-2 py-1 w-fit mb-2">
                                {(match.confidence * 100).toFixed(1)}% Match Confidence
                            </div>
                            
                            <div className="flex items-start gap-1 text-xs text-slate-400">
                                <MapPin className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                                <span>
                                    Detected via {match.source === 'CCTV' || match.source === 'LIVE_SURVEILLANCE' ? 'CCTV Feed' : 'Citizen Photo'}<br/>
                                    {typeof match.latitude === 'number' && Number.isFinite(match.latitude) &&
                                     typeof match.longitude === 'number' && Number.isFinite(match.longitude)
                                        ? `${match.latitude.toFixed(4)}, ${match.longitude.toFixed(4)}`
                                        : 'Location unavailable'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
