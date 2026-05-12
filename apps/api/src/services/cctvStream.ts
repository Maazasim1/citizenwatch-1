/**
 * Persistent binary WebSocket client to the Python CCTV pipeline.
 *
 * Wire format matches apps/cctv-pipeline/ws_server.py:
 *   [4 bytes BE seq] [4 bytes BE meta_len] [meta JSON UTF-8] [JPEG bytes]
 *
 * Exposes recognizeFrame() which sends a single binary message and resolves
 * with the pipeline's response (also binary).
 */

import WebSocket from 'ws';

const PIPELINE_WS_URL =
    process.env.CCTV_PIPELINE_WS_URL ||
    (process.env.CCTV_PIPELINE_URL || 'http://localhost:3600').replace(/^http/, 'ws').replace(/:\d+$/, ':3601');

// Inference can occasionally spike on the first few frames (model warm-up / GPU contention),
// so keep a wider default timeout to avoid false "stuck loading" errors on the frontend.
const REQUEST_TIMEOUT_MS = Number(process.env.CCTV_PIPELINE_WS_TIMEOUT_MS || 45000);
const RECONNECT_DELAY_MS = 1000;

export interface PipelineFrameRequestMeta {
    camera_latitude?: number | null;
    camera_longitude?: number | null;
    camera_id?: string | null;
    camera_name?: string | null;
}

export interface PipelineFrameResponse {
    meta: any;
    jpeg: Buffer;
}

type Pending = {
    resolve: (value: PipelineFrameResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
};

let socket: WebSocket | null = null;
let connectingPromise: Promise<WebSocket> | null = null;
let nextSeq = 1;
const pending = new Map<number, Pending>();

function rejectAllPending(reason: string) {
    for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
    }
    pending.clear();
}

function handleMessage(data: WebSocket.RawData) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (buf.length < 8) return;
    const seq = buf.readUInt32BE(0);
    const metaLen = buf.readUInt32BE(4);
    if (buf.length < 8 + metaLen) return;

    let meta: any;
    try {
        meta = JSON.parse(buf.subarray(8, 8 + metaLen).toString('utf-8'));
    } catch {
        meta = {};
    }
    const jpeg = buf.subarray(8 + metaLen);

    const p = pending.get(seq);
    if (!p) return;
    pending.delete(seq);
    clearTimeout(p.timer);
    p.resolve({ meta, jpeg: Buffer.from(jpeg) });
}

function connect(): Promise<WebSocket> {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (connectingPromise) return connectingPromise;

    connectingPromise = new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(PIPELINE_WS_URL, {
            perMessageDeflate: false,
            maxPayload: 32 * 1024 * 1024,
        });

        const onOpen = () => {
            console.log(`[cctv-stream] connected to pipeline at ${PIPELINE_WS_URL}`);
            ws.off('error', onError);
            socket = ws;
            connectingPromise = null;
            resolve(ws);
        };
        const onError = (err: Error) => {
            console.warn(`[cctv-stream] pipeline connect error: ${err.message}`);
            ws.off('open', onOpen);
            socket = null;
            connectingPromise = null;
            reject(err);
        };
        ws.once('open', onOpen);
        ws.once('error', onError);

        ws.on('message', handleMessage);
        ws.on('close', () => {
            console.warn(`[cctv-stream] pipeline socket closed`);
            socket = null;
            rejectAllPending('Pipeline socket closed');
            // Try a single reconnect attempt after a short delay; future calls
            // will trigger another lazy connect on demand if this one races.
            setTimeout(() => {
                connect().catch(() => {});
            }, RECONNECT_DELAY_MS);
        });
    });

    return connectingPromise;
}

export function recognizeFrame(
    jpeg: Buffer,
    meta: PipelineFrameRequestMeta = {},
): Promise<PipelineFrameResponse> {
    return new Promise(async (resolve, reject) => {
        let ws: WebSocket;
        try {
            ws = await connect();
        } catch (err) {
            reject(err as Error);
            return;
        }

        const seq = nextSeq++ >>> 0;
        const metaBytes = Buffer.from(JSON.stringify(meta), 'utf-8');
        const header = Buffer.alloc(8);
        header.writeUInt32BE(seq, 0);
        header.writeUInt32BE(metaBytes.length, 4);
        const payload = Buffer.concat([header, metaBytes, jpeg]);

        const timer = setTimeout(() => {
            pending.delete(seq);
            reject(new Error(`Pipeline timeout after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(seq, { resolve, reject, timer });
        ws.send(payload, { binary: true }, (err) => {
            if (err) {
                clearTimeout(timer);
                pending.delete(seq);
                reject(err);
            }
        });
    });
}

export function pipelineSocketState(): 'open' | 'connecting' | 'closed' {
    if (socket && socket.readyState === WebSocket.OPEN) return 'open';
    if (connectingPromise) return 'connecting';
    return 'closed';
}

// Best-effort connect on import so the first frame doesn't pay the handshake cost.
connect().catch(() => {});
