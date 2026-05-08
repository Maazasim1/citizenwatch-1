'use client';

import { useMemo } from 'react';
import { Polyline, MapContainer, TileLayer, CircleMarker, Popup, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import LeafletHeatLayer, { type HeatPoint } from './LeafletHeatLayer';
import type { HotspotCluster } from './MapComponent';

type LatLng = { latitude: number; longitude: number };

type Segment = {
    start: LatLng;
    end: LatLng;
    risk: number;
    placeLabel?: string;
};

type ReportHotspotPoint = {
    id: string;
    latitude: number;
    longitude: number;
    severity: number;
    type: string;
    status: string;
};

interface RouteMapProps {
    start: LatLng;
    end: LatLng;
    shortestPath: LatLng[]; // typically [start, end]
    safePath: LatLng[]; // full polyline
    safeSegments: Segment[];
    hotspots?: ReportHotspotPoint[];
    hotspotClusters?: HotspotCluster[];
    selectionMode?: 'start' | 'end' | null;
    onSelectPoint?: (mode: 'start' | 'end', point: LatLng) => void;
}

export default function RouteMap({
    start,
    end,
    shortestPath,
    safeSegments,
    hotspots = [],
    hotspotClusters = [],
    safePath,
    selectionMode,
    onSelectPoint,
}: RouteMapProps) {
    const center: [number, number] = [(start.latitude + end.latitude) / 2, (start.longitude + end.longitude) / 2];
    const heatPoints: HeatPoint[] = useMemo(
        () =>
            hotspots
                .filter((h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude))
                .map((h) => [h.latitude, h.longitude, Math.min(1, Math.max(0.06, h.severity / 10))] as HeatPoint),
        [hotspots],
    );

    const MapClickHandler = () => {
        useMapEvents({
            click(e) {
                if (!onSelectPoint || !selectionMode) return;
                onSelectPoint(selectionMode, { latitude: e.latlng.lat, longitude: e.latlng.lng });
            },
        });
        return null;
    };

    return (
        <MapContainer
            center={center}
            zoom={13}
            style={{ width: '100%', height: '420px', background: '#0f172a' }}
            className="rounded-2xl"
        >
            <MapClickHandler />

            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {heatPoints.length > 0 ? <LeafletHeatLayer points={heatPoints} /> : null}

            {/* Direct / danger-prone fastest line */}
            {shortestPath.length >= 2 ? (
                <Polyline
                    positions={shortestPath.map((p) => [p.latitude, p.longitude]) as [number, number][]}
                    pathOptions={{ color: '#f59e0b', weight: 4, opacity: 0.95, dashArray: '2 10' }}
                />
            ) : null}

            {/* Safe route overall line */}
            {safePath.length >= 2 ? (
                <Polyline
                    positions={safePath.map((p) => [p.latitude, p.longitude]) as [number, number][]}
                    pathOptions={{ color: '#22c55e', weight: 5, opacity: 0.95 }}
                />
            ) : null}

            {hotspotClusters.map((c, idx) => (
                <CircleMarker
                    key={`rcluster-${idx}-${c.center.latitude}-${c.center.longitude}`}
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

            {/* Reported hotspot points (aligned with Live Map source) */}
            {hotspots.map((h, idx) => {
                const radius = Math.max(5, Math.min(12, h.severity * 1.2));
                const severityRatio = Math.min(1, h.severity / 10);
                const color = severityRatio > 0.75 ? '#ef4444' : severityRatio > 0.45 ? '#f59e0b' : '#f97316';
                return (
                    <CircleMarker
                        key={h.id || `hotspot-${idx}`}
                        center={[h.latitude, h.longitude]}
                        radius={radius}
                        pathOptions={{
                            color,
                            fillColor: color,
                            fillOpacity: 0.32,
                            weight: 1.5,
                        }}
                    >
                        <Popup className="custom-popup">
                            <div className="min-w-[200px] rounded-lg border border-slate-700/80 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-700 p-2.5 text-slate-100 shadow-[0_10px_24px_rgba(2,6,23,0.45)]">
                                <p className="mb-1.5 text-sm font-semibold leading-5 text-slate-100">
                                    Reported Hotspot
                                </p>
                                <div className="mb-2 inline-flex items-center rounded-full border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-200">
                                        {h.type.replace(/_/g, ' ')}
                                    </span>
                                </div>
                                <div className="text-xs leading-5 text-slate-200">
                                    Status: {h.status}
                                </div>
                                <div className="mt-2.5">
                                    <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs font-semibold text-white shadow-sm">
                                        Severity: {h.severity.toFixed(1)}/10
                                    </span>
                                </div>
                            </div>
                        </Popup>
                    </CircleMarker>
                );
            })}

            {/* Start/end markers */}
            <CircleMarker
                center={[start.latitude, start.longitude]}
                radius={8}
                pathOptions={{ color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.9 }}
            >
                <Popup>Start</Popup>
            </CircleMarker>
            <CircleMarker
                center={[end.latitude, end.longitude]}
                radius={8}
                pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.9 }}
            >
                <Popup>End</Popup>
            </CircleMarker>
        </MapContainer>
    );
}

