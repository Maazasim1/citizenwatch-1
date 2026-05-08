"""
Face Detection & Recognition Engine
Uses OpenCV Haar cascades for detection + LBPH Face Recognizer for identification.
Modeled after the example projects' architecture:
  - face_samples/{person_name}/*.png  for training data
  - LBPHFaceRecognizer for real-time recognition
  - Haar cascades for face detection

Also retains the criminal database JSON for the existing CCTV upload workflow.
"""

import os
import json
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
    get_identity_backend_status,
)

CRIMINAL_DB_DIR = os.path.join(os.path.dirname(__file__), "criminal_db")
EMBEDDINGS_FILE = os.path.join(CRIMINAL_DB_DIR, "embeddings.json")
FACE_SAMPLES_DIR = os.path.join(os.path.dirname(__file__), "face_samples")
os.makedirs(CRIMINAL_DB_DIR, exist_ok=True)
os.makedirs(FACE_SAMPLES_DIR, exist_ok=True)

# Haar cascade for face detection (ships with OpenCV, no extra downloads)
_face_cascade = None
_profile_cascade = None

# Global LBPH model (lazy-trained)
_lbph_model = None
_lbph_names = {}
_model_trained = False
_subject_embedding_gallery = {}
_subject_reid_gallery = {}

# Standard face size for LBPH training (matches example projects)
FACE_WIDTH = 112
FACE_HEIGHT = 92
DETECTION_SCALE = 2
LBPH_MATCH_THRESHOLD = 86.0
HISTOGRAM_MATCH_THRESHOLD = 0.78
HISTOGRAM_STRONG_MATCH_THRESHOLD = 0.84
ARCFACE_MATCH_THRESHOLD = float(os.environ.get("ARCFACE_MATCH_THRESHOLD", "0.5"))
ARCFACE_STRONG_MATCH_THRESHOLD = float(os.environ.get("ARCFACE_STRONG_MATCH_THRESHOLD", "0.62"))
REID_MATCH_THRESHOLD = float(os.environ.get("REID_MATCH_THRESHOLD", "0.72"))
REID_STRONG_MATCH_THRESHOLD = float(os.environ.get("REID_STRONG_MATCH_THRESHOLD", "0.82"))
EMBEDDING_TOP2_MARGIN = 0.02
LIVE_PERSON_DETECTION_THRESHOLD = float(os.environ.get("LIVE_PERSON_DETECTION_THRESHOLD", "0.45"))


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


# ── LBPH Face Recognition (matches example projects) ───────────────

def train_model():
    """
    Train LBPH face recognizer from face_samples/ directory.
    Each subdirectory = one person. All images inside become training samples.
    Returns (model, names_dict) and caches globally.
    """
    global _lbph_model, _lbph_names, _model_trained, _subject_embedding_gallery, _subject_reid_gallery

    model = cv2.face.LBPHFaceRecognizer_create()
    images, labels, names = [], [], {}
    current_id = 0

    if not os.path.isdir(FACE_SAMPLES_DIR):
        _model_trained = False
        _subject_embedding_gallery = {}
        _subject_reid_gallery = {}
        return None, {}

    for subdir in sorted(os.listdir(FACE_SAMPLES_DIR)):
        subject_path = os.path.join(FACE_SAMPLES_DIR, subdir)
        if not os.path.isdir(subject_path):
            continue

        names[current_id] = subdir
        for filename in os.listdir(subject_path):
            _, ext = os.path.splitext(filename)
            if ext.lower() not in [".png", ".jpg", ".jpeg", ".pgm"]:
                continue
            filepath = os.path.join(subject_path, filename)
            img = cv2.imread(filepath, cv2.IMREAD_GRAYSCALE)
            if img is None:
                continue
            # Ensure consistent size + contrast normalization
            img = cv2.resize(img, (FACE_WIDTH, FACE_HEIGHT))
            img = _normalize_gray(img)
            images.append(img)
            labels.append(current_id)

            # Lightweight augmentation for pose/illumination robustness.
            flipped = cv2.flip(img, 1)
            images.append(flipped)
            labels.append(current_id)

            for angle in (-12, 12):
                M = cv2.getRotationMatrix2D((FACE_WIDTH / 2, FACE_HEIGHT / 2), angle, 1.0)
                rotated = cv2.warpAffine(img, M, (FACE_WIDTH, FACE_HEIGHT), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
                images.append(rotated)
                labels.append(current_id)

        current_id += 1

    if len(images) == 0 or len(names) == 0:
        _model_trained = False
        _subject_embedding_gallery = {}
        _subject_reid_gallery = {}
        return None, {}

    images = np.array(images)
    labels = np.array(labels)
    model.train(images, labels)

    _lbph_model = model
    _lbph_names = names
    _model_trained = True
    _subject_embedding_gallery = _build_subject_embedding_gallery()
    _subject_reid_gallery = _build_subject_reid_gallery()
    print(f"[FaceEngine] LBPH model trained with {len(images)} samples across {len(names)} subjects")
    return model, names


def get_trained_model():
    """Get the currently trained model, training if necessary."""
    global _lbph_model, _lbph_names, _model_trained
    if not _model_trained:
        train_model()
    return _lbph_model, _lbph_names


def recognize_faces_in_frame(frame):
    """
    Detect and recognize faces in a BGR frame.
    Returns:
      - annotated_frame (with bounding boxes and name labels)
      - recognized: list of dicts with name, confidence, bounding_box
    """
    model, names = get_trained_model()
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Apply CLAHE for low-light / dark environment enhancement
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    face_coords = detect_faces_in_frame(gray)
    recognized = []
    matched_face_boxes = []

    if model is None or len(names) == 0:
        # No model trained — just return face detections without recognition
        for face_coord in face_coords:
            (x, y, w, h) = [v * DETECTION_SCALE for v in face_coord]
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
            cv2.putText(frame, "Unknown", (x, y - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            recognized.append({
                "name": "Unknown",
                "confidence": 0,
                "bounding_box": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
                "is_match": False,
            })
        return frame, recognized

    for face_coord in face_coords:
        (x, y, w, h) = [v * DETECTION_SCALE for v in face_coord]
        if w < 40 or h < 40:
            # Skip tiny crops that often produce noisy LBPH predictions.
            continue
        face = gray[y:y + h, x:x + w]
        face_bgr = frame[y:y + h, x:x + w]

        if face.size == 0:
            continue

        face_resized = cv2.resize(face, (FACE_WIDTH, FACE_HEIGHT))
        face_resized = _normalize_gray(face_resized)

        # Test-time augmentation + voting to improve non-frontal matching.
        variants = [face_resized, cv2.flip(face_resized, 1)]
        for angle in (-10, 10):
            M = cv2.getRotationMatrix2D((FACE_WIDTH / 2, FACE_HEIGHT / 2), angle, 1.0)
            variants.append(
                cv2.warpAffine(
                    face_resized,
                    M,
                    (FACE_WIDTH, FACE_HEIGHT),
                    flags=cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_REFLECT,
                )
            )

        votes = {}
        best_conf = {}
        for v in variants:
            pred_i, conf_i = model.predict(v)
            votes[pred_i] = votes.get(pred_i, 0) + 1
            if pred_i not in best_conf or conf_i < best_conf[pred_i]:
                best_conf[pred_i] = conf_i

        prediction = max(votes.items(), key=lambda kv: (kv[1], -best_conf.get(kv[0], 1e9)))[0]
        confidence = best_conf.get(prediction, 999.0)

        # Cross-reference against all stored images per subject via modern face embeddings first.
        emb_name = None
        emb_conf = 0.0
        emb_margin_ok = False
        query_embedding = _compute_embedding_entry_from_face_crop(face_bgr)
        if query_embedding is not None and _subject_embedding_gallery:
            best_name, best_sim, second_best_sim = _best_gallery_match(query_embedding, _subject_embedding_gallery)
            embedding_threshold, _ = _face_threshold_for_model(_entry_model(query_embedding))
            if best_name is not None and best_sim >= embedding_threshold:
                emb_name = best_name
                emb_conf = float(best_sim)
                emb_margin_ok = (best_sim - max(second_best_sim, 0.0)) >= EMBEDDING_TOP2_MARGIN

        # LBPH confidence is a distance metric: lower is better.
        # Use a slightly higher threshold for live webcam variability.
        lbph_name = names[prediction] if (confidence <= LBPH_MATCH_THRESHOLD and prediction in names) else None
        lbph_score = max(0.0, min(1.0, (LBPH_MATCH_THRESHOLD - float(confidence)) / 30.0))

        # Conservative acceptance to reduce cross-person confusion:
        # accept embedding match only if very strong OR if not ambiguous.
        _, embedding_strong_threshold = _face_threshold_for_model(_entry_model(query_embedding))
        emb_acceptable = emb_name is not None and (
            emb_conf >= embedding_strong_threshold or emb_margin_ok
        )

        if emb_acceptable and (lbph_name is None or emb_conf >= lbph_score):
            name = emb_name
            color = (0, 0, 255)
            is_match = True
            label = f"{name} ({int(emb_conf * 100)}%)"
            out_conf = round(float(emb_conf), 4)
        elif lbph_name:
            name = lbph_name
            color = (0, 0, 255)  # Red for recognized criminal
            is_match = True
            label = f"{name} ({confidence:.0f})"
            out_conf = round(float(confidence), 2)
        else:
            name = "Unknown"
            color = (0, 255, 0)  # Green for unknown
            is_match = False
            label = "Unknown"
            out_conf = round(float(confidence), 2)

        cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
        cv2.putText(frame, label, (x, y - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        if is_match:
            recognized.append({
                "name": name,
                "confidence": out_conf,
                "bounding_box": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
                "is_match": True,
                "method": "face_embedding" if emb_acceptable and name == emb_name else "lbph",
                "identity_backend": _entry_model(query_embedding) if emb_acceptable and name == emb_name else "opencv_lbph",
            })
            matched_face_boxes.append((int(x), int(y), int(w), int(h)))
        elif not is_match:
            recognized.append({
                "name": "Unknown",
                "confidence": out_conf,
                "bounding_box": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
                "is_match": False,
                "method": "unknown",
            })

    if _subject_reid_gallery:
        for det in detect_person_boxes_in_frame(frame, LIVE_PERSON_DETECTION_THRESHOLD):
            box = det.get("bounding_box") or {}
            x, y, w, h = int(box.get("x", 0)), int(box.get("y", 0)), int(box.get("w", 0)), int(box.get("h", 0))
            if w <= 0 or h <= 0:
                continue
            if any(_iou((x, y, w, h), face_box) > 0.15 for face_box in matched_face_boxes):
                continue

            crop = frame[y:y + h, x:x + w]
            query_reid = _embedding_to_entry(compute_reid_embedding(crop), fallback_model="torchreid:osnet")
            best_name, best_sim, second_best_sim = _best_gallery_match(query_reid, _subject_reid_gallery)
            margin_ok = (best_sim - max(second_best_sim, 0.0)) >= EMBEDDING_TOP2_MARGIN
            if best_name is None or best_sim < REID_MATCH_THRESHOLD:
                continue
            if best_sim < REID_STRONG_MATCH_THRESHOLD and not margin_ok:
                continue

            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 0, 255), 2)
            cv2.putText(frame, f"{best_name} ReID ({int(best_sim * 100)}%)", (x, max(20, y - 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
            recognized.append({
                "name": best_name,
                "confidence": round(float(best_sim), 4),
                "bounding_box": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
                "is_match": True,
                "method": "person_reid",
                "identity_backend": _entry_model(query_reid),
            })

    return frame, recognized


# ── Criminal Registration (multi-sample, matching example projects) ─

def _safe_subject_name(name: str) -> str:
    safe = "".join(ch for ch in name.strip() if ch.isalnum() or ch in (" ", "_", "-")).strip()
    return safe.replace(" ", "_") or "unknown_subject"


def register_criminal_samples(name: str, images_data: list, fir_number: str = "", append: bool = False):
    """
    Register a criminal by saving multiple face sample images.
    images_data: list of numpy arrays (BGR images from webcam).
    Creates face_samples/{name}/ with preprocessed face images.
    Returns dict with registration info, or None on failure.
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


def add_criminal(name: str, fir_number: str, mugshot_path: str) -> dict | None:
    """
    Add a criminal to the face database (single mugshot path).
    Computes face embedding from the mugshot and stores it.
    Also creates face_samples entry for LBPH training.
    """
    img = cv2.imread(mugshot_path)
    embedding = compute_face_embedding_entry(mugshot_path)
    if embedding is None or img is None:
        return None

    # Also create face_samples entry for LBPH
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

    # Re-train LBPH with new data
    train_model()

    return {"id": criminal_id, "name": name, "fir_number": fir_number, "identity_backends": get_identity_backend_status()}


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
