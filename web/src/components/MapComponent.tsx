'use client';

import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import LeafletHeatLayer, { type HeatPoint } from './LeafletHeatLayer';

export interface HotspotCluster {
    center: { latitude: number; longitude: number };
    count: number;
    avgSeverity: number;
    maxSeverity: number;
    weight: number;
    topTypes?: Array<{ type: string; count: number }>;
    sampleReports?: string[];
}

interface Report {
    id: string;
    title: string;
    description: string;
    severity: number | null;
    createdAt: string;
    latitude: number;
    longitude: number;
    type: string;
    status: string;
    isResolved?: boolean;
    resolutionTag?: string | null;
    resolvedAt?: string | null;
}

interface MapComponentProps {
    reports: Report[];
    clusters: HotspotCluster[];
    activeLocation?: [number, number] | null;
    /** When false, resolved verified incidents are omitted from the heat layer (markers still show if present in `reports`). */
    showResolvedHeat?: boolean;
}

function MapFlyTo({ activeLocation }: { activeLocation?: [number, number] | null }) {
    const map = useMap();
    useEffect(() => {
        if (activeLocation) {
            map.flyTo(activeLocation, 16, { animate: true, duration: 1.5 });
        }
    }, [activeLocation, map]);
    return null;
}

export default function MapComponent({
    reports,
    clusters,
    activeLocation,
    showResolvedHeat = false,
}: MapComponentProps) {
    const center: [number, number] = [24.8607, 67.0011];

    const heatPoints: HeatPoint[] = useMemo(
        () =>
            reports
                .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
                .filter((r) => showResolvedHeat || !(r.status === 'VERIFIED' && r.isResolved))
                .map((r) => {
                    const sev =
                        typeof r.severity === 'number' && !Number.isNaN(r.severity) ? r.severity : 5;
                    const resolved = r.status === 'VERIFIED' && r.isResolved;
                    const base = Math.min(1, Math.max(0.06, sev / 10));
                    const intensity = resolved ? Math.min(0.35, sev / 25) : base;
                    return [r.latitude, r.longitude, intensity] as HeatPoint;
                }),
        [reports, showResolvedHeat],
    );

    const getSeverityColor = (severity: number) => {
        if (severity >= 7) return '#f43f5e';
        if (severity >= 4) return '#f59e0b';
        return '#6366f1';
    };

    return (
        <MapContainer
            center={center}
            zoom={13}
            style={{ width: '100%', height: '100%', background: '#0f172a' }}
            className="rounded-2xl"
        >
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
            {heatPoints.length > 0 ? <LeafletHeatLayer points={heatPoints} /> : null}
            <MapFlyTo activeLocation={activeLocation} />
            {reports.map((report) => {
                const sev =
                    typeof report.severity === 'number' && !Number.isNaN(report.severity)
                        ? report.severity
                        : 5;
                const resolved = report.status === 'VERIFIED' && report.isResolved;
                const color = resolved ? '#22c55e' : getSeverityColor(sev);
                const tagLabel = report.resolutionTag ? report.resolutionTag.replace(/_/g, ' ') : '';
                const fillOpacity = resolved ? 0.55 : 0.4;
                return (
                    <CircleMarker
                        key={report.id}
                        center={[report.latitude, report.longitude]}
                        radius={resolved ? Math.max(6, sev + 4) : Math.max(4, sev * 2)}
                        pathOptions={{
                            color,
                            fillColor: color,
                            fillOpacity,
                            weight: resolved ? 3 : 2,
                        }}
                    >
                        <Popup className="custom-popup">
                            <div className="min-w-[200px] rounded-lg border border-slate-700/80 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-700 p-2.5 text-slate-100 shadow-[0_10px_24px_rgba(2,6,23,0.45)]">
                                {resolved ? (
                                    <>
                                        <p className="mb-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                                            ✓ Resolved Incident
                                        </p>
                                        {tagLabel ? (
                                            <p className="mb-1 text-xs leading-5 text-slate-200">
                                                <span className="font-semibold">Outcome:</span> {tagLabel}
                                            </p>
                                        ) : null}
                                        {report.resolvedAt ? (
                                            <p className="text-[11px] text-slate-300">
                                                {new Date(report.resolvedAt).toLocaleString()}
                                            </p>
                                        ) : null}
                                    </>
                                ) : (
                                    <>
                                        <p className="mb-1.5 text-sm font-semibold leading-5 text-slate-100">{report.title}</p>
                                        <div className="mb-2 inline-flex items-center rounded-full border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-200">
                                                {report.type.replace(/_/g, ' ')}
                                            </span>
                                        </div>
                                        <p className="text-xs leading-5 text-slate-200">{report.description}</p>
                                        <div className="mt-2.5 flex items-center gap-1">
                                            <span
                                                className="rounded-full px-2 py-0.5 text-xs font-semibold text-white shadow-sm"
                                                style={{ background: color }}
                                            >
                                                Severity: {sev}/10
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </Popup>
                    </CircleMarker>
                );
            })}
            {clusters.map((c, idx) => (
                <CircleMarker
                    key={`cluster-${idx}-${c.center.latitude}-${c.center.longitude}`}
                    center={[c.center.latitude, c.center.longitude]}
                    radius={10 + Math.min(16, c.count * 2)}
                    pathOptions={{
                        color: '#a78bfa',
                        fillColor: '#7c3aed',
                        fillOpacity: 0.35,
                        weight: 2,
                    }}
                >
                    <Popup className="custom-popup">
                        <div className="min-w-[220px] rounded-lg border border-slate-700/80 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-700 p-2.5 text-slate-100 shadow-[0_10px_24px_rgba(2,6,23,0.45)]">
                            <p className="mb-1.5 text-sm font-semibold leading-5 text-slate-100">
                                Verified Hotspot Cluster
                            </p>
                            {Array.isArray(c.topTypes) && c.topTypes.length > 0 ? (
                                <div className="mb-2 inline-flex items-center rounded-full border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-200">
                                        {c.topTypes[0].type.replace(/_/g, ' ')}
                                    </span>
                                </div>
                            ) : null}
                            <p className="text-xs leading-5 text-slate-200">
                                {Array.isArray(c.sampleReports) && c.sampleReports.length > 0
                                    ? `Most reported: ${c.sampleReports[0]}`
                                    : 'Multiple verified incidents are clustered in this area.'}
                            </p>
                            <div className="mt-2.5 flex items-center gap-1">
                                <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs font-semibold text-white shadow-sm">
                                    Severity: {c.maxSeverity}/10
                                </span>
                            </div>
                        </div>
                    </Popup>
                </CircleMarker>
            ))}
        </MapContainer>
    );
}
