'use client';

import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat/dist/leaflet-heat.js';

export type HeatPoint = [number, number, number];

export default function LeafletHeatLayer({ points }: { points: HeatPoint[] }) {
    const map = useMap();

    useEffect(() => {
        if (points.length === 0) return;

        const heatCreate = (L as unknown as { heatLayer: (p: HeatPoint[], o?: Record<string, unknown>) => L.Layer }).heatLayer;
        const layer = heatCreate(points, {
            radius: 26,
            blur: 18,
            max: 0.85,
            maxZoom: 17,
            minOpacity: 0.22,
        });
        layer.addTo(map);

        return () => {
            map.removeLayer(layer);
        };
    }, [map, points]);

    return null;
}
