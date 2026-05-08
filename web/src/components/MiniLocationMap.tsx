'use client';

import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

type MiniLocationMapProps = {
    latitude: number;
    longitude: number;
    locationLabel: string;
    detectedAt: string;
};

const markerIcon = L.divIcon({
    className: 'mini-location-pin',
    html:
        '<div style="width:14px;height:14px;border-radius:9999px;background:#ef4444;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.35);"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
});

export default function MiniLocationMap({ latitude, longitude, locationLabel, detectedAt }: MiniLocationMapProps) {
    return (
        <div className="mt-3 rounded-xl overflow-hidden border border-slate-700">
            <MapContainer
                center={[latitude, longitude]}
                zoom={15}
                className="h-[200px] w-full"
                scrollWheelZoom={false}
                dragging={false}
                doubleClickZoom={false}
                touchZoom={false}
                zoomControl={false}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Marker position={[latitude, longitude]} icon={markerIcon}>
                    <Popup>
                        <div className="text-xs">
                            <div className="font-semibold">{locationLabel}</div>
                            <div>{new Date(detectedAt).toLocaleString()}</div>
                        </div>
                    </Popup>
                </Marker>
            </MapContainer>
        </div>
    );
}
