"""Benchmark the binary WebSocket pipeline (port 3601) directly."""
import asyncio
import json
import os
import struct
import sys
import time

import cv2
import websockets


WS_URL = os.environ.get("BENCH_WS_URL", "ws://127.0.0.1:3601")
N = int(os.environ.get("BENCH_N", "20"))


def _find_sample() -> str:
    sample_dir = os.path.join("criminal_db", "original_samples")
    if not os.path.isdir(sample_dir):
        return ""
    for subj in sorted(os.listdir(sample_dir)):
        sd = os.path.join(sample_dir, subj)
        if not os.path.isdir(sd):
            continue
        for f in sorted(os.listdir(sd)):
            if f.lower().endswith((".jpg", ".jpeg", ".png")):
                return os.path.join(sd, f)
    return ""


def _encode(seq: int, meta: dict, jpeg: bytes) -> bytes:
    meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    return struct.pack(">II", seq, len(meta_bytes)) + meta_bytes + jpeg


def _decode(buf: bytes):
    seq = struct.unpack(">I", buf[0:4])[0]
    meta_len = struct.unpack(">I", buf[4:8])[0]
    meta = json.loads(buf[8 : 8 + meta_len].decode("utf-8"))
    return seq, meta, buf[8 + meta_len :]


async def main() -> None:
    sample = _find_sample()
    if not sample:
        print("No sample image found", file=sys.stderr)
        sys.exit(1)
    print(f"sample: {sample}")

    img = cv2.imread(sample)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    jpeg = buf.tobytes()
    print(f"jpeg bytes: {len(jpeg)}")

    async with websockets.connect(WS_URL, max_size=20 * 1024 * 1024) as ws:
        # Warm-up
        await ws.send(_encode(0, {}, jpeg))
        _ = await ws.recv()

        latencies: list[float] = []
        match_count_total = 0
        reid_seen = 0
        for i in range(N):
            t0 = time.perf_counter()
            await ws.send(_encode(i + 1, {}, jpeg))
            resp = await ws.recv()
            dt = (time.perf_counter() - t0) * 1000.0
            latencies.append(dt)

            seq, meta, ann_jpeg = _decode(resp)
            faces = meta.get("faces", [])
            mc = meta.get("match_count", 0)
            methods = sorted({f.get("method", "?") for f in faces})
            if any(f.get("method", "").startswith("person_reid") for f in faces):
                reid_seen += 1
            match_count_total += mc
            print(f"  iter {i + 1}: rtt={dt:.1f} ms  pipeline={meta.get('elapsed_ms')} ms  matches={mc}  ann_bytes={len(ann_jpeg)}  methods={methods}")

        avg = sum(latencies) / len(latencies)
        print(f"\nAvg client RTT: {avg:.1f} ms  ({1000.0 / avg:.2f} fps)")
        print(f"ReID observed in {reid_seen}/{N} frames; matches={match_count_total}")


if __name__ == "__main__":
    asyncio.run(main())
