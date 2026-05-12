"""
Low-latency binary WebSocket server for /recognize-frame style streaming.

Wire format (single binary message both directions):

    [4 bytes BE seq] [4 bytes BE meta_len] [meta JSON UTF-8] [JPEG bytes]

Request:
  - meta: {"camera_latitude"?: float, "camera_longitude"?: float}
  - body: raw JPEG of the frame

Response:
  - meta: {"seq": int, "faces": [...], "matches": [...], "face_count": int,
           "match_count": int, "elapsed_ms": float}
  - body: raw JPEG of the annotated frame

Runs in a daemon thread alongside the existing Flask/waitress HTTP server so
both protocols stay available.
"""

from __future__ import annotations

import asyncio
import json
import os
import struct
import threading
import time
from typing import Optional, Tuple

import cv2
import numpy as np
import websockets

from face_engine import recognize_faces_in_frame


WS_HOST = os.environ.get("CCTV_WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("CCTV_WS_PORT", "3601"))
WS_MAX_MSG_BYTES = int(os.environ.get("CCTV_WS_MAX_MSG_BYTES", str(20 * 1024 * 1024)))
WS_JPEG_QUALITY = int(os.environ.get("CCTV_WS_JPEG_QUALITY", "80"))

# Recognition is GPU-bound but the Python wrapper is not necessarily reentrant
# safe across threads (ONNX/torch models share state). Serialize per-frame work.
_recog_lock = threading.Lock()


def _decode_request(data: bytes) -> Optional[Tuple[int, dict, bytes]]:
    if len(data) < 8:
        return None
    seq = struct.unpack(">I", data[0:4])[0]
    meta_len = struct.unpack(">I", data[4:8])[0]
    if len(data) < 8 + meta_len:
        return None
    meta_bytes = data[8 : 8 + meta_len]
    jpeg = data[8 + meta_len :]
    try:
        meta = json.loads(meta_bytes.decode("utf-8")) if meta_len else {}
    except Exception:
        meta = {}
    return seq, meta, bytes(jpeg)


def _encode_response(seq: int, meta: dict, jpeg: bytes) -> bytes:
    payload = dict(meta)
    payload.setdefault("seq", seq)
    meta_bytes = json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8")
    header = struct.pack(">II", seq, len(meta_bytes))
    return header + meta_bytes + jpeg


def _process_frame(jpeg: bytes, camera_id: str = "default") -> Tuple[dict, bytes]:
    arr = np.frombuffer(jpeg, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return {"error": "invalid_jpeg", "faces": [], "face_count": 0, "match_count": 0, "matches": []}, b""

    t0 = time.perf_counter()
    with _recog_lock:
        annotated, faces = recognize_faces_in_frame(frame, camera_id=camera_id)
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, WS_JPEG_QUALITY])
    ann_bytes = buf.tobytes() if ok else b""

    matches = [f for f in faces if f.get("is_match")]
    return (
        {
            "faces": faces,
            "face_count": len(faces),
            "matches": matches,
            "match_count": len(matches),
            "elapsed_ms": elapsed_ms,
            "camera_id": camera_id,
        },
        ann_bytes,
    )


async def _handle_client(ws):
    peer = getattr(ws, "remote_address", "?")
    print(f"[CCTV WS] client connected: {peer}")
    frames = 0
    try:
        async for msg in ws:
            if not isinstance(msg, (bytes, bytearray)):
                continue
            parsed = _decode_request(msg)
            if parsed is None:
                continue
            seq, meta, jpeg = parsed
            camera_id = str(meta.get("camera_id") or f"peer:{peer}")

            response_meta, ann_bytes = await asyncio.to_thread(_process_frame, jpeg, camera_id)
            await ws.send(_encode_response(seq, response_meta, ann_bytes))
            frames += 1
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:  # pragma: no cover - defensive log
        print(f"[CCTV WS] client error: {exc}")
    finally:
        print(f"[CCTV WS] client disconnected: {peer} (frames={frames})")


async def _serve_forever():
    print(f"[CCTV WS] listening on ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(
        _handle_client,
        WS_HOST,
        WS_PORT,
        max_size=WS_MAX_MSG_BYTES,
        ping_interval=20,
        ping_timeout=20,
        compression=None,
    ):
        await asyncio.Future()


def _run_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_serve_forever())
    finally:  # pragma: no cover
        loop.close()


def start_in_background() -> threading.Thread:
    """Spawn the WebSocket server on a daemon thread; safe to call once at startup."""
    t = threading.Thread(target=_run_loop, name="cctv-ws-server", daemon=True)
    t.start()
    return t
