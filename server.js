/* FactorDesk server — static files + real market data API (Yahoo Finance, delayed). */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CACHE_FILE = path.join(ROOT, ".cache-universe.json");
const CACHE_TTL = 6 * 3600 * 1000;
/* Bump when a row's shape changes — a snapshot written by an older build is missing
   fields the UI now reads, and serving it silently would show blanks as if they were zeros. */
const ROW_SHAPE = 7;
const YF_BASE = process.env.YF_BASE || "http://127.0.0.1:8765";
const SYMBOLS = JSON.parse(fs.readFileSync(path.join(ROOT, "datasource", "symbols.json"), "utf8"));
const backtest = require("./backtest.js");

/* .env is read for GROQ_API_KEY / GROQ_MODEL only — the key never reaches the browser. */
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env file */ }
}
loadEnv();

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const TICKERS = SYMBOLS.equities;

/* ---------- Yahoo auth (cookie + crumb bootstrap) ---------- */
let auth = null;
async function getAuth() {
  if (auth) return auth;
  try {
    const rc = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } }).catch(() => null);
    const cookie = rc && rc.headers.get("set-cookie") ? rc.headers.get("set-cookie").split(";")[0] : "";
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) } });
    const crumb = (await crumbRes.text()).trim();
    auth = { cookie, crumb: /crumb/.test(crumb) || crumb.length > 20 ? "" : crumb };
  } catch { auth = { cookie: "", crumb: "" }; }
  return auth;
}

async function jfetch(url, tries = 3) {
  const { cookie, crumb } = await getAuth();
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url + (url.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(crumb),
        { headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) }, signal: ctrl.signal });
      clearTimeout(to);
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 800 * (i + 1))); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await new Promise(r => setTimeout(r, 400)); }
  }
  return null;
}

const raw = (o, k) => (o && o[k] != null && typeof o[k] === "number" ? o[k] : (o && o[k] && typeof o[k] === "object" && "raw" in o[k] ? o[k].raw : null));

/* ---------- per-ticker fetch + normalise ---------- */
async function fetchStock(t) {
  const qs = await jfetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile`);
  const r = qs && qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0];
  if (!r) return null;
  const ch = await jfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1d`);
  const cr = ch && ch.chart && ch.chart.result && ch.chart.result[0];
  const closes = cr && cr.indicators && cr.indicators.quote && cr.indicators.quote[0] && cr.indicators.quote[0].close
    ? cr.indicators.quote[0].close.filter(x => x != null) : [];
  const dates = cr && cr.timestamp ? cr.timestamp.filter((x, i) => cr.indicators.quote[0].close[i] != null) : [];

  const p = r.price || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {},
    fd = r.financialData || {}, ap = r.assetProfile || {};
  // Yahoo quotes LSE listings in pence (GBp) but reports EPS, book value, dividends and
  // market cap in pounds — put every per-share figure on the same footing before ratioing.
  const scale = p.currency === "GBp" ? 100 : 1;
  const price0 = raw(p, "regularMarketPrice") || raw(sd, "regularMarketPrice");
  if (!price0) return null;
  const price = price0 / scale;
  const mcapB = raw(p, "marketCap") != null ? raw(p, "marketCap") / 1e9 : raw(sd, "marketCap") != null ? raw(sd, "marketCap") / 1e9 : null;
  const equity = raw(ks, "sharesOutstanding") && raw(ks, "bookValue") ? raw(ks, "sharesOutstanding") * raw(ks, "bookValue") : null;
  const totalDebt = raw(fd, "totalDebt"), totalCash = raw(fd, "totalCash");
  const nde = equity ? ((totalDebt || 0) - (totalCash || 0)) / equity * 100 : (raw(ks, "debtToEquity") != null ? raw(ks, "debtToEquity") : null);
  const g = (o, k) => { const v = raw(o, k); return v == null ? null : v; };
  const dyCand = g(sd, "dividendYield") != null ? g(sd, "dividendYield") * 100
    : g(p, "trailingAnnualDividendYield") != null ? g(p, "trailingAnnualDividendYield") * 100 : null;
  const divRate = g(sd, "dividendRate");
  const dy = dyCand != null && dyCand > 0 ? dyCand : (divRate && price ? divRate / price * 100 : null);
  const eps = g(ks, "trailingEps");
  const pe = eps > 0 ? price / eps : (g(sd, "trailingPE") ?? g(ks, "trailingPE"));
  // banks and insurers: gross margin and net-debt/equity are meaningless on a deposit-funded
  // balance sheet, so return on equity replaces ROCE and those two legs are scored N/A
  const financial = ap.sector === "Financial Services";
  const roce = g(ks, "returnOnCapitalEmployed") != null ? g(ks, "returnOnCapitalEmployed") * 100
    : (financial && g(ks, "returnOnEquity") != null ? g(ks, "returnOnEquity") * 100 : null);
  const roceBasis = !g(ks, "returnOnCapitalEmployed") && financial ? "ROE" : "ROCE";

  const d = {
    t, name: p.longName || p.shortName || t,
    w: ap.website || null,
    country: (ap.country || (t.endsWith(".L") ? "United Kingdom" : t.endsWith(".AX") ? "Australia" : "United States")),
    sector: ap.sector || "Other",
    currency: p.currency === "GBP" || p.currency === "GBp" ? "£" : p.currency === "AUD" ? "A$" : p.currency === "USD" ? "$" : (p.currency || "") + " ",
    price, mcap: mcapB,
    pe,
    pb: g(ks, "priceToBook") ?? g(sd, "priceToBook"),
    dy,
    payout: dy && g(ks, "payoutRatio") != null ? g(ks, "payoutRatio") * 100 : null,
    fcfy: g(ks, "freeCashflow") != null && mcapB != null ? g(ks, "freeCashflow") / (mcapB * 1e9) * 100 : null,
    roce, roceBasis,
    gm: financial || g(fd, "grossMargins") == null ? null : g(fd, "grossMargins") * 100,
    nde: financial ? null : nde, ic: g(ks, "interestCoverage"),
    eg: g(ks, "earningsQuarterlyGrowth") != null ? g(ks, "earningsQuarterlyGrowth") * 100 : null,
    rg: g(fd, "revenueGrowth") != null ? g(fd, "revenueGrowth") * 100 : null,
    fg: g(fd, "earningsGrowth") != null ? g(fd, "earningsGrowth") * 100 : null,
    beta: g(p, "beta") ?? g(sd, "beta"),
    target: g(fd, "targetMeanPrice") != null ? g(fd, "targetMeanPrice") / scale : null,
    rec: fd.recommendationKey || null,
    peg: g(ks, "trailingPegRatio"),
    inst: g(ks, "heldPercentInstitutions") != null ? g(ks, "heldPercentInstitutions") * 100 : null,
    insider: g(ks, "heldPercentInsiders") != null ? g(ks, "heldPercentInsiders") * 100 : null,
    shortPct: g(ks, "shortPercentOfFloat") != null ? g(ks, "shortPercentOfFloat") * 100 : null,
    shortDays: g(ks, "shortRatio"),
    nextEarnings: g(ks, "earningsTimestampStart") ? g(ks, "earningsTimestampStart") * 1000 : null,
    week52Hi: g(p, "fiftyTwoWeekHigh") != null ? g(p, "fiftyTwoWeekHigh") / scale : null,
    week52Lo: g(p, "fiftyTwoWeekLow") != null ? g(p, "fiftyTwoWeekLow") / scale : null,
    closes: closes.slice(-260).map(x => +(x / scale).toFixed(3)),
    dates: dates.slice(-260),
  };
  let h = 0, n = 0;
  const flag = (cond, val) => { if (val != null) { n++; if (cond) h++; } };
  flag(d.roce > 10, d.roce); flag(d.gm > 25, d.gm); flag(d.nde < 70, d.nde);
  flag(d.ic > 3, d.ic); flag(d.rg > 0, d.rg); flag(d.eg > 0, d.eg);
  flag(d.fcfy > 2, d.fcfy); flag(d.dy > 0, d.dy); flag(d.beta < 1.3, d.beta);
  d.health = n >= 5 ? Math.round(h / n * 9) : null;
  return d;
}

async function buildUniverse() {
  const out = [];
  const queue = [...TICKERS];
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      try { const d = await fetchStock(t); if (d) out.push(d); } catch { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

/* ---------- yfinance (python) datasource: preferred, direct Yahoo is the fallback ---------- */
async function yfJson(tail, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(YF_BASE + tail, { signal: ctrl.signal });
    clearTimeout(to);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function spawnYfService() {
  if (process.env.FD_NO_YF) return;
  /* Reuse a service that is already answering rather than stack up orphans: on
     Windows a second bind to 127.0.0.1:8765 succeeds, and then any request may
     be served by a stale process holding older cached data. */
  if (await yfJson("/health", 1500)) { console.log("Reusing yfinance service on " + YF_BASE); return; }
  try {
    const child = spawn(process.env.PYTHON || "python", [path.join(ROOT, "datasource", "yf_service.py")],
      { cwd: ROOT, stdio: "ignore", windowsHide: true });
    child.on("error", () => console.log("yfinance service unavailable — using direct Yahoo API"));
    process.on("exit", () => { try { child.kill(); } catch { /* gone */ } });
  } catch { /* python absent */ }
}

async function yfUniverse() {
  const j = await yfJson("/universe", 900000); // first global build can take ~10 min
  const stocks = j && j.stocks;
  return stocks && stocks.length >= 20 ? { stocks, src: j.src || "yfinance", asof: Number(j.asof) || 0 } : null;
}

let universeCache = null, universeAt = 0, universeSrc = "", building = null, staleRows = null, staleSrc = "", staleAt = 0;
function getUniverse(force) {
  if (!force && universeCache && Date.now() - universeAt < CACHE_TTL) return Promise.resolve({ stocks: universeCache, src: universeSrc, asof: universeAt });
  if (!force && !universeCache && fs.existsSync(CACHE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(parsed.stocks) && parsed.stocks.length > 20) {
        staleRows = parsed.stocks; staleSrc = parsed.src || "Yahoo Finance";
        staleAt = Number(parsed.asof) || fs.statSync(CACHE_FILE).mtimeMs;
      }
    } catch { /* unreadable snapshot */ }
  }
  /* a rebuild of 334 names takes minutes; until it lands, readers get the last good snapshot
     (row shape changed = a field is missing, so only rows from the current shape may be served) */
  if (building) return staleRows ? Promise.resolve({ stocks: staleRows, src: staleSrc, asof: staleAt, refreshing: true }) : building;
  if (!force && fs.existsSync(CACHE_FILE) && Date.now() - fs.statSync(CACHE_FILE).mtimeMs < CACHE_TTL) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { parsed = null; }
    if (parsed && parsed.shape === ROW_SHAPE && Array.isArray(parsed.stocks)) {
      universeCache = parsed.stocks; universeSrc = parsed.src || "Yahoo Finance";
      universeAt = Number(parsed.asof) || fs.statSync(CACHE_FILE).mtimeMs;
      staleRows = universeCache; staleSrc = universeSrc; staleAt = universeAt;
      return Promise.resolve({ stocks: universeCache, src: universeSrc, asof: universeAt });
    }
  }
  const job = (async () => {
    let r = await yfUniverse();
    if (!r) r = { stocks: await buildUniverse(), src: "Yahoo Finance (direct)" };
    if (r.stocks.length) {
      universeCache = r.stocks; universeAt = r.asof || Date.now(); universeSrc = r.src;
      staleRows = universeCache; staleSrc = universeSrc; staleAt = universeAt;
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ shape: ROW_SHAPE, src: r.src, asof: universeAt, stocks: r.stocks })); } catch { /* ignore */ }
    } else if (universeCache) { r = { stocks: universeCache, src: universeSrc, asof: universeAt }; }
    else if (staleRows) { r = { stocks: staleRows, src: staleSrc, asof: staleAt }; }
    building = null;
    return { ...r, asof: universeAt || staleAt || Date.now() };
  })();
  job.rows = staleRows;
  building = job;
  return staleRows ? Promise.resolve({ stocks: staleRows, src: staleSrc, asof: staleAt, refreshing: true }) : building;
}

/* ---------- company logos ----------
   The mark is fetched from Google's icon service using the website Yahoo publishes for the
   company, so a logo is either the issuer's real one or there is none — nothing is drawn here. */
const LOGO_DIR = path.join(ROOT, ".logocache");
const LOGO_TTL = 30 * 24 * 3600 * 1000, LOGO_MISS_TTL = 10 * 60 * 1000;
const LOGO_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
  "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico", "image/svg+xml": ".svg", "image/gif": ".gif" };
const logoPending = new Map();

function hostOf(u) {
  if (!u || typeof u !== "string") return "";
  try {
    const h = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase();
    return /^[a-z0-9\u00c0-\u024f.-]+\.[a-z]{2,}$/i.test(h) ? h : "";
  } catch { return ""; }
}

/* Both services only hold icons that exist — a miss is a real "nothing published here",
   so a second source is tried before the monogram takes over. */
const ICON_SOURCES = [
  (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=128`,
  (h) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(h)}.ico`,
];

async function tryIcon(host) {
  for (const src of ICON_SOURCES) {
    try {
      const r = await fetch(src(host), { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(12000) });
      const type = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!r.ok || !LOGO_EXT[type]) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length >= 96) return { type, buf };
    } catch { /* try the next source */ }
  }
  return null;
}

async function logoFor(sym) {
  if (!/^[A-Z0-9._-]{1,20}$/.test(sym) || sym.includes("..")) return null;
  const img = path.join(LOGO_DIR, sym + ".img"), meta = path.join(LOGO_DIR, sym + ".meta.json"), miss = path.join(LOGO_DIR, sym + ".miss");
  try {
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (m.type && Date.now() - m.at < LOGO_TTL) return { type: m.type, buf: fs.readFileSync(img) };
  } catch { /* not cached yet */ }
  try { if (Date.now() - fs.statSync(miss).mtimeMs < LOGO_MISS_TTL) return null; } catch { /* no failure marker */ }
  if (logoPending.has(sym)) return logoPending.get(sym);

  const job = (async () => {
    const u = await getUniverse();
    const row = u.stocks.find(s => String(s.t).toUpperCase() === sym);
    const base = hostOf(row && row.w);
    /* the icon service is literal about the host it is given — tcs.com has nothing while
       www.tcs.com has the mark — so the published host is tried bare and with the www alias. */
    const hosts = [...new Set([base, base.replace(/^www\./, ""), base && "www." + base.replace(/^www\./, "")])].filter(Boolean);
    for (const h of hosts) {
      const got = await tryIcon(h);
      if (got) {
        fs.mkdirSync(LOGO_DIR, { recursive: true });
        fs.writeFileSync(img, got.buf);
        fs.writeFileSync(meta, JSON.stringify({ type: got.type, host: h, at: Date.now() }));
        return got;
      }
    }
    throw new Error("no icon for " + sym);
  })().then(r => { try { fs.rmSync(miss, { force: true }); } catch { /* none */ } return r; })
    .catch(() => { try { fs.mkdirSync(LOGO_DIR, { recursive: true }); fs.writeFileSync(miss, ""); } catch { /* ignore */ } return null; })
    .finally(() => logoPending.delete(sym));
  logoPending.set(sym, job);
  return job;
}

/* ---------- market tape + macro dashboard ---------- */
const MACRO_META = SYMBOLS.macro;
const labelOf = (sym) => (MACRO_META.find(m => m.s === sym) || { n: sym }).n;
const INDICES = SYMBOLS.tape.map(s => [s, labelOf(s)]);

async function chartCloses(sym, range) {
  const j = await jfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const cl = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
  const closes = cl && cl.close ? cl.close.filter(x => x != null) : [];
  const ts = r && r.timestamp ? r.timestamp : [];
  return { closes, ts: ts.slice(-closes.length) };
}
const chg = (c, back) => (c.length > back && c[c.length - 1 - back] ? +((c[c.length - 1] / c[c.length - 1 - back] - 1) * 100).toFixed(2) : null);

let tapeCache = null, tapeAt = 0;
async function getTickers() {
  if (tapeCache && Date.now() - tapeAt < 5 * 60000) return tapeCache;
  const y = await yfJson("/tickers", 30000);
  if (y && y.tickers && y.tickers.length) { tapeCache = y.tickers; tapeAt = Date.now(); return tapeCache; }
  const results = await Promise.all(INDICES.map(async ([sym, label]) => {
    try {
      const { closes } = await chartCloses(sym, "5d");
      if (closes.length < 2) return null;
      const v = closes[closes.length - 1];
      return { s: sym, n: label, v: +v.toFixed(v < 2 ? 4 : 2), c: chg(closes, 1) };
    } catch { return null; }
  }));
  const list = results.filter(Boolean);
  if (list.length) { tapeCache = list; tapeAt = Date.now(); }
  return tapeCache || [];
}

let macroCache = null, macroAt = 0;
async function getMacro() {
  if (macroCache && Date.now() - macroAt < 15 * 60000) return macroCache;
  const y = await yfJson("/macro", 120000);
  if (y && y.items && y.items.length) { macroCache = y.items; macroAt = Number(y.asof) || Date.now(); return macroCache; }
  const results = await Promise.all(MACRO_META.map(async (m) => {
    try {
      const { closes, ts } = await chartCloses(m.s, "1y");
      if (closes.length < 3) return null;
      const v = closes[closes.length - 1];
      return { s: m.s, n: m.n, g: m.g, u: m.g === "rates" ? "percent" : "index", v: +v.toFixed(v < 10 ? 4 : 2),
        d: chg(closes, 1), m: chg(closes, 21), q: chg(closes, 63), y: chg(closes, Math.min(252, closes.length - 1)),
        hi52: +Math.max(...closes).toFixed(2), lo52: +Math.min(...closes).toFixed(2), closes: closes.slice(-260), dates: ts.slice(-260) };
    } catch { return null; }
  }));
  const list = results.filter(Boolean);
  if (list.length) { macroCache = list; macroAt = Date.now(); }
  return macroCache || [];
}

let newsCache = {};
/* Yahoo's own article picture. Their feed offers only an "original" — sometimes 5000px and
   several megabytes — and a signed 140px tile whose signature cannot be rewritten to another
   size. The original is used when its own width is a sane web image; a monster is swapped for
   the 10KB tile, which is all a 90px box needs. https only. */
function articlePicture(thumb) {
  const rs = ((thumb && thumb.resolutions) || [])
    .filter(r => r && /^https:\/\//.test(r.url))
    .map(r => ({ w: r.width || 0, tag: r.tag || "", u: r.url }));
  if (!rs.length) return null;
  const byWidth = (a, b) => a.w - b.w;
  const originals = rs.filter(r => r.tag === "original");
  const sane = originals.filter(r => r.w >= 140 && r.w <= 2200)
    .concat(rs.filter(r => r.w >= 140 && r.w <= 2200));
  if (sane.length) return sane.sort(byWidth).pop().u;
  const big = rs.filter(r => r.w > 2200).sort(byWidth);
  return big.length ? big[0].u : rs.sort(byWidth)[0].u;
}

async function getNews(query) {
  const hit = newsCache[query];
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.items;
  const y = await yfJson("/news/" + encodeURIComponent(query), 30000);
  let items = y && y.items ? y.items : null;
  if (!items) {
    const j = await jfetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=8&quotesCount=0`);
    items = (j && j.news ? j.news : []).filter(n => n.title && n.link)
      .map(n => ({ t: n.title, u: n.link, p: n.provider || "", ts: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
        i: articlePicture(n.thumbnail) }));
  }
  items = (items || []).slice(0, 8);
  if (items.length) newsCache[query] = { at: Date.now(), items };
  return hit ? hit.items : items;
}

/* ---------- Groq AI proxy: the key stays on the server ---------- */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_RULES = `You are FactorDesk's analysis writer for an equity research platform. You receive REAL, already-computed market data as JSON and must explain it in plain English for a private investor.
Rules you must never break:
- Use ONLY the figures supplied. Never invent numbers, never state a price target, forecast or recommendation to buy/sell.
- This is education, not investment advice. Say so once if relevant.
- Be specific and numeric. Prefer short sentences, no hype, no adjectives like "exciting".
- Flag what could go wrong and what data is missing (nulls mean not reported, not zero).
- State the direction of every figure exactly as the numbers imply — never describe a net negative as positive, or a fall as a rise, and never compare two figures you were not given.
- UK listings are shown in pounds; prices are delayed; fundamentals are as-reported and unaudited.`;

/* The chat may say BUY, HOLD, SELL or AVOID and suggest a split — but only as a relay of the
   rule engine's own output, which the client computes and passes in as FACTS. The model gets no
   authority of its own, so an answer is auditable back to a number on the page. */
const CHAT_RULES = `You are FactorDesk's investing assistant. You answer questions about the stocks this user tracks: what to buy, hold, trim, sell or avoid, how to split money between names, how to diversify, when to get out, and what a stock's profile says.

You are handed FACTS JSON computed by FactorDesk's own rules from live market data. That JSON is your only source. Rules you must never break:
- Every recommendation must be traceable to a field in FACTS. Quote the field's number next to the recommendation so the user can check it — in words, like "stop 7.81, the unfilled gap edge below". Never paste raw JSON fragments, field names in quotes, braces or 【】 markers.
- The engine's per-stock verdicts arrive as a tag (Buy / Buy on weakness / Wait for the trend / Weak watch / Hold / Trim / Sell / No trend data) with a FactorRank score and an entry, stop, target, risk, reward and risk-reward. Use those words and those levels; never restate a verdict more bullish than the tag, and never invent a level the facts do not carry.
- Allocation: if FACTS carries proposedAllocation, that IS FactorDesk's own split — quote its positions, weightPct and amount as they are, name its method, and quote its measured return, volatility, drawdown and average correlation alongside it. Do not build a different weighting of your own. Only if proposedAllocation is absent may you arithmetic on ranks or volatility from FACTS, and then show the arithmetic. If FACTS carries no sizing numbers at all, say what is missing and answer qualitatively — never guess a split.
- Never name a ticker, index, sector or fund that is not in FACTS. Never invent a price, percentage, date or correlation. Nulls mean not reported, never zero.
- State the direction of every figure exactly as the numbers imply; never call a fall a rise, never compare two figures you were not given.
- Say plainly when the facts cannot answer, and which measurement is missing. It is better to say "no data" than to sound confident.
- Prices are delayed, fundamentals are as-reported and unaudited, and backtests are price-legs only with no point-in-time fundamentals — say so when an answer leans on them. This is research support for the user's own decision, not regulated advice; add that once per answer at most, and only when you are giving a concrete action.
- Be specific, numeric and unsentimental. No hype, no "exciting", no promises of return.
- Write money in the currency the facts carry on that position (its "currency" field); never swap pounds for dollars, never assume an FX rate, and never add mixed currencies together.
Format: plain markdown, bold labels, short bullets, under 260 words unless the user asks for more.`;

async function askGroq(messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { error: "No Groq API key configured.", needsKey: true };
  /* a reasoning model can spend the whole token budget on thinking and answer with empty
     content, and Groq throws transient 429/5xx — both are worth one more attempt */
  for (const budget of [1800, 3200]) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 45000);
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.3, max_completion_tokens: budget }),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && budget !== 3200) continue;
        return { error: (j.error && j.error.message) || ("Groq HTTP " + res.status) };
      }
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (text) return { text, model: j.model || GROQ_MODEL, usage: j.usage };
    } catch (e) { return { error: "Groq request failed: " + e.message }; }
  }
  return { error: "the model thought but wrote nothing — press the button again" };
}

/* ---------- backtest (price legs only, point-in-time) ---------- */
let btCache = null, btPromise = null;
async function computeBacktest() {
  const u = await getUniverse();
  if (!u.stocks.length) return { error: "no universe data to test" };
  const { map } = await backtest.getHistory(u.stocks.map(s => s.t));
  const r = backtest.runBacktest(u.stocks, map);
  return r.error ? r : Object.assign({ src: u.src }, r);
}
function getBacktest(force) {
  if (!force && btCache && Date.now() - btCache.at < CACHE_TTL) return Promise.resolve(btCache.r);
  if (!btPromise) btPromise = computeBacktest()
    .then(r => { if (!r.error) btCache = { at: Date.now(), r }; btPromise = null; return r; })
    .catch(e => { btPromise = null; return { error: "backtest failed: " + e.message }; });
  return btPromise;
}

/* ---------- five years of daily bars, one listing at a time ----------
   Kept out of the universe payload on purpose: every report page asks for its own history, and
   334 names × ~1300 bars would bloat a file only one screen reads. Both legs return raw Yahoo
   numbers; the pence listings are scaled here so the client sees the same basis as the quote. */
const barsCache = new Map();
const roundBars = (a) => a.map(v => (v == null ? null : +v.toFixed(4)));
const penceScale = (cur) => (cur === "GBp" ? 100 : 1);

async function getBars(sym) {
  const hit = barsCache.get(sym);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.r;
  const d = await yfJson("/bars/" + encodeURIComponent(sym), 25000);
  let r = null;
  if (d && d.dates && d.dates.length) {
    const k = penceScale(d.cur);
    r = { t: sym, src: "yfinance", dates: d.dates,
      o: roundBars(d.o.map(v => v / k)), h: roundBars(d.h.map(v => v / k)),
      l: roundBars(d.l.map(v => v / k)), c: roundBars(d.c.map(v => v / k)) };
  } else {
    const ch = await jfetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`);
    const cr = ch && ch.chart && ch.chart.result && ch.chart.result[0];
    if (cr && cr.timestamp) {
      const q = (cr.indicators && cr.indicators.quote && cr.indicators.quote[0]) || {};
      const k = penceScale((cr.meta && cr.meta.currency) || "");
      const keep = [];
      for (let i = 0; i < cr.timestamp.length; i++) {
        if (!q.close || q.close[i] == null || !q.open || q.open[i] == null
          || !q.high || q.high[i] == null || !q.low || q.low[i] == null) continue;
        keep.push([cr.timestamp[i] * 1000, q.open[i] / k, q.high[i] / k, q.low[i] / k, q.close[i] / k]);
      }
      if (keep.length) r = { t: sym, src: "yahoo-direct", dates: keep.map(x => x[0]),
        o: roundBars(keep.map(x => x[1])), h: roundBars(keep.map(x => x[2])),
        l: roundBars(keep.map(x => x[3])), c: roundBars(keep.map(x => x[4])) };
    }
  }
  if (r) barsCache.set(sym, { at: Date.now(), r });
  return r;
}

/* ---------- HTTP server ---------- */
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify(obj)); };

  if (url === "/api/universe") {
    getUniverse(req.url.includes("force=1")).then(r =>
      r.stocks.length ? json(200, { asof: r.asof || Date.now(), count: r.stocks.length, src: r.src, refreshing: !!r.refreshing, stocks: r.stocks })
        : json(502, { error: "data source unavailable" }));
    return;
  }
  if (url === "/api/tickers") {
    getTickers().then(list => json(200, { asof: Date.now(), tickers: list }));
    return;
  }
  if (url === "/api/macro") {
    getMacro().then(items => items.length ? json(200, { asof: macroAt || Date.now(), count: items.length, items })
      : json(502, { error: "macro data unavailable" }));
    return;
  }
  const nm = url.match(/^\/api\/news(?:\/(.+))?$/);
  if (nm) {
    getNews(decodeURIComponent(nm[1] || "stock market")).then(items => json(200, { asof: Date.now(), items }));
    return;
  }
  if (url === "/api/backtest") {
    getBacktest(req.url.includes("force=1")).then(r => json(r.error ? 502 : 200, r));
    return;
  }
  if (url === "/api/ai/status") {
    json(200, { key: !!process.env.GROQ_API_KEY, model: GROQ_MODEL });
    return;
  }
  if (req.method === "POST" && url === "/api/ai") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 400000) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const facts = payload.facts;
      if (!facts || typeof facts !== "object") return json(400, { error: "facts required" });
      const isEvidence = payload.kind === "evidence";
      const fmt = isEvidence
        ? "Write in this exact structure, using the JSON facts only:\n"
          + "1. DID IT PAY — say plainly whether the tested rules beat the universe, quoting the excess return and the t-stat.\n"
          + "2. WHICH RULES — rank the price rules by strength of evidence, and name any that lost money.\n"
          + "3. WHAT IT COST — drawdown, turnover cost and how often the rule paid off.\n"
          + "4. WHY YOU CANNOT TRUST IT FULLY — the limits in the facts, in plain words.\n"
          + "Never imply that a rule tested only on prices validates a valuation-based ranking. Under 300 words."
        : "Write in this exact structure, using the JSON facts only:\n"
          + "1. THE SIMPLE VERSION — 2 or 3 sentences a non-specialist can act on.\n"
          + "2. WHAT'S WORKING — bullets with the numbers that support it.\n"
          + "3. WHAT COULD GO WRONG — bullets, honest, specific.\n"
          + "4. CHART READ — trend, momentum and where price sits versus its range.\n"
          + "5. THINGS TO WATCH — dates, levels or data that would change the picture.\n"
          + "Where the facts carry measuredDrivers, use them: each is a measured relationship against a published series, so describe it as a correlation that has been observed, never as a cause or a forecast.\n"
          + "Plain markdown, no headings markup beyond bold labels, under 320 words.";
      const scopeRule = payload.kind === "market"
        ? "The equity figures in FACTS are scoped to the market named in \"market\" and bounded by \"marketNote\" — name that market in the first line, never present a single-country read as the whole world, and treat the macro arrays as global context unless domesticIndex or domesticCurrency says otherwise.\n"
        : "";
      const out = await askGroq([
        { role: "system", content: SYSTEM_RULES },
        { role: "user", content: `Task: ${isEvidence ? "backtest evidence review" : (payload.kind === "market" ? (facts.market || "Global") + " market briefing" : "single-stock analysis")}.`
          + "\n" + scopeRule + fmt + "\n\nFACTS JSON:\n"
          + JSON.stringify(facts).slice(0, 12000) },
      ]);
      json(out.text ? 200 : (out.needsKey ? 200 : 502), out);
    });
    return;
  }
  /* ---------- floating chat: a bounded conversation + a facts snapshot ----------
     The browser sends the transcript and the numbers it just computed. The key never leaves
     the server, and the model is told the FACTS block is its only source of truth. */
  if (req.method === "POST" && url === "/api/chat") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 400000) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const facts = payload.facts;
      if (!facts || typeof facts !== "object") return json(400, { error: "facts required" });
      const hist = (Array.isArray(payload.messages) ? payload.messages : []).slice(-12).map(mm => ({
        role: mm && mm.role === "assistant" ? "assistant" : "user",
        content: String(mm && mm.content || "").slice(0, 3000),
      })).filter(mm => mm.content.trim());
      if (!hist.length || hist[hist.length - 1].role !== "user") return json(400, { error: "ask a question first" });
      const out = await askGroq([
        { role: "system", content: CHAT_RULES
          + "\n\nAnswer in under 300 words. Plain markdown: bold labels, short bullet lines, no headings, no tables."
          + "\nCite a verdict as [[Tag|TICKER]] — for example [[Buy|HSBA.L]] — so the name renders as a link; use the tag word exactly as FACTS states it and the ticker exactly as FACTS spells it."
          + "\nFACTS JSON (your only source):\n" + JSON.stringify(facts).slice(0, 26000) },
        ...hist,
      ]);
      json(out.text ? 200 : (out.needsKey ? 200 : 502), out);
    });
    return;
  }
  let lm = url.match(/^\/api\/logo\/([\w.\-]+)$/);
  if (lm) {
    logoFor(lm[1].toUpperCase()).then(r => {
      if (!r) { res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" }); return res.end("no logo"); }
      res.writeHead(200, { "Content-Type": r.type, "Cache-Control": "public, max-age=86400",
        "Cross-Origin-Resource-Policy": "same-origin" });
      res.end(r.buf);
    });
    return;
  }
  let bm = url.match(/^\/api\/bars\/([\w.\-]+)$/);
  if (bm) {
    const sym = bm[1].toUpperCase();
    getBars(sym).then(r => json(r ? 200 : 404, r || { error: "no bars published for " + sym }));
    return;
  }
  let m = url.match(/^\/api\/stock\/([\w.\-]+)$/);
  if (m) {
    const sym = m[1];
    getUniverse().then(r => {
      const hit = r.stocks.find(x => x.t.toLowerCase() === sym.toLowerCase());
      if (hit) return json(200, hit);
      return yfJson("/stock/" + encodeURIComponent(sym), 20000).then(d =>
        d && d.t ? json(200, d)
          : fetchStock(sym).then(x => x ? json(200, x) : json(404, { error: "not found" })));
    });
    return;
  }

  /* Reported statements are not in the bulk universe payload (334 names × five years
     would triple it), so the stock report asks for them separately. */
  m = url.match(/^\/api\/fundamentals\/([\w.\-]+)$/);
  if (m) {
    yfJson("/stock/" + encodeURIComponent(m[1]), 20000).then(d => {
      if (d && d.t) return json(200, { t: d.t, ccy: d.ccy, fin: d.fin || [], divs: d.divs || null });
      json(503, { error: "the yfinance service is not answering — reported statements have no other source here" });
    });
    return;
  }

  if (url.startsWith("/api/")) return json(404, { error: "unknown api route: " + url });

  let file = path.normalize(path.join(ROOT, url === "/" ? "index.html" : url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  /* Only the app's own html/css/js is readable over HTTP — .env, the caches,
     the logs and the server source itself must never be served. */
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (!/^([\w.\-]+\.html|(?:css|js)\/[\w.\-]+)$/.test(rel)) { res.writeHead(404); return res.end("not found"); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, async () => {
  console.log(`FactorDesk running at http://localhost:${PORT}`);
  spawnYfService();
  let alive = false;
  const deadline = Date.now() + 25000;
  while (!alive && Date.now() < deadline) { alive = !!(await yfJson("/health", 1200)); if (!alive) await new Promise(r => setTimeout(r, 700)); }
  console.log(alive ? "Warming market data cache from yfinance…" : "Warming market data cache (direct Yahoo)…");
  let r = await getUniverse();
  if (alive && !/yfinance/.test(r.src)) r = await getUniverse(true); // cached fallback is missing statement metrics
  console.log(`Universe ready: ${r.stocks.length} real stocks via ${r.src}.`);
  console.log(process.env.GROQ_API_KEY
    ? `Groq analysis writer: ON (${GROQ_MODEL})`
    : "Groq analysis writer: OFF — copy .env.example to .env and paste GROQ_API_KEY to enable the plain-English write-ups.");
});
