"""Crypto: Coinbase spot candles + Hyperliquid perpetual funding + Wikipedia pageviews.

All three sources are reachable from US-hosted CI runners (Binance / OKX geo-block US IPs).
"""
from __future__ import annotations

import datetime as dt
import sys
import time
import urllib.parse

from common import CACHE_DIR, DATA_DIR, http_get, http_post_json, r4, read_json, write_json

ASSETS = {
    "BTC": {"name": "Bitcoin", "product": "BTC-USD", "wiki": "Bitcoin", "start": "2017-01-01"},
    "ETH": {"name": "Ethereum", "product": "ETH-USD", "wiki": "Ethereum", "start": "2017-01-01"},
    "SOL": {"name": "Solana", "product": "SOL-USD", "wiki": "Solana (blockchain platform)", "start": "2021-06-17"},
}
HOURLY_START = "2023-01-01"
CB = "https://api.exchange.coinbase.com/products/{p}/candles"
HL = "https://api.hyperliquid.xyz/info"
WIKI = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
        "{article}/daily/{start}/{end}")

CACHE = CACHE_DIR / "crypto"


def _ts(d: str) -> int:
    return int(dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc).timestamp())


def fetch_candles(product: str, gran: int, start: int, end: int) -> dict[int, list]:
    """Coinbase returns at most 300 candles per call: [time, low, high, open, close, volume]."""
    out: dict[int, list] = {}
    step = 300 * gran
    t = start
    while t < end:
        t2 = min(t + step, end)
        params = {"granularity": gran,
                  "start": dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(),
                  "end": dt.datetime.fromtimestamp(t2, dt.timezone.utc).isoformat()}
        rows = http_get(CB.format(p=product), params=params).json()
        for ts, lo, hi, op, cl, vol in rows:
            out[int(ts)] = [int(ts), op, hi, lo, cl, vol]
        t = t2
        time.sleep(0.12)  # stay well under the public rate limit
    return out


def update_candles(sym: str, gran: int, first: str, now: int) -> list[list]:
    path = CACHE / f"{sym}_{'1d' if gran == 86400 else '1h'}.json"
    cached = {int(r[0]): r for r in (read_json(path, []) or [])}
    start = _ts(first)
    if cached:
        start = max(cached) - 3 * gran  # re-fetch the last few bars (the latest one is still forming)
    fresh = fetch_candles(ASSETS[sym]["product"], gran, start, now)
    cached.update(fresh)
    rows = [cached[k] for k in sorted(cached)]
    # drop the still-forming bar
    rows = [r for r in rows if r[0] + gran <= now]
    write_json(path, rows)
    return rows


def update_funding(sym: str, now_ms: int) -> dict[int, float]:
    """Hourly funding rate of the Hyperliquid perpetual (history starts 2023-05)."""
    path = CACHE / f"{sym}_funding.json"
    cached = {int(k): v for k, v in (read_json(path, {}) or {}).items()}
    start = (max(cached) + 1) if cached else _ts("2023-05-01") * 1000
    for _ in range(200):
        if start >= now_ms:
            break
        try:
            rows = http_post_json(HL, {"type": "fundingHistory", "coin": sym, "startTime": start})
        except Exception as e:  # noqa: BLE001
            print(f"  ! funding {sym}: {e}", flush=True)
            break
        if not rows:
            break
        for r in rows:
            cached[int(r["time"]) // 3_600_000 * 3_600_000] = float(r["fundingRate"])
        nxt = int(rows[-1]["time"]) + 1
        if nxt <= start:
            break
        start = nxt
        time.sleep(0.2)
    write_json(path, {str(k): v for k, v in sorted(cached.items())})
    return cached


def update_wiki(sym: str, today: dt.date) -> dict[str, int]:
    path = CACHE / f"{sym}_wiki.json"
    cached: dict[str, int] = read_json(path, {}) or {}
    start = (dt.date.fromisoformat(max(cached)) - dt.timedelta(days=3)) if cached else dt.date(2016, 1, 1)
    article = urllib.parse.quote(ASSETS[sym]["wiki"].replace(" ", "_"), safe="")
    url = WIKI.format(article=article, start=start.strftime("%Y%m%d"), end=today.strftime("%Y%m%d"))
    try:
        items = http_get(url, retries=4).json().get("items", [])
        for it in items:
            d = it["timestamp"][:8]
            cached[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = int(it["views"])
    except Exception as e:  # noqa: BLE001 - pageviews are optional context
        print(f"  ! wiki {sym}: {e}", flush=True)
    write_json(path, dict(sorted(cached.items())))
    return cached


def export(sym: str, today: dt.date) -> dict:
    now = int(time.time())
    info = ASSETS[sym]
    daily = update_candles(sym, 86400, info["start"], now)
    hourly = update_candles(sym, 3600, max(HOURLY_START, info["start"]), now)
    funding = update_funding(sym, now * 1000)
    wiki = update_wiki(sym, today)

    # Daily funding = mean of hourly rates over the UTC day (as a per-hour rate).
    fday: dict[str, list[float]] = {}
    for ms, rate in funding.items():
        d = dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).date().isoformat()
        fday.setdefault(d, []).append(rate)

    days = [dt.datetime.fromtimestamp(r[0], dt.timezone.utc).date().isoformat() for r in daily]
    out = {
        "symbol": sym, "freq": "1d", "tz": "UTC",
        "t": days,
        "o": [r[1] for r in daily], "h": [r[2] for r in daily],
        "l": [r[3] for r in daily], "c": [r[4] for r in daily],
        "v": [r4(r[5], 3) for r in daily],                      # base-asset volume (Coinbase spot)
        "fund": [r4(sum(fday[d]) / len(fday[d]), 8) if d in fday else None for d in days],
        "wiki": [wiki.get(d) for d in days],
    }
    write_json(DATA_DIR / "daily" / f"{sym}.json", out)

    hout = {
        "symbol": sym, "freq": "1h", "tz": "UTC (bar open time)",
        "t": [r[0] for r in hourly],
        "o": [r[1] for r in hourly], "h": [r[2] for r in hourly],
        "l": [r[3] for r in hourly], "c": [r[4] for r in hourly],
        "v": [r4(r[5], 3) for r in hourly],
        "fund": [funding.get(r[0] * 1000) for r in hourly],
    }
    write_json(DATA_DIR / "hourly" / f"{sym}.json", hout)

    meta = {
        "symbol": sym, "group": "crypto", "name": info["name"], "exchange": "Coinbase",
        "product": info["product"], "multiplier": 1, "unit": sym, "tick": 0.01,
        "daily": {"start": days[0], "end": days[-1], "bars": len(days)},
        "hourly": {"start": hout["t"][0], "end": hout["t"][-1], "bars": len(hourly)},
        "funding_from": min(fday) if fday else None,
    }
    print(f"[crypto] {sym}: {len(days)} daily, {len(hourly)} hourly, funding days={len(fday)}, "
          f"wiki days={len(wiki)}", flush=True)
    return meta


def run(today: dt.date | None = None) -> list[dict]:
    today = today or dt.date.today()
    return [export(s, today) for s in ASSETS]


if __name__ == "__main__":
    run()
    sys.exit(0)
