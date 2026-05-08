"""
Face Detection & Recognition Engine
Uses modern identity embeddings (ArcFace + ReID) for identification and matching.
Haar cascades remain for lightweight face localization in low-resource environments.
"""

import os
import json
import threading
import uuid
import shutil
import cv2
import numpy as np
from pathlib import Path

from detector import detect_person_boxes_in_frame
from identity_models import (
    IdentityEmbedding,
    compute_arcface_embedding,
    compute_reid_embedding,
    cosine_similarity as identity_cosine_similarity,
    detect_arcface_faces,
    get_identity_backend_status,
)
from person_motion_tracker import reset_motion_tracker, update_motion_tracks
from tracker import VoteObservation, get_identity_store

# Identity + BoxMOT motion state resets together when galleries change.
_global_reid_lock = threading.Lock()
_global_reid_cache: list[dict] = []
_cam_frame_lock = threading.Lock()
_camera_frame_counters: dict[str, int] = {}


def _next_frame_no(camera_id: str) -> int:
    with _cam_frame_lock:
        n = _camera_frame_counters.get(camera_id, 0) + 1
        _camera_frame_counters[camera_id] = n
        return n


def _global_reid_cache_sweep() -> None:
    import time
    now = time.monotonic()
    with _global_reid_lock:
        _global_reid_cache[:] = [e for e in _global_reid_cache if e["expires"] > now]


def _global_reid_lookup(body_emb: np.ndarray | None) -> tuple[str, float] | None:
    if body_emb is None:
        return None
    min_sim = float(os.environ.get("GLOBAL_REID_MATCH_MIN", "0.78"))
    import time
    _global_reid_cache_sweep()
    with _global_reid_lock:
        best_n: str | None = None
        best_s = min_sim
        for e in _global_reid_cache:
            s = float(identity_cosine_similarity(body_emb, e["emb"]))
            if s > best_s:
                best_s = s
                best_n = e["name"]
        if best_n:
            return best_n, best_s
    return None


def _push_global_reid(name: str, body_emb: np.ndarray | None) -> None:
    if body_emb is None or not name:
        return
    import time
    ttl = float(os.environ.get("GLOBAL_REID_CACHE_TTL_SEC", "300"))
    maxn = int(os.environ.get("GLOBAL_REID_CACHE_MAX", "80"))
    with _global_reid_lock:
        _global_reid_cache_sweep()
        _global_reid_cache.append(
            {"name": name, "emb": body_emb.astype(np.float32), "expires": time.monotonic() + ttl}
        )
        while len(_global_reid_cache) > maxn:
            _global_reid_cache.pop(0)


def reset_person_trackers(camera_id: str | None = None) -> None:
    reset_motion_tracker(camera_id)
    st = get_identity_store()
    if camera_id is None:
        st.reset_all()
    else:
        st.reset_camera(camera_id)
    with _cam_frame_lock:
        if camera_id is None:
            _camera_frame_counters.clear()
        else:
            _camera_frame_counters.pop(camera_id, None)


def reset_face_tracker(camera_id: str | None = None) -> None:
    """Backward-compatible alias for gallery refresh hooks."""
    reset_person_trackers(camera_id)

CRIMINAL_DB_DIR = os.path.join(os.path.dirname(__file__), "criminal_db")
EMBEDDINGS_FILE = os.path.join(CRIMINAL_DB_DIR, "embeddings.json")
FACE_SAMPLES_DIR = os.path.join(os.path.dirname(__file__), "face_samples")
os.makedirs(CRIMINAL_DB_DIR, exist_ok=True)
os.makedirs(FACE_SAMPLES_DIR, exist_ok=True)

# Haar cascade for face detection (ships with OpenCV, no extra downloads)
_face_cascade = None
_profile_cascade = None

_model_trained = False
_subject_embedding_gallery = {}
_subject_reid_gallery = {}
_trained_subject_names = {}

DETECTION_SCALE = 2
FACE_WIDTH = 112
FACE_HEIGHT = 92
HISTOGRAM_MATCH_THRESHOLD = 0.78
HISTOGRAM_STRONG_MATCH_THRESHOLD = 0.84
ARCFACE_MATCH_THRESHOLD = float(os.environ.get("ARCFACE_MATCH_THRESHOLD", "0.5"))
ARCFACE_STRONG_MATCH_THRESHOLD = float(os.environ.get("ARCFACE_STRONG_MATCH_THRESHOLD", "0.62"))
REID_MATCH_THRESHOLD = float(os.environ.get("REID_MATCH_THRESHOLD", "0.72"))
REID_STRONG_MATCH_THRESHOLD = float(os.environ.get("REID_STRONG_MATCH_THRESHOLD", "0.82"))
EMBEDDING_TOP2_MARGIN = 0.02
LIVE_PERSON_DETECTION_THRESHOLD = float(os.environ.get("LIVE_PERSON_DETECTION_THRESHOLD", "0.45"))
VERBOSE_RECOGNITION_LOGS = os.environ.get("VERBOSE_RECOGNITION_LOGS", "1").lower() in {"1", "true", "yes", "on"}
ALERT_MIN_TRACK_AGE = int(os.environ.get("ALERT_MIN_TRACK_AGE", "20"))
ALERT_MIN_LOCKED_CONF = float(os.environ.get("ALERT_MIN_LOCKED_CONF", "0.72"))
ALERT_MIN_FACE_FRAMES = int(os.environ.get("ALERT_MIN_FACE_FRAMES", "2"))
LOCK_WEIGHT_THRESHOLD = float(os.environ.get("TRACKER_LOCK_WEIGHT_THRESHOLD", "5.0"))
LOCK_MIN_AVG_CONF = float(os.environ.get("TRACKER_LOCK_MIN_AVG_CONF", "0.62"))
IDENTITY_MAX_MISSED = int(os.environ.get("IDENTITY_MAX_MISSED_FRAMES", "90"))


def _xyxy_to_xywh(x1: int, y1: int, x2: int, y2: int) -> tuple[int, int, int, int]:
    return x1, y1, max(0, x2 - x1), max(0, y2 - y1)


def _face_quality_factor(fw: int, fh: int) -> float:
    area = max(1, fw * fh)
    ref = 96 * 96
    return float(min(1.0, np.sqrt(area / ref)))


def _assemble_person_detections(
    frame: np.ndarray,
    yolo_dets: list,
    arcface_faces: list,
) -> tuple[list[dict], list[dict | None]]:
    """
    YOLO person boxes + synthetic full-person boxes for faces YOLO missed.
    Returns parallel lists: ultralytics-style detections, meta (face_idx or None).
    """
    H, W = frame.shape[:2]
    detections: list[dict] = []
    meta: list[dict] = []
    for d in yolo_dets:
        detections.append(d)
        meta.append({"face_idx": None, "from_yolo": True})
    used_faces: set[int] = set()
    for pi in range(len(detections)):
        box = detections[pi]["bounding_box"]
        px, py, pw, ph = int(box["x"]), int(box["y"]), int(box["w"]), int(box["h"])
        pb = (px, py, pw, ph)
        best_fi: int | None = None
        best_score = -1.0
        for fi, face in enumerate(arcface_faces):
            if fi in used_faces:
                continue
            fb = face["bbox"]
            iou = _iou(pb, fb)
            cx = fb[0] + fb[2] / 2
            cy = fb[1] + fb[3] / 2
            inside = px <= cx <= px + pw and py <= cy <= py + ph
            score = iou + (0.15 if inside else 0.0)
            if score > best_score:
                best_score = score
                best_fi = fi
        if best_fi is not None and best_score >= 0.06:
            used_faces.add(best_fi)
            meta[pi]["face_idx"] = best_fi
    for fi, face in enumerate(arcface_faces):
        if fi in used_faces:
            continue
        fb = face["bbox"]
        fx, fy, fw, fh = int(fb[0]), int(fb[1]), int(fb[2]), int(fb[3])
        body_h = min(H - fy, max(fh * 3, int(fh * 2.5)))
        body_w = min(W, max(fw, int(fw * 1.3)))
        bx = max(0, int(fx + (fw - body_w) / 2))
        by = fy
        if body_h <= 0 or body_w <= 0:
            continue
        detections.append({
            "confidence": 0.55,
            "bounding_box": {"x": bx, "y": by, "w": body_w, "h": body_h},
        })
        meta.append({"face_idx": fi, "from_yolo": False})
    return detections, meta


def _match_detection_to_track_meta(
    tx1: int, ty1: int, tx2: int, ty2: int,
    detections: list[dict],
) -> int:
    """Index of YOLO/synth box best matching this track (xyxy), or 0."""
    best_j = 0
    best_iou = 0.0
    for j, det in enumerate(detections):
        b = det["bounding_box"]
        px, py, pw, ph = int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"])
        iou = _iou((tx1, ty1, tx2 - tx1, ty2 - ty1), (px, py, pw, ph))
        if iou > best_iou:
            best_iou = iou
            best_j = j
    return best_j


def _face_vote_from_embedding(query_embedding: dict | None) -> tuple[str | None, float, bool]:
    if not query_embedding or not _subject_embedding_gallery:
        return None, 0.0, False
    best_name, best_sim, second_best_sim = _best_gallery_match(query_embedding, _subject_embedding_gallery)
    embedding_threshold, embedding_strong_threshold = _face_threshold_for_model(_entry_model(query_embedding))
    emb_name: str | None = None
    emb_conf = 0.0
    if best_name is not None and best_sim >= embedding_threshold:
        emb_name = best_name
        emb_conf = float(best_sim)
    emb_margin_ok = second_best_sim > 0.0 and (best_sim - second_best_sim) >= EMBEDDING_TOP2_MARGIN
    acceptable = emb_name is not None and (emb_conf >= embedding_strong_threshold or emb_margin_ok)
    return emb_name, emb_conf, acceptable


def _body_vote_from_embedding(query_reid: dict | None) -> tuple[str | None, float, bool]:
    if not query_reid or not _subject_reid_gallery:
        return None, 0.0, False
    best_name, best_sim, second_best_sim = _best_gallery_match(query_reid, _subject_reid_gallery)
    margin_ok = second_best_sim > 0.0 and (best_sim - second_best_sim) >= EMBEDDING_TOP2_MARGIN
    acceptable = (
        best_name is not None
        and best_sim >= REID_MATCH_THRESHOLD
        and (best_sim >= REID_STRONG_MATCH_THRESHOLD or margin_ok)
    )
    return best_name, float(best_sim), acceptable


def _embedding_to_entry(embedding: IdentityEmbedding | np.ndarray | None, fallback_model: str = "opencv_histogram_v1"):
    if embedding is None:
        return None
    if isinstance(embedding, IdentityEmbedding):
        return {"model": embedding.model, "vector": embedding.vector.astype(np.float32)}
    return {"model": fallback_model, "vector": np.asarray(embedding, dtype=np.float32)}


def _entry_vector(entry):
    if entry is None:
        return None
    if isinstance(entry, dict):
        return np.asarray(entry.get("vector"), dtype=np.float32)
    return np.asarray(entry, dtype=np.float32)


def _entry_model(entry) -> str:
    if isinstance(entry, dict):
        return str(entry.get("model") or "opencv_histogram_v1")
    return "opencv_histogram_v1"


def _face_threshold_for_model(model_name: str) -> tuple[float, float]:
    if model_name.startswith("insightface:"):
        return ARCFACE_MATCH_THRESHOLD, ARCFACE_STRONG_MATCH_THRESHOLD
    return HISTOGRAM_MATCH_THRESHOLD, HISTOGRAM_STRONG_MATCH_THRESHOLD


def _log_recognition_decision(method: str, name: str, confidence: float, details: str = ""):
    if not VERBOSE_RECOGNITION_LOGS:
        return
    suffix = f" | {details}" if details else ""
    print(f"[FaceEngine] method={method} name={name} confidence={confidence:.4f}{suffix}")


def _best_gallery_match(query_entry, gallery: dict):
    query_vector = _entry_vector(query_entry)
    query_model = _entry_model(query_entry)
    if query_vector is None:
        return None, 0.0, 0.0

    best_name = None
    best_sim = -1.0
    second_best_sim = -1.0
    for subject_name, entries in gallery.items():
        if not entries:
            continue
        sims = []
        for entry in entries:
            if _entry_model(entry) != query_model:
                continue
            sim = identity_cosine_similarity(query_vector, _entry_vector(entry))
            sims.append(sim)
        if not sims:
            continue
        sim = max(sims)
        if sim > best_sim:
            second_best_sim = best_sim
            best_sim = sim
            best_name = subject_name
        elif sim > second_best_sim:
            second_best_sim = sim

    return best_name, float(best_sim), float(second_best_sim)


def _get_face_cascade():
    global _face_cascade
    if _face_cascade is None:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        _face_cascade = cv2.CascadeClassifier(cascade_path)
    return _face_cascade


def _get_profile_cascade():
    global _profile_cascade
    if _profile_cascade is None:
        cascade_path = cv2.data.haarcascades + "haarcascade_profileface.xml"
        _profile_cascade = cv2.CascadeClassifier(cascade_path)
    return _profile_cascade


def _normalize_gray(gray):
    # Contrast normalization for dark/overexposed frames.
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    return clahe.apply(gray)


def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _merge_rects(rects, iou_threshold=0.35):
    merged = []
    for r in sorted(rects, key=lambda x: x[2] * x[3], reverse=True):
        if all(_iou(r, m) < iou_threshold for m in merged):
            merged.append(r)
    return merged


# ── Face Detection ──────────────────────────────────────────────────

def detect_faces_in_frame(gray_frame):
    """
    Detect faces in a grayscale frame using Haar cascade.
    Applies CLAHE for low-light enhancement and uses smaller minSize for distant faces.
    Returns list of (x, y, w, h) tuples in the scaled-down coordinate space.
    """
    frontal = _get_face_cascade()
    profile = _get_profile_cascade()
    mini = cv2.resize(
        gray_frame,
        (gray_frame.shape[1] // DETECTION_SCALE, gray_frame.shape[0] // DETECTION_SCALE),
    )
    mini_eq = cv2.equalizeHist(mini)
    mini_enhanced = _normalize_gray(mini)

    candidates = []
    for src in (mini_enhanced, mini_eq, mini):
        faces = frontal.detectMultiScale(src, scaleFactor=1.08, minNeighbors=5, minSize=(18, 18))
        candidates.extend([(int(x), int(y), int(w), int(h)) for (x, y, w, h) in faces])

        # Left-profile
        pfaces = profile.detectMultiScale(src, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18))
        candidates.extend([(int(x), int(y), int(w), int(h)) for (x, y, w, h) in pfaces])

        # Right-profile via horizontal flip
        flipped = cv2.flip(src, 1)
        pfaces_r = profile.detectMultiScale(flipped, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18))
        w_img = src.shape[1]
        for (x, y, w, h) in pfaces_r:
            rx = w_img - (x + w)
            candidates.append((int(rx), int(y), int(w), int(h)))

    if len(candidates) == 0:
        return []
    return _merge_rects(candidates, iou_threshold=0.3)


def detect_faces(image_path: str):
    """
    Detect faces in an image file. Returns bounding boxes + cropped images.
    Used by the existing /detect-faces endpoint.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Could not read image: {image_path}", "faces": []}

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade = _get_face_cascade()
    rects = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60),
        flags=cv2.CASCADE_SCALE_IMAGE,
    )

    faces = []
    for (x, y, w, h) in rects:
        face_crop = img[y:y+h, x:x+w]
        face_id = str(uuid.uuid4())[:8]
        face_filename = f"face_{face_id}.jpg"
        face_path = os.path.join(CRIMINAL_DB_DIR, "crops", face_filename)
        os.makedirs(os.path.dirname(face_path), exist_ok=True)
        cv2.imwrite(face_path, face_crop)
        faces.append({
            "id": face_id,
            "bounding_box": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
            "crop_path": face_path,
            "crop_filename": face_filename,
        })

    return {
        "source": os.path.basename(image_path),
        "face_count": len(faces),
        "faces": faces,
    }


def has_human_face(image_path: str) -> bool:
    """Quick check: does this image contain at least one human face?"""
    result = detect_faces(image_path)
    return result.get("face_count", 0) > 0


# ── Identity Gallery Training ──────────────────────────────────────

def train_model():
    """
    Build identity galleries from stored criminal samples.
    Returns (None, names_dict) to preserve legacy return shape.
    """
    global _model_trained, _subject_embedding_gallery, _subject_reid_gallery, _trained_subject_names

    _subject_embedding_gallery = _build_subject_embedding_gallery()
    _subject_reid_gallery = _build_subject_reid_gallery()
    subject_names = sorted(set(_subject_embedding_gallery.keys()) | set(_subject_reid_gallery.keys()))
    _trained_subject_names = {idx: name for idx, name in enumerate(subject_names)}
    _model_trained = len(subject_names) > 0

    face_counts = {n: len(v) for n, v in _subject_embedding_gallery.items()}
    reid_counts = {n: len(v) for n, v in _subject_reid_gallery.items()}
    print(
        f"[FaceEngine] Galleries ready: subjects={len(subject_names)} "
        f"face_subjects={len(face_counts)} reid_subjects={len(reid_counts)} "
        f"face_counts={face_counts} reid_counts={reid_counts}"
    )
    # The gallery just changed — clear track-id locks so old name->track
    # bindings can't bleed into the new state.
    reset_face_tracker()
    return None, _trained_subject_names


def get_trained_model():
    """Get current identity gallery status in a backward-compatible shape."""
    global _model_trained, _trained_subject_names
    if not _model_trained:
        train_model()
    return None, _trained_subject_names


def recognize_faces_in_frame(frame, camera_id: str = "default"):
    """
    Person-centric tracking: BoxMOT ByteTrack yields stable motion ids on body
    boxes; ArcFace + OSNet ReID feed weighted identity votes into the same track.

    Annotates the body box (primary). An inner thin box marks a visible face.
    """
    _, _names = get_trained_model()
    recognized: list = []
    frame_no = _next_frame_no(camera_id)

    arcface_faces = detect_arcface_faces(frame)
    if not arcface_faces:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        face_coords = detect_faces_in_frame(gray)
        legacy_faces = []
        for fc in face_coords:
            (x, y, w, h) = [v * DETECTION_SCALE for v in fc]
            if w < 40 or h < 40:
                continue
            face_bgr = frame[y:y + h, x:x + w]
            entry = _compute_embedding_entry_from_face_crop(face_bgr)
            if entry is None:
                continue
            legacy_faces.append({"bbox": (x, y, w, h), "embedding": IdentityEmbedding(
                vector=_entry_vector(entry), model=_entry_model(entry)
            )})
        arcface_faces = legacy_faces

    yolo_dets = detect_person_boxes_in_frame(frame, LIVE_PERSON_DETECTION_THRESHOLD)
    person_detections, det_meta = _assemble_person_detections(frame, yolo_dets, arcface_faces)

    if VERBOSE_RECOGNITION_LOGS:
        print(
            f"[FaceEngine] person_track yolo={len(yolo_dets)} dets_for_mot={len(person_detections)} "
            f"faces={len(arcface_faces)}"
        )

    tracks_out = update_motion_tracks(camera_id, frame, person_detections)

    identity_store = get_identity_store()
    unlock_streak = int(os.environ.get("TRACKER_UNLOCK_DISAGREEMENT_STREAK", "5"))
    seen_motion: set[int] = set()

    if tracks_out is None or len(tracks_out) == 0:
        identity_store.end_frame(camera_id, frame_no, seen_motion, IDENTITY_MAX_MISSED)
        return frame, recognized

    for row in tracks_out:
        tx1, ty1, tx2, ty2 = int(row[0]), int(row[1]), int(row[2]), int(row[3])
        motion_id = int(row[4])
        tx1, ty1 = max(0, tx1), max(0, ty1)
        ty2 = min(frame.shape[0], ty2)
        tx2 = min(frame.shape[1], tx2)
        if tx2 <= tx1 or ty2 <= ty1:
            continue

        seen_motion.add(motion_id)
        dj = _match_detection_to_track_meta(tx1, ty1, tx2, ty2, person_detections)
        m0 = det_meta[dj] if dj < len(det_meta) else {"face_idx": None, "from_yolo": True}
        fi = m0.get("face_idx")

        person_xywh = _xyxy_to_xywh(tx1, ty1, tx2, ty2)
        crop_body = frame[ty1:ty2, tx1:tx2]
        query_reid = _embedding_to_entry(compute_reid_embedding(crop_body), fallback_model="torchreid:osnet")

        face_emb_vec = None
        query_embedding = None
        face_bbox = None
        fx = fy = fw = fh = 0
        if fi is not None and fi < len(arcface_faces):
            face = arcface_faces[fi]
            emb = face["embedding"]
            face_emb_vec = np.asarray(emb.vector, dtype=np.float32)
            query_embedding = {"model": emb.model, "vector": emb.vector}
            fx, fy, fw, fh = face["bbox"]
            face_bbox = (int(fx), int(fy), int(fw), int(fh))

        emb_name, emb_conf, emb_ok = _face_vote_from_embedding(query_embedding)
        body_name, body_conf, body_ok = _body_vote_from_embedding(query_reid)

        q_face = _face_quality_factor(int(fw), int(fh)) if face_bbox else 0.0
        votes: list[VoteObservation] = []

        if emb_ok and emb_name:
            votes.append(VoteObservation(
                frame_no, "face", emb_name, emb_conf, weight=2.0 * max(0.35, q_face)
            ))
        if body_ok and body_name:
            accept_body = True
            if emb_name and emb_name != body_name and body_conf < REID_STRONG_MATCH_THRESHOLD + 0.04:
                accept_body = False
            if accept_body:
                w_b = 1.0 if (not emb_name or emb_name == body_name) else 0.35
                votes.append(VoteObservation(
                    frame_no, "body", body_name, body_conf, weight=w_b
                ))

        if not votes and query_reid is not None and _entry_vector(query_reid) is not None:
            g = _global_reid_lookup(_entry_vector(query_reid))
            if g:
                gn, gs = g
                votes.append(VoteObservation(
                    frame_no, "global_reid", gn, float(gs), weight=0.75
                ))

        tr = identity_store.get_or_create(
            camera_id,
            motion_id,
            LOCK_WEIGHT_THRESHOLD,
            LOCK_MIN_AVG_CONF,
            unlock_streak,
        )
        prev_lock = tr.locked_name
        tr.add_observation(
            frame_no,
            person_xywh,
            _entry_vector(query_reid),
            face_emb_vec,
            face_bbox,
            votes,
        )
        if tr.locked_name and tr.locked_name != prev_lock:
            _push_global_reid(tr.locked_name, _entry_vector(query_reid))

        is_match = tr.locked_name is not None
        name = tr.locked_name if is_match else "Unknown"
        out_conf = round(float(tr.locked_confidence), 4) if is_match else 0.0

        tent_face = emb_name
        tent_conf = float(emb_conf)
        tent_body = body_name
        body_tent_conf = float(body_conf)
        if tent_face is None and tent_body and body_ok:
            tent_face = tent_body
            tent_conf = body_tent_conf

        if is_match:
            color = (0, 0, 255)
            label = f"#{motion_id} {name} {int(tr.locked_confidence * 100)}%"
            method = "person_track"
            _log_recognition_decision(
                method="person_track",
                name=str(name),
                confidence=out_conf,
                details=f"motion_id={motion_id} age={tr.age} face_frames={tr.face_vote_frames}",
            )
        elif tent_face and (emb_ok or body_ok):
            color = (0, 215, 255)
            label = f"#{motion_id} ?{tent_face}? {int(tent_conf * 100)}%"
            method = "person_track_pending"
            _log_recognition_decision(
                method="person_track_pending",
                name=str(tent_face),
                confidence=round(float(tent_conf), 4),
                details=f"motion_id={motion_id} age={tr.age}",
            )
        else:
            color = (0, 255, 0)
            label = f"#{motion_id} Unknown"
            method = "unknown"
            _log_recognition_decision(
                method="unknown",
                name="Unknown",
                confidence=0.0,
                details=f"motion_id={motion_id} age={tr.age}",
            )

        cv2.rectangle(frame, (tx1, ty1), (tx2, ty2), color, 2)
        cv2.putText(
            frame, label, (tx1, max(24, ty1 - 8)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2,
        )
        if face_bbox and fw >= 20 and fh >= 20:
            fx1, fy1 = int(fx), int(fy)
            cv2.rectangle(
                frame, (fx1, fy1), (fx1 + int(fw), fy1 + int(fh)),
                (200, 200, 200), 1,
            )

        serialized = _serialize_identity_embeddings(
            face_entries=[query_embedding] if query_embedding else [],
            reid_entries=[query_reid] if query_reid is not None else [],
        )

        alert_eligible = bool(
            is_match
            and tr.age >= ALERT_MIN_TRACK_AGE
            and tr.locked_confidence >= ALERT_MIN_LOCKED_CONF
            and tr.face_vote_frames >= ALERT_MIN_FACE_FRAMES
        )

        recognized.append({
            "name": name,
            "confidence": out_conf,
            "bounding_box": {"x": person_xywh[0], "y": person_xywh[1], "w": person_xywh[2], "h": person_xywh[3]},
            "face_bounding_box": {
                "x": face_bbox[0], "y": face_bbox[1], "w": face_bbox[2], "h": face_bbox[3],
            } if face_bbox else None,
            "is_match": is_match,
            "alert_eligible": alert_eligible,
            "method": method,
            "motion_track_id": motion_id,
            "track_id": motion_id,
            "track_age": tr.age,
            "face_vote_frames": tr.face_vote_frames,
            "tentative_name": tent_face,
            "tentative_confidence": round(float(tent_conf), 4),
            "vote_sources": {
                "face": {"name": emb_name, "score": round(float(emb_conf), 4), "accepted": emb_ok},
                "body": {"name": body_name, "score": round(float(body_conf), 4), "accepted": body_ok},
            },
            "reid_best_match_name": body_name,
            "reid_best_match_score": round(float(body_conf), 4),
            "reid_threshold": REID_MATCH_THRESHOLD,
            "identity_backend": _entry_model(query_embedding) if query_embedding else (
                _entry_model(query_reid) if query_reid else None
            ),
            "identity_embeddings": serialized,
        })

    identity_store.end_frame(camera_id, frame_no, seen_motion, IDENTITY_MAX_MISSED)
    return frame, recognized


# ── Criminal Registration (multi-sample, matching example projects) ─

def _safe_subject_name(name: str) -> str:
    safe = "".join(ch for ch in name.strip() if ch.isalnum() or ch in (" ", "_", "-")).strip()
    return safe.replace(" ", "_") or "unknown_subject"


MIN_CRIMINAL_FACE_SAMPLES = int(os.environ.get("MIN_CRIMINAL_FACE_SAMPLES", "5"))


def register_criminal_samples(name: str, images_data: list, fir_number: str = "", append: bool = False):
    """
    Register a criminal by saving multiple face sample images.
    images_data: list of numpy arrays (BGR images from webcam).
    Creates face_samples/{name}/ with preprocessed face images.
    Returns dict with registration info, error dict, or None on failure.
    """
    safe_name = _safe_subject_name(name)
    person_dir = os.path.join(FACE_SAMPLES_DIR, safe_name)
    temp_dir = os.path.join(FACE_SAMPLES_DIR, f"_temp_{safe_name}")
    originals_dir = os.path.join(CRIMINAL_DB_DIR, "original_samples", safe_name)
    os.makedirs(temp_dir, exist_ok=True)
    os.makedirs(originals_dir, exist_ok=True)

    saved_count = 0
    failed = []
    next_idx = 1
    if append and os.path.isdir(person_dir):
        existing = [f for f in os.listdir(person_dir) if f.endswith((".png", ".jpg", ".jpeg"))]
        next_idx = len(existing) + 1

    for i, img in enumerate(images_data):
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = detect_faces_in_frame(gray)

        if len(faces) == 0:
            failed.append(i + 1)
            continue

        # Take the largest face
        faces_list = list(faces)
        faces_list.sort(key=lambda f: f[2] * f[3], reverse=True)
        fx, fy, fw, fh = [v * DETECTION_SCALE for v in faces_list[0]]
        face = gray[fy:fy + fh, fx:fx + fw]

        if face.size == 0:
            failed.append(i + 1)
            continue

        face = cv2.resize(face, (FACE_WIDTH, FACE_HEIGHT))

        # Save one canonical processed sample; training does dynamic augmentation.
        cv2.imwrite(os.path.join(temp_dir, f"{next_idx}.png"), face)
        # Save original uploaded/captured frame for UI gallery.
        cv2.imwrite(os.path.join(originals_dir, f"sample_{next_idx}.jpg"), img)

        saved_count += 1
        next_idx += 1

    if saved_count < 1:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return None

    if not append and saved_count < MIN_CRIMINAL_FACE_SAMPLES:
        shutil.rmtree(temp_dir, ignore_errors=True)
        if os.path.isdir(originals_dir):
            shutil.rmtree(originals_dir, ignore_errors=True)
        return {
            "error": (
                f"Enrollment requires at least {MIN_CRIMINAL_FACE_SAMPLES} images with detectable faces. "
                f"Got {saved_count}."
            ),
            "code": "INSUFFICIENT_SAMPLES",
            "failed_captures": failed,
            "sample_count": saved_count,
            "min_required": MIN_CRIMINAL_FACE_SAMPLES,
        }

    # Move temp to final (overwrite or append).
    if append and os.path.isdir(person_dir):
        for f in os.listdir(temp_dir):
            shutil.move(os.path.join(temp_dir, f), os.path.join(person_dir, f))
        shutil.rmtree(temp_dir, ignore_errors=True)
    else:
        if os.path.isdir(person_dir):
            shutil.rmtree(person_dir)
        shutil.move(temp_dir, person_dir)

    # Save a profile pic (first image)
    profile_dir = os.path.join(CRIMINAL_DB_DIR, "mugshots")
    os.makedirs(profile_dir, exist_ok=True)
    profile_name = f"mugshot_{safe_name}.jpg"
    profile_path = os.path.join(profile_dir, profile_name)
    if len(images_data) > 0:
        cv2.imwrite(profile_path, images_data[0])

    # Re-train the model with new data
    identity_id = _upsert_criminal_identity_record(name, fir_number, originals_dir, profile_path)
    train_model()

    total_saved = saved_count
    if os.path.isdir(person_dir):
        total_saved = len([f for f in os.listdir(person_dir) if f.endswith((".png", ".jpg", ".jpeg"))])

    return {
        "name": name,
        "safe_name": safe_name,
        "fir_number": fir_number,
        "sample_count": total_saved,
        "failed_captures": failed,
        "profile_image": profile_name,
        "append_mode": append,
        "embedding_id": identity_id,
        "identity_embeddings": collect_subject_identity_embeddings(originals_dir),
        "identity_backends": get_identity_backend_status(),
    }


def get_recognition_status():
    """Return current model training status."""
    subjects = []
    if os.path.isdir(FACE_SAMPLES_DIR):
        for d in sorted(os.listdir(FACE_SAMPLES_DIR)):
            dp = os.path.join(FACE_SAMPLES_DIR, d)
            if os.path.isdir(dp) and not d.startswith("_temp_"):
                count = len([f for f in os.listdir(dp) if f.endswith((".png", ".jpg"))])
                subjects.append({"name": d, "sample_count": count})
    return {
        "model_trained": _model_trained,
        "total_subjects": len(subjects),
        "subjects": subjects,
        "identity_backends": get_identity_backend_status(),
    }


# ── Criminal Database Manager (backward compatible) ────────────────

def _load_db() -> dict:
    """Load the criminal embeddings database from disk."""
    if os.path.exists(EMBEDDINGS_FILE):
        with open(EMBEDDINGS_FILE, "r") as f:
            return json.load(f)
    return {"criminals": []}


def _save_db(db: dict):
    """Persist the criminal embeddings database to disk."""
    with open(EMBEDDINGS_FILE, "w") as f:
        json.dump(db, f, indent=2)


def _compute_histogram_embedding_from_face_crop(face_bgr: np.ndarray) -> np.ndarray | None:
    """Legacy OpenCV descriptor used when ArcFace is unavailable."""
    if face_bgr is None or getattr(face_bgr, "size", 0) == 0:
        return None
    try:
        face_resized = cv2.resize(face_bgr, (64, 64))
    except Exception:
        return None
    gray_face = cv2.cvtColor(face_resized, cv2.COLOR_BGR2GRAY)
    gray_face = _normalize_gray(gray_face)

    gray_hist = cv2.calcHist([gray_face], [0], None, [64], [0, 256])
    gray_hist = cv2.normalize(gray_hist, gray_hist).flatten()

    hsv = cv2.cvtColor(face_resized, cv2.COLOR_BGR2HSV)
    h_hist = cv2.calcHist([hsv], [0], None, [32], [0, 180])
    h_hist = cv2.normalize(h_hist, h_hist).flatten()
    s_hist = cv2.calcHist([hsv], [1], None, [32], [0, 256])
    s_hist = cv2.normalize(s_hist, s_hist).flatten()

    edges = cv2.Canny(gray_face, 50, 150)
    sobel_x = cv2.Sobel(gray_face, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray_face, cv2.CV_64F, 0, 1, ksize=3)
    angles = np.arctan2(sobel_y, sobel_x)
    angle_hist, _ = np.histogram(angles[edges > 0], bins=36, range=(-np.pi, np.pi))
    angle_hist = angle_hist.astype(np.float32)
    norm = np.linalg.norm(angle_hist)
    if norm > 0:
        angle_hist /= norm

    return np.concatenate([gray_hist, h_hist, s_hist, angle_hist])


def _compute_embedding_entry_from_face_crop(face_bgr: np.ndarray):
    modern = compute_arcface_embedding(face_bgr)
    if modern is not None:
        return _embedding_to_entry(modern)
    legacy = _compute_histogram_embedding_from_face_crop(face_bgr)
    return _embedding_to_entry(legacy, fallback_model="opencv_histogram_v1")


def compute_face_embedding(image_path: str) -> np.ndarray | None:
    """
    Backward-compatible face vector API.
    Uses ArcFace when available, otherwise the legacy OpenCV histogram descriptor.
    """
    entry = compute_face_embedding_entry(image_path)
    return _entry_vector(entry) if entry is not None else None


def compute_face_embedding_entry(image_path: str):
    img = cv2.imread(image_path)
    if img is None:
        return None

    modern = compute_arcface_embedding(img)
    if modern is not None:
        return _embedding_to_entry(modern)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rects_scaled = detect_faces_in_frame(gray)
    rects = [(x * DETECTION_SCALE, y * DETECTION_SCALE, w * DETECTION_SCALE, h * DETECTION_SCALE) for (x, y, w, h) in rects_scaled]

    if len(rects) == 0:
        return None

    areas = [w * h for (x, y, w, h) in rects]
    idx = int(np.argmax(areas))
    x, y, w, h = rects[idx]
    face = img[y:y+h, x:x+w]
    legacy = _compute_histogram_embedding_from_face_crop(face)
    return _embedding_to_entry(legacy, fallback_model="opencv_histogram_v1")


def _build_subject_embedding_gallery() -> dict:
    """
    Build per-subject face embedding gallery from all original sample images.
    This ensures cross-referencing all images in each criminal record.
    """
    gallery = {}
    originals_root = os.path.join(CRIMINAL_DB_DIR, "original_samples")
    if not os.path.isdir(originals_root):
        return gallery

    for subject in sorted(os.listdir(originals_root)):
        subject_dir = os.path.join(originals_root, subject)
        if not os.path.isdir(subject_dir):
            continue
        subject_embs = []
        for fname in sorted(os.listdir(subject_dir)):
            if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            fpath = os.path.join(subject_dir, fname)
            entry = compute_face_embedding_entry(fpath)
            if entry is not None:
                subject_embs.append(entry)
        if subject_embs:
            gallery[subject] = subject_embs
    return gallery


def _build_subject_reid_gallery() -> dict:
    """Build per-subject OSNet ReID gallery from original uploaded/captured samples."""
    gallery = {}
    originals_root = os.path.join(CRIMINAL_DB_DIR, "original_samples")
    if not os.path.isdir(originals_root):
        return gallery

    for subject in sorted(os.listdir(originals_root)):
        subject_dir = os.path.join(originals_root, subject)
        if not os.path.isdir(subject_dir):
            continue
        subject_embs = []
        for fname in sorted(os.listdir(subject_dir)):
            if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            img = cv2.imread(os.path.join(subject_dir, fname))
            entry = _embedding_to_entry(compute_reid_embedding(img), fallback_model="torchreid:osnet")
            if entry is not None:
                subject_embs.append(entry)
        if subject_embs:
            gallery[subject] = subject_embs
    return gallery


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    return identity_cosine_similarity(a, b)


def _serialize_entries(entries):
    serialized = []
    for entry in entries:
        vector = _entry_vector(entry)
        if vector is None:
            continue
        serialized.append({
            "model": _entry_model(entry),
            "vector": vector.astype(float).tolist(),
        })
    return serialized


def _serialize_identity_embeddings(face_entries=None, reid_entries=None, sample_path: str | None = None):
    payload = []
    for modality, entries in (("FACE", face_entries or []), ("REID", reid_entries or [])):
        for entry in entries:
            vector = _entry_vector(entry)
            if vector is None:
                continue
            payload.append({
                "modality": modality,
                "model_name": _entry_model(entry),
                "dimension": int(vector.shape[0]),
                "vector": vector.astype(float).tolist(),
                "sample_path": sample_path,
            })
    return payload


def _deserialize_entries(raw_embeddings, fallback_model: str):
    entries = []
    if not isinstance(raw_embeddings, list):
        return entries
    for item in raw_embeddings:
        if isinstance(item, dict) and "vector" in item:
            entries.append({
                "model": str(item.get("model") or fallback_model),
                "vector": np.asarray(item.get("vector"), dtype=np.float32),
            })
        elif isinstance(item, list):
            entries.append({
                "model": fallback_model,
                "vector": np.asarray(item, dtype=np.float32),
            })
    return entries


def _upsert_criminal_identity_record(name: str, fir_number: str, originals_dir: str, mugshot_path: str) -> str:
    """Persist modern face/ReID galleries for API-level matching."""
    safe_name = _safe_subject_name(name)
    face_entries = []
    reid_entries = []

    if os.path.isdir(originals_dir):
        for fname in sorted(os.listdir(originals_dir)):
            if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            path = os.path.join(originals_dir, fname)
            face_entry = compute_face_embedding_entry(path)
            if face_entry is not None:
                face_entries.append(face_entry)
            img = cv2.imread(path)
            reid_entry = _embedding_to_entry(compute_reid_embedding(img), fallback_model="torchreid:osnet")
            if reid_entry is not None:
                reid_entries.append(reid_entry)

    db = _load_db()
    criminals = db.setdefault("criminals", [])
    existing = next(
        (c for c in criminals if _safe_subject_name(str(c.get("name", ""))).lower() == safe_name.lower()),
        None,
    )
    identity_id = existing.get("id") if existing and existing.get("id") else str(uuid.uuid4())
    record = {
        "id": identity_id,
        "name": name,
        "safe_name": safe_name,
        "fir_number": fir_number,
        "mugshot_path": mugshot_path,
        "embedding_model": _entry_model(face_entries[0]) if face_entries else None,
        "embedding": _entry_vector(face_entries[0]).astype(float).tolist() if face_entries else None,
        "embeddings": _serialize_entries(face_entries),
        "reid_model": _entry_model(reid_entries[0]) if reid_entries else None,
        "reid_embeddings": _serialize_entries(reid_entries),
    }

    if existing:
        existing.update(record)
    else:
        criminals.append(record)
    _save_db(db)
    return identity_id


def collect_subject_identity_embeddings(originals_dir: str):
    """Return face and ReID embeddings for every original sample image in a subject directory."""
    face_entries = []
    reid_entries = []

    if os.path.isdir(originals_dir):
        for fname in sorted(os.listdir(originals_dir)):
            if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            path = os.path.join(originals_dir, fname)
            face_entry = compute_face_embedding_entry(path)
            if face_entry is not None:
                face_entries.append((face_entry, path))
            img = cv2.imread(path)
            reid_entry = _embedding_to_entry(compute_reid_embedding(img), fallback_model="torchreid:osnet")
            if reid_entry is not None:
                reid_entries.append((reid_entry, path))

    payload = []
    for entry, path in face_entries:
        payload.extend(_serialize_identity_embeddings(face_entries=[entry], sample_path=path))
    for entry, path in reid_entries:
        payload.extend(_serialize_identity_embeddings(reid_entries=[entry], sample_path=path))
    return payload


def extract_identity_embeddings_from_image(image_path: str) -> list:
    """Compute query embeddings for a probe image without matching locally."""
    img = cv2.imread(image_path)
    if img is None:
        return []

    face_entry = compute_face_embedding_entry(image_path)
    reid_entry = _embedding_to_entry(compute_reid_embedding(img), fallback_model="torchreid:osnet")
    return _serialize_identity_embeddings(
        face_entries=[face_entry] if face_entry is not None else [],
        reid_entries=[reid_entry] if reid_entry is not None else [],
        sample_path=image_path,
    )


def add_criminal(name: str, fir_number: str, mugshot_path: str) -> dict | None:
    """
    Add a criminal to the face database (single mugshot path).
    Computes face embedding from the mugshot and stores it.
    Also stores normalized samples for backward-compatible sample management.
    """
    img = cv2.imread(mugshot_path)
    embedding = compute_face_embedding_entry(mugshot_path)
    if embedding is None or img is None:
        return None

    # Also create normalized face_samples entry for sample lifecycle compatibility
    safe_name = _safe_subject_name(name)
    person_dir = os.path.join(FACE_SAMPLES_DIR, safe_name)
    originals_dir = os.path.join(CRIMINAL_DB_DIR, "original_samples", safe_name)
    os.makedirs(person_dir, exist_ok=True)
    os.makedirs(originals_dir, exist_ok=True)
    cv2.imwrite(os.path.join(originals_dir, "sample_1.jpg"), img)
    if img is not None:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        rects_s = detect_faces_in_frame(gray)
        rects = [(x * DETECTION_SCALE, y * DETECTION_SCALE, w * DETECTION_SCALE, h * DETECTION_SCALE) for (x, y, w, h) in rects_s]
        if len(rects) > 0:
            areas = [w * h for (x, y, w, h) in rects]
            idx = int(np.argmax(areas))
            x, y, w, h = rects[idx]
            face = gray[y:y+h, x:x+w]
            face = cv2.resize(face, (FACE_WIDTH, FACE_HEIGHT))
            existing = len(os.listdir(person_dir))
            cv2.imwrite(os.path.join(person_dir, f"{existing + 1}.png"), face)
            flipped = cv2.flip(face, 1)
            cv2.imwrite(os.path.join(person_dir, f"{existing + 2}.png"), flipped)

    criminal_id = _upsert_criminal_identity_record(name, fir_number, originals_dir, mugshot_path)

    # Refresh identity galleries with new data
    train_model()

    return {
        "id": criminal_id,
        "name": name,
        "fir_number": fir_number,
        "identity_embeddings": collect_subject_identity_embeddings(originals_dir),
        "identity_backends": get_identity_backend_status(),
    }


def list_criminals() -> list:
    """List all criminals in the database (without embedding vectors)."""
    db = _load_db()
    return [
        {"id": c["id"], "name": c["name"], "fir_number": c["fir_number"],
         "mugshot_path": c.get("mugshot_path", "")}
        for c in db.get("criminals", [])
    ]


def remove_criminal(criminal_id: str) -> bool:
    """Remove a criminal from the database by ID."""
    db = _load_db()
    before = len(db["criminals"])

    # Find the name and mugshot path before removing
    name_to_remove = None
    mugshot_path_to_remove = None
    for c in db["criminals"]:
        if c["id"] == criminal_id:
            name_to_remove = c["name"]
            mugshot_path_to_remove = c.get("mugshot_path", "")
            break

    db["criminals"] = [c for c in db["criminals"] if c["id"] != criminal_id]
    if len(db["criminals"]) < before:
        _save_db(db)

        # Also remove face_samples directory
        if name_to_remove:
            person_dir = os.path.join(FACE_SAMPLES_DIR, name_to_remove)
            if os.path.isdir(person_dir):
                shutil.rmtree(person_dir)

            # Also remove mugshot image from criminal_db/mugshots/
            mugshot_dir = os.path.join(CRIMINAL_DB_DIR, "mugshots")
            if os.path.isdir(mugshot_dir):
                for fname in os.listdir(mugshot_dir):
                    if name_to_remove.replace(' ', '_') in fname:
                        try:
                            os.remove(os.path.join(mugshot_dir, fname))
                        except OSError:
                            pass

            # Remove mugshot referenced in the record
            if mugshot_path_to_remove and os.path.isfile(mugshot_path_to_remove):
                try:
                    os.remove(mugshot_path_to_remove)
                except OSError:
                    pass

            # Re-train model
            train_model()

        return True
    return False


def remove_criminal_by_name(name: str) -> bool:
    """Remove a criminal subject by name from samples + embeddings."""
    if not name or not name.strip():
        return False

    target = name.strip()
    target_safe = _safe_subject_name(target)
    removed_any = False

    # Remove from embeddings database by name (exact, case-insensitive).
    db = _load_db()
    before = len(db.get("criminals", []))
    db["criminals"] = [
        c for c in db.get("criminals", [])
        if str(c.get("name", "")).strip().lower() != target.lower()
    ]
    if len(db["criminals"]) < before:
        _save_db(db)
        removed_any = True

    # Remove trained face sample directory (legacy and safe-name forms).
    for candidate in {target, target_safe}:
        person_dir = os.path.join(FACE_SAMPLES_DIR, candidate)
        if os.path.isdir(person_dir):
            shutil.rmtree(person_dir, ignore_errors=True)
            removed_any = True

    # Remove original sample gallery directory if present.
    originals_dir = os.path.join(CRIMINAL_DB_DIR, "original_samples", target_safe)
    if os.path.isdir(originals_dir):
        shutil.rmtree(originals_dir, ignore_errors=True)
        removed_any = True

    # Remove matching mugshot files.
    mugshot_dir = os.path.join(CRIMINAL_DB_DIR, "mugshots")
    if os.path.isdir(mugshot_dir):
        needle = target_safe.lower()
        for fname in os.listdir(mugshot_dir):
            if needle in fname.lower():
                try:
                    os.remove(os.path.join(mugshot_dir, fname))
                    removed_any = True
                except OSError:
                    pass

    if removed_any:
        train_model()

    return removed_any


def sync_subjects_with_names(names: list[str]) -> dict:
    """
    Keep only provided subject names in model stores.
    Removes stale face_samples/original_samples/embeddings entries, then retrains.
    """
    allowed_safe = {_safe_subject_name(str(n)) for n in (names or []) if str(n).strip()}
    changed = False

    # Sync face_samples subjects
    if os.path.isdir(FACE_SAMPLES_DIR):
        for d in os.listdir(FACE_SAMPLES_DIR):
            if d.startswith("_temp_"):
                continue
            dp = os.path.join(FACE_SAMPLES_DIR, d)
            if os.path.isdir(dp) and d not in allowed_safe:
                shutil.rmtree(dp, ignore_errors=True)
                changed = True

    # Sync original sample galleries
    originals_root = os.path.join(CRIMINAL_DB_DIR, "original_samples")
    if os.path.isdir(originals_root):
        for d in os.listdir(originals_root):
            dp = os.path.join(originals_root, d)
            if os.path.isdir(dp) and d not in allowed_safe:
                shutil.rmtree(dp, ignore_errors=True)
                changed = True

    # Sync embeddings DB entries by name
    db = _load_db()
    before = len(db.get("criminals", []))
    db["criminals"] = [
        c for c in db.get("criminals", [])
        if _safe_subject_name(str(c.get("name", ""))) in allowed_safe
    ]
    if len(db["criminals"]) < before:
        _save_db(db)
        changed = True

    if changed or len(allowed_safe) == 0:
        train_model()

    status = get_recognition_status()
    return {
        "success": True,
        "changed": changed,
        "allowed_subjects": sorted(list(allowed_safe)),
        "status": status,
    }


def match_face(image_path: str, threshold: float = 0.65) -> list:
    """
    Match an image against known subjects.
    Face embeddings are the primary signal; OSNet person ReID is used as a fallback
    for full-body/non-frontal crops where a reliable face cannot be extracted.
    Returns sorted list of matches above threshold.
    """
    img = cv2.imread(image_path)
    if img is None:
        return []

    query_face = compute_face_embedding_entry(image_path)
    query_reid = _embedding_to_entry(compute_reid_embedding(img), fallback_model="torchreid:osnet")
    db = _load_db()
    matches = []

    for criminal in db.get("criminals", []):
        best_method = None
        best_model = None
        best_similarity = -1.0

        if query_face is not None:
            face_entries = _deserialize_entries(criminal.get("embeddings"), fallback_model=str(criminal.get("embedding_model") or "opencv_histogram_v1"))
            if not face_entries and criminal.get("embedding") is not None:
                face_entries = [{
                    "model": str(criminal.get("embedding_model") or "opencv_histogram_v1"),
                    "vector": np.asarray(criminal.get("embedding"), dtype=np.float32),
                }]
            face_sims = [
                identity_cosine_similarity(_entry_vector(query_face), _entry_vector(entry))
                for entry in face_entries
                if _entry_model(entry) == _entry_model(query_face)
            ]
            if face_sims:
                best_similarity = max(face_sims)
                best_method = "face_embedding"
                best_model = _entry_model(query_face)

        if query_reid is not None:
            reid_entries = _deserialize_entries(criminal.get("reid_embeddings"), fallback_model=str(criminal.get("reid_model") or "torchreid:osnet"))
            reid_sims = [
                identity_cosine_similarity(_entry_vector(query_reid), _entry_vector(entry))
                for entry in reid_entries
                if _entry_model(entry) == _entry_model(query_reid)
            ]
            if reid_sims:
                reid_similarity = max(reid_sims)
                if best_method is None or (best_similarity < threshold and reid_similarity > best_similarity):
                    best_similarity = reid_similarity
                    best_method = "person_reid"
                    best_model = _entry_model(query_reid)

        required_threshold = REID_MATCH_THRESHOLD if best_method == "person_reid" else threshold
        if best_method is not None and best_similarity >= required_threshold:
            matches.append({
                "criminal_id": criminal["id"],
                "criminal_name": criminal["name"],
                "fir_number": criminal.get("fir_number", ""),
                "confidence": round(float(best_similarity), 4),
                "method": best_method,
                "identity_backend": best_model,
            })

    # Sort by confidence descending
    matches.sort(key=lambda m: m["confidence"], reverse=True)
    return matches
