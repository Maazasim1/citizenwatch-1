/**
 * Resolve the API base URL for browser and SSR.
 * - Honors NEXT_PUBLIC_API_BASE_URL when set.
 * - If the page is opened on a non-loopback host but env still points at localhost,
 *   use the same hostname so LAN / mixed 127.0.0.1 vs localhost works.
 */
export function getApiBaseUrl(): string {
    const env = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '').trim() || '';
    if (typeof window === 'undefined') {
        return env || 'http://localhost:3001';
    }
    const { protocol, hostname } = window.location;
    const port = process.env.NEXT_PUBLIC_API_PORT || '3001';
    const sameHostFallback = `${protocol}//${hostname}:${port}`;

    if (!env) {
        return sameHostFallback;
    }

    const isLoopback =
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    const envIsLoopback =
        env.includes('localhost') || env.includes('127.0.0.1') || env.includes('[::1]');

    if (!isLoopback && envIsLoopback) {
        return sameHostFallback;
    }

    return env;
}
