#!/usr/bin/env python3
"""Generate bitmap icon candidates through the Friday AIGC gateway.

Usage:
  python3 .gen/generate.py --only A1
  python3 .gen/generate.py --dir A
  python3 .gen/generate.py --all

The script reads .gen/prompts.json, submits imageGenerate jobs (at most
--workers concurrent), polls imageGenerateQuery, downloads the result and
normalizes it to a 1024x1024 PNG under raw/.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image, ImageOps

APPID = os.environ.get("AIGC_APPID", "")
BASE = os.environ.get("AIGC_BASE", "https://aigc.sankuai.com")
DEFAULT_MODEL = "gemini-3.1-flash-image"

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw"
GEN = ROOT / ".gen"
LOG = GEN / "results.jsonl"
RAW.mkdir(parents=True, exist_ok=True)


def _request(url: str, payload: dict | None = None, method: str = "GET", timeout: int = 300) -> str:
    if not APPID:
        raise RuntimeError("set AIGC_APPID before generating images")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": "Bearer " + APPID,
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def submit(prompt: str, seed: int, model: str) -> str:
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "seed": seed,
            "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"},
        },
    }
    for attempt in range(1, 7):
        try:
            out = _request(f"{BASE}/v1/google/models/{model}:imageGenerate", payload, "POST").strip()
            if out and not out.startswith("{"):
                return out
            raise RuntimeError(f"unexpected submit response: {out[:500]}")
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code == 429 and attempt < 6:
                wait = 12 * attempt
                print(f"  429 rate limited, retry in {wait}s", flush=True)
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code}: {body}") from e
        except Exception:
            if attempt < 6:
                time.sleep(5 * attempt)
                continue
            raise
    raise RuntimeError("submit exhausted")


def wait(op: str, interval: float = 5.0, max_tries: int = 60) -> str:
    url = f"{BASE}/v1/google/models/{op}:imageGenerateQuery"
    for _ in range(max_tries):
        j = json.loads(_request(url, timeout=120))
        status = j.get("status")
        if status == 1:
            for cand in j["data"]["candidates"]:
                for part in cand["content"]["parts"]:
                    if "inlineData" in part:
                        return part["inlineData"]["data"]
            raise RuntimeError(f"success but no inlineData: {json.dumps(j)[:1000]}")
        if status == -1:
            raise RuntimeError(f"generation failed: {j.get('data')}")
        time.sleep(interval)
    raise TimeoutError(f"poll timeout: {op}")


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=180) as r:
        return r.read()


def normalize(raw: bytes, dst: Path) -> tuple[int, int]:
    from io import BytesIO
    im = Image.open(BytesIO(raw))
    im.load()
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    # Gemini returns a square-ish image; fit exactly 1024 without distortion.
    if im.width != 1024 or im.height != 1024:
        im = ImageOps.fit(im, (1024, 1024), method=Image.LANCZOS, centering=(0.5, 0.5))
    im.save(dst, "PNG")
    return im.size


def run_one(item: dict, model: str) -> dict:
    tid = item["id"]
    started = time.time()
    print(f"[{tid}] submit: {item['title']}", flush=True)
    op = submit(item["prompt"], int(item.get("seed", 0)), model)
    print(f"[{tid}] operationId: {op}", flush=True)
    url = wait(op)
    raw = download(url)
    dst = RAW / f"{tid}.png"
    size = normalize(raw, dst)
    rec = {
        "id": tid,
        "dir": item.get("dir"),
        "title": item.get("title"),
        "seed": item.get("seed"),
        "model": model,
        "operationId": op,
        "url": url,
        "file": str(dst.relative_to(ROOT)),
        "size": list(size),
        "elapsed": round(time.time() - started, 1),
    }
    print(f"[{tid}] saved {dst} {size} in {rec['elapsed']}s", flush=True)
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=[], help="ids, e.g. A1 B2")
    ap.add_argument("--dir", default="", help="A, B or C")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    items = json.loads((GEN / "prompts.json").read_text())
    if args.only:
        wanted = set(args.only)
        items = [x for x in items if x["id"] in wanted]
    elif args.dir:
        items = [x for x in items if x.get("dir") == args.dir]
    elif not args.all:
        ap.error("choose --only, --dir or --all")

    missing = [x["id"] for x in items if not (RAW / f"{x['id']}.png").exists()]
    todo = [x for x in items if x["id"] in missing]
    print(f"items={len(items)} existing={len(items)-len(todo)} todo={len(todo)} model={args.model}", flush=True)

    records = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(run_one, x, args.model): x for x in todo}
        for fut in as_completed(futs):
            item = futs[fut]
            try:
                rec = fut.result()
                records.append(rec)
                with LOG.open("a") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            except Exception as e:
                print(f"[{item['id']}] FAILED: {e}", flush=True)
                with LOG.open("a") as f:
                    f.write(json.dumps({"id": item["id"], "error": str(e)}, ensure_ascii=False) + "\n")

    print(f"done ok={len(records)} fail={len(todo)-len(records)}", flush=True)
    return 0 if len(records) == len(todo) else 1


if __name__ == "__main__":
    sys.exit(main())
