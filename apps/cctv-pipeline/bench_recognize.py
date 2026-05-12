"""Quick benchmark for /recognize-frame to confirm GPU latency + ReID activity."""
import os, time, base64, cv2, requests, sys

URL = os.environ.get("BENCH_URL", "http://127.0.0.1:3600/recognize-frame")
N = int(os.environ.get("BENCH_N", "8"))

sample_dir = os.path.join("criminal_db", "original_samples")
img_path = None
if os.path.isdir(sample_dir):
    for subj in sorted(os.listdir(sample_dir)):
        sd = os.path.join(sample_dir, subj)
        if not os.path.isdir(sd):
            continue
        for f in sorted(os.listdir(sd)):
            if f.lower().endswith((".jpg", ".jpeg", ".png")):
                img_path = os.path.join(sd, f)
                break
        if img_path:
            break

if not img_path:
    print("No sample image found in criminal_db/original_samples", file=sys.stderr)
    sys.exit(1)

print("Using sample:", img_path)
img = cv2.imread(img_path)
ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
b64 = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
headers = {"Connection": "close"}

# Warm-up
print("Warm-up...")
requests.post(URL, data={"frame_base64": b64}, headers=headers, timeout=120)

times = []
match_count_total = 0
reid_seen = 0
for i in range(N):
    t0 = time.perf_counter()
    r = requests.post(URL, data={"frame_base64": b64}, headers=headers, timeout=120)
    dt = time.perf_counter() - t0
    times.append(dt)
    j = r.json()
    mc = j.get("match_count", 0)
    methods = sorted({f.get("method", "?") for f in j.get("faces", [])})
    if any(f.get("method") in ("person_reid", "person_reid_no_match") for f in j.get("faces", [])):
        reid_seen += 1
    match_count_total += mc
    print(f"  iter {i+1}: {dt*1000:.1f} ms status={r.status_code} matches={mc} methods={methods}")

avg = sum(times) / len(times)
fps = 1.0 / avg if avg > 0 else 0.0
print(f"\nAvg latency: {avg*1000:.1f} ms  ({fps:.2f} fps)")
print(f"Total matches across {N} frames: {match_count_total}")
print(f"ReID pass observed in {reid_seen}/{N} frames")
