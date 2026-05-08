"""
YOLOv8 Person Detection Module
Runs YOLOv8 on images/video frames to detect persons and crop them out.
"""

import os
import uuid
import cv2
import numpy as np
from pathlib import Path

# Global model reference (lazy-loaded)
_model = None

DETECTIONS_DIR = os.path.join(os.path.dirname(__file__), "detections")
os.makedirs(DETECTIONS_DIR, exist_ok=True)


def get_model():
    """Lazy-load YOLOv8 model. Downloads yolov8n.pt on first run (~6MB)."""
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO("yolov8n.pt")  # nano model for speed on CPU
    return _model


def detect_person_boxes_in_frame(frame, confidence_threshold: float = 0.4):
    """
    Run YOLOv8 person detection on an in-memory frame.
    Returns person boxes without writing crops to disk.
    """
    if frame is None or getattr(frame, "size", 0) == 0:
        return []

    model = get_model()
    results = model(frame, verbose=False)
    detections = []

    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue

        for box in boxes:
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            if cls_id != 0 or conf < confidence_threshold:
                continue

            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            h, w = frame.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if x2 <= x1 or y2 <= y1:
                continue

            detections.append({
                "confidence": round(conf, 4),
                "bounding_box": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
            })

    return detections


def detect_persons_in_image(image_path: str, confidence_threshold: float = 0.4):
    """
    Run YOLOv8 person detection on a single image.
    Returns list of detection dicts with bounding boxes and cropped person images.
    """
    model = get_model()
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Could not read image: {image_path}", "detections": []}

    results = model(img, verbose=False)
    detections = []

    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue

        for i, box in enumerate(boxes):
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])

            # Class 0 = person in COCO dataset
            if cls_id != 0 or conf < confidence_threshold:
                continue

            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())

            # Clamp to image bounds
            h, w = img.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)

            # Crop person region
            crop = img[y1:y2, x1:x2]
            if crop.size == 0:
                continue

            # Save cropped person image
            crop_id = str(uuid.uuid4())[:8]
            crop_filename = f"person_{crop_id}.jpg"
            crop_path = os.path.join(DETECTIONS_DIR, crop_filename)
            cv2.imwrite(crop_path, crop)

            detections.append({
                "id": crop_id,
                "confidence": round(conf, 4),
                "bounding_box": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                "crop_path": crop_path,
                "crop_filename": crop_filename,
            })

    return {
        "source": os.path.basename(image_path),
        "total_persons": len(detections),
        "detections": detections,
    }


def detect_persons_in_video(video_path: str, sample_every_n_frames: int = 30,
                             confidence_threshold: float = 0.4, max_frames: int = 300):
    """
    Run YOLOv8 person detection on video frames (sampled every N frames).
    Returns aggregated list of detections across all sampled frames.
    """
    model = get_model()
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": f"Could not open video: {video_path}", "detections": []}

    all_detections = []
    frame_idx = 0
    processed = 0

    while True:
        ret, frame = cap.read()
        if not ret or processed >= max_frames:
            break

        if frame_idx % sample_every_n_frames == 0:
            results = model(frame, verbose=False)

            for result in results:
                boxes = result.boxes
                if boxes is None:
                    continue

                for box in boxes:
                    cls_id = int(box.cls[0])
                    conf = float(box.conf[0])

                    if cls_id != 0 or conf < confidence_threshold:
                        continue

                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    h, w = frame.shape[:2]
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(w, x2), min(h, y2)

                    crop = frame[y1:y2, x1:x2]
                    if crop.size == 0:
                        continue

                    crop_id = str(uuid.uuid4())[:8]
                    crop_filename = f"person_{crop_id}.jpg"
                    crop_path = os.path.join(DETECTIONS_DIR, crop_filename)
                    cv2.imwrite(crop_path, crop)

                    all_detections.append({
                        "id": crop_id,
                        "frame_index": frame_idx,
                        "confidence": round(conf, 4),
                        "bounding_box": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                        "crop_path": crop_path,
                        "crop_filename": crop_filename,
                    })

            processed += 1

        frame_idx += 1

    cap.release()

    return {
        "source": os.path.basename(video_path),
        "frames_processed": processed,
        "total_persons": len(all_detections),
        "detections": all_detections,
    }
