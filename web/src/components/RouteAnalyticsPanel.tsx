'use client';

import { useMemo } from 'react';
import {
    ShieldCheck,
    Zap,
    Clock,
    Route,
    TrendingDown,
    AlertTriangle,
    BarChart3,
    ArrowRight,
    Shield,
    Timer,
} from 'lucide-react';

/* ── types ─────────────────────────────────────────────────────────── */

type LatLng = { latitude: number; longitude: number };
type Segment = { start: LatLng; end: LatLng; risk: number; placeLabel?: string };

export interface RouteStats {
    shortestDistanceKm: number;
    shortestRiskAvg: number;
    safeDistanceKm: number;
    safeRiskAvg: number;
    riskReductionPct: number;
}

export interface RouteAnalyticsPanelProps {
    stats: RouteStats;
    safeSegments: Segment[];
    avoidedPlaces: Array<{ label: string; diff: number }>;
}

/* ── helper: estimated travel time ─────────────────────────────────── */
const AVG_SPEED_KMH = 30; // urban Karachi avg

const estimateMinutes = (distKm: number) =>
    Math.max(1, Math.round((distKm / AVG_SPEED_KMH) * 60));

const fmtTime = (mins: number) =>
    mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;

/* ── sub-components ────────────────────────────────────────────────── */

function RiskGauge({ pct }: { pct: number }) {
    const clamped = Math.max(-100, Math.min(100, pct));
    const positive = clamped >= 0;
    const absVal = Math.abs(clamped);
    const circumference = 2 * Math.PI * 54;
    const offset = circumference - (absVal / 100) * circumference;

    return (
        <div className="flex flex-col items-center">
            <div className="relative w-36 h-36">
                <svg className="w-36 h-36 -rotate-90" viewBox="0 0 120 120">
                    {/* Background track */}
                    <circle
                        cx="60" cy="60" r="54"
                        fill="none"
                        stroke="currentColor"
                        className="text-slate-800"
                        strokeWidth="8"
                    />
                    {/* Active arc */}
                    <circle
                        cx="60" cy="60" r="54"
                        fill="none"
                        stroke={positive ? '#22c55e' : '#ef4444'}
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                        style={{
                            transition: 'stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)',
                        }}
                    />
                </svg>
                {/* Center text */}
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span
                        className={`text-3xl font-bold tracking-tight ${positive ? 'text-green-400' : 'text-red-400'}`}
                    >
                        {positive ? '' : '-'}
                        {absVal.toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest mt-0.5">
                        Risk {positive ? 'Reduced' : 'Increased'}
                    </span>
                </div>
            </div>
        </div>
    );
}

function StatCard({
    icon: Icon,
    label,
    shortestValue,
    safeValue,
    unit,
    better,
}: {
    icon: React.ElementType;
    label: string;
    shortestValue: string;
    safeValue: string;
    unit: string;
    better: 'safe' | 'shortest' | 'equal';
}) {
    return (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
            <div className="flex items-center gap-2 mb-3">
                <Icon className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    {label}
                </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div
                    className={`rounded-lg p-2.5 text-center border ${
                        better === 'shortest'
                            ? 'bg-green-500/5 border-green-500/20'
                            : 'bg-slate-950 border-slate-800'
                    }`}
                >
                    <div className="text-[10px] text-amber-400 font-semibold uppercase tracking-wider mb-1">
                        Shortest
                    </div>
                    <div className="text-lg font-bold text-slate-100">{shortestValue}</div>
                    <div className="text-[10px] text-slate-500">{unit}</div>
                </div>
                <div
                    className={`rounded-lg p-2.5 text-center border ${
                        better === 'safe'
                            ? 'bg-green-500/5 border-green-500/20'
                            : 'bg-slate-950 border-slate-800'
                    }`}
                >
                    <div className="text-[10px] text-blue-400 font-semibold uppercase tracking-wider mb-1">
                        Safe Route
                    </div>
                    <div className="text-lg font-bold text-slate-100">{safeValue}</div>
                    <div className="text-[10px] text-slate-500">{unit}</div>
                </div>
            </div>
        </div>
    );
}

function TradeOffBar({ riskReduced, distAdded }: { riskReduced: number; distAdded: number }) {
    // Efficiency ratio: how much risk is reduced per unit of extra distance
    const efficiency =
        distAdded > 0 ? (riskReduced / distAdded).toFixed(1) : riskReduced > 0 ? '∞' : '0';
    const riskBar = Math.min(100, Math.max(0, riskReduced));
    const distBar = Math.min(100, Math.max(0, distAdded));

    return (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <TrendingDown className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Safety–Distance Trade-off
                </span>
            </div>

            {/* Risk reduced bar */}
            <div className="mb-3">
                <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-green-400 font-medium flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" /> Risk Reduced
                    </span>
                    <span className="text-green-300 font-bold">{riskReduced.toFixed(1)}%</span>
                </div>
                <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                        className="h-full rounded-full bg-gradient-to-r from-green-600 to-emerald-400"
                        style={{
                            width: `${riskBar}%`,
                            transition: 'width 1s cubic-bezier(.4,0,.2,1)',
                        }}
                    />
                </div>
            </div>

            {/* Distance added bar */}
            <div className="mb-4">
                <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-amber-400 font-medium flex items-center gap-1">
                        <Route className="w-3 h-3" /> Distance Added
                    </span>
                    <span className="text-amber-300 font-bold">{distAdded.toFixed(1)}%</span>
                </div>
                <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-400"
                        style={{
                            width: `${distBar}%`,
                            transition: 'width 1s cubic-bezier(.4,0,.2,1)',
                        }}
                    />
                </div>
            </div>

            {/* Efficiency ratio */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg px-4 py-3 flex items-center justify-between">
                <span className="text-xs text-slate-400">Efficiency ratio</span>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                        {riskReduced.toFixed(0)}% safer
                    </span>
                    <ArrowRight className="w-3 h-3 text-slate-600" />
                    <span className="text-xs text-slate-500">{distAdded.toFixed(0)}% longer</span>
                    <span className="text-sm font-bold text-indigo-400 ml-2">
                        {efficiency}× efficiency
                    </span>
                </div>
            </div>
        </div>
    );
}

function SegmentRiskDistribution({ segments }: { segments: Segment[] }) {
    const maxRisk = Math.max(1e-6, ...segments.map((s) => s.risk));
    const buckets = [0, 0, 0, 0, 0]; // 5 buckets: 0-20%, 20-40%, 40-60%, 60-80%, 80-100%
    const bucketLabels = ['Very Low', 'Low', 'Medium', 'High', 'Critical'];
    const bucketColors = ['#6366f1', '#3b82f6', '#f59e0b', '#f97316', '#ef4444'];

    for (const s of segments) {
        const ratio = s.risk / maxRisk;
        const bucket = Math.min(4, Math.floor(ratio * 5));
        buckets[bucket]++;
    }

    const maxBucket = Math.max(1, ...buckets);

    return (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Segment Risk Distribution
                </span>
                <span className="ml-auto text-xs text-slate-600">
                    {segments.length} segment{segments.length !== 1 ? 's' : ''}
                </span>
            </div>

            <div className="flex items-end gap-2 h-24 mb-2">
                {buckets.map((count, i) => {
                    const height = (count / maxBucket) * 100;
                    return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1">
                            <span className="text-[10px] text-slate-400 font-mono">{count}</span>
                            <div
                                className="w-full rounded-t-md"
                                style={{
                                    height: `${Math.max(4, height)}%`,
                                    backgroundColor: bucketColors[i],
                                    opacity: count > 0 ? 0.85 : 0.2,
                                    transition: 'height 0.8s cubic-bezier(.4,0,.2,1)',
                                }}
                            />
                        </div>
                    );
                })}
            </div>

            <div className="flex gap-2">
                {bucketLabels.map((label, i) => (
                    <div key={i} className="flex-1 text-center">
                        <div
                            className="w-2 h-2 rounded-full mx-auto mb-1"
                            style={{ backgroundColor: bucketColors[i] }}
                        />
                        <span className="text-[9px] text-slate-500">{label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function DangerZonesTable({ places }: { places: Array<{ label: string; diff: number }> }) {
    if (places.length === 0) return null;
    const maxDiff = Math.max(1e-6, ...places.map((p) => Math.abs(p.diff)));

    return (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Danger Zones Avoided
                </span>
            </div>

            <div className="space-y-2.5">
                {places.map((p, idx) => {
                    const isAvoided = p.diff > 0;
                    const barWidth = Math.min(100, (Math.abs(p.diff) / maxDiff) * 100);
                    return (
                        <div key={`${p.label}-${idx}`}>
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-xs text-slate-300 font-medium truncate max-w-[60%]">
                                    {p.label}
                                </span>
                                <span
                                    className={`text-xs font-bold ${
                                        isAvoided ? 'text-green-400' : 'text-red-400'
                                    }`}
                                >
                                    {isAvoided ? '−' : '+'}
                                    {Math.abs(p.diff).toFixed(2)} exposure
                                </span>
                            </div>
                            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${
                                        isAvoided
                                            ? 'bg-gradient-to-r from-green-600 to-emerald-400'
                                            : 'bg-gradient-to-r from-red-600 to-red-400'
                                    }`}
                                    style={{
                                        width: `${barWidth}%`,
                                        transition: 'width 0.8s ease',
                                    }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/* ── main component ────────────────────────────────────────────────── */

export default function RouteAnalyticsPanel({
    stats,
    safeSegments,
    avoidedPlaces,
}: RouteAnalyticsPanelProps) {
    const shortestTimeMins = estimateMinutes(stats.shortestDistanceKm);
    const safeTimeMins = estimateMinutes(stats.safeDistanceKm);
    const addedTimeMins = safeTimeMins - shortestTimeMins;
    const distAddedPct =
        stats.shortestDistanceKm > 0
            ? ((stats.safeDistanceKm - stats.shortestDistanceKm) / stats.shortestDistanceKm) * 100
            : 0;

    return (
        <div className="space-y-4 mt-6">
            {/* Header */}
            <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                    <Shield className="w-4 h-4 text-indigo-400" />
                </div>
                <div>
                    <h2 className="text-base font-bold text-slate-100">Route Comparison Analytics</h2>
                    <p className="text-xs text-slate-500">
                        Risk reduced vs. time added when taking the safe route
                    </p>
                </div>
            </div>

            {/* Top row: Gauge + Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Gauge */}
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex items-center justify-center">
                    <RiskGauge pct={stats.riskReductionPct} />
                </div>

                {/* Quick summary cards */}
                <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <StatCard
                        icon={Route}
                        label="Distance"
                        shortestValue={stats.shortestDistanceKm.toFixed(2)}
                        safeValue={stats.safeDistanceKm.toFixed(2)}
                        unit="km"
                        better={
                            stats.shortestDistanceKm <= stats.safeDistanceKm
                                ? 'shortest'
                                : 'safe'
                        }
                    />
                    <StatCard
                        icon={AlertTriangle}
                        label="Avg Risk Score"
                        shortestValue={stats.shortestRiskAvg.toFixed(2)}
                        safeValue={stats.safeRiskAvg.toFixed(2)}
                        unit="risk"
                        better={
                            stats.safeRiskAvg <= stats.shortestRiskAvg ? 'safe' : 'shortest'
                        }
                    />
                    <StatCard
                        icon={Timer}
                        label="Est. Travel Time"
                        shortestValue={fmtTime(shortestTimeMins)}
                        safeValue={fmtTime(safeTimeMins)}
                        unit={`@ ${AVG_SPEED_KMH}km/h`}
                        better={shortestTimeMins <= safeTimeMins ? 'shortest' : 'safe'}
                    />
                    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center">
                        <Clock className="w-5 h-5 text-slate-600 mb-2" />
                        <span className="text-2xl font-bold text-slate-100">
                            +{addedTimeMins < 0 ? 0 : addedTimeMins} min
                        </span>
                        <span className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
                            Extra Time for Safety
                        </span>
                        <span className="text-xs text-slate-400 mt-2">
                            {stats.riskReductionPct > 0
                                ? `${stats.riskReductionPct.toFixed(1)}% safer for ${Math.max(0, distAddedPct).toFixed(1)}% longer trip`
                                : 'No detour needed'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Trade-off bar */}
            <TradeOffBar
                riskReduced={Math.max(0, stats.riskReductionPct)}
                distAdded={Math.max(0, distAddedPct)}
            />

            {/* Bottom row: Segment distribution + Danger zones */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {safeSegments.length > 0 && (
                    <SegmentRiskDistribution segments={safeSegments} />
                )}
                <DangerZonesTable places={avoidedPlaces} />
            </div>
        </div>
    );
}
