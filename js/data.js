/* FactorDesk data engine.
   One universe only: real Yahoo Finance data through the Node API (/api/universe).
   If that fails the app shows an error — it never falls back to invented numbers.
   Scoring is transparent: percentile-rank each metric across the universe, average the available legs into factors. */
(function () {
  const FD = (window.FD = window.FD || {});
  FD.source = "idle";
  FD.stocks = [];
  FD.countries = [];
  FD.sectors = [];
  FD.macro = [];
  FD.bt = null;
  FD.btError = null;

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /* ============ SCORING (null-tolerant: missing data is neutral, never guessed) ============ */
  function pctRanker(list, pick, invert) {
    const known = list.map(s => ({ v: pick(s.metrics), t: s.t })).filter(e => e.v != null && isFinite(e.v)).sort((a, b) => a.v - b.v);
    const map = new Map();
    known.forEach((e, i) => map.set(e.t, (i / Math.max(known.length - 1, 1)) * 100));
    return (t) => {
      if (!map.has(t)) return null;
      const v = map.get(t);
      return invert ? 100 - v : v;
    };
  }

  function scoreList(list) {
    const P = {
      roce: pctRanker(list, m => m.roce), fScore: pctRanker(list, m => m.fScore),
      gm: pctRanker(list, m => m.grossMargin), nde: pctRanker(list, m => m.netDebtEq, true),
      ic: pctRanker(list, m => m.intCover),
      pe: pctRanker(list, m => m.pe, true), pb: pctRanker(list, m => m.pb, true),
      dy: pctRanker(list, m => m.divYield), fcf: pctRanker(list, m => m.fcfYield),
      p12: pctRanker(list, m => m.perf12), p6: pctRanker(list, m => m.perf6),
      rsi: pctRanker(list, m => m.rsi), p1: pctRanker(list, m => m.perf1, true),
      eg: pctRanker(list, m => m.epsGrowth), rg: pctRanker(list, m => m.revG), fg: pctRanker(list, m => m.fwdEPS),
      size: pctRanker(list, m => m.mcap, true),
    };
    const avgAvail = (ts, keys) => {
      const xs = keys.map(k => P[k](ts)).filter(x => x != null);
      return xs.length ? mean(xs) : 50;
    };
    for (const s of list) {
      s.factors = {
        quality: avgAvail(s.t, ["roce", "fScore", "gm", "nde", "ic"]),
        value: avgAvail(s.t, ["pe", "pb", "dy", "fcf"]),
        momentum: avgAvail(s.t, ["p12", "p6", "rsi"]),
        growth: avgAvail(s.t, ["eg", "rg", "fg"]),
        smallcap: avgAvail(s.t, ["size"]),
      };
      s.rank = clamp(s.factors.quality * .35 + s.factors.value * .25 + s.factors.momentum * .25 + s.factors.growth * .10 + s.factors.smallcap * .05, 0, 100);
      s.type = classify(s.factors);
    }
    return list;
  }

  function classify(f) {
    const { quality: q, momentum: m, value: v } = f;
    if (q >= 60 && m >= 60) return "Star Share";
    if (q >= 60 && m < 40) return "Sleeping Compounder";
    if (q < 40 && m >= 60) return "Momentum Trap";
    if (q < 40 && m < 40 && v < 40) return "Value Avoid";
    if (v >= 60 && m < 45) return "Contrarian Play";
    return "Middle Ground";
  }

  /* ============ REAL DATA ============ */
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      d >= 0 ? g += d : l -= d;
    }
    if (l === 0) return 100;
    return clamp(100 - 100 / (1 + g / l), 0, 100);
  }
  function normalizeLive(d) {
    const c = (d.closes || []).filter(x => x != null && isFinite(x)), n = c.length;
    const ch = (k) => (n > k + 1 ? (c[n - 1] / c[n - 1 - k] - 1) * 100 : (k <= n ? (c[n - 1] / c[0] - 1) * 100 : null));
    const metrics = {
      price: d.price, mcap: d.mcap, pe: d.pe, pb: d.pb, divYield: d.dy, payout: d.payout, fcfYield: d.fcfy,
      roce: d.roce, fScore: d.health, grossMargin: d.gm, netDebtEq: d.nde, intCover: d.ic,
      altmanZ: null,
      perf12: n > 2 ? (c[n - 1] / c[0] - 1) * 100 : null,
      perf6: ch(126), perf3m: ch(63), perf1: ch(21),
      rsi: calcRSI(c),
      epsGrowth: d.eg, revG: d.rg, fwdEPS: d.fg, beta: d.beta,
      peg: d.peg, instOwn: d.inst, insider: d.insider, shortPct: d.shortPct, shortDays: d.shortDays,
      gap: d.gap == null ? null : d.gap, gapCount: d.gapCount || 0,
    };
    return { t: d.t, name: d.name, country: d.country, sector: d.sector, currency: d.currency, ccy: d.ccy || d.currency,
      site: d.w || "",
      target: d.target, rec: d.rec, roceBasis: d.roceBasis || "ROCE", nextEarnings: d.nextEarnings,
      week52Hi: d.week52Hi, week52Lo: d.week52Lo,
      gaps: d.gaps || [], gapZone: d.gapZone || null,
      closes: c, tsDates: d.dates, metrics };
  }

  FD.loadLive = async function () {
    const res = await fetch("/api/universe", { signal: AbortSignal.timeout(35000) });
    if (!res.ok) throw new Error("data API responded " + res.status);
    const data = await res.json();
    if (!data.stocks || data.stocks.length < 20) throw new Error("data source returned too few stocks");
    FD.stocks = scoreList(data.stocks.map(normalizeLive));
    FD.liveAsof = new Date(data.asof || Date.now());
    FD.asOf = fmtAsOf(FD.liveAsof);
    FD.refreshing = !!data.refreshing;
    FD.source = "live";
    FD.dataSrc = data.src || "Yahoo Finance (direct)";
    FD.countries = [...new Set(FD.stocks.map(s => s.country))].sort();
    FD.sectors = [...new Set(FD.stocks.map(s => s.sector).filter(x => x && x !== "Other"))].sort();
    sigCache.clear(); sectorCache = null; seriesCache.clear();
    return FD.stocks.length;
  };

  let macroPromise = null;
  FD.loadMacro = function (force) {
    if (FD.macro.length && !force) return Promise.resolve(FD.macro);
    if (macroPromise) return macroPromise;
    macroPromise = (async () => {
      try {
        const r = await fetch("/api/macro");
        if (!r.ok) return [];
        const j = await r.json();
        FD.macro = j.items || [];
        FD.macroAsof = new Date(j.asof);
        return FD.macro;
      } catch { return []; }
      finally { macroPromise = null; }
    })();
    return macroPromise;
  };

  let btPromise = null;
  FD.backtest = function (force) {
    if (FD.bt && !force) return Promise.resolve(FD.bt);
    if (btPromise) return btPromise;
    btPromise = (async () => {
      try {
        const r = await fetch("/api/backtest" + (force ? "?force=1" : ""));
        const j = await r.json();
        if (!r.ok || j.error) { FD.btError = j.error || ("API " + r.status); return null; }
        FD.bt = j; return j;
      } catch (e) { FD.btError = e.message; return null; }
      finally { btPromise = null; }
    })();
    return btPromise;
  };

  FD.news = async function (query) {
    try {
      const r = await fetch("/api/news/" + encodeURIComponent(query || "stock market"));
      if (!r.ok) return [];
      return ((await r.json()).items) || [];
    } catch { return []; }
  };

  /* Reported statements are per stock, so they come on demand and stay cached here. */
  const finCache = new Map();
  FD.fundamentals = function (sym) {
    if (!finCache.has(sym)) finCache.set(sym, (async () => {
      try {
        const r = await fetch("/api/fundamentals/" + encodeURIComponent(sym));
        const j = await r.json().catch(() => ({}));
        return (!r.ok || j.error) ? { error: j.error || ("API " + r.status) } : j;
      } catch (e) { return { error: e.message }; }
    })());
    return finCache.get(sym);
  };

  /* ============ BASKET MEASUREMENT — what a set of names actually returned ============
     Aligns every constituent on the union of its real trading days, holds the last price
     across a day it did not trade, then compounds the average daily return. Nothing here is
     simulated: the window is the published history and the cost is the one line stated. */
  FD.basket = function (list, days, weights) {
    const names = list.filter(s => (s.closes || []).length > 40 && (s.tsDates || []).length);
    if (names.length < 2) return null;
    const dayOf = (ms) => Math.floor(ms / 86400000);
    const axis = new Set();
    for (const s of names) s.tsDates.forEach((d, i) => { if (s.closes[i] != null) axis.add(dayOf(d)); });
    const all = [...axis].sort((a, b) => a - b).slice(-(days || 252));
    if (all.length < 40) return null;

    const cols = names.map(s => {
      const map = new Map();
      s.tsDates.forEach((d, i) => { const c = s.closes[i]; if (c != null) map.set(dayOf(d), c); });
      const col = new Array(all.length).fill(null);
      const live = new Array(all.length).fill(false);
      let last = null;
      for (let i = 0; i < all.length; i++) { if (map.has(all[i])) { last = map.get(all[i]); live[i] = true; } col[i] = last; }
      const first = col.find(x => x != null);
      for (let i = 0; i < all.length; i++) if (col[i] == null) col[i] = first != null ? first : col[i - 1];
      return { col, live };
    });
    const rets = cols.map(({ col }) => {
      const r = new Array(all.length).fill(0);
      for (let i = 1; i < all.length; i++) r[i] = col[i] && col[i - 1] ? col[i] / col[i - 1] - 1 : 0;
      return r;
    });
    /* a day only counts as a real observation when the listing itself traded on it */
    const traded = cols.map(({ live }) => {
      const t = new Array(all.length).fill(false);
      for (let i = 1; i < all.length; i++) t[i] = live[i] && live[i - 1];
      return t;
    });
    const w = weights ? weights(names) : names.map(() => 1 / names.length);
    const wsum = w.reduce((a, b) => a + b, 0) || 1;
    const br = new Array(all.length).fill(0);
    for (let i = 1; i < all.length; i++) { let acc = 0; for (let j = 0; j < names.length; j++) acc += (w[j] / wsum) * rets[j][i]; br[i] = acc; }

    let cum = 1, peak = 1, mdd = 0; const curve = [];
    for (let i = 1; i < br.length; i++) {
      cum *= 1 + br[i]; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum / peak - 1);
      curve.push({ d: all[i] * 86400000, v: (cum - 1) * 100 });
    }
    const n = br.length - 1, total = (cum - 1) * 100;
    const mu = br.slice(1).reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(br.slice(1).reduce((a, x) => a + (x - mu) * (x - mu), 0) / (n - 1));
    const vol = sd * Math.sqrt(252) * 100;
    const ann = (Math.pow(cum, 252 / n) - 1) * 100;

    /* average pairwise correlation, capped at 25 names so the maths stays quick.
       Overlapping days only: a London listing has no bar during a New York session,
       and counting those flat zeros as returns would understate how alike the names are. */
    const pick = names.slice(0, 25), pr = rets.slice(0, 25), pt = traded.slice(0, 25);
    let csum = 0, cn = 0;
    for (let a = 0; a < pr.length; a++) for (let b = a + 1; b < pr.length; b++) {
      const xs = [], ys = [];
      for (let i = 1; i < all.length; i++) if (pt[a][i] && pt[b][i]) { xs.push(pr[a][i]); ys.push(pr[b][i]); }
      if (xs.length < 30) continue;
      const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
      let cov = 0, vx = 0, vy = 0;
      for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
      if (vx > 0 && vy > 0) { csum += cov / Math.sqrt(vx * vy); cn++; }
    }
    return {
      n: names.length, sessions: n, from: all[0] * 86400000, to: all[all.length - 1] * 86400000,
      total, ann, vol, sharpe: vol ? ann / vol : null, mdd: mdd * 100,
      corr: cn ? csum / cn : null, curve,
      per: names.map((s, j) => { const c = cols[j]; return { t: s.t, name: s.name, sector: s.sector, total: c[0] ? (c[c.length - 1] / c[0] - 1) * 100 : null, w: w[j] / wsum }; }),
    };
  };

  FD.aiStatus = async function () {
    try { const r = await fetch("/api/ai/status"); return r.ok ? await r.json() : { key: false }; }
    catch { return { key: false, offline: true }; }
  };

  /* Server-side Groq proxy: only the computed facts leave the browser, never an API key. */
  FD.askAI = async function (kind, facts) {
    const res = await fetch("/api/ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, facts }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.error) { const e = new Error(j.error); e.needsKey = !!j.needsKey; throw e; }
    return j;
  };

  /* ---------- relative ("perma") performance against an equal-weight benchmark ---------- */
  const dayOf = (ms) => Math.floor(ms / 86400000);
  function relSeries(target, pool, days) {
    const build = (x) => {
      const n = Math.min(x.closes.length, (x.tsDates || []).length, days);
      if (n < 20) return null;
      const m = new Map();
      for (let i = x.closes.length - n; i < x.closes.length; i++) m.set(dayOf(x.tsDates[i]), x.closes[i]);
      return m;
    };
    const tm = build(target);
    const bs = pool.filter(x => x !== target).map(build).filter(Boolean);
    if (!tm || !bs.length) return null;
    /* each listing trades on its own exchange calendar, so the axis is the union of
       every day anyone in the group traded and gaps carry the last close forward */
    const axis = [...new Set([...tm.keys(), ...bs.flatMap(m => [...m.keys()])])].sort((a, b) => a - b);
    const walk = (m) => {
      let last = null, base = null;
      return axis.map(d => {
        if (m.has(d)) last = m.get(d);
        if (last != null && base === null) base = last;
        return last == null || !base ? null : last / base - 1;
      });
    };
    const t = walk(tm), b = bs.map(walk);
    const rel = [];
    let carry = null;
    for (let i = 0; i < axis.length; i++) {
      const got = b.map(a => a[i]).filter(v => v != null);
      if (t[i] != null && got.length) carry = (t[i] - got.reduce((x, y) => x + y, 0) / got.length) * 100;
      rel.push(carry);
    }
    const from = rel.findIndex(v => v != null);
    return { dates: axis.slice(from).map(d => new Date(d * 86400000)), rel: rel.slice(from), pool: bs.length + 1 };
  }
  FD.relative = function (s, basis, days = 252) {
    const key = s.t + ":" + basis + ":" + days + ":" + FD.stocks.length;
    if (relCache.has(key)) return relCache.get(key);
    const pool = basis === "sector" ? FD.stocks.filter(x => x.sector === s.sector) : FD.stocks;
    const out = relSeries(s, pool, days);
    relCache.set(key, out);
    return out;
  };

  /* ============ TECHNICAL READS (computed from the real close series) ============ */
  const sigCache = new Map();
  const relCache = new Map();
  let sectorCache = null;
  function aggSectors(list) {
    const by = {};
    for (const s of list) {
      (by[s.sector] = by[s.sector] || []).push(s);
    }
    const out = {};
    for (const [sec, l] of Object.entries(by)) {
      const avg = (k) => mean(l.map(s => s.metrics[k]).filter(v => v != null));
      out[sec] = { n: l.length, perf12: avg("perf12"), perf3m: avg("perf3m"), perf1: avg("perf1"), rank: mean(l.map(s => s.rank)) };
    }
    return out;
  }
  function sectorStats() {
    if (sectorCache) return sectorCache;
    sectorCache = aggSectors(FD.stocks);
    return sectorCache;
  }

  FD.signals = function (s) {
    if (sigCache.has(s.t)) return sigCache.get(s.t);
    const c = s.closes || [], n = c.length, last = n ? c[n - 1] : null;
    const sma = (k, end = n) => (end >= k ? c.slice(end - k, end).reduce((a, b) => a + b, 0) / k : null);
    const ema = (k) => {
      if (n < k) return null;
      const m = 2 / (k + 1); let e = c.slice(0, k).reduce((a, b) => a + b, 0) / k;
      for (let i = k; i < n; i++) e = c[i] * m + e * (1 - m);
      return e;
    };
    const w = c.slice(-Math.min(n, 252));
    const hi52 = s.week52Hi != null ? Math.max(s.week52Hi, Math.max(...w)) : (w.length ? Math.max(...w) : null);
    const lo52 = s.week52Lo != null ? Math.min(s.week52Lo, Math.min(...w)) : (w.length ? Math.min(...w) : null);

    const e12 = ema(12), e26 = ema(26);
    const macd = e12 != null && e26 != null ? e12 - e26 : null;
    const macdSeries = [];
    if (n >= 26) {
      let fast = null, slow = null, mF = 2 / 13, mS = 2 / 27, sig = null;
      fast = c.slice(0, 12).reduce((a, b) => a + b, 0) / 12; slow = c.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
      const line = [];
      for (let i = 26; i < n; i++) { fast = c[i] * mF + fast * (1 - mF); slow = c[i] * mS + slow * (1 - mS); line.push(fast - slow); }
      const mG = 2 / 10; sig = line[0];
      for (let i = 1; i < line.length; i++) sig = line[i] * mG + sig * (1 - mG);
      if (macd != null) { macdSeries.push(sig); }
    }
    const macdSignal = macdSeries[0] ?? null;

    let vol = null, dd = null, peak = null;
    if (n > 30) {
      const rets = [];
      for (let i = Math.max(1, n - 126); i < n; i++) if (c[i - 1] > 0) rets.push(Math.log(c[i] / c[i - 1]));
      if (rets.length > 20) {
        const mu = mean(rets);
        vol = Math.sqrt(rets.reduce((a, x) => a + (x - mu) * (x - mu), 0) / (rets.length - 1)) * Math.sqrt(252) * 100;
      }
      peak = -Infinity; let worst = 0;
      for (const x of c) { if (x > peak) peak = x; worst = Math.min(worst, x / peak - 1); }
      dd = worst * 100;
    }
    const cur50 = sma(50), cur200 = sma(200), prev50 = sma(50, n - 20), prev200 = sma(200, n - 20);
    let cross = null;
    if (cur50 != null && cur200 != null) {
      if (prev50 != null && prev200 != null && prev50 <= prev200 && cur50 > cur200) cross = "golden";
      else if (prev50 != null && prev200 != null && prev50 >= prev200 && cur50 < cur200) cross = "death";
      else cross = cur50 > cur200 ? "bullish" : "bearish";
    }
    const ss = sectorStats()[s.sector];
    const out = {
      ok: n > 60, bars: n, last,
      sma20: sma(20), sma50: cur50, sma200: cur200, cross,
      above50: cur50 != null && last != null ? last >= cur50 : null,
      above200: cur200 != null && last != null ? last >= cur200 : null,
      hi52, lo52,
      fromHi: hi52 && last != null ? (last / hi52 - 1) * 100 : null,
      fromLo: lo52 && last != null ? (last / lo52 - 1) * 100 : null,
      rsi: s.metrics.rsi, macd, macdSignal,
      macdUp: macd != null && macdSignal != null ? macd >= macdSignal : null,
      vol, drawdown: dd, beta: s.metrics.beta,
      rel3m: ss && s.metrics.perf3m != null ? s.metrics.perf3m - ss.perf3m : null,
      rel12m: ss && s.metrics.perf12 != null ? s.metrics.perf12 - ss.perf12 : null,
      sector: ss || null,
    };
    sigCache.set(s.t, out);
    return out;
  };

  /* ============ ACTION — when to buy, hold or sell ============
     Not a forecast: the score is a sum of the rules stated below, and every level is a price
     that already exists in the record (an average, a gap edge, the 52-week high or low). */
  FD.action = function (s, rank) {
    const m = s.metrics, g = FD.signals(s);
    const bull = [], bear = [], watch = [];
    let score = 0;
    const V = (n, list, text) => { score += n; list.push(text); };
    if (!g.ok) return { tag: "No trend data", cls: "na", score: 0, bull, bear, watch: ["Fewer than 60 daily bars are published for this listing, so no trend rule can be applied."], plan: null };

    if (g.above200 && (g.cross === "bullish" || g.cross === "golden")) V(2, bull, `Trend intact: ${FD.fmt.num(g.last, 2)} sits above its 200-day average of ${FD.fmt.num(g.sma200, 2)}, with the 50-day (${FD.fmt.num(g.sma50, 2)}) above that.`);
    else if (g.above200) V(1, bull, `Above the 200-day average (${FD.fmt.num(g.sma200, 2)}), though the 50-day (${FD.fmt.num(g.sma50, 2)}) has not turned up yet.`);
    else V(-2, bear, `Below its 200-day average (${FD.fmt.num(g.last, 2)} vs ${FD.fmt.num(g.sma200, 2)}) — the long trend is against it.`);
    if (g.cross === "death") V(-2, bear, "Death cross within the last month: the 50-day average fell through the 200-day.");
    if (g.macdUp === true) V(1, bull, "MACD is above its signal line.");
    else if (g.macdUp === false) V(-1, watch, "MACD is below its signal line — the short-term thrust has gone.");

    if (rank >= 70) V(2, bull, `FactorRank ${Math.round(rank)}: top decile of your weighted blend.`);
    else if (rank >= 50) V(1, bull, `FactorRank ${Math.round(rank)}: above the universe median.`);
    else if (rank < 35) V(-2, bear, `FactorRank ${Math.round(rank)}: bottom third of the blend.`);
    if (s.type === "Momentum Trap") V(-2, bear, "Rally unbacked: price up while returns on capital stay low.");

    if (m.pe != null && m.pe > 0 && m.pe <= 15 && (m.peg == null || m.peg <= 1.5)) V(1, bull, `Earnings cost ${FD.fmt.num(m.pe, 1)}x with PEG ${FD.fmt.num(m.peg, 2)}x.`);
    else if (m.pe != null && m.pe > 35) V(-1, watch, `At ${FD.fmt.num(m.pe, 1)}x earnings there is no margin for a bad quarter.`);
    if (m.fcfYield != null && m.fcfYield >= 5) V(1, bull, `Free cash flow yield ${FD.fmt.num(m.fcfYield, 1)}%.`);
    else if (m.fcfYield != null && m.fcfYield <= 0) V(-1, bear, `Free cash flow yield ${FD.fmt.num(m.fcfYield, 1)}% — the business burns cash.`);
    if (m.payout != null && m.payout > 100 && m.divYield > 0) V(-2, bear, `The ${FD.fmt.num(m.divYield, 1)}% dividend pays out ${Math.round(m.payout)}% of earnings.`);

    if (m.fScore != null && m.fScore >= 7) V(1, bull, `Fundamental checks improving together (health ${Math.round(m.fScore)}/9).`);
    else if (m.fScore != null && m.fScore <= 3) V(-1, bear, `Most fundamental checks deteriorating (health ${Math.round(m.fScore)}/9).`);

    if (m.rsi != null && m.rsi >= 75) watch.push(`RSI ${Math.round(m.rsi)}: buying here chases strength rather than confirming it.`);
    if (m.rsi != null && m.rsi <= 30 && rank >= 50 && g.above200) V(1, bull, `RSI ${Math.round(m.rsi)} on a highly-ranked name in an uptrend — washed out, not broken.`);

    if (m.gap != null && Math.abs(m.gap) >= 3) {
      const edge = s.gapZone ? ` The unfilled gap edge is ${FD.fmt.num(s.gapZone.lo, 2)}–${FD.fmt.num(s.gapZone.hi, 2)}.` : "";
      if (m.gap < 0) { if (rank >= 50 && g.above200) V(1, bull, `Gapped down ${FD.fmt.num(m.gap, 1)}% while rank and trend hold — a price change, not a thesis change.${edge}`); else V(-1, bear, `Gapped down ${FD.fmt.num(m.gap, 1)}% overnight — sellers priced something in before the bell.${edge}`); }
      else watch.push(`Gapped up ${FD.fmt.num(m.gap, 1)}%; chase risk is highest on the first bar.${edge}`);
    }

    const tag = score >= 5 ? (g.above200 ? "Buy" : "Wait for the trend")
      : score >= 3 ? (g.above200 ? "Buy on weakness" : "Weak watch")
      : score >= 1 ? "Hold" : score >= -1 ? "Trim" : "Sell";
    const cls = tag === "Buy" ? "buy" : tag === "Buy on weakness" ? "buy" : tag === "Hold" ? "hold" : tag === "Trim" ? "trim" : tag === "Sell" ? "sell" : "watch";

    const below = [g.sma200, g.sma50, g.lo52, s.gapZone && s.gapZone.dir === "up" ? s.gapZone.lo : null]
      .filter(x => x != null && x < g.last);
    const above = [g.hi52, s.gapZone && s.gapZone.dir === "down" ? s.gapZone.hi : null]
      .filter(x => x != null && x > g.last);
    const stop = below.length ? Math.max(...below) : null;
    const target = above.length ? Math.min(...above) : null;
    const plan = {
      entry: m.rsi != null && m.rsi >= 70 && g.sma50 ? g.sma50 : g.last,
      entryNote: m.rsi != null && m.rsi >= 70 && g.sma50 ? "the 50-day average, since RSI is stretched" : "today's close — no stretched signal to wait for",
      stop, stopNote: stop === g.sma200 ? "200-day average" : stop === g.sma50 ? "50-day average" : stop === g.lo52 ? "52-week low" : "the unfilled gap edge below",
      target, targetNote: target === g.hi52 ? "52-week high" : "the unfilled gap edge above",
      risk: stop ? (g.last - stop) / g.last * 100 : null,
      reward: target ? (target - g.last) / g.last * 100 : null,
      rr: stop && target && g.last > stop ? (target - g.last) / (g.last - stop) : null,
    };
    return { tag, cls, score, bull, bear, watch, plan };
  };

  /* Human-readable chips for tables and report headers. */
  FD.chips = function (s) {
    const g = FD.signals(s), out = [];
    const add = (label, tone, title) => out.push({ label, tone, title });
    if (g.above200 != null) add(g.above200 ? "Above 200d avg" : "Below 200d avg", g.above200 ? "pos" : "neg",
      "Price " + FD.fmt.num(g.last, 2) + " vs 200-day average " + FD.fmt.num(g.sma200, 2));
    if (g.cross === "golden") add("Golden cross", "pos", "50-day average crossed above the 200-day average within the last month");
    if (g.cross === "death") add("Death cross", "neg", "50-day average crossed below the 200-day average within the last month");
    if (g.fromHi != null) add(g.fromHi <= -1 ? FD.fmt.num(-g.fromHi, 0) + "% off high" : "At 52-week high",
      g.fromHi <= -20 ? "neg" : g.fromHi <= -10 ? "warn" : "pos", "Close vs 52-week high " + FD.fmt.num(g.hi52, 2));
    if (g.rsi != null) add("RSI " + Math.round(g.rsi), g.rsi >= 70 ? "warn" : g.rsi <= 30 ? "warn" : "pos",
      g.rsi >= 70 ? "Stretched short-term" : g.rsi <= 30 ? "Washed out short-term" : "Neutral short-term thrust");
    if (g.rel3m != null) add("3m vs sector " + FD.fmt.pct(g.rel3m, 0), g.rel3m >= 0 ? "pos" : "neg",
      "Three-month price change minus the average for " + s.sector);
    if (g.vol != null) add("Vol " + FD.fmt.num(g.vol, 0) + "%", g.vol >= 45 ? "warn" : "pos", "Annualised daily volatility over the last six months");
    return out;
  };

  /* ============ INVESTMENT POINTS — deterministic, every line cites a number ============ */
  const kv = (label, v, dp = 1, suf = "") => (v == null ? null : `${label} ${FD.fmt.num(v, dp)}${suf}`);
  const jnl = (...xs) => { const k = xs.filter(Boolean); return k.length ? k.join(", ") : "not published"; };

  FD.points = function (s) {
    const m = s.metrics, f = s.factors, g = FD.signals(s), bull = [], bear = [], watch = [];
    let score = 0;
    const B = (n) => { score += n; };

    if (f.quality >= 70) { bull.push(`Quality sits in the top third of the universe (${Math.round(f.quality)}/100) on ${jnl(kv(s.roceBasis, m.roce, 1, "%"), kv("health read", m.fScore, 0, "/9"))}.`); B(2); }
    else if (f.quality >= 55) { bull.push(`Quality ${Math.round(f.quality)}/100 — profitable enough to clear the universe median.`); B(1); }
    else if (f.quality < 35) { bear.push(`Quality ${Math.round(f.quality)}/100 is bottom-third: ${jnl(kv(s.roceBasis, m.roce, 1, "%"), kv("gross margin", m.grossMargin, 1, "%"))}.`); B(-2); }

    if (f.value >= 65) { bull.push(`Cheap on the published value legs (value score ${Math.round(f.value)}): ${jnl(kv("P/E", m.pe, 1, "x"), kv("P/BV", m.pb, 1, "x"), kv("FCF yield", m.fcfYield, 1, "%"), kv("dividend", m.divYield, 1, "%"))}.`); B(2); }
    else if (f.value <= 30) { bear.push(`Priced richly versus the universe (value score ${Math.round(f.value)}): ${jnl(kv("P/E", m.pe, 1, "x"), kv("P/BV", m.pb, 1, "x"))}.`); B(-1); }

    if (f.momentum >= 65 && g.above200) { bull.push(`Trend and tape agree: momentum ${Math.round(f.momentum)}/100, ${FD.fmt.pct(m.perf12)} over a year, price above its 200-day average.`); B(2); }
    else if (f.momentum <= 35) { bear.push(`Momentum ${Math.round(f.momentum)}/100 — ${FD.fmt.pct(m.perf12)} over 12 months, ${FD.fmt.pct(m.perf3m)} in the last quarter.`); B(-1); }
    if (s.type === "Momentum Trap") { bear.push(`Screens as a momentum trap: price up ${FD.fmt.pct(m.perf12)} while quality is only ${Math.round(f.quality)}/100 — unbacked rallies are the ones that give it back.`); B(-2); }

    if (m.fScore >= 7) { bull.push(`Health read ${Math.round(m.fScore)}/9 — most fundamental checks (margin, leverage, coverage, growth) improved at once.`); B(1); }
    if (m.netDebtEq != null && m.netDebtEq > 100) { bear.push(`Balance sheet is the risk: net debt/equity ${FD.fmt.num(m.netDebtEq)}% with interest cover ${FD.fmt.num(m.intCover)}x.`); B(-2); }
    else if (m.netDebtEq != null && m.netDebtEq < 0) { bull.push(`Net cash position (${FD.fmt.num(m.netDebtEq)}% net debt/equity) — optionality in a downturn.`); B(1); }

    if (m.perf12 != null && m.revG != null && m.perf12 < -20 && m.revG < 0) { bear.push(`Falling knife: ${FD.fmt.pct(m.perf12)} over a year while revenue also shrank ${FD.fmt.pct(m.revG)}.`); B(-2); }
    if (m.epsGrowth > 15 && m.revG > 5) { bull.push(`Fundamentals accelerating: earnings ${FD.fmt.pct(m.epsGrowth)}, revenue ${FD.fmt.pct(m.revG)} (latest reported quarter).`); B(1); }
    if (m.peg != null && m.peg > 0 && m.peg < 1.2) { bull.push(`P/E is covered by growth — PEG ${FD.fmt.num(m.peg, 2)}.`); B(1); }
    if (m.peg > 2.5) { bear.push(`Growth is expensive here: PEG ${FD.fmt.num(m.peg, 2)}.`); B(-1); }

    /* dividend sustainability, from the two published numbers that decide it */
    if (m.divYield > 0 && m.payout != null && m.payout > 100) { bear.push(`The ${FD.fmt.num(m.divYield, 1)}% dividend costs more than the business earns: payout ${Math.round(m.payout)}% of earnings.`); B(-2); }
    else if (m.divYield > 0 && m.payout != null && m.payout < 50 && m.fcfYield != null && m.fcfYield > 4) { bull.push(`Dividend is comfortably funded: ${FD.fmt.num(m.divYield, 1)}% yield on a ${Math.round(m.payout)}% payout, with ${FD.fmt.num(m.fcfYield, 1)}% free cash flow yield behind it.`); B(1); }

    if (g.fromHi != null) {
      if (g.fromHi > -8 && g.above200) { bull.push(`Only ${FD.fmt.num(-g.fromHi, 1)}% below its 52-week high (${FD.fmt.num(g.hi52, 2)}) with the trend intact.`); B(1); }
      if (g.fromHi < -35) { watch.push(`Deep drawdown: ${FD.fmt.pct(g.fromHi, 0)} below the 52-week high; worst peak-to-trough in the window was ${FD.fmt.num(g.drawdown, 1)}%.`); }
    }
    if (g.vol != null && g.vol > 50) { bear.push(`Swing risk is high: ${FD.fmt.num(g.vol, 0)}% annualised volatility, beta ${FD.fmt.num(m.beta, 2)}.`); B(-1); }
    if (g.rsi != null && g.rsi >= 75) watch.push(`RSI(14) at ${Math.round(g.rsi)} — short-term stretched; a pullback toward the 50-day average (${FD.fmt.num(g.sma50, 2)}) is the ordinary course.`);
    if (g.rsi != null && g.rsi <= 25 && f.quality >= 60) watch.push(`Oversold at RSI ${Math.round(g.rsi)} in a business that still scores ${Math.round(f.quality)}/100 on quality — the classic contrarian setup, with no guarantee of a floor.`);
    if (m.shortPct != null && m.shortPct > 8) watch.push(`Short interest ${FD.fmt.num(m.shortPct)}% of float (${FD.fmt.num(m.shortDays)} days to cover) — squeezes possible, conviction against it is real.`);
    if (s.target && m.price) watch.push("Sell-side mean target " + FD.fmt.px(s, s.target) + " is " + FD.fmt.pct((s.target / m.price - 1) * 100, 0) + " from today" + (s.rec ? ", consensus labelled " + s.rec.replace(/_/g, " ") : "") + " — a crowd datapoint, not a forecast.");
    if (s.nextEarnings) watch.push(`Next reported earnings on ${new Date(s.nextEarnings).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} — the single biggest scheduled change in available information.`);
    if (m.fScore == null || m.roce == null) watch.push(`Some fundamentals are not reported for this listing; factor scores use only the legs that exist, so read them as partial.`);

    const verdict = score >= 6 ? { label: "Constructive", tone: "good" }
      : score >= 3 ? { label: "Leaning positive", tone: "good" }
      : score >= 0 ? { label: "Balanced — no edge", tone: "" }
      : score >= -3 ? { label: "Cautious", tone: "warn" }
      : { label: "Negative on the rules", tone: "bad" };

    return { score, verdict, bull, bear, watch: watch.slice(0, 5), bars: { bull: bull.length, bear: bear.length } };
  };

  /* ============ MARKET-WIDE READS ============ */
  /* every one of these takes an optional list so a single market can be read the
     same way as the whole universe — the maths is identical either way */
  FD.pulse = function (list) {
    list = list || FD.stocks;
    let above200 = 0, known200 = 0, above50 = 0, known50 = 0;
    for (const s of list) {
      const g = FD.signals(s);
      if (g.above200 != null) { known200++; if (g.above200) above200++; }
      if (g.above50 != null) { known50++; if (g.above50) above50++; }
    }
    const monthReturns = list.map(s => s.metrics.perf1).filter(v => Number.isFinite(v));
    const adv1 = monthReturns.filter(v => v > 0).length;
    const dec1 = monthReturns.filter(v => v < 0).length;
    const unchanged1 = monthReturns.filter(v => v === 0).length;
    const yearReturns = list.map(s => s.metrics.perf12).filter(v => Number.isFinite(v));
    return {
      n: list.length,
      breadth200: known200 ? above200 / known200 * 100 : null,
      breadth200Known: known200,
      breadth50: known50 ? above50 / known50 * 100 : null,
      breadth50Known: known50,
      medianPerf: median(yearReturns),
      medianPerfKnown: yearReturns.length,
      medianPerf1: median(monthReturns),
      medianPerf1Known: monthReturns.length,
      advancers1m: adv1, decliners1m: dec1, unchanged1m: unchanged1, knownPerf1m: monthReturns.length,
      asof: FD.liveAsof,
    };
  };

  FD.sectorTable = function (list) {
    return Object.entries(list ? aggSectors(list) : sectorStats())
      .map(([sector, v]) => ({ sector, ...v }))
      .filter(r => r.n >= 3 && r.sector && r.sector !== "Other")
      .sort((a, b) => (b.perf3m ?? -999) - (a.perf3m ?? -999));
  };

  FD.movers = function (key = "perf3m", n = 6, list) {
    const rows = (list || FD.stocks).filter(s => s.metrics[key] != null);
    return { up: [...rows].sort((a, b) => b.metrics[key] - a.metrics[key]).slice(0, n),
      down: [...rows].sort((a, b) => a.metrics[key] - b.metrics[key]).slice(0, n) };
  };

  /* ---------- single-market scope ---------- */
  FD.MARKETS = () => {
    const c = {};
    for (const s of FD.stocks) c[s.country] = (c[s.country] || 0) + 1;
    return Object.entries(c).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).map(([country, n]) => ({ country, n }));
  };
  FD.marketName = () => FD.store.get("market", "Global");
  FD.marketList = () => {
    const m = FD.marketName();
    return m === "Global" ? FD.stocks : FD.stocks.filter(s => s.country === m);
  };
  /* the domestic index and FX pair are matched on the published macro feed by name,
     so a market with no listed instrument simply returns null and is left out of the screen */
  FD.marketIndex = (name) => {
    if (name === "Global") return null;
    const want = { "United States": /S&P 500/i, "United Kingdom": /FTSE 100/i, "Japan": /Nikkei/i, "Australia": /ASX/i,
      "Hong Kong": /Hang Seng/i, "India": /Sensex/i, "Germany": /DAX/i, "France": /CAC/i, "Spain": /IBEX/i,
      "Singapore": /ST\.?I/i, "Switzerland": /SMI/i, "China": /CSI|HANG SENG/i }[name];
    return want ? FD.macro.find(x => x.g === "index" && want.test(x.n)) || null : null;
  };
  FD.marketFx = (name) => {
    const cur = (FD.stocks.find(s => s.country === name) || {}).currency || "";
    const pair = { "United Kingdom": /GBP/i, "Japan": /JPY/i, "Australia": /AUD/i, "Switzerland": /CHF/i, "China": /CNY/i, "India": /INR/i }[name];
    if (name === "United States") return FD.macro.find(x => /dollar index/i.test(x.n)) || null;
    if (pair) return FD.macro.find(x => x.g === "fx" && pair.test(x.n)) || null;
    return /USD/.test(cur) ? FD.macro.find(x => /dollar index/i.test(x.n)) || null : null;
  };

  FD.riskRegime = function () {
    const vol = FD.macro.find(x => /VIX/i.test(x.n)) || FD.macro.find(x => x.g === "vol");
    const v = vol ? vol.v : null;
    const label = v == null ? "Unknown" : v < 15 ? "Calm" : v < 20 ? "Normal" : v < 28 ? "Elevated" : "Stressed";
    const tone = v == null ? "" : v < 20 ? "good" : v < 28 ? "warn" : "bad";
    return { label, tone, v, vix: v, instrument: vol || null };
  };

  FD.macroBy = function (group) { return FD.macro.filter(x => x.g === group); };

  /* ============ PER-STOCK DRIVER ANALYSIS ============
     Everything below is measured between two published price series. The links are
     stated as relationships that were observed, never as forecasts. */
  const HOME_INDEX = {
    "United States": "^GSPC", "United Kingdom": "^FTSE", "Japan": "^N225", "Germany": "^GDAXI",
    "France": "^FCHI", "Spain": "^IBEX", "Australia": "^AXJO", "India": "^BSESN",
    "Hong Kong": "^HSI", "Macau": "^HSI", "China": "EEM",
    "Netherlands": "^STOXX50E", "Ireland": "^STOXX50E", "Italy": "^STOXX50E",
    "Switzerland": "^STOXX50E", "Singapore": "EFA", "Canada": "EFA", "Mexico": "EEM", "Uruguay": "EEM",
  };
  const PROXY = new Set(["EEM", "EFA"]);
  const FX_PAIR = { GBp: "GBPUSD=X", GBP: "GBPUSD=X", EUR: "EURUSD=X", JPY: "USDJPY=X", AUD: "AUDUSD=X" };
  const SECTOR_ETF = {
    Energy: "XLE", Financials: "XLF", Technology: "XLK", "Health Care": "XLV", Industrials: "XLI",
    "Consumer Staples": "XLP", Utilities: "XLU", "Basic Materials": "XLB", "Real Estate": "XLRE",
    "Communication Services": "XLC", "Consumer Discretionary": "XLY",
  };
  const COMMODITY_LINK = {
    Energy: [["BZ=F", "Brent crude — the price a barrel of its output is worth"]],
    "Basic Materials": [["HG=F", "copper — the metal price behind mining and materials margins"], ["GC=F", "gold — the price miners sell into"]],
    Utilities: [["NG=F", "natural gas — the marginal fuel that sets power prices"]],
    "Consumer Staples": [["CB=F", "corn — one of the farm inputs behind food costs"], ["SB=F", "sugar"]],
    Financials: [["^TNX", "the 10-year yield — the spread business is priced off"]],
    "Real Estate": [["^TNX", "the 10-year yield — the discount rate on long leases"]],
  };

  const retByDay = (dates, closes) => {
    const m = new Map();
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] == null || closes[i - 1] == null || !closes[i - 1]) continue;
      m.set(Math.floor(dates[i] / 86400000), closes[i] / closes[i - 1] - 1);
    }
    return m;
  };

  /* how this stock has actually behaved against another series, on days both traded */
  FD.coMove = function (a, b, n = 126) {
    if (!a || !b || !a.dates || !b.dates) return null;
    const ra = retByDay(a.dates, a.closes), rb = retByDay(b.dates, b.closes);
    const shared = [...ra.keys()].filter(k => rb.has(k)).sort((x, y) => x - y).slice(-n);
    if (shared.length < 40) return null;
    const xs = shared.map(k => ra.get(k)), ys = shared.map(k => rb.get(k));
    const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
    let cov = 0, vy = 0, vx = 0;
    for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vy += dy * dy; vx += dx * dx; }
    if (!vy || !vx) return null;
    return { n: shared.length, beta: cov / vy, corr: cov / Math.sqrt(vx * vy) };
  };

  FD.stockDrivers = function (s) {
    const out = [];
    const m = s.metrics;
    const ser = (sym) => FD.macro.find(x => x.s === sym);
    const push = (name, num, why, tone) => out.push({ name, num, why, tone: tone || "" });
    const chg = (x, k) => x && x[k] != null ? FD.fmt.pct(x[k], 1) : null;

    /* 1 — the market it is listed on */
    const idxSym = HOME_INDEX[s.country];
    const idx = idxSym && ser(idxSym);
    if (idx) {
      const co = FD.coMove({ dates: s.tsDates, closes: s.closes }, { dates: idx.dates, closes: idx.closes });
      push(`${idx.n}${PROXY.has(idxSym) ? " — regional proxy" : ""} · ${idx.s}`,
        co ? `${FD.fmt.num(co.beta, 2)}x · correlation ${FD.fmt.num(co.corr, 2)}` : "not measurable",
        `The index itself is ${chg(idx, "q")} over 3 months and ${chg(idx, "y")} over a year. ` +
        (co ? `On the ${co.n} sessions both markets were open, a 1% move in the index came with ${FD.fmt.num(co.beta, 2)}% here, and the two series explained ${FD.fmt.num(co.corr * co.corr * 100, 0)}% of each other's daily swings.`
            : "The two have no shared trading history long enough to measure, so no relationship is claimed."),
        idx.q >= 0 ? "pos" : "neg");
    }
    /* 2 — published beta as the cross-check */
    if (m.beta != null) push("Published beta", `${FD.fmt.num(m.beta, 2)}x`,
      `Yahoo's own beta, taken from roughly five months of monthly closes. It disagrees with the daily number above because the windows differ, not because either is wrong — which is why both are shown.`,
      m.beta > 1.2 ? "neg" : m.beta < 0.8 ? "pos" : "");

    /* 3 — the sector */
    const sec = FD.sectorTable().find(r => r.sector === s.sector);
    const etf = ser(SECTOR_ETF[s.sector]);
    if (sec) {
      const rel = m.perf3m != null && sec.perf3m != null ? m.perf3m - sec.perf3m : null;
      push(`${s.sector} (universe)`, `${FD.fmt.pct(sec.perf3m, 1)} in 3 months across ${sec.n} names`,
        `The share itself is ${FD.fmt.pct(m.perf3m, 1)} over the same quarter — ${rel == null ? "not comparable" : rel >= 0 ? FD.fmt.num(rel, 1) + "% better, so the move is company-specific" : FD.fmt.num(-rel, 1) + "% worse, so the sector is doing the moving"}.${etf ? ` The US ${etf.n} ETF is ${chg(etf, "q")} over the quarter as a second read.` : ""}`,
        sec.perf3m >= 0 ? "pos" : "neg");
    }

    /* 4 — rates */
    const t10 = ser("^TNX"), t2 = ser("^FVX");
    if (t10) {
      const moveBp = t10.closes && t10.closes.length > 63 ? (t10.closes[t10.closes.length - 1] - t10.closes[t10.closes.length - 64]) * 100 : null;
      const sensitive = (m.pe > 25 || s.sector === "Utilities" || s.sector === "Real Estate" || m.divYield > 4);
      push("US 10-year yield", `${FD.fmt.num(t10.v, 2)}%${moveBp != null ? ", " + FD.fmt.num(moveBp, 0) + "bp over 3 months" : ""}`,
        `${sensitive ? "This one is rate-sensitive — " : "Not obviously rate-sensitive. "}Long-dated cash flows are discounted at this rate${t2 ? `, and the front end (5-year, ${FD.fmt.num(t2.v, 2)}%) decides what refinancing costs next year` : ""}.`, moveBp > 25 ? "neg" : moveBp < -25 ? "pos" : "");
    }

    /* 5 — risk appetite and the volatility regime */
    const reg = FD.riskRegime();
    if (reg.instrument) push("Volatility (VIX)", `${FD.fmt.num(reg.v, 1)} — ${reg.label}`,
      `Where the fear index sits now (${chg(reg.instrument, "m")} over a month). Higher VIX compresses multiples on the speculative end of the universe, which is where this name's factor scores are most reactive.`, reg.tone === "good" ? "pos" : reg.tone === "bad" ? "neg" : "");
    const cred = ser("HYGM");
    if (cred) push("Credit appetite", `${chg(cred, "m")} in a month`,
      `An investment-grade credit ETF: when spreads widen this fund falls first, and equity multiples follow with a lag.`);

    /* 6 — breadth: how many peers are in an uptrend */
    const p = FD.pulse();
    if (p.breadth200 != null) push("Market breadth", `${FD.fmt.num(p.breadth200, 0)}% above their 200-day`,
      `Across the ${p.n} live listings. A stock can outrun a weak tape, but a falling breadth number has rarely accompanied a durable rally.`, p.breadth200 >= 55 ? "pos" : p.breadth200 < 40 ? "neg" : "");

    /* 7 — currency, because the price and the reader may not share one */
    const fxSym = FX_PAIR[s.ccy] || FX_PAIR[s.currency];
    const fx = fxSym && ser(fxSym);
    if (fx) push(`Currency (${fx.n})`, `${chg(fx, "q")} in 3 months`,
      `The share is quoted in ${s.ccy === "GBp" ? "pence/sterling" : s.ccy || s.currency}, so for a sterling or dollar investor part of the reported return is the exchange rate, not the business: a ${chg(fx, "y")} move in the pair over a year is worth that much of the value of the position on its own.`);

    /* 8 — the input the sector actually buys or sells */
    for (const [sym, note] of (COMMODITY_LINK[s.sector] || [])) {
      const c = ser(sym);
      if (!c) continue;
      push(`${c.n} (input)`, `${chg(c, "m")} in a month, ${chg(c, "q")} in 3 months`,
        `Linked by the ${s.sector.toLowerCase()} cost or revenue line: ${note}.`);
    }

    /* 9 — the company-specific residual over a year */
    if (idx && m.perf12 != null && idx.y != null) {
      const idio = m.perf12 - idx.y;
      push("Company-specific return", `${FD.fmt.pct(idio, 1)} vs its index (12m)`,
        `The share is ${FD.fmt.pct(m.perf12, 1)} over a year while ${idx.n} did ${FD.fmt.pct(idx.y, 1)}, before currency. Roughly this much of the outcome came from the business rather than the market.` +
        ` Currency and consolidation make this an approximation, not an accounting.`,
        idio >= 0 ? "pos" : "neg");
    }
    if (s.nextEarnings) push("Next earnings", new Date(s.nextEarnings).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
      `The largest scheduled change in what is known about this company. Positions are carried through it at the risk of a gap no stop can catch.`);

    /* 10 — positioning and flow that the feed publishes */
    if (m.shortPct != null) push("Short interest", `${FD.fmt.num(m.shortPct, 1)}% of float`,
      `${m.shortDays != null ? FD.fmt.num(m.shortDays, 1) + " days to cover. " : ""}Crowded bets against a name move the price on days the fundamentals do not.`, m.shortPct > 8 ? "neg" : "");
    if (m.divYield > 0) push("Dividend", `${FD.fmt.num(m.divYield, 2)}% yield${m.payout != null ? `, ${Math.round(m.payout)}% of earnings` : ""}`,
      `The cash paid while the holder waits. Above a 100% payout the dividend is being funded from something other than profit, and that is the number that decides whether it survives.`);
    if (m.gap != null) push("Overnight gap", `${FD.fmt.pct(m.gap, 2)} at the last open`,
      `${m.gapCount != null ? m.gapCount + " days in the past year moved more than 1.5% between the close and the next open. " : ""}Gap risk is the part of the daily swing no intraday stop can catch, because the price changes while the market is shut${s.gapZone ? `. The nearest unfilled gap runs ${FD.fmt.num(s.gapZone.lo, 2)}–${FD.fmt.num(s.gapZone.hi, 2)}, ${s.gapZone.dir === "up" ? "support" : "resistance"} until price trades back through it` : ""}.`);

    return { rows: out, asof: FD.liveAsof };
  };

  /* ============ shared API ============ */
  FD.rankedWith = function (w) {
    return FD.stocks.map(s => ({ ...s, liveRank:
      (s.factors.quality * w.quality + s.factors.value * w.value +
      s.factors.momentum * w.momentum + s.factors.growth * w.growth + s.factors.smallcap * w.smallcap) / 100 }))
      .sort((a, b) => b.liveRank - a.liveRank);
  };

  const seriesCache = new Map();
  /* Five years of daily open/high/low/close arrives on demand — the universe payload only
     carries the 260-bar close window the rankings and backtests need. A null result means the
     listing publishes no history, which the chart says out loud rather than drawing a guess. */
  const barsCache = new Map();
  FD.bars = function (t) {
    if (!barsCache.has(t)) barsCache.set(t, (async () => {
      try {
        const r = await fetch("/api/bars/" + encodeURIComponent(t));
        if (!r.ok) return null;
        const j = await r.json();
        if (!(j && j.dates && j.dates.length)) return null;
        j.dates = j.dates.map(d => (d instanceof Date ? d : new Date(d)));
        return j;
      } catch { return null; }
    })());
    return barsCache.get(t);
  };

  FD.series = function (s) {
    if (seriesCache.has(s.t)) return seriesCache.get(s.t);
    const closes = s.closes || [];
    let out;
    if (closes.length > 1) {
      let dates = (s.tsDates || []).map(ts => new Date(ts));
      if (dates.length !== closes.length || dates.some(d => isNaN(d))) {
        const anchor = FD.liveAsof || new Date();
        dates = closes.map((_, i) => { const x = new Date(anchor); x.setDate(x.getDate() - Math.round((closes.length - 1 - i) * 1.42)); return x; });
      }
      out = { dates, closes };
    } else {
      out = { dates: [], closes: [] };
    }
    seriesCache.set(s.t, out);
    return out;
  };

  FD.decileTable = function () {
    const sorted = [...FD.stocks].sort((a, b) => b.rank - a.rank);
    const out = [];
    for (let d = 0; d < 10; d++) {
      const seg = sorted.slice(Math.floor(d * sorted.length / 10), Math.floor((d + 1) * sorted.length / 10));
      const perfs = seg.map(s => s.metrics.perf12).filter(v => v != null);
      out.push({ decile: d + 1, perf: perfs.length ? mean(perfs) : 0, n: seg.length });
    }
    return out;
  };

  FD.fmt = {
    px(s, v) { if (v == null) return "—"; return s.currency + (v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2)); },
    pct(v, dp = 1) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(dp) + "%"; },
    num(v, dp = 1) { return v == null ? "—" : v.toFixed(dp); },
    cap(v, ccy) { return v == null ? "—" : (ccy || "£") + (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + "bn"; },
    date(d) { return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }); },
  };
  const fmtAsOf = (d) => (d || new Date()).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  FD.asOf = fmtAsOf();

  FD.store = {
    get(k, dflt) { try { const v = JSON.parse(localStorage.getItem("fd." + k)); return v ?? dflt; } catch { return dflt; } },
    set(k, v) { localStorage.setItem("fd." + k, JSON.stringify(v)); },
  };
  FD.watchlist = {
    all: () => FD.store.get("watch", {}),
    has: (t) => !!FD.watchlist.all()[t],
    toggle(t) { const w = FD.watchlist.all(); w[t] ? delete w[t] : w[t] = { added: Date.now() }; FD.store.set("watch", w); },
    note(t, txt) { const w = FD.watchlist.all(); if (w[t]) { w[t].note = txt; FD.store.set("watch", w); } },
  };
  FD.portfolio = {
    all: () => FD.store.get("pf", []),
    upsert(entry) { const p = FD.portfolio.all(); const i = p.findIndex(x => x.t === entry.t);
      i >= 0 ? (p[i] = entry) : p.push(entry); FD.store.set("pf", p); },
    remove(t) { FD.store.set("pf", FD.portfolio.all().filter(x => x.t !== t)); },
  };
  FD.get = (t) => FD.stocks.find(s => s.t === t);

  /* ---------- market tape ---------- */
  FD.renderTape = async function (el) {
    if (!el) return;
    const escT = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    let items = [];
    try {
      const r = await fetch("/api/tickers");
      if (r.ok) items = (await r.json()).tickers || [];
    } catch { /* server offline — handled by the error state */ }
    if (!items.length) { el.hidden = true; return; }
    const run = items.map(i => `<span class="tape-item"><b>${escT(i.n)}</b>${i.v.toLocaleString("en-GB", { maximumFractionDigits: 2 })}<span class="${i.c >= 0 ? "pos" : "neg"}">${i.c >= 0 ? "▲" : "▼"} ${Math.abs(i.c).toFixed(2)}%</span></span>`).join('<span class="tape-sep">|</span>');
    el.innerHTML = `<div class="tape-track">${run}<span class="tape-sep">|</span>${run}<span class="tape-sep">|</span></div>`;
  };
  FD.DEFAULT_WEIGHTS = { quality: 35, value: 25, momentum: 25, growth: 10, smallcap: 5 };
})();
