"""
CCTV Pipeline — Flask REST API Server
Exposes YOLOv8 person detection, face detection, criminal DB matching,
and LBPH-based real-time face recognition to the Node.js backend via HTTP.

Run: python server.py
Listens on port 3600 by default.
"""

import os
import uuid
import base64
import tempfile
import json
import socket
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

from detector import detect_persons_in_image, detect_persons_in_video, DETECTIONS_DIR
from face_engine import (
    detect_faces,
    has_human_face,
    match_face,
    add_criminal,
    list_criminals,
    remove_criminal,
    remove_criminal_by_name,
    sync_subjects_with_names,
    register_criminal_samples,
    recognize_faces_in_frame,
    train_model,
    get_recognition_status,
    CRIMINAL_DB_DIR,
)
import cv2

app = Flask(__name__)
CORS(app)

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
DEBUG_LOG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "debug-2eaf59.log"))

def _debug_log(hypothesis_id: str, location: str, message: str, data: dict):
    payload = {
        "sessionId": "2eaf59",
        "runId": "initial",
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": int(__import__("time").time() * 1000),
    }
    with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "cctv-pipeline"})


# ── Person Detection (Feature 2) ────────────────────────────────────

@app.route("/detect", methods=["POST"])
def detect():
    """
    Upload an image or video file. Runs YOLOv8 person detection.
    Returns bounding boxes + cropped person images.
    """
    # #region agent log
    _debug_log(
        "H5",
        "apps/cctv-pipeline/server.py:/detect:entry",
        "Pipeline received detect request",
        {"file_keys": list(request.files.keys()), "form_keys": list(request.form.keys()), "content_type": request.content_type},
    )
    # #endregion
    if "file" not in request.files:
        # #region agent log
        _debug_log(
            "H5",
            "apps/cctv-pipeline/server.py:/detect:missing-file",
            "Pipeline detect request missing file",
            {"file_keys": list(request.files.keys()), "content_type": request.content_type},
        )
        # #endregion
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Save uploaded file
    ext = os.path.splitext(file.filename)[1].lower()
    unique_name = f"{uuid.uuid4()}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, unique_name)
    file.save(saved_path)

    # Determine if image or video
    image_exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    video_exts = {".mp4", ".avi", ".mov", ".mkv", ".webm"}

    confidence = float(request.form.get("confidence", 0.4))

    if ext in image_exts:
        result = detect_persons_in_image(saved_path, confidence)
    elif ext in video_exts:
        sample_rate = int(request.form.get("sample_every", 30))
        result = detect_persons_in_video(saved_path, sample_rate, confidence)
    else:
        return jsonify({"error": f"Unsupported file type: {ext}"}), 400

    return jsonify(result)


@app.route("/detections", methods=["GET"])
def list_detections():
    """List all saved person detection crops."""
    crops = []
    if os.path.isdir(DETECTIONS_DIR):
        for fname in sorted(os.listdir(DETECTIONS_DIR)):
            if fname.endswith((".jpg", ".png")):
                crops.append({
                    "filename": fname,
                    "path": os.path.join(DETECTIONS_DIR, fname),
                })
    return jsonify({"detections": crops, "count": len(crops)})


@app.route("/detections/<filename>", methods=["GET"])
def serve_detection(filename):
    """Serve a cropped person image."""
    return send_from_directory(DETECTIONS_DIR, filename)


# ── Face Detection & Matching (Feature 3 & 4) ──────────────────────

@app.route("/detect-faces", methods=["POST"])
def detect_faces_endpoint():
    """
    Upload an image. Detects faces and returns bounding boxes + crops.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    ext = os.path.splitext(file.filename or "")[1].lower()
    unique_name = f"{uuid.uuid4()}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, unique_name)
    file.save(saved_path)

    result = detect_faces(saved_path)
    return jsonify(result)


@app.route("/check-face-presence", methods=["POST"])
def check_face_presence():
    """
    Quick check: does this image contain a human face?
    Used by Feature 4 to auto-flag citizen-submitted photos.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    ext = os.path.splitext(file.filename or "")[1].lower()
    unique_name = f"{uuid.uuid4()}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, unique_name)
    file.save(saved_path)

    has_face = has_human_face(saved_path)

    # Clean up temp file
    try:
        os.remove(saved_path)
    except OSError:
        pass

    return jsonify({"has_face": has_face, "filename": file.filename})


@app.route("/match-face", methods=["POST"])
def match_face_endpoint():
    """
    Upload an image with a face. Match it against the criminal database.
    Returns sorted list of matches above the confidence threshold.
    """
    # #region agent log
    _debug_log(
        "H7",
        "apps/cctv-pipeline/server.py:/match-face:entry",
        "Pipeline received match-face request",
        {"file_keys": list(request.files.keys()), "form_keys": list(request.form.keys()), "content_type": request.content_type},
    )
    # #endregion
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    ext = os.path.splitext(file.filename or "")[1].lower()
    unique_name = f"{uuid.uuid4()}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, unique_name)
    file.save(saved_path)

    threshold = float(request.form.get("threshold", 0.55))
    matches = match_face(saved_path, threshold)
    # #region agent log
    _debug_log(
        "H7",
        "apps/cctv-pipeline/server.py:/match-face:result",
        "Pipeline match-face result",
        {"threshold": threshold, "match_count": len(matches), "matches": matches[:3]},
    )
    # #endregion

    return jsonify({
        "filename": file.filename,
        "matches": matches,
        "match_count": len(matches),
    })


# ── Criminal Database Management (Feature 3) ───────────────────────

@app.route("/criminal-db", methods=["GET"])
def get_criminals():
    """List all criminals in the face database."""
    criminals = list_criminals()
    return jsonify({"criminals": criminals, "count": len(criminals)})


@app.route("/criminal-db", methods=["POST"])
def add_criminal_endpoint():
    """
    Add a criminal to the face database.
    Requires: name, fir_number, and a mugshot image file.
    """
    # #region agent log
    _debug_log(
        "H2",
        "apps/cctv-pipeline/server.py:/criminal-db:entry",
        "Pipeline received criminal-db request",
        {
            "file_keys": list(request.files.keys()),
            "form_keys": list(request.form.keys()),
            "content_type": request.content_type,
        },
    )
    # #endregion
    if "mugshot" not in request.files:
        # #region agent log
        _debug_log(
            "H2",
            "apps/cctv-pipeline/server.py:/criminal-db:missing-mugshot",
            "Pipeline missing mugshot in request.files",
            {"file_keys": list(request.files.keys()), "content_type": request.content_type},
        )
        # #endregion
        return jsonify({"error": "Mugshot image required"}), 400

    name = request.form.get("name", "").strip()
    fir_number = request.form.get("fir_number", "").strip()
    if not name:
        # Defensive fallback: do not fail registration solely due to multipart field drop.
        fallback = (request.form.get("fir_number") or "").strip()
        name = fallback if fallback else f"Unknown-{uuid.uuid4().hex[:6]}"

    file = request.files["mugshot"]
    # #region agent log
    _debug_log(
        "H3",
        "apps/cctv-pipeline/server.py:/criminal-db:file-present",
        "Pipeline has mugshot file",
        {"filename": file.filename, "mimetype": file.mimetype},
    )
    # #endregion
    ext = os.path.splitext(file.filename or "")[1].lower()
    mugshot_name = f"mugshot_{uuid.uuid4()}{ext}"
    mugshot_dir = os.path.join(CRIMINAL_DB_DIR, "mugshots")
    os.makedirs(mugshot_dir, exist_ok=True)
    mugshot_path = os.path.join(mugshot_dir, mugshot_name)
    file.save(mugshot_path)

    result = add_criminal(name, fir_number, mugshot_path)
    if result is None:
        return jsonify({"error": "No detectable face found in mugshot image. Use a clear, front-facing photo (jpg/png)."}), 400

    return jsonify({"success": True, "criminal": result})


@app.route("/criminal-db/<criminal_id>", methods=["DELETE"])
def delete_criminal(criminal_id):
    """Remove a criminal from the database."""
    removed = remove_criminal(criminal_id)
    if removed:
        return jsonify({"success": True})
    return jsonify({"error": "Criminal not found"}), 404


@app.route("/criminal-db/by-name/<path:name>", methods=["DELETE"])
def delete_criminal_by_name(name):
    """Remove a criminal subject by name."""
    removed = remove_criminal_by_name(name)
    if removed:
        return jsonify({"success": True})
    return jsonify({"error": "Criminal not found"}), 404


@app.route("/criminal-db/mugshots/<filename>", methods=["GET"])
def serve_mugshot(filename):
    """Serve a mugshot image."""
    mugshot_dir = os.path.join(CRIMINAL_DB_DIR, "mugshots")
    return send_from_directory(mugshot_dir, filename)


# ── Live Recognition Endpoints (New) ───────────────────────────────

@app.route("/register-samples", methods=["POST"])
def register_samples_endpoint():
    """
    Register a criminal using multiple face sample images.
    Accepts:
      - name (form field)
      - fir_number (form field, optional)
      - samples (multiple image files)
      - OR base64_samples (JSON array of base64-encoded images)
    """
    name = (
        request.form.get("name")
        or request.form.get("fullName")
        or request.form.get("full_name")
        or request.form.get("criminalName")
        or request.form.get("criminal_name")
        or ""
    ).strip()
    fir_number = request.form.get("fir_number", "").strip()
    append = str(request.form.get("append", "")).lower() in {"1", "true", "yes", "on"}

    if not name:
        # Defensive fallback: avoid false negatives from multipart field drops.
        name = fir_number if fir_number else f"Unknown-{uuid.uuid4().hex[:6]}"

    images = []

    # Handle file uploads
    sample_files = request.files.getlist("samples")
    for f in sample_files:
        ext = os.path.splitext(f.filename or "")[1].lower()
        temp_name = f"{uuid.uuid4()}{ext}"
        temp_path = os.path.join(UPLOAD_DIR, temp_name)
        f.save(temp_path)
        img = cv2.imread(temp_path)
        if img is not None:
            images.append(img)
        try:
            os.remove(temp_path)
        except OSError:
            pass

    # Handle base64 images (from webcam capture)
    b64_data = request.form.get("base64_samples", "")
    if b64_data:
        import json as json_mod
        try:
            b64_list = json_mod.loads(b64_data)
            for b64_str in b64_list:
                # Remove data URL prefix if present
                if "," in b64_str:
                    b64_str = b64_str.split(",", 1)[1]
                img_bytes = base64.b64decode(b64_str)
                nparr = np.frombuffer(img_bytes, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if img is not None:
                    images.append(img)
        except Exception as e:
            return jsonify({"error": f"Failed to decode base64 images: {str(e)}"}), 400

    if len(images) < 1:
        return jsonify({"error": f"At least 1 face image is required, got {len(images)}"}), 400

    result = register_criminal_samples(name, images, fir_number, append=append)
    if result is None:
        return jsonify({"error": "Registration failed — too few images contained detectable faces"}), 400

    return jsonify({"success": True, "registration": result})


@app.route("/recognize-frame", methods=["POST"])
def recognize_frame_endpoint():
    """
    Receive a single frame and run face recognition.
    Accepts:
      - file (image upload) OR
      - frame_base64 (base64-encoded image in form data)
    Returns recognized faces with bounding boxes and names.
    """
    frame = None

    if "file" in request.files:
        f = request.files["file"]
        ext = os.path.splitext(f.filename or "")[1].lower()
        temp_name = f"{uuid.uuid4()}{ext}"
        temp_path = os.path.join(UPLOAD_DIR, temp_name)
        f.save(temp_path)
        frame = cv2.imread(temp_path)
        try:
            os.remove(temp_path)
        except OSError:
            pass
    else:
        b64 = request.form.get("frame_base64", "")
        if not b64:
            # Try JSON body
            data = request.get_json(silent=True)
            if data:
                b64 = data.get("frame_base64", "")

        if b64:
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                img_bytes = base64.b64decode(b64)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            except Exception:
                return jsonify({"error": "Failed to decode base64 frame"}), 400

    if frame is None:
        return jsonify({"error": "No frame provided"}), 400

    annotated, recognized = recognize_faces_in_frame(frame)
    # #region agent log
    _debug_log(
        "H6",
        "apps/cctv-pipeline/server.py:/recognize-frame:result",
        "Pipeline recognize-frame result",
        {"face_count": len(recognized), "match_count": len([f for f in recognized if f.get("is_match")]), "recognized": recognized[:3]},
    )
    # #endregion

    # Encode annotated frame back to base64 for the frontend
    _, buffer = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
    annotated_b64 = base64.b64encode(buffer).decode("utf-8")

    return jsonify({
        "annotated_frame": f"data:image/jpeg;base64,{annotated_b64}",
        "faces": recognized,
        "face_count": len(recognized),
        "matches": [f for f in recognized if f.get("is_match")],
        "match_count": len([f for f in recognized if f.get("is_match")]),
    })


@app.route("/train", methods=["POST"])
def train_endpoint():
    """Force re-train the LBPH model from current face_samples/."""
    model, names = train_model()
    if model is None:
        return jsonify({"success": False, "message": "No training data available"}), 400
    return jsonify({
        "success": True,
        "subjects": len(names),
        "names": list(names.values()),
    })


@app.route("/recognition-status", methods=["GET"])
def recognition_status_endpoint():
    """Return current model training status."""
    status = get_recognition_status()
    return jsonify(status)


@app.route("/sync-subjects", methods=["POST"])
def sync_subjects_endpoint():
    """Force model subjects to match the provided list of names."""
    payload = request.get_json(silent=True) or {}
    names = payload.get("names") or []
    if not isinstance(names, list):
        return jsonify({"error": "names must be an array"}), 400
    result = sync_subjects_with_names(names)
    return jsonify(result)


if __name__ == "__main__":
    # Pre-train model on startup if samples exist
    print("[CCTV Pipeline] Pre-training LBPH model...")
    train_model()

    host = os.environ.get("CCTV_HOST", "127.0.0.1")
    port = int(os.environ.get("CCTV_PORT", 3600))
    debug_mode = os.environ.get("CCTV_DEBUG", "0").lower() in {"1", "true", "yes", "on"}
    max_port_attempts = int(os.environ.get("CCTV_PORT_FALLBACK_ATTEMPTS", 5))
    print(f"[CCTV Pipeline] Starting on {host}:{port}")
    print(f"[CCTV Pipeline] Detections dir: {DETECTIONS_DIR}")
    print(f"[CCTV Pipeline] Criminal DB dir: {CRIMINAL_DB_DIR}")
    selected_port = None
    for i in range(max_port_attempts):
        candidate = port + i
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, candidate))
            selected_port = candidate
            break
        except OSError as exc:
            if i < max_port_attempts - 1:
                print(f"[CCTV Pipeline] Port {candidate} unavailable ({exc}). Trying {candidate + 1}...")
            else:
                print(f"[CCTV Pipeline] Port {candidate} unavailable ({exc}).")
        finally:
            s.close()

    if selected_port is None:
        # Last-resort on Windows where an entire configured range can be blocked by policy.
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind((host, 0))
        selected_port = s.getsockname()[1]
        s.close()
        print(f"[CCTV Pipeline] Falling back to OS-assigned port {selected_port}.")

    app.run(
        host=host,
        port=selected_port,
        debug=debug_mode,
        # Disable Flask reloader by default to avoid duplicate bind races on Windows.
        use_reloader=False,
    )
