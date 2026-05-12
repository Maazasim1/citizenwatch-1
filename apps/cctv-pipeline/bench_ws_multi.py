"""Multi-camera throughput bench against the binary WS pipeline (port 3601).

Spawns N concurrent connections, each backpressured (one frame in flight at a time).
Reports per-camera + aggregate latency / fps / match counts after a fixed duration.
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
N_CAMERAS = int(os.environ.get("BENCH_CAMERAS", "4"))
RUN_SECONDS = float(os.environ.get("BENCH_SECONDS", "10"))


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


async def run_camera(idx: int, jpeg: bytes, deadline: float, results: list):
    cam_lats = []
    cam_matches = 0
    cam_frames = 0
    seq = 0
    try:
        async with websockets.connect(WS_URL, max_size=20 * 1024 * 1024) as ws:
            # Single warm-up
            await ws.send(_encode(seq, {"camera_id": f"bench-{idx}"}, jpeg))
            await ws.recv()
            seq += 1

            while time.perf_counter() < deadline:
                t0 = time.perf_counter()
                await ws.send(_encode(seq, {"camera_id": f"bench-{idx}"}, jpeg))
                resp = await ws.recv()
                dt = (time.perf_counter() - t0) * 1000.0
                cam_lats.append(dt)
                _, meta, _ = _decode(resp)
                cam_matches += int(meta.get("match_count", 0))
                cam_frames += 1
                seq += 1
    except Exception as exc:
        print(f"[cam {idx}] error: {exc}", file=sys.stderr)
    avg = sum(cam_lats) / len(cam_lats) if cam_lats else 0.0
    fps = cam_frames / RUN_SECONDS if RUN_SECONDS else 0.0
    results.append((idx, cam_frames, avg, fps, cam_matches))


async def main() -> None:
    sample = _find_sample()
    if not sample:
        print("No sample image found", file=sys.stderr)
        sys.exit(1)
    img = cv2.imread(sample)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    jpeg = buf.tobytes()
    print(f"sample: {sample} ({len(jpeg)} bytes)")
    print(f"cameras: {N_CAMERAS}  duration: {RUN_SECONDS}s  url: {WS_URL}")

    deadline = time.perf_counter() + RUN_SECONDS
    results: list = []
    await asyncio.gather(*[run_camera(i, jpeg, deadline, results) for i in range(N_CAMERAS)])

    results.sort()
    total_frames = sum(r[1] for r in results)
    total_matches = sum(r[4] for r in results)
    if results:
        avg_lat = sum(r[2] * r[1] for r in results) / total_frames if total_frames else 0.0
    else:
        avg_lat = 0.0

    print("\n  cam  frames   avg ms    fps   matches")
    print("  ---  ------   ------    ---   -------")
    for idx, frames, avg, fps, matches in results:
        print(f"  {idx:>3}  {frames:>6}   {avg:>6.1f}  {fps:>5.2f}   {matches:>7}")

    print(f"\nAggregate: {total_frames} frames in {RUN_SECONDS}s "
          f"=> {total_frames / RUN_SECONDS:.2f} fps "
          f"(avg per-camera latency {avg_lat:.1f} ms, total matches {total_matches})")


if __name__ == "__main__":
    asyncio.run(main())
