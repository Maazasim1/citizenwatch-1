"""
Modern identity backends for CCTV recognition.

The pipeline uses lazy-loaded state-of-the-art identity backends when their
dependencies are present:
  - InsightFace ArcFace embeddings for face identity.
  - OSNet person ReID embeddings through torchreid for non-frontal/no-face cases.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np


ARCFACE_MODEL_NAME = os.environ.get("FACE_MODEL_NAME", "buffalo_l")
# Prefer CUDA by default when available; can still be overridden via FACE_MODEL_PROVIDER.
ARCFACE_PROVIDER = os.environ.get("FACE_MODEL_PROVIDER", "CUDAExecutionProvider")
ARCFACE_DET_SIZE = int(os.environ.get("FACE_MODEL_DET_SIZE", "640"))

REID_MODEL_NAME = os.environ.get("REID_MODEL_NAME", "osnet_x1_0")
REID_IMAGE_WIDTH = 128
REID_IMAGE_HEIGHT = 256

_face_app = None
_face_app_error: Optional[str] = None
_reid_model = None
_reid_torch = None
_reid_device = None
_reid_error: Optional[str] = None


@dataclass
class IdentityEmbedding:
    vector: np.ndarray
    model: str


def _l2_normalize(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    if norm == 0:
        return vector.astype(np.float32)
    return (vector / norm).astype(np.float32)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    if a is None or b is None:
        return 0.0
    if a.shape != b.shape:
        return 0.0
    dot = np.dot(a, b)
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(dot / (na * nb))


def _get_face_app():
    global _face_app, _face_app_error
    if _face_app is not None or _face_app_error is not None:
        return _face_app

    try:
        from insightface.app import FaceAnalysis

        # Default to GPU (ctx_id=0) when CUDA provider is requested. ctx_id=-1 forces CPU.
        default_ctx_id = "0" if "CUDAExecutionProvider" in ARCFACE_PROVIDER else "-1"
        ctx_id = int(os.environ.get("FACE_MODEL_CTX_ID", default_ctx_id))

        providers = [ARCFACE_PROVIDER]
        if "CUDAExecutionProvider" in ARCFACE_PROVIDER and "CPUExecutionProvider" not in providers:
            providers.append("CPUExecutionProvider")

        app = FaceAnalysis(name=ARCFACE_MODEL_NAME, providers=providers)
        app.prepare(ctx_id=ctx_id, det_size=(ARCFACE_DET_SIZE, ARCFACE_DET_SIZE))
        print(f"[IdentityModels] InsightFace ready providers={providers} ctx_id={ctx_id}")
        _face_app = app
    except Exception as exc:  # pragma: no cover - depends on optional model packages/downloads.
        _face_app_error = str(exc)
        print(f"[IdentityModels] InsightFace init failed: {exc}")
        _face_app = None
    return _face_app


def compute_arcface_embedding(image_bgr: np.ndarray) -> Optional[IdentityEmbedding]:
    """Return the largest detected face's ArcFace embedding, if available."""
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return None

    app = _get_face_app()
    if app is None:
        return None

    try:
        faces = app.get(image_bgr)
    except Exception as exc:  # pragma: no cover - runtime backend failure.
        global _face_app_error
        _face_app_error = str(exc)
        return None

    if not faces:
        return None

    largest = max(
        faces,
        key=lambda f: max(0.0, float(f.bbox[2] - f.bbox[0])) * max(0.0, float(f.bbox[3] - f.bbox[1])),
    )
    embedding = getattr(largest, "normed_embedding", None)
    if embedding is None:
        embedding = getattr(largest, "embedding", None)
    if embedding is None:
        return None

    return IdentityEmbedding(vector=_l2_normalize(np.asarray(embedding, dtype=np.float32)), model=f"insightface:{ARCFACE_MODEL_NAME}")


def detect_arcface_faces(image_bgr: np.ndarray) -> list:
    """Return all faces detected by ArcFace with bbox + embedding in one pass.

    This avoids running Haar then ArcFace separately for every face.
    Each item: {"bbox": (x, y, w, h), "embedding": IdentityEmbedding}
    """
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return []
    app = _get_face_app()
    if app is None:
        return []
    try:
        faces = app.get(image_bgr)
    except Exception as exc:  # pragma: no cover
        global _face_app_error
        _face_app_error = str(exc)
        return []

    out = []
    for f in faces:
        try:
            x1, y1, x2, y2 = [int(v) for v in f.bbox]
        except Exception:
            continue
        bx, by, bw, bh = x1, y1, max(0, x2 - x1), max(0, y2 - y1)
        if bw <= 0 or bh <= 0:
            continue
        emb = getattr(f, "normed_embedding", None)
        if emb is None:
            emb = getattr(f, "embedding", None)
        if emb is None:
            continue
        out.append({
            "bbox": (bx, by, bw, bh),
            "score": float(getattr(f, "det_score", 0.0)),
            "embedding": IdentityEmbedding(
                vector=_l2_normalize(np.asarray(emb, dtype=np.float32)),
                model=f"insightface:{ARCFACE_MODEL_NAME}",
            ),
        })
    return out


def _get_reid_model():
    global _reid_model, _reid_torch, _reid_device, _reid_error
    if _reid_model is not None or _reid_error is not None:
        return _reid_model

    try:
        import torch
        import torchreid

        requested_device = os.environ.get("REID_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
        if requested_device == "cuda" and not torch.cuda.is_available():
            requested_device = "cpu"

        model = torchreid.models.build_model(
            name=REID_MODEL_NAME,
            num_classes=1000,
            loss="softmax",
            pretrained=True,
        )
        model.to(requested_device)
        model.eval()

        _reid_torch = torch
        _reid_device = requested_device
        _reid_model = model
        print(f"[IdentityModels] OSNet ReID ready model={REID_MODEL_NAME} device={requested_device}")
    except Exception as exc:  # pragma: no cover - depends on optional model packages/downloads.
        _reid_error = str(exc)
        print(f"[IdentityModels] OSNet ReID init failed: {exc}")
        _reid_model = None
    return _reid_model


def compute_reid_embedding(image_bgr: np.ndarray) -> Optional[IdentityEmbedding]:
    """Return an OSNet person ReID embedding for a full-body crop, if available."""
    if image_bgr is None or getattr(image_bgr, "size", 0) == 0:
        return None

    model = _get_reid_model()
    if model is None or _reid_torch is None:
        return None

    try:
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (REID_IMAGE_WIDTH, REID_IMAGE_HEIGHT))
        tensor = _reid_torch.from_numpy(resized).permute(2, 0, 1).float() / 255.0
        mean = _reid_torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
        std = _reid_torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
        tensor = ((tensor - mean) / std).unsqueeze(0).to(_reid_device)

        with _reid_torch.no_grad():
            features = model(tensor)
        if isinstance(features, (tuple, list)):
            features = features[0]
        vector = features.detach().cpu().numpy().reshape(-1).astype(np.float32)
        return IdentityEmbedding(vector=_l2_normalize(vector), model=f"torchreid:{REID_MODEL_NAME}")
    except Exception as exc:  # pragma: no cover - runtime backend failure.
        global _reid_error
        _reid_error = str(exc)
        return None


def get_identity_backend_status(load: bool = False) -> dict:
    """Expose backend availability without forcing callers to know optional imports."""
    face_ready = (_get_face_app() is not None) if load else (_face_app is not None)
    reid_ready = (_get_reid_model() is not None) if load else (_reid_model is not None)
    return {
        "face_embedding": {
            "backend": f"insightface:{ARCFACE_MODEL_NAME}",
            "available": face_ready,
            "loaded": _face_app is not None,
            "error": _face_app_error,
        },
        "person_reid": {
            "backend": f"torchreid:{REID_MODEL_NAME}",
            "available": reid_ready,
            "loaded": _reid_model is not None,
            "error": _reid_error,
        },
    }
