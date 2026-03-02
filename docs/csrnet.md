# CSRNet Integration

This project integrates CSRNet as a third-party module under:

- `third_party/csrnet` (vendored from `https://github.com/leeyeehoo/CSRNet-pytorch`)

The original training entry from CSRNet repo is:

- `python train.py train.json val.json [--pre ...] [gpu] [task]`

This remains available at:

- `third_party/csrnet/train.py`

## 1) Install Dependencies

```bash
python -m pip install -r requirements-csrnet.txt
```

## 2) Weights Convention

Default expected path:

- `assets/weights/csrnet_shanghaitechA.pth`

If you do not have a ready checkpoint:

1. Train with CSRNet training script:
   - `python third_party/csrnet/train.py third_party/csrnet/part_A_train.json third_party/csrnet/part_A_val.json 0 csrnet_`
2. Copy the generated checkpoint to:
   - `assets/weights/csrnet_shanghaitechA.pth`
   - or pass a custom path to wrapper/demo with `--weights`.

## 3) Wrapper API

Wrapper file:

- `crowd_counting/csrnet_wrapper.py`

Class:

- `CSRNetCounter(weights_path: str, device: str = "cuda")`

Methods:

- `predict_density(frame_bgr: np.ndarray) -> np.ndarray`
  - Returns CSRNet density map `[H', W']` (usually input size downsampled by 8).
- `predict_count(frame_bgr: np.ndarray, roi_polygon: list[tuple[int,int]] | None = None) -> float`
  - If `roi_polygon` is provided, density is integrated only inside ROI.
  - If not provided, full-image count is returned.

Robustness checks:

- Missing weights file raises clear error with path and placement hint.
- Device fallback:
  - `device="cuda"` falls back to CPU when CUDA is unavailable.
  - `device="auto"` picks CUDA if available else CPU.

## 4) Demo Script

Script:

- `scripts/csrnet_infer_demo.py`

Example (single image):

```bash
python scripts/csrnet_infer_demo.py \
  --image path/to/image.jpg \
  --weights assets/weights/csrnet_shanghaitechA.pth \
  --roi "120,100;600,100;650,500;90,500" \
  --show-heatmap \
  --save artifacts/csrnet_demo.jpg
```

Example (camera):

```bash
python scripts/csrnet_infer_demo.py \
  --camera 0 \
  --weights assets/weights/csrnet_shanghaitechA.pth \
  --roi "120,100;600,100;650,500;90,500" \
  --show-heatmap \
  --save artifacts/csrnet_demo.mp4
```

The demo overlays:

- `count`
- `roi_count`
- `fps`

and draws ROI polygon. Heatmap overlay is optional.

## 5) Minimal Main-Loop Integration

```python
from crowd_counting.csrnet_wrapper import CSRNetCounter

counter = CSRNetCounter("assets/weights/csrnet_shanghaitechA.pth", device="auto")

while True:
    # frame: OpenCV BGR frame
    density_map = counter.predict_density(frame)
    roi_count = counter.predict_count_from_density(
        density_map,
        frame_shape_hw=frame.shape[:2],
        roi_polygon=roi_polygon,  # [(x1,y1),...]
    )

    density_ppm2 = roi_count / area_m2_est  # from your area estimator
    if density_ppm2 > 6:
        risk_level = "extreme"
    elif density_ppm2 > 4:
        risk_level = "high_risk"
    elif density_ppm2 >= 2:
        risk_level = "crowded"
    else:
        risk_level = "safe"
```

## 6) Notes

- `third_party/csrnet` is kept isolated to avoid polluting existing project modules.
- Compatibility updates were applied to make CSRNet code runnable on Python 3.10+ and PyTorch 2.x without changing the model architecture.
