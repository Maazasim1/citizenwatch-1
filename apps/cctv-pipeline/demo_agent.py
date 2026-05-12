"""
Demo agent script for the CCTV pipeline.

What it does:
1) Picks one enrolled sample image from criminal_db/original_samples.
2) Sends N frames directly to the pipeline WebSocket (ws://127.0.0.1:3601 by default).
3) Prints concise per-frame identity output for demo runs.

Usage:
  python demo_agent.py
  DEMO_N=12 DEMO_WS_URL=ws://127.0.0.1:3601 python demo_agent.py
"""

from __future__ import annotations

import asyncio
import json
import os
import struct
import sys
import time

import cv2
import websockets

DEMO_WS_URL = os.environ.get("DEMO_WS_URL", "ws://127.0.0.1:3601")
DEMO_N = int(os.environ.get("DEMO_N", "10"))


def _find_sample_image() -> str:
    root = os.path.join("criminal_db", "original_samples")
    if not os.path.isdir(root):
        return ""
    for subject in sorted(os.listdir(root)):
        subject_dir = os.path.join(root, subject)
        if not os.path.isdir(subject_dir):
            continue
        for fname in sorted(os.listdir(subject_dir)):
            if fname.lower().endswith((".jpg", ".jpeg", ".png")):
                return os.path.join(subject_dir, fname)
    return ""


def _encode_packet(seq: int, meta: dict, jpeg: bytes) -> bytes:
    meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    return struct.pack(">II", seq, len(meta_bytes)) + meta_bytes + jpeg


def _decode_packet(buf: bytes):
    seq = struct.unpack(">I", buf[0:4])[0]
    meta_len = struct.unpack(">I", buf[4:8])[0]
    meta = json.loads(buf[8 : 8 + meta_len].decode("utf-8"))
    jpeg = buf[8 + meta_len :]
    return seq, meta, jpeg


def _best_label(meta: dict) -> str:
    faces = meta.get("faces") or []
    if not faces:
        return "No face"
    best = max(faces, key=lambda f: float(f.get("confidence", 0.0)))
    name = str(best.get("name", "Unknown"))
    conf = float(best.get("confidence", 0.0))
    method = str(best.get("method", "unknown"))
    return f"{name} ({conf:.3f}, {method})"


async def main() -> None:
    sample = _find_sample_image()
    if not sample:
        print("No sample found under criminal_db/original_samples", file=sys.stderr)
        sys.exit(1)

    image = cv2.imread(sample)
    if image is None:
        print(f"Failed to read sample image: {sample}", file=sys.stderr)
        sys.exit(1)

    ok, enc = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        print("Failed to JPEG-encode sample image", file=sys.stderr)
        sys.exit(1)
    jpeg = enc.tobytes()

    print(f"[demo-agent] sample={sample}")
    print(f"[demo-agent] ws={DEMO_WS_URL} frames={DEMO_N} jpeg_bytes={len(jpeg)}")

    async with websockets.connect(DEMO_WS_URL, max_size=20 * 1024 * 1024) as ws:
        # Warm-up frame
        await ws.send(_encode_packet(0, {"camera_id": "demo-agent", "camera_name": "Demo Agent"}, jpeg))
        _ = await ws.recv()

        rtts = []
        for i in range(DEMO_N):
            seq = i + 1
            t0 = time.perf_counter()
            await ws.send(_encode_packet(seq, {"camera_id": "demo-agent", "camera_name": "Demo Agent"}, jpeg))
            raw = await ws.recv()
            rtt = (time.perf_counter() - t0) * 1000.0
            rtts.append(rtt)

            _, meta, _ann = _decode_packet(raw)
            label = _best_label(meta)
            elapsed_ms = meta.get("elapsed_ms")
            face_count = meta.get("face_count", 0)
            match_count = meta.get("match_count", 0)
            print(
                f"[demo-agent] frame={seq:02d} "
                f"rtt={rtt:6.1f}ms pipeline={elapsed_ms}ms "
                f"faces={face_count} matches={match_count} top={label}"
            )

        avg = sum(rtts) / len(rtts) if rtts else 0.0
        print(f"[demo-agent] avg_rtt={avg:.1f}ms fps={1000.0 / avg:.2f}" if avg > 0 else "[demo-agent] no frames")


if __name__ == "__main__":
    asyncio.run(main())
