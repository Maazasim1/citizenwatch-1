"""
Per-camera ByteTrack (BoxMOT) for person bounding-box tracking.

BoxMOT is AGPL-3.0 — ensure license compliance for commercial distribution.

Detection layout: (x1, y1, x2, y2, conf, cls) per BoxMOT AxisAlignedDetections.
Output from ByteTrack.update: Nx8 — x1,y1,x2,y2, track_id, conf, cls, det_ind
"""

from __future__ import annotations

import os
import threading

import numpy as np

from boxmot.trackers.bytetrack.bytetrack import ByteTrack

_trackers: dict[str, ByteTrack] = {}
_lock = threading.Lock()


def _new_byte_track() -> ByteTrack:
    return ByteTrack(
        track_thresh=float(os.environ.get("BOXMOT_TRACK_THRESH", "0.45")),
        match_thresh=float(os.environ.get("BOXMOT_MATCH_THRESH", "0.8")),
        track_buffer=int(os.environ.get("BOXMOT_TRACK_BUFFER", "45")),
        frame_rate=int(os.environ.get("BOXMOT_FRAME_RATE", "30")),
        min_conf=float(os.environ.get("BOXMOT_MIN_CONF", "0.08")),
    )


def get_byte_tracker(camera_id: str) -> ByteTrack:
    with _lock:
        t = _trackers.get(camera_id)
        if t is None:
            t = _new_byte_track()
            _trackers[camera_id] = t
        return t


def reset_motion_tracker(camera_id: str | None = None) -> None:
    with _lock:
        if camera_id is None:
            _trackers.clear()
        else:
            _trackers.pop(camera_id, None)


def yolo_boxes_to_dets(person_detections: list[dict]) -> np.ndarray:
    """Build (N,6) float32 — x1,y1,x2,y2,conf,cls."""
    rows = []
    for d in person_detections:
        box = d.get("bounding_box") or {}
        ww = int(box.get("w", 0))
        hh = int(box.get("h", 0))
        if ww <= 0 or hh <= 0:
            continue
        x1 = int(box.get("x", 0))
        y1 = int(box.get("y", 0))
        rows.append([x1, y1, x1 + ww, y1 + hh, float(d.get("confidence", 0.5)), 0.0])
    if not rows:
        return np.empty((0, 6), dtype=np.float32)
    return np.asarray(rows, dtype=np.float32)


def update_motion_tracks(camera_id: str, frame_bgr: np.ndarray, person_detections: list[dict]) -> np.ndarray:
    dets = yolo_boxes_to_dets(person_detections)
    tracker = get_byte_tracker(camera_id)
    return tracker.update(dets, frame_bgr)
