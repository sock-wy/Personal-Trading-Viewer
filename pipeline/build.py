"""Entry point used by CI: refresh every source, rebuild data/*.json and data/meta.json.

    python pipeline/build.py                 # everything
    python pipeline/build.py --only futures  # one group
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import traceback

import crypto
import futures
from common import DATA_DIR, read_json, write_json


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["futures", "crypto"])
    ap.add_argument("--skip-fetch", action="store_true", help="futures: rebuild from cache only")
    args = ap.parse_args()

    meta_path = DATA_DIR / "meta.json"
    meta = read_json(meta_path, {}) or {}
    instruments = {i["symbol"]: i for i in meta.get("instruments", [])}
    updated = dict(meta.get("updated", {}))
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    failed = []

    if args.only in (None, "futures"):
        try:
            for info in futures.run(skip_fetch=args.skip_fetch):
                instruments[info["symbol"]] = info
            updated["futures"] = now
        except Exception:  # noqa: BLE001 - keep the last good data for the other group
            traceback.print_exc()
            failed.append("futures")

    if args.only in (None, "crypto"):
        try:
            for info in crypto.run():
                instruments[info["symbol"]] = info
            updated["crypto"] = now
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            failed.append("crypto")

    order = list(futures.PRODUCTS) + list(crypto.ASSETS)
    meta = {
        "generated_at": now,
        "updated": updated,
        "groups": {
            "futures": {"label": "China Black Series", "symbols": list(futures.PRODUCTS),
                        "annualization": 244, "currency": "CNY"},
            "crypto": {"label": "Crypto", "symbols": list(crypto.ASSETS),
                       "annualization": 365, "currency": "USD"},
        },
        "instruments": [instruments[s] for s in order if s in instruments],
    }
    write_json(meta_path, meta, compact=False)
    print("[build] wrote", meta_path, "failed:", failed or "none")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
