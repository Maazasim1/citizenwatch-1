import { Router, Request, Response } from 'express';

const router = Router();

type GeocodeResult = {
    label: string;
    latitude: number;
    longitude: number;
    type: string;
};

router.get('/', async (req: Request, res: Response) => {
    try {
        const query = String(req.query.query ?? '').trim();
        if (!query || query.length < 3) {
            return res.json({ results: [] as GeocodeResult[] });
        }

        const limitRaw = req.query.limit;
        const limit = Math.max(1, Math.min(10, Number(limitRaw ?? 5)));

        // Proxy to Nominatim so the browser doesn't need CORS access.
        const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=${limit}&q=${encodeURIComponent(
            query,
        )}`;

        const resp = await fetch(url, {
            headers: {
                // Nominatim is polite-server; this helps with rate limiting / identity.
                'Accept-Language': 'en',
                'User-Agent': 'citizenwatch-demo/1.0',
            },
        });

        if (!resp.ok) {
            return res.status(500).json({ error: `Geocoding failed (${resp.status})` });
        }

        const data = (await resp.json()) as Array<any>;
        const results: GeocodeResult[] = (data ?? [])
            .map((r) => ({
                label: String(r.display_name ?? ''),
                latitude: Number(r.lat),
                longitude: Number(r.lon),
                type: String(r.type ?? ''),
            }))
            .filter((r) => r.label && !Number.isNaN(r.latitude) && !Number.isNaN(r.longitude));

        res.json({ results });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to geocode address' });
    }
});

export default router;

