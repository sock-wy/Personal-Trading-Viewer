"""China black-series futures: per-contract download, dominant-contract roll, ratio back-adjustment.

Source: Sina Finance per-contract daily and 60-minute bars (expired contracts are kept back to ~2018).

Why build our own continuous series instead of using a vendor "main continuous" (e.g. RB0)?
Vendor main-continuous series simply splice the prices of consecutive contracts, so every roll
introduces an artificial gap equal to the calendar spread. A backtest on such a series books that
spread as P&L. Here we:
  1. download every listed contract,
  2. pick the dominant contract by open interest, using only information available at the prior close,
  3. back-adjust earlier prices by the ratio new/old observed at the roll-decision close,
so the continuous return series is exactly the return of holding the dominant contract and rolling it.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from common import CACHE_DIR, DATA_DIR, http_get, r4, read_json, write_json

SINA_DAILY = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20x=/"
              "InnerFuturesNewService.getDailyKLine?symbol={sym}")
SINA_MIN = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20x=/"
            "InnerFuturesNewService.getFewMinLine?symbol={sym}&type=60")
SINA_HEADERS = {"Referer": "https://finance.sina.com.cn"}

PRODUCTS = {
    "RB": {"name": "Rebar", "cn": "螺纹钢", "exchange": "SHFE", "multiplier": 10, "unit": "t", "tick": 1},
    "HC": {"name": "Hot-rolled Coil", "cn": "热轧卷板", "exchange": "SHFE", "multiplier": 10, "unit": "t", "tick": 1},
    "I": {"name": "Iron Ore", "cn": "铁矿石", "exchange": "DCE", "multiplier": 100, "unit": "t", "tick": 0.5},
    "J": {"name": "Coke", "cn": "焦炭", "exchange": "DCE", "multiplier": 100, "unit": "t", "tick": 0.5},
    "JM": {"name": "Coking Coal", "cn": "焦煤", "exchange": "DCE", "multiplier": 60, "unit": "t", "tick": 0.5},
    "SF": {"name": "Ferrosilicon", "cn": "硅铁", "exchange": "CZCE", "multiplier": 5, "unit": "t", "tick": 2},
    "SM": {"name": "Silicomanganese", "cn": "锰硅", "exchange": "CZCE", "multiplier": 5, "unit": "t", "tick": 2},
}

# Continuous series start: from here on every contract expiring in the next 12 months is in our data set.
SERIES_START = "2019-06-03"
HOURLY_START = "2023-01-01"
FIRST_YYMM = 1901

DAILY_CACHE = CACHE_DIR / "futures" / "daily"
HOURLY_CACHE = CACHE_DIR / "futures" / "hourly"
MISSING_FILE = CACHE_DIR / "futures" / "missing.json"

_JSONP = re.compile(r"var x=\((.*)\);?\s*$", re.S)


def parse_sina(text: str):
    m = _JSONP.search(text.strip())
    if not m:
        raise ValueError("unexpected Sina payload: " + text[:120])
    body = m.group(1).strip()
    return None if body in ("null", "") else json.loads(body)


def contract_expiry(code: str) -> dt.date:
    yymm = int(code[-4:])
    return dt.date(2000 + yymm // 100, yymm % 100, 15)


def all_contract_codes(sym: str, today: dt.date) -> list[str]:
    last = (today.year % 100 + 1) * 100 + 12
    codes = []
    for yymm in range(FIRST_YYMM, last + 1):
        if 1 <= yymm % 100 <= 12:
            codes.append(f"{sym}{yymm:04d}")
    # Not listed yet if more than ~13 months out.
    horizon = today + dt.timedelta(days=400)
    return [c for c in codes if contract_expiry(c) <= horizon]


# ---------------------------------------------------------------- cache IO

def _read_csv(path: Path) -> list[list]:
    if not path.exists():
        return []
    with path.open() as f:
        return [row for row in csv.reader(f)]


def _write_csv(path: Path, rows: list[list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        csv.writer(f).writerows(rows)


def fetch_contract_daily(code: str) -> list[list] | None:
    data = parse_sina(http_get(SINA_DAILY.format(sym=code), headers=SINA_HEADERS).text)
    if not data:
        return None
    rows = []
    for b in data:
        rows.append([b["d"], b["o"], b["h"], b["l"], b["c"], b["v"], b["p"]])
    return rows


def fetch_contract_hourly(code: str) -> list[list] | None:
    data = parse_sina(http_get(SINA_MIN.format(sym=code), headers=SINA_HEADERS).text)
    if not data:
        return None
    return [[b["d"], b["o"], b["h"], b["l"], b["c"], b["v"], b["p"]] for b in data]


def refresh_daily_cache(today: dt.date, workers: int = 4) -> None:
    """Download contracts that are new, still trading, or expired within the last few weeks."""
    missing: dict = read_json(MISSING_FILE, {}) or {}
    jobs = []
    for sym in PRODUCTS:
        for code in all_contract_codes(sym, today):
            path = DAILY_CACHE / sym / f"{code}.csv"
            exp = contract_expiry(code)
            settled = exp < today - dt.timedelta(days=25)
            if settled and (path.exists() or code in missing):
                continue
            jobs.append((sym, code, path, settled))

    print(f"[futures] daily: {len(jobs)} contracts to fetch", flush=True)

    def work(job):
        sym, code, path, settled = job
        try:
            rows = fetch_contract_daily(code)
        except Exception as e:  # noqa: BLE001
            return code, "error", str(e)[:100]
        if rows is None:
            return code, "missing" if settled else "notlisted", None
        old = {r[0]: r for r in _read_csv(path)}
        for r in rows:
            old[r[0]] = r
        _write_csv(path, [old[k] for k in sorted(old)])
        return code, "ok", len(rows)

    errors = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for fut in as_completed([ex.submit(work, j) for j in jobs]):
            code, status, info = fut.result()
            if status == "missing":
                missing[code] = today.isoformat()
            elif status == "error":
                errors += 1
                print(f"  ! {code}: {info}", flush=True)
    write_json(MISSING_FILE, dict(sorted(missing.items())), compact=False)
    print(f"[futures] daily done, errors={errors}", flush=True)


def load_daily_cache(sym: str) -> dict[str, dict[str, tuple]]:
    """{contract: {date: (o,h,l,c,v,oi)}}"""
    out: dict[str, dict[str, tuple]] = {}
    for path in sorted((DAILY_CACHE / sym).glob("*.csv")):
        bars = {}
        for d, o, h, l, c, v, oi in _read_csv(path):
            o, h, l, c = float(o), float(h), float(l), float(c)
            if c <= 0:
                continue
            # Sina occasionally reports 0 for o/h/l on no-trade days; fall back to close.
            o = o if o > 0 else c
            h = max(h, o, c) if h > 0 else max(o, c)
            l = min(l, o, c) if l > 0 else min(o, c)
            bars[d] = (o, h, l, c, float(v), float(oi))
        if bars:
            out[path.stem] = bars
    return out


# ---------------------------------------------------------------- continuous construction

def build_continuous(sym: str, contracts: dict[str, dict[str, tuple]]):
    dates = sorted({d for bars in contracts.values() for d in bars if d >= SERIES_START})
    if not dates:
        raise RuntimeError(f"no data for {sym}")
    order = sorted(contracts, key=lambda c: int(c[-4:]))
    yymm = {c: int(c[-4:]) for c in order}

    def leader_on(d: str, min_yymm: int):
        best, best_oi = None, -1.0
        for c in order:
            if yymm[c] < min_yymm:
                continue
            b = contracts[c].get(d)
            if b and b[5] > best_oi:
                best, best_oi = c, b[5]
        return best

    dom = leader_on(dates[0], 0)
    rows = []          # per date: contract, raw o,h,l,c, v, oi, totV, totOI
    rolls = []         # (index where new contract starts, from, to, ratio, decision_date)
    for i, d in enumerate(dates):
        b = contracts[dom].get(d)
        if b is None:  # data gap on dominant: carry forward flat bar
            pc = rows[-1][4]
            b = (pc, pc, pc, pc, 0.0, rows[-1][6])
        tot_v = sum(cb[d][4] for cb in contracts.values() if d in cb)
        tot_oi = sum(cb[d][5] for cb in contracts.values() if d in cb)
        rows.append([dom, b[0], b[1], b[2], b[3], b[4], b[5], tot_v, tot_oi])

        if i + 1 == len(dates):
            break
        nxt = dates[i + 1]
        # Decide tomorrow's contract with information available at today's close only.
        cand = leader_on(d, yymm[dom] + 1)
        cur_oi = contracts[dom].get(d, (0, 0, 0, 0, 0, -1))[5]
        expired_tomorrow = nxt not in contracts[dom]
        new = None
        if cand and contracts[cand][d][5] > cur_oi:
            new = cand
        elif expired_tomorrow:
            new = cand
        if new and new != dom:
            old_c = contracts[dom].get(d, (None,) * 4)[3] or rows[-1][4]
            new_c = contracts[new][d][3]
            rolls.append((i + 1, dom, new, new_c / old_c, d))
            dom = new

    # Ratio back-adjustment: bars before roll k are multiplied by ratio_k (cumulatively).
    n = len(rows)
    factor = [1.0] * n
    f = 1.0
    ri = len(rolls) - 1
    for i in range(n - 1, -1, -1):
        while ri >= 0 and rolls[ri][0] > i:
            f *= rolls[ri][3]
            ri -= 1
        factor[i] = f
    return dates, rows, factor, rolls


def validate_against_sina_main(sym: str, dates, rows) -> float:
    """Share of days where our dominant raw close equals Sina's spliced main series close."""
    try:
        data = parse_sina(http_get(SINA_DAILY.format(sym=f"{sym}0"), headers=SINA_HEADERS).text)
    except Exception:  # noqa: BLE001
        return float("nan")
    ref = {b["d"]: float(b["c"]) for b in data or []}
    hit = tot = 0
    for d, r in zip(dates, rows):
        if d in ref:
            tot += 1
            hit += abs(ref[d] - r[4]) < 1e-6
    return hit / tot if tot else float("nan")


# ---------------------------------------------------------------- hourly

def trading_day_of(ts: str, cal: list[str], cal_idx: dict[str, int]) -> str | None:
    """Sina 60m bars are labelled with their end time in CST; night session (>=20:00) belongs to
    the next trading day."""
    day, hm = ts[:10], ts[11:16]
    if hm >= "20:00":
        # first calendar date strictly after `day`
        lo, hi = 0, len(cal)
        while lo < hi:
            mid = (lo + hi) // 2
            if cal[mid] <= day:
                lo = mid + 1
            else:
                hi = mid
        return cal[lo] if lo < len(cal) else None
    if hm < "04:00":  # after-midnight night session (not used by black series, kept for safety)
        prev = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()
        return trading_day_of(prev + " 23:59", cal, cal_idx)
    return day if day in cal_idx else None


def refresh_hourly_cache(sym: str, needed: list[str], today: dt.date, workers: int = 4) -> None:
    jobs = []
    for code in needed:
        path = HOURLY_CACHE / sym / f"{code}.csv"
        settled = contract_expiry(code) < today - dt.timedelta(days=25)
        if settled and path.exists():
            continue
        jobs.append((code, path))

    def work(job):
        code, path = job
        try:
            rows = fetch_contract_hourly(code)
        except Exception as e:  # noqa: BLE001
            return code, str(e)[:100]
        if not rows:
            return code, "empty"
        old = {r[0]: r for r in _read_csv(path)}
        for r in rows:
            old[r[0]] = r
        _write_csv(path, [old[k] for k in sorted(old)])
        return code, None

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for fut in as_completed([ex.submit(work, j) for j in jobs]):
            code, err = fut.result()
            if err:
                print(f"  ! hourly {code}: {err}", flush=True)


def wall_clock_epoch(ts: str) -> int:
    """CST wall-clock time encoded as if it were UTC, so charts display exchange-local time."""
    t = dt.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    return int(t.timestamp())


def build_hourly(sym: str, dates, rows, factor, today: dt.date):
    dom_by_day = {d: r[0] for d, r in zip(dates, rows)}
    fac_by_day = dict(zip(dates, factor))
    hourly_days = [d for d in dates if d >= HOURLY_START]
    needed = sorted({dom_by_day[d] for d in hourly_days})
    refresh_hourly_cache(sym, needed, today)

    cal_idx = {d: i for i, d in enumerate(dates)}
    by_day: dict[str, list] = {}
    for code in needed:
        for ts, o, h, l, c, v, oi in _read_csv(HOURLY_CACHE / sym / f"{code}.csv"):
            td = trading_day_of(ts, dates, cal_idx)
            if td is None or td < HOURLY_START or dom_by_day.get(td) != code:
                continue
            f = fac_by_day[td]
            o, h, l, c = float(o), float(h), float(l), float(c)
            if c <= 0:
                continue
            o = o if o > 0 else c
            by_day.setdefault(td, []).append(
                (wall_clock_epoch(ts), o * f, max(h, o, c) * f, min(l if l > 0 else c, o, c) * f, c * f, float(v), float(oi), c,
                 code))

    # Keep only the contiguous tail of trading days that all have hourly bars.
    start = 0
    for i, d in enumerate(hourly_days):
        if d not in by_day:
            start = i + 1
    days = hourly_days[start:]
    bars = [b for d in days for b in sorted(by_day[d])]
    return days, bars


# ---------------------------------------------------------------- output

def export(sym: str, today: dt.date) -> dict:
    contracts = load_daily_cache(sym)
    dates, rows, factor, rolls = build_continuous(sym, contracts)
    match = validate_against_sina_main(sym, dates, rows)

    ctr_list = sorted({r[0] for r in rows}, key=lambda c: int(c[-4:]))
    ctr_idx = {c: i for i, c in enumerate(ctr_list)}
    nd = 3
    daily = {
        "symbol": sym, "freq": "1d", "tz": "Asia/Shanghai",
        "contracts": ctr_list,
        "t": dates,
        "o": [r4(r[1] * f, nd) for r, f in zip(rows, factor)],
        "h": [r4(r[2] * f, nd) for r, f in zip(rows, factor)],
        "l": [r4(r[3] * f, nd) for r, f in zip(rows, factor)],
        "c": [r4(r[4] * f, nd) for r, f in zip(rows, factor)],
        "rc": [r[4] for r in rows],               # raw (unadjusted) dominant close
        "ctr": [ctr_idx[r[0]] for r in rows],      # dominant contract index
        "v": [int(r[5]) for r in rows],            # dominant contract volume
        "oi": [int(r[6]) for r in rows],           # dominant contract open interest
        "V": [int(r[7]) for r in rows],            # all-contract volume
        "OI": [int(r[8]) for r in rows],           # all-contract open interest
    }
    write_json(DATA_DIR / "daily" / f"{sym}.json", daily)

    days, hb = build_hourly(sym, dates, rows, factor, today)
    hourly = {
        "symbol": sym, "freq": "1h", "tz": "Asia/Shanghai (wall clock, bar end time)",
        "t": [b[0] for b in hb],
        "o": [r4(b[1], nd) for b in hb], "h": [r4(b[2], nd) for b in hb],
        "l": [r4(b[3], nd) for b in hb], "c": [r4(b[4], nd) for b in hb],
        "rc": [b[7] for b in hb],
        "v": [int(b[5]) for b in hb], "oi": [int(b[6]) for b in hb],
        "contracts": ctr_list,
        "ctr": [ctr_idx[b[8]] for b in hb],
    }
    write_json(DATA_DIR / "hourly" / f"{sym}.json", hourly)

    info = dict(PRODUCTS[sym])
    info.update({
        "symbol": sym, "group": "futures",
        "daily": {"start": dates[0], "end": dates[-1], "bars": len(dates)},
        "hourly": {"start": days[0] if days else None, "end": days[-1] if days else None, "bars": len(hb)},
        "rolls": [{"date": dates[i], "decided": d, "from": a, "to": b, "ratio": r4(r, 6)}
                  for i, a, b, r, d in rolls],
        "dominant": rows[-1][0],
        "validation": {"same_close_as_vendor_main_pct": None if match != match else round(match * 100, 1)},
    })
    print(f"[futures] {sym}: {len(dates)} daily bars, {len(hb)} hourly bars, {len(rolls)} rolls, "
          f"dominant={rows[-1][0]}, vendor-main agreement={info['validation']['same_close_as_vendor_main_pct']}%",
          flush=True)
    return info


def run(today: dt.date | None = None, skip_fetch: bool = False) -> list[dict]:
    today = today or dt.date.today()
    if not skip_fetch:
        refresh_daily_cache(today)
    return [export(sym, today) for sym in PRODUCTS]


if __name__ == "__main__":
    run(skip_fetch="--skip-fetch" in sys.argv)
