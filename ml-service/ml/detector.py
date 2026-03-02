from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import numpy as np


@dataclass
class Detection:
    bbox: List[float]  # [x1, y1, x2, y2]
    conf: float


class YoloV8HeadVehicleDetector:
    """YOLOv8 CPU wrapper for person + vehicle + head-proxy detection."""

    COCO_PERSON_CLASS = 0
    COCO_VEHICLE_CLASSES = (1, 2, 3, 5, 7)  # bicycle, car, motorcycle, bus, truck

    def __init__(
        self,
        model_name: str = "yolov8n.pt",
        conf_threshold: float = 0.25,
        include_person: bool = True,
        include_vehicle: bool = True,
        include_head_proxy: bool = True,
        head_box_height_ratio: float = 0.35,
        head_box_width_ratio: float = 0.60,
    ):
        self.model_name = model_name
        self.conf_threshold = float(conf_threshold)
        self.include_person = bool(include_person)
        self.include_vehicle = bool(include_vehicle)
        self.include_head_proxy = bool(include_head_proxy)
        self.head_box_height_ratio = float(head_box_height_ratio)
        self.head_box_width_ratio = float(head_box_width_ratio)
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

    def _target_classes(self) -> List[int]:
        classes: List[int] = []
        if self.include_person:
            classes.append(self.COCO_PERSON_CLASS)
        if self.include_vehicle:
            classes.extend(self.COCO_VEHICLE_CLASSES)
        return classes

    @staticmethod
    def _vehicle_name(class_id: int) -> str:
        return {
            1: "bicycle",
            2: "car",
            3: "motorcycle",
            5: "bus",
            7: "truck",
        }.get(class_id, "vehicle")

    def _head_bbox_from_person(
        self, bbox: List[float], frame_width: int, frame_height: int
    ) -> List[float]:
        x1, y1, x2, y2 = [float(v) for v in bbox]
        w = max(1.0, x2 - x1)
        h = max(1.0, y2 - y1)
        cx = 0.5 * (x1 + x2)

        head_w = max(4.0, w * self.head_box_width_ratio)
        head_h = max(4.0, h * self.head_box_height_ratio)

        hx1 = max(0.0, cx - 0.5 * head_w)
        hx2 = min(float(frame_width - 1), cx + 0.5 * head_w)
        hy1 = max(0.0, y1)
        hy2 = min(float(frame_height - 1), y1 + head_h)
        return [hx1, hy1, hx2, hy2]

    def detect(self, frame_bgr: np.ndarray) -> List[Dict[str, float | List[float]]]:
        if not self.available or self._model is None:
            return []

        target_classes = self._target_classes()
        if not target_classes:
            return []

        try:
            results = self._model.predict(
                source=frame_bgr,
                device="cpu",
                classes=target_classes,
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
        classes = boxes.cls.cpu().numpy() if boxes.cls is not None else np.empty((0,))
        frame_h, frame_w = frame_bgr.shape[:2]

        for i in range(len(xyxy)):
            x1, y1, x2, y2 = xyxy[i].tolist()
            conf = float(confs[i]) if i < len(confs) else 0.0
            class_id = int(classes[i]) if i < len(classes) else -1

            label = "unknown"
            class_name = "unknown"
            if class_id == self.COCO_PERSON_CLASS:
                label = "person"
                class_name = "person"
            elif class_id in self.COCO_VEHICLE_CLASSES:
                label = "vehicle"
                class_name = self._vehicle_name(class_id)

            det: Dict[str, float | int | str | List[float]] = {
                "bbox": [x1, y1, x2, y2],
                "conf": conf,
                "label": label,
                "classId": class_id,
                "className": class_name,
            }
            parsed.append(det)

            if self.include_head_proxy and class_id == self.COCO_PERSON_CLASS:
                head_bbox = self._head_bbox_from_person(
                    [x1, y1, x2, y2],
                    frame_width=frame_w,
                    frame_height=frame_h,
                )
                parsed.append(
                    {
                        "bbox": head_bbox,
                        "conf": conf,
                        "label": "head",
                        "classId": -1,
                        "className": "head_proxy",
                    }
                )

        return parsed


class YoloV8PersonDetector(YoloV8HeadVehicleDetector):
    """Backward-compatible detector that only returns person boxes."""

    def __init__(self, model_name: str = "yolov8n.pt", conf_threshold: float = 0.25):
        super().__init__(
            model_name=model_name,
            conf_threshold=conf_threshold,
            include_person=True,
            include_vehicle=False,
            include_head_proxy=False,
        )
