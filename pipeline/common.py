"""Shared helpers for the data pipeline: HTTP with retries, paths, JSON IO."""
from __future__ import annotations

import json
import os
import random
import time
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "pipeline" / "cache"

UA = "PersonalTradingViewer/1.0 (+https://github.com/sock-wy/Personal-Trading-Viewer)"

_session = requests.Session()
_session.headers.update({"User-Agent": UA})


def http_get(url: str, *, headers: dict | None = None, params: dict | None = None,
             retries: int = 5, timeout: float = 20.0) -> requests.Response:
    """GET with exponential backoff. Raises the last error if every attempt fails."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = _session.get(url, headers=headers, params=params, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}", response=r)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001 - network errors are varied
            last = e
            time.sleep(min(30.0, (2 ** attempt) * 0.7 + random.random()))
    assert last is not None
    raise last


def http_post_json(url: str, body: dict, *, retries: int = 5, timeout: float = 20.0) -> Any:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = _session.post(url, json=body, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}", response=r)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(30.0, (2 ** attempt) * 0.7 + random.random()))
    assert last is not None
    raise last


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj: Any, *, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def r4(x: float | None, nd: int = 4) -> float | None:
    if x is None:
        return None
    return round(float(x), nd)
