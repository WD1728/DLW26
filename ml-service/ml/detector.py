from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import numpy as np


@dataclass
class Detection:
    bbox: List[float]  # [x1, y1, x2, y2]
    conf: float


class YoloV8PersonDetector:
    """YOLOv8n CPU wrapper that fails gracefully when unavailable."""

    def __init__(self, model_name: str = "yolov8n.pt", conf_threshold: float = 0.25):
        self.model_name = model_name
        self.conf_threshold = float(conf_threshold)
        self.available = False
        self.reason = ""
        self._model = None

        try:
            from ultralytics import YOLO  # pylint: disable=import-outside-toplevel
        except Exception as exc:  # pragma: no cover
            self.reason = f"ultralytics unavailable: {exc}"
            return

        try:
            self._model = YOLO(model_name)
            self.available = True
        except Exception as exc:  # pragma: no cover
            self.reason = f"model load failed: {exc}"
            self._model = None
            self.available = False

    def detect(self, frame_bgr: np.ndarray) -> List[Dict[str, float | List[float]]]:
        if not self.available or self._model is None:
            return []

        try:
            results = self._model.predict(
                source=frame_bgr,
                device="cpu",
                classes=[0],  # person class
                conf=self.conf_threshold,
                verbose=False,
            )
        except Exception as exc:  # pragma: no cover
            self.reason = f"inference failed: {exc}"
            self.available = False
            return []

        if not results:
            return []

        parsed: List[Dict[str, float | List[float]]] = []
        boxes = results[0].boxes
        if boxes is None:
            return parsed

        xyxy = boxes.xyxy.cpu().numpy() if boxes.xyxy is not None else np.empty((0, 4))
        confs = boxes.conf.cpu().numpy() if boxes.conf is not None else np.empty((0,))

        for i in range(len(xyxy)):
            x1, y1, x2, y2 = xyxy[i].tolist()
            conf = float(confs[i]) if i < len(confs) else 0.0
            parsed.append({"bbox": [x1, y1, x2, y2], "conf": conf})

        return parsed
