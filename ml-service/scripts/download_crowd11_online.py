#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Tuple

import requests


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Crowd-11 online sources (pond5/youtube/gettyimages) from web_urls.csv."
    )
    parser.add_argument("--csv", required=True, help="Path to web_urls.csv")
    parser.add_argument("--out-root", required=True, help="Output root where source folders are created")
    parser.add_argument(
        "--sources",
        default="pond5",
        help="Comma-separated sources to download (default: pond5). Example: pond5,youtube",
    )
    parser.add_argument("--max-files", type=int, default=0, help="Optional cap on number of files (0=all)")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=2)
    return parser.parse_args()


def _read_rows(csv_path: Path, allowed_sources: set[str], max_files: int) -> List[Tuple[str, str, str]]:
    rows: List[Tuple[str, str, str]] = []
    with csv_path.open("r", encoding="utf-8", errors="ignore") as f:
        reader = csv.reader(f)
        for row in reader:
            if not row or len(row) < 3:
                continue
            source = row[0].strip().lower()
            url = row[1].strip()
            name = row[2].strip()
            if source not in allowed_sources:
                continue
            if not url.startswith("http"):
                continue
            if not name:
                continue
            rows.append((source, url, name))
            if max_files > 0 and len(rows) >= max_files:
                break
    return rows


def _download_one(
    source: str,
    url: str,
    name: str,
    out_root: Path,
    timeout: int,
    retries: int,
) -> Tuple[str, str, str]:
    out_dir = out_root / source
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / name

    if out_path.exists() and out_path.stat().st_size > 0:
        return ("skip", source, name)

    headers = {"User-Agent": "Mozilla/5.0"}
    attempt = 0
    while attempt <= retries:
        attempt += 1
        try:
            with requests.get(url, stream=True, timeout=timeout, headers=headers) as resp:
                if resp.status_code != 200:
                    if attempt <= retries:
                        continue
                    return ("fail", source, f"{name} status={resp.status_code}")
                tmp_path = out_path.with_suffix(out_path.suffix + ".part")
                with tmp_path.open("wb") as f:
                    for chunk in resp.iter_content(chunk_size=1024 * 64):
                        if chunk:
                            f.write(chunk)
                os.replace(tmp_path, out_path)
                return ("ok", source, name)
        except Exception as exc:
            if attempt > retries:
                return ("fail", source, f"{name} err={exc}")
    return ("fail", source, f"{name} unknown")


def main() -> None:
    args = parse_args()
    csv_path = Path(args.csv)
    out_root = Path(args.out_root)
    out_root.mkdir(parents=True, exist_ok=True)

    sources = {s.strip().lower() for s in args.sources.split(",") if s.strip()}
    if not sources:
        raise ValueError("No sources selected")

    rows = _read_rows(csv_path, sources, args.max_files)
    if not rows:
        raise RuntimeError(f"No matching rows found in {csv_path} for sources={sorted(sources)}")

    lock = threading.Lock()
    counts: Dict[str, int] = {"ok": 0, "skip": 0, "fail": 0}
    per_source: Dict[str, Dict[str, int]] = {}
    failures: List[str] = []

    for source in sources:
        per_source[source] = {"ok": 0, "skip": 0, "fail": 0}

    def _record(result: Tuple[str, str, str]) -> None:
        status, source, info = result
        with lock:
            counts[status] += 1
            per_source.setdefault(source, {"ok": 0, "skip": 0, "fail": 0})
            per_source[source][status] += 1
            if status == "fail":
                failures.append(f"{source},{info}")
            done = counts["ok"] + counts["skip"] + counts["fail"]
            if done % 25 == 0 or done == len(rows):
                print(
                    f"[progress] {done}/{len(rows)} "
                    f"ok={counts['ok']} skip={counts['skip']} fail={counts['fail']}"
                )

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futures = [
            ex.submit(
                _download_one,
                source=source,
                url=url,
                name=name,
                out_root=out_root,
                timeout=args.timeout,
                retries=args.retries,
            )
            for source, url, name in rows
        ]
        for fut in as_completed(futures):
            _record(fut.result())

    print("[done] total:", len(rows))
    print("[done] summary:", counts)
    print("[done] per_source:", per_source)

    if failures:
        fail_path = out_root / "download_failures.txt"
        fail_path.write_text("\n".join(failures), encoding="utf-8")
        print(f"[done] failures written: {fail_path}")


if __name__ == "__main__":
    main()
