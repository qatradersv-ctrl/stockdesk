"""FactorDesk yfinance datasource — read-only market data microservice.

Serves the JSON shapes the FactorDesk Node server expects, using the yfinance
library (github.com/ranaroussi/yfinance) for Yahoo Finance access. Every number
here is real, as-reported market data — nothing in this service is generated.

Endpoints: /health /tickers /macro /universe /stock/<TICKER> /news/<QUERY> /news
Run:       python datasource/yf_service.py   (port: env YF_PORT, default 8765)
"""
import json
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import yfinance as yf

PORT = int(os.environ.get("YF_PORT", "8765"))
TTL = 6 * 3600          # fundamentals + price history
TAPE_TTL = 5 * 60       # market tape
MACRO_TTL = 15 * 60     # macro dashboard
NEWS_TTL = 15 * 60      # headlines
WORKERS = 8

# Bump these when a row's SHAPE changes: the disk cache outlives the process, and an
# old snapshot missing a field would otherwise be served as if it were complete.
UKEY = "u6"
SKEY = "s8:"

HERE = os.path.dirname(os.path.abspath(__file__))
SYMBOLS = json.load(open(os.path.join(HERE, "symbols.json"), encoding="utf-8"))
TICKERS = SYMBOLS["equities"]
MACRO = SYMBOLS["macro"]
TAPE = SYMBOLS["tape"]

CCY = {"GBP": "£", "GBp": "£", "USD": "$", "AUD": "A$", "EUR": "€", "JPY": "¥",
       "CHF": "CHF ", "INR": "₹", "HKD": "HK$", "KRW": "₩", "SGD": "S$", "CAD": "C$",
       "CNY": "CN¥", "MXN": "MX$", "BRL": "R$", "NOK": "NKr ", "SEK": "SKr ", "DKK": "DKr "}

# what a value means when we render it: price per share, an index level, a percent yield
UNIT = {"index": "index", "vol": "index", "rates": "percent", "fx": "fx",
        "commodity": "price", "crypto": "price", "etf": "price", "sector": "price"}


def num(v):
    return v if isinstance(v, (int, float)) and v == v else None


def pct(v, scale=100.0):
    v = num(v)
    return round(v * scale, 3) if v is not None else None


def fetch_bars(sym):
    """Five years of daily OHLC for one listing, asked for on the report page rather than
    carried in the universe payload: 334 names x 1300 bars would multiply the cache for a chart
    only a single page opens. Bars are kept only when all four legs print, so the client never
    draws a candle with a missing body. Prices stay on Yahoo's adjusted basis, in their own
    currency unit — the caller scales pence listings the same way the quote is scaled."""
    import pandas as pd
    try:
        h = yf.Ticker(sym).history(period="5y", interval="1d", auto_adjust=True)
    except Exception:
        return None
    if h is None or not len(h) or "Close" not in h:
        return None
    idx = h.index
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_convert("UTC")

    def vals(name):
        if name not in h:
            return [None] * len(idx)
        return [float(v) if v == v and v is not None else None for v in h[name].tolist()]

    o, hgt, l, c = vals("Open"), vals("High"), vals("Low"), [None if v != v else float(v) for v in h["Close"].tolist()]
    ts = [int(pd.Timestamp(x).timestamp() * 1000) for x in idx.tolist()]
    rows = [(ts[i], o[i], hgt[i], l[i], c[i]) for i in range(len(ts))
            if c[i] is not None and o[i] is not None and hgt[i] is not None and l[i] is not None]
    if not rows:
        return None
    cur = ""
    try:
        cur = (yf.Ticker(sym).info or {}).get("currency") or ""
    except Exception:
        pass
    return {"t": sym.upper(), "cur": cur, "dates": [r[0] for r in rows],
            "o": [r[1] for r in rows], "h": [r[2] for r in rows],
            "l": [r[3] for r in rows], "c": [r[4] for r in rows], "n": len(rows)}


def dividend_pct(info, price_pounds):
    """Dividend yield in percent. yfinance reports dividendYield already in percent,
    trailingAnnualDividendYield as a fraction, dividendRate as cash per share."""
    v = num(info.get("dividendYield"))
    if v is not None and v > 0:
        return round(v, 3)
    v = num(info.get("trailingAnnualDividendYield"))
    if v is not None and v > 0:
        return round(v * 100, 3)
    rate = num(info.get("dividendRate"))
    if rate and price_pounds:
        return round(rate / price_pounds * 100, 3)
    return None


def div_history(tk, scale, info):
    """Cash paid per share by calendar year, newest first.

    Yahoo quotes an LSE listing in pence but reports its cash rate in pounds, so the
    history is matched against dividendRate before any figure leaves here — if the
    basis cannot be identified the card shows nothing rather than a number off by 100.
    """
    try:
        s = tk.dividends
    except Exception:
        return None
    if s is None or getattr(s, "empty", True):
        return None
    import pandas as pd
    pairs = []
    for idx, v in s.items():
        v = num(v)
        if v is None:
            continue
        ts = pd.Timestamp(idx)
        if getattr(ts, "tz", None) is not None:
            ts = ts.tz_convert("UTC")
        pairs.append((int(ts.timestamp()), int(ts.year), v))
    if not pairs:
        return None

    factors = [1.0, 1.0 / scale] if scale != 1 else [1.0]
    # A calendar-year trailing window can catch five quarterly ex-dates (one at each end),
    # which would overstate the rate by 25%. Count one payment period instead, read from
    # the median gap between ex-dates, so monthly payers get 12 and half-yearlies get 2.
    secs = sorted((p[0] for p in pairs), reverse=True)
    gaps = sorted((secs[i] - secs[i + 1]) / 86400 for i in range(len(secs) - 1))
    med = gaps[len(gaps) // 2] if gaps else 999
    k = 12 if med <= 45 else 4 if med <= 137 else 2 if med <= 274 else 1
    k = min(k, len(secs))
    trailing = sum(v for _, _, v in sorted(pairs, key=lambda p: -p[0])[:k])
    trailing_n = k
    if len(factors) > 1:
        rate = num(info.get("dividendRate"))
        ok = [f for f in factors if rate and 0.75 <= (trailing * f) / rate <= 1.35]
        if not ok:
            return None
        factor = ok[0]
    else:
        factor = 1.0

    by = {}
    for sec, y, v in pairs:
        e = by.setdefault(y, {"y": y, "cps": 0.0, "n": 0, "last": sec})
        e["cps"] += v
        e["n"] += 1
        e["last"] = max(e["last"], sec)
    years = sorted(by.values(), key=lambda e: -e["y"])[:6]
    for e in years:
        e["cps"] = round(e["cps"] * factor, 4)
    return {"years": years, "ttm": round(trailing * factor, 4), "ttmN": trailing_n,
            "exLast": max(p[0] for p in pairs) * 1000}


def first_val(df, row):
    """Most recent non-null value of a statement line item."""
    if df is None or getattr(df, "empty", True) or row not in df.index:
        return None
    s = df.loc[row]
    vals = s.tolist() if hasattr(s, "tolist") else [s]
    for v in (num(x) for x in vals):
        if v is not None:
            return v
    return None


def recent_vals(df, row, n=2):
    """Latest n non-null values of a statement line item, newest first."""
    if df is None or getattr(df, "empty", True) or row not in df.index:
        return []
    s = df.loc[row]
    vals = s.tolist() if hasattr(s, "tolist") else [s]
    return [v for v in (num(x) for x in vals) if v is not None][:n]


def stmt_history(inc, bal, n=5):
    """Reported annual figures, newest fiscal year first. Nothing here is estimated:
    a line is null when the company did not report it, and the client renders "—"."""
    if inc is None or getattr(inc, "empty", True):
        return []

    def cell(df, row, c):
        if df is None or getattr(df, "empty", True) or row not in df.index or c not in df.columns:
            return None
        v = df.loc[row, c]
        if hasattr(v, "iloc"):  # a duplicated statement row — take the first, never average
            v = v.iloc[0]
        return num(v)

    out = []
    for c in list(inc.columns)[:n]:
        y = getattr(c, "year", None)
        row = {"y": str(y) if y else str(c)[:10],
               "rev": cell(inc, "Total Revenue", c),
               "ebit": cell(inc, "EBIT", c),
               "net": cell(inc, "Net Income", c),
               "eps": cell(inc, "Diluted EPS", c),
               "eq": cell(bal, "Stockholders Equity", c),
               "debt": cell(bal, "Total Debt", c),
               "cash": cell(bal, "Cash Cash Equivalents And Short Term Investments", c)}
        if any(v is not None for k, v in row.items() if k != "y"):
            out.append(row)
    return out


def roce_from_statements(inc, bal):
    """Published formula: EBIT over average (equity + total debt), latest two year-ends."""
    ebit = first_val(inc, "EBIT")
    debt = recent_vals(bal, "Total Debt")
    equity = recent_vals(bal, "Stockholders Equity")
    if ebit is None or not debt or not equity:
        return None
    ce_now = equity[0] + debt[0]
    ce_prev = (equity[1] if len(equity) > 1 else equity[0]) + (debt[1] if len(debt) > 1 else debt[0])
    avg = (ce_now + ce_prev) / 2
    if not avg:
        return None
    return round(ebit / avg * 100, 3)


def interest_cover(inc):
    ebit = first_val(inc, "EBIT")
    expense = first_val(inc, "Interest Expense")
    if ebit is None or expense is None or expense <= 0:
        return None
    return round(ebit / expense, 2)


def close_series(tk):
    """One year of daily bars as (closes, dates, opens, highs, lows), all on the same
    adjusted basis so a gap measured between them is the gap a trader would see."""
    import pandas as pd
    try:
        h = tk.history(period="1y", interval="1d", auto_adjust=True)
    except Exception:
        return [], [], [], [], []
    col = h["Close"].dropna() if "Close" in h else None
    if col is None or not len(col):
        return [], [], [], [], []
    idx = col.index
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_convert("UTC")
    dates = [int(pd.Timestamp(x).timestamp() * 1000) for x in idx.tolist()]

    def series(name):
        if name not in h:
            return [None] * len(dates)
        s = h[name].reindex(idx)
        return [float(v) if v == v and v is not None else None for v in s.tolist()]

    return [float(x) for x in col.tolist()], dates, series("Open"), series("High"), series("Low")


def gap_read(closes, opens, highs, lows):
    """Today's gap and the nearest unfilled gap zone, both from the real bars.

    A gap is the distance between yesterday's close and today's open — it only exists
    because nothing traded in between, which is why it acts as support or resistance.
    It counts as filled once price later trades back to the pre-gap close.
    """
    n = len(closes)
    if n < 3 or opens is None:
        return {}
    out = {}
    last_g = (opens[n - 1] / closes[n - 2] - 1) if opens[n - 1] and closes[n - 2] else None
    if last_g is not None:
        out["gap"] = round(last_g * 100, 2)
    events = []
    for i in range(1, n):
        po, pc = opens[i], closes[i - 1]
        if po is None or not pc:
            continue
        g = po / pc - 1
        if abs(g) < 0.015:
            continue
        events.append([i, round(g * 100, 2)])
    if events:
        out["gaps"] = events[-12:]
        out["gapCount"] = len(events)
        # nearest unfilled gap, newest first
        for i, g in reversed(events):
            ref = closes[i - 1]
            lows_after = [v for v in (lows[i + 1:] if lows else []) if v is not None]
            highs_after = [v for v in (highs[i + 1:] if highs else []) if v is not None]
            if g > 0:
                if not lows_after or min(lows_after) > ref:
                    out["gapZone"] = {"dir": "up", "lo": round(ref, 4), "hi": round(opens[i], 4),
                                      "pct": g, "ago": n - 1 - i}
                    break
            elif not highs_after or max(highs_after) < ref:
                out["gapZone"] = {"dir": "down", "lo": round(opens[i], 4), "hi": round(ref, 4),
                                  "pct": g, "ago": n - 1 - i}
                break
    return out


def fetch_stock(t):
    tk = yf.Ticker(t)
    try:
        info = tk.info or {}
    except Exception:
        info = {}
    inc = bal = None
    try:
        inc, bal = tk.income_stmt, tk.balance_sheet
    except Exception:
        pass
    closes_raw, dates, opens_raw, highs_raw, lows_raw = close_series(tk)

    cur = info.get("currency") or ""
    raw_price = num(info.get("currentPrice")) or num(info.get("regularMarketPrice")) or (closes_raw[-1] if closes_raw else None)
    if not raw_price:
        return None
    # Yahoo quotes LSE listings in pence (GBp) but reports EPS, book value, dividends and
    # market cap in pounds — put every per-share figure on the same footing before ratioing.
    scale = 100.0 if cur == "GBp" else 1.0
    price = raw_price / scale
    closes = [round(c / scale, 4) for c in closes_raw]
    # measured on the same 260-bar window the chart keeps, so an index in "gaps" lines
    # up with the series the client draws
    win = slice(max(0, len(closes) - 260), len(closes))
    adj = lambda arr: [None if v is None else round(v / scale, 4) for v in arr[win]]
    gaps = gap_read(closes[win], adj(opens_raw), adj(highs_raw), adj(lows_raw))
    closes = closes[win]
    dates = dates[win]
    mcap = num(info.get("marketCap"))
    shares = num(info.get("sharesOutstanding"))
    book = num(info.get("bookValue"))
    equity = shares * book if shares and book else None
    debt, cash = num(info.get("totalDebt")), num(info.get("totalCash"))
    nde = round((debt - (cash or 0)) / equity * 100, 2) if equity and debt is not None else num(info.get("debtToEquity"))
    dy = dividend_pct(info, price)
    fcf = num(info.get("freeCashflow"))
    target = num(info.get("targetMeanPrice"))
    eps = num(info.get("trailingEps"))
    pe = round(price / eps, 3) if eps and eps > 0 else num(info.get("trailingPE"))
    sector = info.get("sector") or "Other"
    financial = sector == "Financial Services"
    # banks and insurers: gross margin and net-debt/equity are meaningless on a deposit-funded
    # balance sheet, so return on equity replaces ROCE and those two legs are scored N/A
    gm = None if financial else pct(info.get("grossMargins"))
    nde = None if financial else nde
    roce = roce_from_statements(inc, bal)
    roce_basis = "ROCE"
    if roce is None and financial:
        roce, roce_basis = pct(info.get("returnOnEquity")), "ROE"
    ic = interest_cover(inc)
    when = num(info.get("earningsTimestampStart")) or num(info.get("earningsTimestamp"))
    if when and when < time.time():
        when = num(info.get("earningsTimestampEnd")) or when

    d = {
        "t": t,
        "name": info.get("longName") or info.get("shortName") or t,
        # Yahoo publishes the company's own site; it is the only honest key for a real logo
        "w": info.get("website") or None,
        "country": info.get("country") or ("United Kingdom" if t.endswith(".L") else "Australia" if t.endswith(".AX") else "United States"),
        "sector": sector,
        "currency": CCY.get(cur, (cur or "") + " "),
        "ccy": cur,
        "price": round(float(price), 4),
        "mcap": round(mcap / 1e9, 3) if mcap else None,
        "pe": pe,
        "pb": num(info.get("priceToBook")),
        "peg": num(info.get("trailingPegRatio")),
        "dy": dy,
        # payoutRatio is Yahoo's own paid-out share of earnings; 0 on a non-payer means "no
        # dividend", which the yield already says, so it is only kept when a dividend exists
        "payout": (pct(info.get("payoutRatio")) or None) if dy else None,
        "divs": div_history(tk, scale, info),
        "fcfy": round(fcf / mcap * 100, 3) if fcf and mcap else None,
        "roce": roce,
        "roceBasis": roce_basis,
        "gm": gm,
        "nde": nde,
        "ic": ic,
        "eg": pct(info.get("earningsQuarterlyGrowth")),
        "rg": pct(info.get("revenueGrowth")),
        "fg": pct(info.get("earningsGrowth")),
        "beta": num(info.get("beta")),
        "target": round(target / scale, 4) if target else None,
        "rec": info.get("recommendationKey"),
        "inst": pct(info.get("heldPercentInstitutions")),
        "insider": pct(info.get("heldPercentInsiders")),
        "shortPct": pct(info.get("shortPercentOfFloat")),
        "shortDays": num(info.get("shortRatio")),
        "nextEarnings": int(when * 1000) if when and when > time.time() else None,
        "week52Hi": round(num(info.get("fiftyTwoWeekHigh")) / scale, 4) if num(info.get("fiftyTwoWeekHigh")) else None,
        "week52Lo": round(num(info.get("fiftyTwoWeekLow")) / scale, 4) if num(info.get("fiftyTwoWeekLow")) else None,
        "closes": closes[-260:],
        "dates": dates[-260:],
        "fin": stmt_history(inc, bal),
        "gap": gaps.get("gap"),
        "gaps": gaps.get("gaps") or [],
        "gapCount": gaps.get("gapCount") or 0,
        "gapZone": gaps.get("gapZone"),
    }
    got = 0
    good = 0
    if d["roce"] is not None: got += 1; good += d["roce"] > 10
    if d["gm"] is not None: got += 1; good += d["gm"] > 25
    if d["nde"] is not None: got += 1; good += d["nde"] < 70
    if d["ic"] is not None: got += 1; good += d["ic"] > 3
    if d["rg"] is not None: got += 1; good += d["rg"] > 0
    if d["eg"] is not None: got += 1; good += d["eg"] > 0
    if d["fcfy"] is not None: got += 1; good += d["fcfy"] > 2
    if d["dy"] is not None: got += 1; good += d["dy"] > 0
    if d["beta"] is not None: got += 1; good += d["beta"] < 1.3
    d["health"] = round(good / got * 9) if got >= 5 else None
    return d


def safe_stock(t):
    try:
        return fetch_stock(t)
    except Exception:
        return None


def build_universe():
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(safe_stock, TICKERS))
    res = [d for d in results if d]
    for d in res:
        # the statement history is only ever shown on one stock's report at a time —
        # carrying it for all 334 names would triple the bulk payload
        d.pop("fin", None)
        d.pop("divs", None)
    res.sort(key=lambda d: -(d.get("mcap") or 0))
    return res


def change(closes, back):
    if len(closes) <= back or not closes[-1 - back]:
        return None
    return round((closes[-1] / closes[-1 - back] - 1) * 100, 2)


def fetch_tickers():
    def one(sym):
        try:
            closes, _ = closes_raw_of(sym, "5d")
            if len(closes) < 2:
                return None
            v, prev = closes[-1], closes[-2]
            return {"s": sym, "n": label_of(sym), "v": round(v, 4 if v < 2 else 2),
                    "c": round((v / prev - 1) * 100, 2)}
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return [x for x in pool.map(one, TAPE) if x]


def closes_raw_of(sym, period):
    import pandas as pd
    h = yf.Ticker(sym).history(period=period, interval="1d", auto_adjust=False)
    col = h["Close"].dropna()
    idx = col.index
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_convert("UTC")
    return [float(x) for x in col.tolist()], [int(pd.Timestamp(x).timestamp() * 1000) for x in idx.tolist()]


def label_of(sym):
    for m in MACRO:
        if m["s"] == sym:
            return m["n"]
    return sym


def fetch_macro():
    """Real price history for indices, yields, FX, commodities and rotation proxies,
    each with 1-day, 1-month and 12-month changes computed from the closes."""
    def one(item):
        sym, name, group = item["s"], item["n"], item["g"]
        try:
            closes, ts = closes_raw_of(sym, "1y")
        except Exception:
            return None
        if len(closes) < 3:
            return None
        v = closes[-1]
        return {"s": sym, "n": name, "g": group, "u": UNIT.get(group, "index"),
                "v": round(v, 4 if v < 10 else 2), "d": change(closes, 1), "m": change(closes, 21),
                "q": change(closes, 63), "y": change(closes, min(252, len(closes) - 1)),
                "hi52": round(max(closes), 4 if v < 10 else 2), "lo52": round(min(closes), 4 if v < 10 else 2),
                "dates": ts[-260:], "closes": [round(c, 4) for c in closes][-260:]}

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return [x for x in pool.map(one, MACRO) if x]


def pic(thumb):
    """Yahoo's own article picture, if the feed carries one. Their payload only ever holds two
    entries: an "original" that is sometimes 5000px and several megabytes, and a signed 140px
    tile whose signature stops the size being rewritten. So the original is taken when its own
    width says it is a sane web image, and otherwise the compact tile is used — that tile is
    10KB and only ever shown in a 90px box. https only, since a browser will not load the rest."""
    if not isinstance(thumb, dict):
        return None
    rs = [{"w": num(r.get("width")) or 0, "tag": r.get("tag") or "", "u": r.get("url")}
          for r in thumb.get("resolutions") or [] if isinstance(r, dict)]
    rs = [r for r in rs if str(r["u"] or "").startswith("https://")]
    if not rs:
        return None
    originals = [r for r in rs if r["tag"] == "original"]
    sane = [r for r in originals if 140 <= r["w"] <= 2200] or [r for r in rs if 140 <= r["w"] <= 2200]
    if sane:
        return max(sane, key=lambda r: r["w"])["u"]      # a properly-sized web image: take the sharpest
    big = [r for r in rs if r["w"] > 2200]
    return min(big, key=lambda r: r["w"])["u"] if big else min(rs, key=lambda r: r["w"])["u"]


def fetch_news(query):
    try:
        items = yf.Search(query, news_count=10).news
    except Exception:
        return []
    out = []
    for n in items or []:
        if not isinstance(n, dict):
            continue
        title, link = n.get("title"), n.get("link")
        pub = n.get("publisher") or ""
        ts = num(n.get("providerPublishTime"))
        if title and link:
            out.append({"t": title, "u": link, "p": pub, "ts": int(ts * 1000) if ts else None,
                        "i": pic(n.get("thumbnail"))})
    return out[:8]


_cache = {}
_lock = threading.Lock()
_key_locks = {}
CACHE_FILE = os.path.join(HERE, ".cache-yf.json")


def _load_disk():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return {k: (v["ts"], v["val"]) for k, v in raw.items()}
    except Exception:
        return {}


def _save_disk():
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({k: {"ts": v[0], "val": v[1]} for k, v in _cache.items() if v[0] >= time.time() - TTL}, f)
    except Exception:
        pass


def cached(key, fn, ttl=None):
    """Cache with serve-stale-while-refresh: a slow rebuild never blocks a reader who
    already has data — they get the last good snapshot while another thread refreshes."""
    ttl = TTL if ttl is None else ttl
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        stale = hit[1] if hit and hit[1] else None
        kl = _key_locks.setdefault(key, threading.Lock())
    if kl.acquire(blocking=False):
        try:
            fresh = fn()
            if fresh:
                with _lock:
                    _cache[key] = (time.time(), fresh)
                    if ttl >= TTL:
                        _save_disk()
                return fresh
            return stale
        finally:
            kl.release()
    if stale is not None:
        return stale
    with kl:
        pass
    with _lock:
        hit = _cache.get(key)
        return hit[1] if hit else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path == "/health":
                with _lock:
                    built = UKEY in _cache
                return self.send_json({"ok": True, "yfinance": yf.__version__, "universe": len(_cache.get(UKEY, (0, []))[1]) if built else 0})
            if path == "/tickers":
                return self.send_json({"asof": int(time.time() * 1000), "tickers": cached("t", fetch_tickers, TAPE_TTL) or []})
            if path == "/macro":
                rows = cached("m", fetch_macro, MACRO_TTL) or []
                with _lock:
                    stamp = _cache.get("m", (time.time(), rows))[0]
                return self.send_json({"asof": int(stamp * 1000), "count": len(rows), "items": rows})
            if path == "/universe":
                stocks = cached(UKEY, build_universe) or []
                with _lock:
                    stamp = _cache.get(UKEY, (time.time(), stocks))[0]
                return self.send_json({"asof": int(stamp * 1000), "count": len(stocks),
                                       "src": "yfinance " + yf.__version__, "stocks": stocks})
            if path.startswith("/stock/"):
                sym = path[len("/stock/"):]
                # cached like everything else — a report page is opened repeatedly,
                # and Yahoo's per-ticker statements take a second or two each time
                d = cached(SKEY + sym, lambda: fetch_stock(sym))
                return self.send_json(d if d else {"error": "not found"}, 200 if d else 404)
            if path.startswith("/bars/"):
                sym = path[len("/bars/"):].strip()
                if not sym or len(sym) > 20:
                    return self.send_json({"error": "bad symbol"}, 400)
                # a short in-memory TTL only — five years of bars is not worth writing to disk
                d = cached("b:" + sym.upper(), lambda: fetch_bars(sym.upper()), 30 * 60)
                return self.send_json(d if d else {"error": "no bars"}, 200 if d else 404)
            if path.startswith("/news"):
                q = path[len("/news"):].lstrip("/") or "stock market"
                return self.send_json({"asof": int(time.time() * 1000), "query": q,
                                       "items": cached("n5:" + q, lambda: fetch_news(q), NEWS_TTL) or []})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    _cache.update(_load_disk())
    print(f"yfinance datasource on http://127.0.0.1:{PORT} (yfinance {yf.__version__}, "
          f"{len(TICKERS)} equities, {len(MACRO)} macro instruments)", flush=True)
    threading.Thread(target=lambda: cached(UKEY, build_universe), daemon=True).start()
    threading.Thread(target=lambda: cached("m", fetch_macro, MACRO_TTL), daemon=True).start()

    class Service(ThreadingHTTPServer):
        daemon_threads = True
        if sys.platform == "win32":
            # Windows honours SO_REUSEADDR by letting a second process bind the same
            # port, which silently shadows the first one. Refuse it and exit instead.
            allow_reuse_address = 0

    try:
        Service(("127.0.0.1", PORT), Handler).serve_forever()
    except OSError as e:
        print(f"port {PORT} is already served by another datasource process: {e}", flush=True)
        sys.exit(0)
