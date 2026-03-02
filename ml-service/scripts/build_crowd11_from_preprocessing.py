#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from moviepy import VideoFileClip


LABEL_TO_CLASS = {
    0: "laminar_flow",
    1: "turbulent_flow",
    2: "crossing_flows",
    3: "merging_flow",
    4: "diverging_flow",
    5: "gas_free",
    6: "gas_jammed",
    7: "static_calm",
    8: "static_agitated",
    9: "interacting_crowd",
    10: "no_crowd",
}


@dataclass(frozen=True)
class ClipSpec:
    video_name: str
    label: int
    start_frame: int
    end_frame: int
    left_distance: float
    top_distance: float
    width: float
    height: float
    dataset: str
    scene_number: str
    crop_number: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build Crowd-11 class clips from preprocessing.csv and downloaded VOI videos. "
            "Only rows whose source videos exist are processed."
        )
    )
    parser.add_argument("--preprocessing-csv", required=True)
    parser.add_argument("--voi-root", required=True, help="VOI root containing source folders (e.g., VOI/pond5)")
    parser.add_argument("--out-root", required=True, help="Output class-folder root (crowd11_raw)")
    parser.add_argument("--sources", default="pond5", help="Comma-separated sources to include")
    parser.add_argument("--max-clips", type=int, default=0, help="Optional max clips to build (0=all available)")
    parser.add_argument("--max-clips-per-video", type=int, default=0, help="Optional cap per source video")
    return parser.parse_args()


def _read_specs(path: Path, allowed_sources: set[str]) -> List[ClipSpec]:
    specs: List[ClipSpec] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        reader = csv.reader(f, delimiter=";")
        for row in reader:
            if not row or len(row) < 11:
                continue
            dataset = row[8].strip().lower()
            if dataset not in allowed_sources:
                continue
            try:
                specs.append(
                    ClipSpec(
                        video_name=row[0].strip(),
                        label=int(row[1]),
                        start_frame=int(float(row[2])),
                        end_frame=int(float(row[3])),
                        left_distance=float(row[4]),
                        top_distance=float(row[5]),
                        width=float(row[6]),
                        height=float(row[7]),
                        dataset=dataset,
                        scene_number=row[9].strip(),
                        crop_number=str(int(float(row[10]))),
                    )
                )
            except Exception:
                continue
    return specs


def main() -> None:
    args = parse_args()
    csv_path = Path(args.preprocessing_csv)
    voi_root = Path(args.voi_root)
    out_root = Path(args.out_root)
    out_root.mkdir(parents=True, exist_ok=True)

    allowed_sources = {s.strip().lower() for s in args.sources.split(",") if s.strip()}
    specs = _read_specs(csv_path, allowed_sources)
    if not specs:
        raise RuntimeError(f"No matching rows found in {csv_path} for sources={sorted(allowed_sources)}")

    by_video: Dict[Tuple[str, str], List[ClipSpec]] = defaultdict(list)
    for spec in specs:
        by_video[(spec.dataset, spec.video_name)].append(spec)

    built = 0
    skipped_missing_video = 0
    skipped_existing = 0
    failed = 0

    for (dataset, video_name), rows in by_video.items():
        src_video = voi_root / dataset / video_name
        if not src_video.exists():
            skipped_missing_video += len(rows)
            continue

        # Deterministic ordering for reproducibility.
        rows = sorted(rows, key=lambda x: (x.start_frame, x.end_frame, x.scene_number, x.crop_number))
        if args.max_clips_per_video > 0:
            rows = rows[: int(args.max_clips_per_video)]

        try:
            clip = VideoFileClip(str(src_video))
            fps = float(clip.fps) if clip.fps else 25.0
            for spec in rows:
                if args.max_clips > 0 and built >= args.max_clips:
                    break

                class_name = LABEL_TO_CLASS.get(spec.label, f"class_{spec.label}")
                out_dir = out_root / class_name
                out_dir.mkdir(parents=True, exist_ok=True)
                out_name = f"{class_name}__{spec.scene_number}_{spec.crop_number}_{spec.video_name}"
                out_path = out_dir / out_name
                if out_path.exists() and out_path.stat().st_size > 0:
                    skipped_existing += 1
                    continue

                try:
                    start_t = max(0.0, float(spec.start_frame) / fps)
                    end_t = max(start_t + 0.04, float(spec.end_frame) / fps)
                    sub = clip.subclipped(start_t, end_t)

                    x1 = spec.left_distance * sub.w
                    y1 = spec.top_distance * sub.h
                    w = spec.width * sub.w
                    h = spec.height * sub.h
                    cropped = sub.cropped(x1=x1, y1=y1, width=w, height=h)

                    cropped.write_videofile(
                        str(out_path),
                        codec="libx264",
                        audio=False,
                        logger=None,
                        fps=fps,
                    )
                    built += 1
                except Exception:
                    failed += 1
            clip.close()
        except Exception:
            failed += len(rows)

        if built % 50 == 0 and built > 0:
            print(
                f"[progress] built={built} "
                f"missing_video={skipped_missing_video} existing={skipped_existing} failed={failed}"
            )

        if args.max_clips > 0 and built >= args.max_clips:
            break

    print(
        f"[done] built={built} missing_video={skipped_missing_video} "
        f"existing={skipped_existing} failed={failed}"
    )
    print(f"[done] output root: {out_root}")


if __name__ == "__main__":
    main()
