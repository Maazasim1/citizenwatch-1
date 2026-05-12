let onUnauthorized: (() => void) | null = null;
let handling401 = false;

export function registerUnauthorizedHandler(handler: (() => void) | null) {
    onUnauthorized = handler;
}

function triggerUnauthorized() {
    if (!onUnauthorized || handling401) return;
    handling401 = true;
    try {
        onUnauthorized();
    } finally {
        setTimeout(() => {
            handling401 = false;
        }, 500);
    }
}

/** Socket.IO middleware errors from the API often surface as `connect_error` messages like `Invalid token`. */
export function isSocketAuthErrorMessage(message: string): boolean {
    return /invalid token|session revoked|session expired|auth failed|jwt expired|jwt malformed|invalid signature|no token/i.test(
        message || '',
    );
}

/** For WebSockets that authenticate with JWT (e.g. `/cctv-stream`). */
export function notifySessionInvalid() {
    triggerUnauthorized();
}

/**
 * Like `fetch`, but sets `Authorization: Bearer` when `token` is set.
 * If the response is 401 and a token was sent, runs the handler registered by AuthProvider (logout + redirect).
 */
export async function authFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    token: string | null | undefined,
): Promise<Response> {
    const headers = new Headers(init.headers ?? undefined);
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401 && token) {
        triggerUnauthorized();
    }
    return res;
}
