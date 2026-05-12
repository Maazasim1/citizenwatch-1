"""
Per-camera identity state keyed by motion tracker id (ByteTrack track_id).

Face and body (ReID) cast weighted votes into a sliding window; a display name
locks only after enough consistent evidence. This sits above BoxMOT motion
association — BoxMOT assigns stable track ids; this module assigns names.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Tuple

import numpy as np


@dataclass
class VoteObservation:
    frame_no: int
    source: str  # "face" | "body" | "global_reid"
    name: Optional[str]
    confidence: float
    weight: float


@dataclass
class PersonIdentityTrack:
    motion_track_id: int
    person_bbox: Tuple[int, int, int, int]
    body_embedding: Optional[np.ndarray] = None
    face_embedding: Optional[np.ndarray] = None
    last_face_bbox: Optional[Tuple[int, int, int, int]] = None
    history: Deque[VoteObservation] = field(default_factory=lambda: deque(maxlen=20))
    locked_name: Optional[str] = None
    locked_confidence: float = 0.0
    age: int = 0
    missed_frames: int = 0
    first_seen: int = 0
    last_seen: int = 0
    face_vote_frames: int = 0
    _disagreement_streak: int = 0

    lock_weight_threshold: float = 5.0
    lock_min_avg_conf: float = 0.6
    unlock_disagreement_streak: int = 5

    def add_observation(
        self,
        frame_no: int,
        person_bbox: Tuple[int, int, int, int],
        body_emb: Optional[np.ndarray],
        face_emb: Optional[np.ndarray],
        face_bbox: Optional[Tuple[int, int, int, int]],
        observations: List[VoteObservation],
    ) -> None:
        self.person_bbox = person_bbox
        self.last_seen = frame_no
        self.missed_frames = 0
        self.age += 1
        if self.first_seen == 0:
            self.first_seen = frame_no
        if body_emb is not None:
            self.body_embedding = body_emb.astype(np.float32)
        if face_emb is not None:
            self.face_embedding = face_emb.astype(np.float32)
        self.last_face_bbox = face_bbox

        had_face_vote = False
        for obs in observations:
            self.history.append(obs)
            if obs.source == "face" and obs.name and obs.confidence >= 0.5:
                had_face_vote = True

        if had_face_vote:
            self.face_vote_frames += 1

        if self.locked_name is not None:
            voted_locked = any(
                o.name == self.locked_name and o.confidence >= 0.52
                for o in observations
            )
            voted_other_strong = any(
                o.name and o.name != self.locked_name and o.confidence >= 0.58
                for o in observations
            )
            if voted_locked:
                self._disagreement_streak = 0
            elif voted_other_strong:
                self._disagreement_streak += 1
            else:
                # Keep the lock when the same motion track is still present but
                # current frame has no confident identity evidence (face hidden,
                # blur, occlusion, profile turn). Unlock only on strong conflict.
                self._disagreement_streak = max(0, self._disagreement_streak - 1)

        self._update_lock()

    def _update_lock(self) -> None:
        by_name: Dict[str, List[Tuple[float, float]]] = {}
        for obs in self.history:
            if not obs.name or obs.confidence < 0.5:
                continue
            by_name.setdefault(obs.name, []).append((obs.confidence, obs.weight))

        if by_name:
            best_name: Optional[str] = None
            best_tw = -1.0
            best_avg_c = 0.0
            for name, pairs in by_name.items():
                tw = sum(w for _, w in pairs)
                avg_c = sum(c * w for c, w in pairs) / tw if tw > 0 else 0.0
                if tw > best_tw:
                    best_tw = tw
                    best_avg_c = avg_c
                    best_name = name
            if (
                best_name is not None
                and best_tw >= self.lock_weight_threshold
                and best_avg_c >= self.lock_min_avg_conf
            ):
                if self.locked_name != best_name:
                    self._disagreement_streak = 0
                    self.face_vote_frames = 0
                self.locked_name = best_name
                self.locked_confidence = float(best_avg_c)
                return

        if self.locked_name and self._disagreement_streak >= self.unlock_disagreement_streak:
            self.locked_name = None
            self.locked_confidence = 0.0
            self._disagreement_streak = 0
            self.face_vote_frames = 0


class PersonIdentityStore:
    """Per-camera map: motion_track_id -> PersonIdentityTrack."""

    def __init__(self) -> None:
        self._by_camera: Dict[str, Dict[int, PersonIdentityTrack]] = {}

    def camera_map(self, camera_id: str) -> Dict[int, PersonIdentityTrack]:
        if camera_id not in self._by_camera:
            self._by_camera[camera_id] = {}
        return self._by_camera[camera_id]

    def get_or_create(
        self,
        camera_id: str,
        motion_id: int,
        lock_weight_threshold: float,
        lock_min_avg_conf: float,
        unlock_disagreement_streak: int,
    ) -> PersonIdentityTrack:
        m = self.camera_map(camera_id)
        t = m.get(motion_id)
        if t is None:
            t = PersonIdentityTrack(
                motion_track_id=motion_id,
                person_bbox=(0, 0, 0, 0),
                lock_weight_threshold=lock_weight_threshold,
                lock_min_avg_conf=lock_min_avg_conf,
                unlock_disagreement_streak=unlock_disagreement_streak,
            )
            m[motion_id] = t
        else:
            t.lock_weight_threshold = lock_weight_threshold
            t.lock_min_avg_conf = lock_min_avg_conf
            t.unlock_disagreement_streak = unlock_disagreement_streak
        return t

    def end_frame(self, camera_id: str, frame_no: int, seen_motion_ids: set[int], max_missed: int) -> None:
        m = self._by_camera.get(camera_id)
        if not m:
            return
        dead: List[int] = []
        for mid, tr in m.items():
            if mid not in seen_motion_ids:
                tr.missed_frames += 1
                if tr.missed_frames > max_missed:
                    dead.append(mid)
        for mid in dead:
            del m[mid]

    def reset_camera(self, camera_id: str) -> None:
        self._by_camera.pop(camera_id, None)

    def reset_all(self) -> None:
        self._by_camera.clear()


_identity_stores_singleton = PersonIdentityStore()


def get_identity_store() -> PersonIdentityStore:
    return _identity_stores_singleton
