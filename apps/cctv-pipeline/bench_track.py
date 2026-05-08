"""Send the same enrolled subject's image repeatedly and watch the tracker:
   we expect the first 1-2 frames to be 'face_embedding_pending' and then to
   transition to 'face_embedding_track' (locked) on track #1.

   Then we send a different image to confirm a *new* track id is assigned and
   does not inherit the previous lock.
"""
import asyncio
import json
import os
import struct
import sys
import time

import cv2
import websockets


WS_URL = os.environ.get("BENCH_WS_URL", "ws://127.0.0.1:3601")
N_PER = int(os.environ.get("BENCH_N", "8"))


def _gather_samples():
    sample_dir = os.path.join("criminal_db", "original_samples")
    found = []
    if not os.path.isdir(sample_dir):
        return found
    for subj in sorted(os.listdir(sample_dir)):
        sd = os.path.join(sample_dir, subj)
        if not os.path.isdir(sd):
            continue
        for f in sorted(os.listdir(sd)):
            if f.lower().endswith((".jpg", ".jpeg", ".png")):
                found.append((subj, os.path.join(sd, f)))
                break
    return found


def _encode(seq: int, meta: dict, jpeg: bytes) -> bytes:
    meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    return struct.pack(">II", seq, len(meta_bytes)) + meta_bytes + jpeg


def _decode(buf: bytes):
    seq = struct.unpack(">I", buf[0:4])[0]
    meta_len = struct.unpack(">I", buf[4:8])[0]
    meta = json.loads(buf[8 : 8 + meta_len].decode("utf-8"))
    return seq, meta, buf[8 + meta_len :]


def _summarize_faces(faces):
    summary = []
    for f in faces:
        bb = f.get("bounding_box") or {}
        bw = int(bb.get("w", 0))
        bh = int(bb.get("h", 0))
        summary.append({
            "tid": f.get("track_id"),
            "name": f.get("name"),
            "is_match": f.get("is_match"),
            "alert": f.get("alert_eligible"),
            "method": f.get("method"),
            "tentative": f.get("tentative_name"),
            "tent_conf": round(float(f.get("tentative_confidence") or 0.0), 3),
            "conf": round(float(f.get("confidence") or 0.0), 3),
            "age": f.get("track_age"),
            "body_box": f"{bw}x{bh}",
        })
    return summary


async def stream_image(ws, label, jpeg, n, camera_id="bench"):
    print(f"\n=== {label} ({n} frames, camera_id={camera_id}) ===")
    seq = int(time.time() * 1000) & 0x7FFFFFFF
    for i in range(n):
        await ws.send(_encode(seq + i, {"camera_id": camera_id}, jpeg))
        resp = await ws.recv()
        _, meta, _ann = _decode(resp)
        print(f"  frame {i+1}: faces={_summarize_faces(meta.get('faces', []))}")


async def main():
    samples = _gather_samples()
    if not samples:
        print("No sample images in criminal_db/original_samples", file=sys.stderr)
        sys.exit(1)

    encoded = []
    for name, path in samples:
        img = cv2.imread(path)
        if img is None:
            continue
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            continue
        encoded.append((name, path, buf.tobytes()))
    if not encoded:
        print("Could not load any sample images", file=sys.stderr)
        sys.exit(1)

    print("Available enrolled subjects:")
    for name, path, jpeg in encoded:
        print(f"  - {name}  ({path}, {len(jpeg)} bytes)")

    async with websockets.connect(WS_URL, max_size=20 * 1024 * 1024) as ws:
        for name, _path, jpeg in encoded:
            await stream_image(ws, f"Subject '{name}' (camera A)", jpeg, N_PER, camera_id="bench-A")

        if len(encoded) >= 2:
            # Force a track switch on the same camera using a *different* subject:
            await stream_image(ws, f"Subject '{encoded[1][0]}' (camera A again)", encoded[1][2], N_PER, camera_id="bench-A")

        # Different camera id should produce a fresh track #1.
        await stream_image(ws, f"Subject '{encoded[0][0]}' (camera B)", encoded[0][2], N_PER, camera_id="bench-B")


if __name__ == "__main__":
    asyncio.run(main())
