/* FactorDesk backtest — point-in-time rules over real traded prices.
   A signal at date p may only use closes dated <= p; forward returns use closes after p.
   Only price-derived legs are tested: today's P/E or ROCE were not knowable at past dates,
   so a fundamentals-ranked backtest would be look-ahead and is reported as impossible instead. */
const fs = require("fs");
const path = require("path");

const HIST_FILE = path.join(__dirname, ".cache-history.json");
const HIST_TTL = 24 * 3600 * 1000;
const COST_BPS = 20;           // 0.20% per side, charged on the traded fraction
const STEP = 21;               // rebalance roughly monthly
const HORIZONS = [21, 63, 126];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ---------- 2y of daily closes per symbol, cached on disk ---------- */
async function fetchHistory(symbols, concurrency = 5) {
  const out = {};
  let i = 0, failed = 0;
  async function grab(t) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=5y&interval=1d`, { headers: { "User-Agent": UA } });
        if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 600 * (attempt + 1))); continue; }
        if (!res.ok) return null;
        const j = await res.json();
        const r = j.chart && j.chart.result && j.chart.result[0];
        const cl = r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
        const ts = r && r.timestamp;
        if (!cl || !ts) return null;
        const sec = ts[0] < 1e12;   // chart timestamps are epoch seconds; the python path sends ms
        /* exchange clocks differ (London closes hours after Tokyo), so bucket to the UTC
           day — otherwise one calendar day becomes several "dates" and every window skews */
        const d = [], c = [];
        for (let k = 0; k < Math.min(cl.length, ts.length); k++) {
          if (cl[k] == null || !isFinite(cl[k])) continue;
          const day = Math.floor((sec ? ts[k] * 1000 : ts[k]) / 86400000);
          if (d.length && d[d.length - 1] === day) { c[c.length - 1] = cl[k]; continue; }
          d.push(day); c.push(cl[k]);
        }
        return c.length > 260 ? { d, c } : null;
      } catch { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
    }
    return null;
  }
  async function worker() {
    while (i < symbols.length) {
      const t = symbols[i++];
      const h = await grab(t);
      if (h) out[t] = h; else failed++;
      await new Promise(r => setTimeout(r, 25));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  fetchHistory.failed = failed;
  return out;
}

async function getHistory(symbols, fetcher) {
  const stamp = symbols.length + symbols.join("").length;
  try {
    const j = JSON.parse(fs.readFileSync(HIST_FILE, "utf8"));
    if (j.saved && Date.now() - j.saved < HIST_TTL && j.stamp === stamp) return { map: j.map, fresh: false };
  } catch { /* no history cache yet */ }
  const map = await (fetcher || fetchHistory)(symbols);
  try { fs.writeFileSync(HIST_FILE, JSON.stringify({ saved: Date.now(), stamp, map })); } catch { /* cache write is best-effort */ }
  return { map, fresh: true };
}

/* ---------- maths ---------- */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function zscores(list) { // list: [{t, v}] -> Map t -> z, blanks dropped
  const v = list.filter(x => x.v != null && isFinite(x.v));
  const m = mean(v.map(x => x.v)), s = sd(v.map(x => x.v)) || 1;
  const out = new Map();
  for (const x of v) out.set(x.t, Math.max(-3, Math.min(3, (x.v - m) / s)));
  return out;
}
function quintiles(vals) {
  const s = vals.slice().sort((a, b) => b.v - a.v);
  const n = Math.max(5, Math.floor(s.length * 0.2));
  return { top: s.slice(0, n).map(x => x.t), bottom: s.slice(-n).map(x => x.t) };
}

/* ---------- price legs, each reading only bars at or before the stock's own index ---------- */
function legsAt(c, i) {
  const at = (k) => (i - k >= 0 ? c[i - k] : NaN);
  const mom12_1 = isFinite(at(21)) && isFinite(at(147)) ? at(21) / at(147) - 1 : null;
  const mom6 = isFinite(at(21)) && isFinite(at(84)) ? at(21) / at(84) - 1 : null;
  let trend = null;
  if (i >= 199) { let m = 0; for (let k = 0; k < 200; k++) m += c[i - k]; trend = c[i] / (m / 200) - 1; }
  const rev1m = i >= 21 && isFinite(at(21)) ? -(c[i] / at(21) - 1) : null;
  return { mom12_1, mom6, trend, rev1m };
}

const LEG_DEFS = [
  { key: "mom12_1", label: "12-1 momentum — buy the 12m winners, skip the last month", warm: 148 },
  { key: "mom6", label: "6-month momentum", warm: 85 },
  { key: "trend", label: "Trend — buy the strongest gap above the 200-day average", warm: 200 },
  { key: "rev1m", label: "1-month reversal — buy the most recent losers", warm: 22 },
  { key: "blend", label: "Chart blend — momentum + trend + reversal, equal weight", warm: 148, blend: true },
];

/* last session index dated <= ts, or null if the stock had not listed yet */
function idxAt(dates, ts) {
  let lo = 0, hi = dates.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function runBacktest(stocks, hist) {
  /* each stock keeps its own session list — no shared calendar, so a London or
     Tokyo listing is not thrown away because an exchange holiday broke the grid */
  const named = new Set(stocks.map(s => s.t));
  const series = new Map();
  for (const t in hist) if (named.has(t) && hist[t].c.length > 260) series.set(t, hist[t]);
  if (series.size < 60) return { error: "too few symbols with usable history", bars: 0 };

  const all = new Set();
  for (const [, s] of series) for (const d of s.d) all.add(d);
  const axis = [...all].sort((a, b) => a - b);

  /* rebalance roughly monthly once the longest leg has its warm-up */
  const rebal = [];
  for (let p = 250; p + STEP < axis.length; p += STEP) rebal.push(axis[p]);
  if (rebal.length < 6) return { error: "not enough rebalance dates", bars: axis.length };

  /* one snapshot per rebalance date: every leg value plus the stock's own index */
  const snaps = rebal.map(ts => {
    const raw = new Map();
    for (const [t, s] of series) {
      const i = idxAt(s.d, ts);
      if (i == null || i < 21) continue;
      const v = legsAt(s.c, i);
      if (v.mom12_1 == null && v.mom6 == null && v.trend == null && v.rev1m == null) continue;
      v._i = i; raw.set(t, v);
    }
    const z = { mom12_1: zscores([...raw].map(([t, v]) => ({ t, v: v.mom12_1 }))),
                trend: zscores([...raw].map(([t, v]) => ({ t, v: v.trend }))),
                rev1m: zscores([...raw].map(([t, v]) => ({ t, v: v.rev1m }))) };
    for (const [t, v] of raw) v.blend = (z.mom12_1.get(t) != null && z.trend.get(t) != null && z.rev1m.get(t) != null)
      ? (z.mom12_1.get(t) + z.trend.get(t) + z.rev1m.get(t)) / 3 : null;
    return { ts, raw };
  });

  const legs = LEG_DEFS.map(def => {
    const per = {};
    HORIZONS.forEach(h => { per[h] = { top: [], bot: [], uni: [], ts: [] }; });
    const monthly = { top: [], uni: [], sets: [], ts: [] };
    for (const { ts, raw } of snaps) {
      const vals = [];
      for (const [t, v] of raw) { const x = v[def.key]; if (x != null && isFinite(x)) vals.push({ t, v: x }); }
      if (vals.length < 40) continue;
      const scored = vals.map(x => x.t);
      const { top, bottom } = quintiles(vals);
      for (const h of HORIZONS) {
        const basket = (list) => mean(list.map(t => {
          const s = series.get(t), i = raw.get(t) && raw.get(t)._i;
          return i == null || i + h >= s.c.length ? null : s.c[i + h] / s.c[i] - 1;
        }).filter(x => x != null));
        const a = basket(top), b = basket(bottom), u = basket(scored);
        if (a == null || b == null || u == null) continue;
        per[h].top.push(a); per[h].bot.push(b); per[h].uni.push(u); per[h].ts.push(ts);
        if (h === STEP) { monthly.top.push(a); monthly.uni.push(u); monthly.sets.push(top); monthly.ts.push(ts); }
      }
    }
    let cs = 1, cb = 1, prev = null;
    const strat = [], bench = [], dates = [];
    let costPaid = 0;
    for (const [k, set] of monthly.sets.entries()) {
      const overlap = prev ? prev.filter(x => set.includes(x)).length / set.length : 0;
      const cost = (1 - overlap) * (COST_BPS / 10000) * 2;
      costPaid += cost;
      cs *= (1 + monthly.top[k] - cost); cb *= (1 + monthly.uni[k]);
      prev = set; strat.push(+((cs - 1) * 100).toFixed(1)); bench.push(+((cb - 1) * 100).toFixed(1));
      dates.push(monthly.ts[k] * 86400000);
    }
    const mdd = (c) => { let pk = -1e9, w = 0; for (const v of c) { pk = Math.max(pk, v); w = Math.min(w, v - pk); } return +w.toFixed(1); };
    const yrs = strat.length / 12;
    const r2 = (x) => (x == null ? null : +x.toFixed(2));
    return {
      key: def.key, label: def.label, names: series.size,
      horizons: HORIZONS.map(h => {
        const d = per[h];
        const ex = d.top.map((v, i) => v - d.uni[i]), eb = d.bot.map((v, i) => v - d.uni[i]);
        const sp = ex.map((v, i) => v - eb[i]), m = mean(ex), s = sd(ex), n = ex.length;
        return { h, n, top: r2(mean(d.top) * 100), uni: r2(mean(d.uni) * 100), bot: r2(mean(d.bot) * 100),
          excess: r2(m * 100), botExcess: r2(mean(eb) * 100), spread: r2(mean(sp) * 100),
          hit: n ? Math.round(ex.filter(x => x > 0).length / n * 100) : null,
          t: m != null && s != null && n > 2 ? +(m / (s / Math.sqrt(n))).toFixed(2) : null };
      }),
      curve: { dates, strat, bench, years: +yrs.toFixed(1), obs: strat.length,
        annStrat: yrs > 0.2 && cs > 0 ? +((Math.pow(cs, 1 / yrs) - 1) * 100).toFixed(1) : null,
        annBench: yrs > 0.2 && cb > 0 ? +((Math.pow(cb, 1 / yrs) - 1) * 100).toFixed(1) : null,
        mddStrat: mdd(strat), mddBench: mdd(bench), costPaid: +(costPaid * 100).toFixed(2) },
    };
  });

  return {
    asof: Date.now(), costBps: COST_BPS, step: STEP, bars: axis.length, rebalances: rebal.length,
    from: new Date(rebal[0] * 86400000).toISOString().slice(0, 10), to: new Date(axis[axis.length - 1] * 86400000).toISOString().slice(0, 10),
    universe: series.size, skipped: stocks.length - series.size, history: Object.keys(hist).length, legs,
    caveat: "Price legs only, tested point-in-time. A ranking built on today's P/E, ROCE or growth cannot be tested at past dates without dated statements, so no such claim is made here. Returns are in each stock's own currency — FX moves are ignored — and baskets are equal-weighted with no capacity limit, so a real portfolio would earn less.",
  };
}

module.exports = { getHistory, runBacktest, HIST_FILE };
