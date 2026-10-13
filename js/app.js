/* FactorDesk app — SPA over live market data only */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const view = $("#view");
  const EMPTY_FILTERS = { q: "", country: "", sector: "", capMin: "", peMax: "", roceMin: "", p12Min: "", dyMin: "", poMax: "", fsMin: "" };
  const state = {
    weights: FD.store.get("weights", FD.DEFAULT_WEIGHTS),
    filters: { ...EMPTY_FILTERS, ...FD.store.get("filters", {}) },
    screens: FD.store.get("screens", []),
    alerts: FD.store.get("alerts", []),
    sort: { key: "liveRank", dir: -1 },
    gapMin: FD.store.get("gapMin", 1),
    sigTag: "",
    oppMode: FD.store.get("oppMode", "rr"),
    build: { rule: "rank", n: 10, cap: 3, weight: "equal", days: 252, ...FD.store.get("build", {}) },
    calc: { start: "10000", monthly: "500", years: "10", basis: "own", rate: "8", t: "", ...FD.store.get("calc", {}) },
    sizing: { capital: 25000, risk: 1, t: "", ...FD.store.get("sizing", {}) },
  };

  /* ---------- shared cell renderers ---------- */
  const scorePill = (v) => {
    const n = Math.round(v);
    const cls = n >= 70 ? "score-hi" : n >= 40 ? "score-mid" : "score-lo";
    return `<span class="score-pill ${cls}">${n}</span>`;
  };
  const perfCell = (v) => v == null ? '<span class="muted">—</span>' : `<span class="${v >= 0 ? "pos" : "neg"}">${FD.fmt.pct(v)}</span>`;
  const numCell = (v, dp = 1, suffix = "") => v == null ? '<span class="muted">—</span>' : FD.fmt.num(v, dp) + suffix;
  const STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9L6.6 19.7l1.1-6L3.2 9.4l6.1-.8L12 3z"/></svg>';
  const STARD = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9L6.6 19.7l1.1-6L3.2 9.4l6.1-.8L12 3z"/></svg>';
  const star = (t) => `<button class="star-btn ${FD.watchlist.has(t) ? "on" : ""}" data-star="${t}" title="Watchlist" aria-label="Toggle watchlist">${FD.watchlist.has(t) ? STARD : STAR}</button>`;

  /* The mark is the issuer's own icon, fetched by the server from the website Yahoo publishes
     for that company. No site on the record, or nothing returned, means the initials tile shows
     instead — a placeholder letter, never a made-up logo. */
  function logoHTML(s, cls) {
    if (!s) return "";
    const words = String(s.name || s.t).replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    const ini = (words.length > 1 ? words[0][0] + words[1][0] : String(s.t).slice(0, 2)).toUpperCase();
    const img = s.site ? `<img src="/api/logo/${encodeURIComponent(s.t)}" alt="" loading="lazy" decoding="async">` : "";
    return `<span class="stk-logo ${cls || ""}" data-i="${esc(ini)}" title="${esc(s.name || s.t)}">${img}</span>`;
  }
  document.addEventListener("error", (e) => {
    const el = e.target;
    if (!el || el.tagName !== "IMG" || !el.parentNode) return;
    if (el.parentNode.classList.contains("stk-logo")) el.parentNode.removeChild(el);
    /* a publisher's CDN can drop an article image after the feed is cached — the headline
       stays, only the missing picture comes down */
    if (el.classList.contains("nr-pic")) el.parentNode.removeChild(el);
  }, true);

  /* one row template for every feed in the app — the photo is Yahoo's own article image,
     so a headline with no thumbnail simply renders as text rather than a placeholder */
  function newsRow(x) {
    const pic = x.i ? `<img class="nr-pic" src="${esc(x.i)}" alt="" loading="lazy" decoding="async">` : "";
    return `<a class="news-row${x.i ? " has-pic" : ""}" href="${esc(x.u)}" target="_blank" rel="noopener">${pic}<div class="nr-body">
      <div class="nr-title">${esc(x.t)}</div>
      <div class="muted small">${esc(x.p || "Yahoo Finance")}${x.ts ? " · " + new Date(x.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</div></div></a>`;
  }

  const COLS = [
    { key: "t", label: "Stock", cell: s => `${logoHTML(s, "lg-sm")}${star(s.t)} <span class="tkr">${esc(s.t)}</span><div class="nm">${esc(s.name)} · ${s.country}</div>` },
    { key: "type", label: "Type", cell: s => `<span class="muted small">${esc(s.type)}</span>` },
    { key: "price", label: "Price", cell: s => FD.fmt.px(s, s.metrics.price) },
    { key: "perf12", label: "12m", cell: s => perfCell(s.metrics.perf12) },
    { key: "trend", label: "Trend", cell: s => `<canvas class="spark" data-spark="${s.t}"></canvas>` },
    { key: "mcap", label: "Mkt cap", cell: s => s.metrics.mcap == null ? "—" : FD.fmt.num(s.metrics.mcap, s.metrics.mcap >= 100 ? 0 : 1) + "bn" },
    { key: "pe", label: "P/E", cell: s => numCell(s.metrics.pe) },
    { key: "divYield", label: "Div yld", cell: s => numCell(s.metrics.divYield, 1, "%") },
    { key: "payout", label: "Payout", cell: s => numCell(s.metrics.payout, 0, "%") },
    { key: "roce", label: "ROCE", cell: s => numCell(s.metrics.roce, 1, "%") },
    { key: "fScore", label: "Health", cell: s => s.metrics.fScore == null ? '<span class="muted">—</span>' : Math.round(s.metrics.fScore) },
    { key: "quality", label: "Q", cell: s => scorePill(s.factors.quality) },
    { key: "value", label: "V", cell: s => scorePill(s.factors.value) },
    { key: "momentum", label: "M", cell: s => scorePill(s.factors.momentum) },
    { key: "growth", label: "G", cell: s => scorePill(s.factors.growth) },
    { key: "liveRank", label: "Rank", cell: s => `<span class="rank-cell">${Math.round(s.liveRank)}</span>` },
  ];

  function metricVal(s, key) {
    if (key === "liveRank") return s.liveRank;
    if (key in s.factors) return s.factors[key];
    if (key in s.metrics) return s.metrics[key];
    if (key === "t") return s.name;
    return 0;
  }

  const sortRows = (rows) => [...rows].sort((a, b) => {
    const va = metricVal(a, state.sort.key), vb = metricVal(b, state.sort.key);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * state.sort.dir;
  });

  function stockTable(rows) {
    const sorted = sortRows(rows);
    const head = COLS.map(c => `<th data-key="${c.key}" class="${state.sort.key === c.key ? "sorted" : ""}">${c.label}${state.sort.key === c.key ? (state.sort.dir === 1 ? " ↑" : " ↓") : ""}</th>`).join("");
    const body = sorted.map(s => `<tr data-t="${s.t}">${COLS.map(c => `<td>${c.cell(s)}</td>`).join("")}</tr>`).join("");
    return `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <div class="table-note">${sorted.length} stocks shown · click headers to sort · click a row for the full report · scores are 0–100 percentile blends (formula on the site)</div></div>`;
  }

  function wireTable(rows) {
    view.querySelectorAll("th[data-key]").forEach(th => th.onclick = () => {
      const k = th.dataset.key;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "t" || k === "type" ? 1 : -1) };
      rerender();
    });
    view.querySelectorAll("tr[data-t]").forEach(tr => tr.onclick = e => {
      if (e.target.closest(".star-btn")) return;
      location.hash = "#/stock/" + tr.dataset.t;
    });
    view.querySelectorAll("[data-star]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      FD.watchlist.toggle(b.dataset.star);
      rerender();
    });
    view.querySelectorAll("[data-spark]").forEach(c => {
      const s = FD.get(c.dataset.spark);
      FD.sparkline(c, FD.series(s).closes.slice(-126));
    });
  }

  /* A search box + sector/market filter injected above every data table. It works purely on the
     rendered rows, so it applies uniformly to rankings, screener, watchlist, portfolio, gaps,
     signals and opportunities without each view having to opt in. Rows carry data-t, so the stock
     lookup gives us sector/country for the dropdowns; tables whose rows aren't stocks just get the
     text search. */
  function addTableFilters() {
    view.querySelectorAll("table.data").forEach(table => {
      if (table.dataset.tf) return;
      const rows = [...table.querySelectorAll("tbody tr")];
      if (!rows.length) return;
      table.dataset.tf = "1";
      const stocks = rows.map(tr => tr.dataset.t && FD.get(tr.dataset.t)).filter(Boolean);
      const isStockTable = stocks.length > 0;
      const uniq = (arr) => [...new Set(arr)].sort((a, b) => a.localeCompare(b));
      const sectors = isStockTable ? uniq(stocks.map(s => s.sector).filter(Boolean)) : [];
      const markets = isStockTable ? uniq(stocks.map(s => s.country).filter(Boolean)) : [];
      const opts = (list, all) => `<option value="">${all}</option>` + list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");

      const bar = document.createElement("div");
      bar.className = "tbl-filter";
      bar.innerHTML = `
        <input type="search" class="tf-q" placeholder="Filter by ticker, name…" aria-label="Filter table by text" autocomplete="off">
        ${isStockTable ? `<select class="tf-sec" aria-label="Filter by sector">${opts(sectors, "All sectors")}</select>
        <select class="tf-mkt" aria-label="Filter by market">${opts(markets, "All markets")}</select>` : ""}
        <button class="btn tf-clear" type="button" hidden>Clear</button>
        <span class="tf-count muted small"></span>`;
      const wrap = table.closest(".table-wrap") || table.closest("[style*='overflow-x']") || table.parentElement;
      wrap.insertAdjacentElement("beforebegin", bar);

      const qEl = bar.querySelector(".tf-q"), secEl = bar.querySelector(".tf-sec"),
        mktEl = bar.querySelector(".tf-mkt"), clearEl = bar.querySelector(".tf-clear"),
        countEl = bar.querySelector(".tf-count");

      const apply = () => {
        const q = qEl.value.trim().toLowerCase(), sec = secEl ? secEl.value : "", mkt = mktEl ? mktEl.value : "";
        let shown = 0;
        rows.forEach(tr => {
          const s = tr.dataset.t && FD.get(tr.dataset.t);
          const ok = (!q || tr.textContent.toLowerCase().includes(q))
            && (!sec || (s && s.sector === sec))
            && (!mkt || (s && s.country === mkt))
            && (!(sec || mkt) || !!s);
          tr.style.display = ok ? "" : "none";
          if (ok) shown++;
        });
        countEl.textContent = `${shown} / ${rows.length}`;
        clearEl.hidden = !(qEl.value || sec || mkt);
      };
      [qEl, secEl, mktEl].forEach(el => el && el.addEventListener("input", apply));
      clearEl.onclick = () => { qEl.value = ""; if (secEl) secEl.value = ""; if (mktEl) mktEl.value = ""; apply(); qEl.focus(); };
      apply();
    });
  }

  /* Some tables (a stock report's fundamentals, dividend history) are filled in asynchronously after
     the route renders, so a one-shot pass at navigation time misses them. This observer re-runs the
     idempotent addTableFilters whenever the view's DOM changes, catching late-rendered tables too.
     The data-tf guard makes each pass a no-op once a table is wired, so the mutation it causes can't
     loop. */
  new MutationObserver(() => addTableFilters()).observe(view, { childList: true, subtree: true });

  function rankedAll() { return FD.rankedWith(state.weights); }
  function wireRowClicks() {
    view.querySelectorAll("tr[data-t]").forEach(tr => tr.onclick = e => {
      if (e.target.closest(".star-btn")) return;
      location.hash = "#/stock/" + tr.dataset.t;
    });
    view.querySelectorAll("[data-star]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      FD.watchlist.toggle(b.dataset.star);
      rerender();
    });
  }
  const live = (s) => (s.factors.quality * state.weights.quality + s.factors.value * state.weights.value +
    s.factors.momentum * state.weights.momentum + s.factors.growth * state.weights.growth + s.factors.smallcap * state.weights.smallcap) / 100;

  function applyFilters(rows) {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    return rows.filter(s =>
      (!q || s.t.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.country.toLowerCase() === q) &&
      (!f.country || s.country === f.country) &&
      (!f.sector || s.sector === f.sector) &&
      (!f.capMin || s.metrics.mcap >= +f.capMin) &&
      (!f.peMax || s.metrics.pe <= +f.peMax) &&
      (!f.roceMin || s.metrics.roce >= +f.roceMin) &&
      (!f.p12Min || s.metrics.perf12 >= +f.p12Min) &&
      (!f.dyMin || s.metrics.divYield >= +f.dyMin) &&
      (!f.poMax || (s.metrics.payout != null && s.metrics.payout <= +f.poMax)) &&
      (!f.fsMin || s.metrics.fScore >= +f.fsMin));
  }

  /* ---------- screener ---------- */
  /* ---------- exports and saved screens ---------- */
  const CSV_COLS = [
    ["Ticker", s => s.t], ["Name", s => s.name], ["Country", s => s.country], ["Sector", s => s.sector],
    ["Type", s => s.type], ["Currency", s => s.ccy], ["Price (GBP listings in pounds, not pence)", s => s.metrics.price], ["Market cap (bn)", s => s.metrics.mcap],
    ["FactorRank", s => s.liveRank], ["Quality", s => s.factors.quality], ["Value", s => s.factors.value],
    ["Momentum", s => s.factors.momentum], ["Growth", s => s.factors.growth], ["Small cap", s => s.factors.smallcap],
    ["P/E", s => s.metrics.pe], ["P/BV", s => s.metrics.pb], ["Dividend yield %", s => s.metrics.divYield],
    ["Payout ratio %", s => s.metrics.payout],
    ["FCF yield %", s => s.metrics.fcfYield], ["Return on capital basis", s => s.roceBasis], ["Return on capital %", s => s.metrics.roce], ["Health score (0-9)", s => s.metrics.fScore],
    ["Gross margin %", s => s.metrics.grossMargin], ["Net debt/equity %", s => s.metrics.netDebtEq], ["Interest cover x", s => s.metrics.intCover],
    ["EPS growth %", s => s.metrics.epsGrowth], ["Revenue growth %", s => s.metrics.revG],
    ["1m %", s => s.metrics.perf1], ["3m %", s => s.metrics.perf3m], ["6m %", s => s.metrics.perf6], ["12m %", s => s.metrics.perf12],
    ["RSI(14)", s => s.metrics.rsi], ["Beta", s => s.metrics.beta], ["52wk high", s => s.week52Hi], ["52wk low", s => s.week52Lo],
    ["Analyst mean target", s => s.target], ["Consensus", s => s.rec], ["Short % of float", s => s.metrics.shortPct],
    ["Institutions %", s => s.metrics.instOwn], ["Insiders %", s => s.metrics.insider],
  ];
  function csvOf(rows) {
    const cell = v => v == null ? "" : `"${String(typeof v === "number" ? +v.toFixed(3) : v).replace(/"/g, '""')}"`;
    return "\ufeff" + [CSV_COLS.map(c => cell(c[0])).join(",")]
      .concat(rows.map(s => CSV_COLS.map(c => cell(c[1](s))).join(","))).join("\r\n");
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const csvName = () => "factordesk-" + new Date().toISOString().slice(0, 10) + ".csv";
  const screenHTML = () => {
    if (!state.screens.length) return `<span class="muted small">No saved screens yet — set filters and weights, then save. Screens live in this browser only.</span>`;
    return `<span class="screens">${state.screens.map((sc, i) => `<span class="screen-chip"><button class="chip-load" data-screen="${i}" title="Weights ${Object.values(sc.weights).join("/")} · saved ${new Date(sc.at).toLocaleDateString("en-GB")}">${esc(sc.name)}</button><button class="chip-del" data-screen-del="${i}" aria-label="Delete ${esc(sc.name)}">×</button></span>`).join("")}</span>`;
  };

  /* Shareable screens: filters, weights and the sort all live in the route query,
     so a screen you built is a URL you can paste to someone else. */
  const FKEYS = { q: "q", country: "co", sector: "se", capMin: "cm", peMax: "pe", roceMin: "ro", p12Min: "p12", dyMin: "dy", poMax: "po", fsMin: "fs" };
  const WKEYS = ["quality", "value", "momentum", "growth", "smallcap"];
  function screenQuery() {
    const p = new URLSearchParams();
    for (const [k, short] of Object.entries(FKEYS)) {
      const v = state.filters[k];
      if (v !== "" && v != null) p.set(short, v);
    }
    const w = WKEYS.map(k => state.weights[k] ?? FD.DEFAULT_WEIGHTS[k]);
    if (w.join() !== WKEYS.map(k => FD.DEFAULT_WEIGHTS[k]).join()) p.set("w", w.join(","));
    p.set("by", state.sort.key); p.set("dir", state.sort.dir === 1 ? "asc" : "desc");
    return p.toString();
  }
  function applyScreenQuery(qs) {
    const p = new URLSearchParams(qs);
    const f = { ...EMPTY_FILTERS };
    for (const [k, short] of Object.entries(FKEYS)) if (p.get(short) != null) f[k] = p.get(short);
    const by = p.get("by");
    state.filters = f;
    if (p.get("w")) {
      const parts = String(p.get("w")).split(",");
      state.weights = Object.fromEntries(WKEYS.map((k, i) => [k, Math.min(60, Math.max(0, Math.round(+parts[i]) || 0))]));
    }
    if (by && COLS.some(c => c.key === by)) state.sort = { key: by, dir: p.get("dir") === "asc" ? 1 : -1 };
    FD.store.set("filters", state.filters); FD.store.set("weights", state.weights);
  }

  /* ---------- alerts: evaluated against the delayed live quote whenever a page loads ---------- */
  const ALERT_FIELDS = { price: ["price", s => s.metrics.price], rank: ["FactorRank", s => Math.round(live(s))] };
  function alertNow(a) { const s = FD.get(a.t), f = ALERT_FIELDS[a.field]; return s && f ? f[1](s) : null; }
  function alertHit(a) {
    const now = alertNow(a);
    return now == null ? null : (a.op === "above" ? now >= a.v : now <= a.v);
  }
  const mineAlerts = (t) => state.alerts.filter(a => a.t === t);
  function alertFlag() {
    const el = $("#alert-flag"); if (!el) return;
    const n = state.alerts.filter(a => alertHit(a) === true).length;
    el.hidden = !n;
    el.textContent = n + (n === 1 ? " alert hit" : " alerts hit");
  }
  function alertsCard() {
    if (!state.alerts.length) return "";
    return `<div class="card" style="margin-top:1.4rem"><h3>Alerts</h3>
      <div style="overflow-x:auto"><table class="data"><thead><tr><th>Stock</th><th>Rule</th><th>Now</th><th>Status</th><th></th></tr></thead><tbody>
      ${state.alerts.map((a, i) => { const f = ALERT_FIELDS[a.field], now = alertNow(a), hit = alertHit(a);
        return `<tr><td>${logoHTML(FD.get(a.t), "lg-sm")}<b class="tkr">${esc(a.t)}</b></td>
        <td>${f ? f[0] : esc(a.field)} ${a.op} ${FD.fmt.num(a.v, a.field === "price" ? 2 : 0)}</td>
        <td>${now == null ? "—" : now}</td>
        <td>${hit == null ? '<span class="muted">no data</span>' : hit ? '<span class="pos">Triggered</span>' : '<span class="muted">Waiting</span>'}</td>
        <td style="text-align:right"><button class="btn sm" data-alert-del="${i}" aria-label="Delete alert">×</button></td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted small">Checked against the delayed live quote every time a page loads. There is no background service in this app, so a hit appears here and in the top bar rather than being pushed to you.</p></div>`;
  }
  function wireAlerts() {
    view.querySelectorAll("[data-alert-del]").forEach(b => b.onclick = () => {
      state.alerts.splice(+b.dataset.alertDel, 1);
      FD.store.set("alerts", state.alerts); rerender();
    });
    alertFlag();
  }

  function renderScreener() {
    $("#crumb").textContent = "Screener";
    const w = state.weights, f = state.filters;
    const sel = (id, opts, val) => `<select data-f="${id}"><option value="">All</option>` +
      opts.map(o => `<option ${o === val ? "selected" : ""}>${o}</option>`).join("") + "</select>";
    const numf = (id, label, ph) => `<div class="field">${label}<input type="number" data-f="${id}" value="${esc(f[id] ?? "")}" placeholder="${ph}" min="0"></div>`;
    const sliders = Object.keys(w).map(k => `
      <div class="weight"><label>${({ quality: "Quality", value: "Value", momentum: "Momentum", growth: "Growth", smallcap: "Small cap" })[k]}<output>${w[k]}</output></label>
      <input type="range" min="0" max="60" value="${w[k]}" data-w="${k}"></div>`).join("");
    const rows = applyFilters(rankedAll());

    view.innerHTML = `
    <div class="controls">
      <div class="controls-row">
        <div class="field">Search<input data-f="q" type="text" value="${esc(f.q)}" placeholder="ticker or name"></div>
        <div class="field">Country${sel("country", FD.countries, f.country)}</div>
        <div class="field">Sector${sel("sector", FD.sectors, f.sector)}</div>
        ${numf("capMin", "Min cap (bn, quote ccy)", "1")}${numf("peMax", "Max P/E", "25")}
        ${numf("roceMin", "Min ROCE %", "15")}${numf("p12Min", "Min 12m %", "0")}
        ${numf("dyMin", "Min div %", "3")}${numf("poMax", "Max payout %", "60")}${numf("fsMin", "Min F-Score", "7")}
        <div class="spacer"></div>
        <button class="btn sm" id="clear-f">Clear filters</button>
        <button class="btn sm" id="save-s">Save this screen</button>
        <button class="btn sm" id="share-s">Copy link to this screen</button>
        <button class="btn sm btn-primary" id="csv-f">Export ${rows.length} rows (CSV)</button>
      </div>
      <div class="controls-row"><span class="muted small" style="align-self:center">Saved screens —</span>${screenHTML()}
      </div>
      <div class="controls-row"><span class="muted small" style="align-self:center">Your FactorRank weights (re-ranks live) —</span>
        <div class="weights" style="flex:1;min-width:min(480px,100%)">${sliders}</div>
        <button class="btn sm" id="reset-w">Reset blend</button>
      </div>
    </div>
    ${stockTable(rows)}`;

    view.querySelectorAll("[data-f]").forEach(inp => inp.oninput = () => {
      state.filters[inp.dataset.f] = inp.value;
      FD.store.set("filters", state.filters);
      if (inp.dataset.f !== "q" || inp.tagName === "SELECT") refreshRows(); else refreshRows();
    });
    view.querySelectorAll("[data-w]").forEach(sl => sl.oninput = () => {
      state.weights[sl.dataset.w] = +sl.value;
      FD.store.set("weights", state.weights);
      sl.parentElement.querySelector("output").textContent = sl.value;
      refreshRows();
    });
    $("#clear-f").onclick = () => { state.filters = { ...EMPTY_FILTERS }; FD.store.set("filters", state.filters); rerender(); };
    $("#reset-w").onclick = () => { state.weights = { ...FD.DEFAULT_WEIGHTS }; FD.store.set("weights", state.weights); rerender(); };
    $("#csv-f").onclick = () => download(csvName(), csvOf(sortRows(applyFilters(rankedAll()))));
    $("#share-s").onclick = async () => {
      const url = location.origin + location.pathname + "#/screener?" + screenQuery();
      const say = (t) => { const b = $("#share-s"); if (b) { b.textContent = t; setTimeout(() => { const c = $("#share-s"); if (c) c.textContent = "Copy link to this screen"; }, 5000); } };
      try { await navigator.clipboard.writeText(url); say("Link copied"); }
      catch { prompt("Clipboard is blocked in this browser — copy the link below:", url); }
    };
    $("#save-s").onclick = () => {
      const name = (prompt("Name this screen — filters and weights, kept in this browser:", "My screen " + (state.screens.length + 1)) || "").trim();
      if (!name) return;
      const at = state.screens.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
      if (at >= 0 && !confirm(`Replace the saved screen "${name}"?`)) return;
      const rec = { name, filters: { ...state.filters }, weights: { ...state.weights }, at: Date.now() };
      if (at >= 0) state.screens[at] = rec; else state.screens.push(rec);
      FD.store.set("screens", state.screens); rerender();
    };
    view.querySelectorAll("[data-screen]").forEach(b => b.onclick = () => {
      const sc = state.screens[+b.dataset.screen]; if (!sc) return;
      state.filters = { ...EMPTY_FILTERS, ...sc.filters }; state.weights = { ...FD.DEFAULT_WEIGHTS, ...sc.weights };
      FD.store.set("filters", state.filters); FD.store.set("weights", state.weights);
      rerender();
    });
    view.querySelectorAll("[data-screen-del]").forEach(b => b.onclick = () => {
      const i = +b.dataset.screenDel;
      if (!confirm(`Delete the saved screen "${state.screens[i].name}"?`)) return;
      state.screens.splice(i, 1); FD.store.set("screens", state.screens); rerender();
    });
    wireTable();
  }
  function refreshRows() {
    const rows = applyFilters(rankedAll());
    const wrap = $(".table-wrap");
    if (wrap) wrap.outerHTML = stockTable(rows);
    const ex = $("#csv-f"); if (ex) ex.textContent = `Export ${rows.length} rows (CSV)`;
    wireTable();
  }

  /* ---------- rankings ---------- */
  function renderRankings() {
    $("#crumb").textContent = "Rankings";
    const rows = rankedAll();
    const champions = FD.sectors.map(sec => {
      const inSec = rows.filter(s => s.sector === sec).slice(0, 2);
      return `<div class="card" style="padding:.8rem 1rem">
        <h4 style="margin:0 0 .4rem">${esc(sec)}</h4>
        ${inSec.map(s => `<div class="peer-row" data-t="${s.t}" style="grid-template-columns:6.4rem 1fr 2.6rem;cursor:pointer">
          <span class="tkr">${logoHTML(s, "lg-xs")}${esc(s.t)}</span><div class="bar-track"><div class="bar-fill" style="width:${s.liveRank}%"></div></div>
          <span class="rank-cell">${Math.round(s.liveRank)}</span></div>`).join("")}
      </div>`;
    }).join("");
    view.innerHTML = `
      <p class="muted">Blend: ${Object.entries(state.weights).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)} ${v}%`).join(" · ")} — change it in the <a href="#/screener">screener</a>. <button class="btn sm" id="csv-r">Export these ${Math.min(60, rows.length)} rows (CSV)</button></p>
      ${stockTable(rows.slice(0, 60))}
      <h3 style="margin-top:1.6rem">Sector champions — top 2 per sector</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">${champions}</div>
      <p class="small muted" style="margin-top:1rem">This is the "Sector Champions" model-portfolio idea in one screen: a rules-based, equally-weighted basket of the highest-ranked two stocks in each sector. Rebalance annually and it forces discipline over narrative.</p>`;
    wireTable();
    $("#csv-r").onclick = () => download(csvName(), csvOf(sortRows(rows.slice(0, 60))));
    view.querySelectorAll(".peer-row[data-t]").forEach(r => r.onclick = () => location.hash = "#/stock/" + r.dataset.t);
  }

  /* ---------- strategy presets ---------- */
  const PRESETS = [
    { name: "QM Leaders", desc: "Quality & Momentum — the classic academic winners blend. Strongest all-weather tilt.", f: { roceMin: "20", p12Min: "5" }, w: { quality: 40, value: 10, momentum: 40, growth: 8, smallcap: 2 } },
    { name: "Deep Value", desc: "Cheap on multiple metrics with a health floor (F-Score) to dodge value traps.", f: { peMax: "12", fsMin: "6", roceMin: "10" }, w: { quality: 20, value: 55, momentum: 5, growth: 5, smallcap: 15 } },
    { name: "GARP", desc: "Growth at a reasonable price — fast growers that aren't priced for perfection.", f: { roceMin: "15", peMax: "25" }, w: { quality: 30, value: 20, momentum: 15, growth: 35, smallcap: 0 } },
    { name: "Dividend Compounders", desc: "High yields funded by real cash flows, run by profitable businesses.", f: { dyMin: "4", poMax: "70", roceMin: "18" }, w: { quality: 35, value: 35, momentum: 5, growth: 10, smallcap: 15 } },
    { name: "Small-Cap Breakouts", desc: "Under-the-radar movers with positive momentum. Higher risk, wider spreads.", f: { p12Min: "10" }, w: { quality: 25, value: 15, momentum: 30, growth: 10, smallcap: 35 } },
    { name: "Sector Champions", desc: "The default balanced blend used on the Rankings page.", f: {}, w: { ...FD.DEFAULT_WEIGHTS } },
  ];
  function renderPresets() {
    $("#crumb").textContent = "Strategy presets";
    view.innerHTML = `<p class="muted">One-click rule sets. Applying a preset loads its filters and factor weights, then opens the screener.</p>
      <div class="presets-grid">${PRESETS.map((p, i) => `
        <div class="card"><h3>${esc(p.name)}</h3><p>${esc(p.desc)}</p>
        <p class="small muted">Weights: ${Object.entries(p.w).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)} ${v}`).join(" / ")}</p>
        <button class="btn btn-primary sm" data-p="${i}">Apply & open screener</button></div>`).join("")}</div>`;
    view.querySelectorAll("[data-p]").forEach(b => b.onclick = () => {
      const p = PRESETS[+b.dataset.p];
      state.weights = { ...FD.DEFAULT_WEIGHTS, ...p.w }; state.filters = { ...EMPTY_FILTERS, ...p.f };
      FD.store.set("weights", state.weights); FD.store.set("filters", state.filters);
      location.hash = "#/screener";
    });
  }

  /* ---------- stock report ---------- */
  function renderStock(t) {
    const s = FD.get(t);
    if (!s) {
      $("#crumb").textContent = "Unknown ticker";
      view.innerHTML = `<div class="empty-state"><div class="big">?</div><h3>${esc(t)} is not in the live universe</h3>
        <p class="small muted">FactorDesk scores the ${FD.stocks.length} listed companies it pulls from Yahoo Finance. Type a ticker or name in the search box at the top, or browse the rankings.</p>
        <div style="display:flex;justify-content:center"><a class="btn btn-primary" href="#/rankings">Browse rankings</a></div></div>`;
      return;
    }
    $("#crumb").innerHTML = `${esc(s.t)} — ${esc(s.name)}`;
    const rows = rankedAll();
    const pos = rows.findIndex(x => x.t === s.t) + 1;
    const m = s.metrics, f = s.factors;
    let chatEntryMarker = FD.entryMarker && FD.entryMarker.ticker === s.t ? FD.entryMarker : null;
    s.liveRank = live(s);
    const typeBadge = s.type === "Star Share" || s.type === "Sleeping Compounder" || s.type === "Contrarian Play" ? "good"
      : s.type === "Middle Ground" ? "" : "bad";
    const grp = (title, pairs) => `<div class="card"><table class="kv"><tr><th colspan="2">${title}</th></tr>
      ${pairs.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("")}</table></div>`;
    const peers = rows.filter(x => x.sector === s.sector).slice(0, 8);
    const insights = insightsFor(s, pos, rows.length);
    const pt = FD.points(s), g = FD.signals(s);
    const ccyNote = s.ccy === "GBp" ? "UK listing — Yahoo quotes pence, every figure here is pounds" : `${s.country} listing, quoted in ${s.ccy || s.currency}`;
    const ccyShort = s.ccy === "GBp" ? "GBP" : (s.ccy || s.currency || "");
    const rangePos = g.hi52 > g.lo52 && g.last != null ? (g.last - g.lo52) / (g.hi52 - g.lo52) * 100 : null;

    view.innerHTML = `
    <div class="stock-head">
      <div class="sh-left">${logoHTML(s, "lg-xl")}<div><h2>${esc(s.name)} <span class="tkr">${esc(s.t)}</span></h2>
        <span class="muted" title="${esc(ccyNote)}">${esc(s.sector)} · ${s.country} · ${esc(ccyShort)}</span>
        <span class="badge ${typeBadge}">${esc(s.type)}</span>
        ${chipRow(FD.chips(s))}</div></div>
      <div class="stock-quote">
        <div class="stock-price">${FD.fmt.px(s, m.price)} <span class="${m.perf12 >= 0 ? "pos" : "neg"} small">${FD.fmt.pct(m.perf12)} 12m</span></div>
        <div class="rank-cell" style="font-size:1.1rem">FactorRank ${Math.round(s.liveRank)} <span class="muted small">#${pos} of ${rows.length}</span></div>
        <button class="btn sm ${FD.watchlist.has(s.t) ? "" : "btn-primary"}" id="wl-btn">${FD.watchlist.has(s.t) ? "★ In watchlist" : "☆ Add to watchlist"}</button>
        <button class="btn sm" id="pf-btn">+ Add to portfolio</button>
      </div>
    </div>
    <div class="panel-grid">
      <div class="card">
        <div class="chart-bar">
          <div class="range-btns" id="ranges">${[["1M", 21], ["3M", 63], ["6M", 128], ["1Y", 252], ["2Y", 504], ["5Y", 1260]]
            .map(([L, n]) => `<button class="tab ${L === "1Y" ? "active" : ""}" data-n="${n}">${L}</button>`).join("")}</div>
          <div class="range-btns" id="kinds" role="group" aria-label="Chart type">
            <button class="tab active" data-kind="line">Line</button>
            <button class="tab" data-kind="candle">Candles</button>
          </div>
        </div>
        <div class="perf-strip" id="px-perf"></div>
        <canvas class="chart" id="px-chart" style="height:300px"></canvas>
        ${chatEntryMarker ? `<p class="entry-marker-note" id="entry-marker-note"><b>Chat entry reference:</b> ${FD.fmt.px(s, chatEntryMarker.price)} · current rule level shown at the latest session, not a historical buy signal. <button class="entry-marker-clear" id="clear-entry-marker" type="button">Clear marker</button></p>` : ""}
        <div class="chart-read">
          <div class="cr-item"><span class="mc-label">52-week range</span>
            <div class="range-bar"><div class="rb-fill" style="left:${rangePos == null ? 0 : rangePos}%"></div><span class="rb-lo">${FD.fmt.num(g.lo52, 2)}</span><span class="rb-hi">${FD.fmt.num(g.hi52, 2)}</span></div>
            <span class="muted small">${g.fromHi == null ? "—" : FD.fmt.pct(g.fromHi, 1) + " from the high · peak-to-trough drawdown " + FD.fmt.num(g.drawdown, 1) + "%"}</span></div>
          <div class="cr-item"><span class="mc-label">Short-term thrust</span>
            <div class="bar-track"><div class="bar-fill ${m.rsi > 70 || m.rsi < 30 ? "neg-fill" : ""}" style="width:${m.rsi == null ? 0 : m.rsi}%"></div></div>
            <span class="muted small">RSI(14) ${m.rsi == null ? "—" : Math.round(m.rsi)} · ${m.rsi >= 70 ? "stretched" : m.rsi <= 30 ? "washed out" : "mid-range"} · volatility ${FD.fmt.num(g.vol, 0)}% annualised</span></div>
          <div class="cr-item"><span class="mc-label">Versus its sector</span>
            <div class="bar-track"><div class="bar-fill" style="width:${g.rel3m == null ? 0 : Math.min(Math.abs(g.rel3m) * 2, 100)}%"></div></div>
            <span class="muted small">${g.rel3m == null ? "—" : "3-month relative " + FD.fmt.pct(g.rel3m) + " · 12-month relative " + FD.fmt.pct(g.rel12m)}${g.sector ? " (vs " + esc(s.sector) + " avg " + FD.fmt.pct(g.sector.perf3m) + " 3m)" : ""}</span></div>
        </div>
        <div class="alert-form">
          <span class="muted small">Alert me when</span>
          <select id="al-field"><option value="price">price</option><option value="rank">FactorRank</option></select>
          <select id="al-op"><option value="above">rises above</option><option value="below">falls below</option></select>
          <input id="al-v" type="number" step="any" value="${FD.fmt.num(m.price, 2)}" aria-label="Alert threshold">
          <button class="btn sm" id="al-btn">Add alert</button>
          ${mineAlerts(s.t).length ? `<span class="muted small">live on ${esc(s.t)}: ${mineAlerts(s.t).map(a => `${a.field} ${a.op} ${a.v}`).join(" · ")}</span>` : ""}
        </div>
      </div>
      <div>
        <div class="mini-cards">          <div class="mini-card"><div class="mc-label">Quality</div><div class="mc-value">${Math.round(f.quality)}</div><div class="bar-track"><div class="bar-fill" style="width:${f.quality}%"></div></div></div>
          <div class="mini-card"><div class="mc-label">Value</div><div class="mc-value">${Math.round(f.value)}</div><div class="bar-track"><div class="bar-fill" style="width:${f.value}%"></div></div></div>
          <div class="mini-card"><div class="mc-label">Momentum</div><div class="mc-value">${Math.round(f.momentum)}</div><div class="bar-track"><div class="bar-fill" style="width:${f.momentum}%"></div></div></div>
          <div class="mini-card"><div class="mc-label">Growth</div><div class="mc-value">${Math.round(f.growth)}</div><div class="bar-track"><div class="bar-fill" style="width:${f.growth}%"></div></div></div>
        </div>
        <div class="card" style="margin-top:.9rem;text-align:center"><canvas class="chart" id="radar"></canvas></div>
        <div class="card verdict ${pt.verdict.tone}" style="margin-top:.9rem">
          <div><span class="mc-label">The rules say</span><div class="vd-label">${esc(pt.verdict.label)}</div></div>
          <div class="vd-tally"><b>${pt.bars.bull}</b> for · <b>${pt.bars.bear}</b> against · score ${pt.score > 0 ? "+" : ""}${pt.score}</div>
          <p class="muted small">Deterministic: every line below cites the number it comes from. No forecasts, no price targets.</p>
        </div>
      </div>
    </div>
    <div class="metric-cols" style="margin-top:1.1rem">
      ${grp("Valuation", [["P/E", numCell(m.pe, 1, "x")], ["P/BV", numCell(m.pb, 1, "x")], ["Dividend yield", numCell(m.divYield, 1, "%")], ["Payout of earnings", numCell(m.payout, 0, "%")], ["FCF yield", numCell(m.fcfYield, 1, "%")], ["Earnings yield", numCell(m.pe ? 100 / m.pe : null, 1, "%")], ["PEG", numCell(m.peg, 2, "x")], s.target ? ["Analyst mean target", FD.fmt.px(s, s.target) + " (" + FD.fmt.pct((s.target / m.price - 1) * 100, 0) + ")"] : null].filter(Boolean))}
      ${grp(s.roceBasis + " & health", [[s.roceBasis, numCell(m.roce, 1, "%")], ["Health score (0–9)", m.fScore != null ? Math.round(m.fScore) + "/9" : "—"], ["Gross margin", numCell(m.grossMargin, 1, "%")], ["Net debt/equity", numCell(m.netDebtEq, 1, "%")], ["Interest cover", numCell(m.intCover, 1, "x")], m.instOwn != null ? ["Institutions hold", numCell(m.instOwn, 0, "%")] : null, m.shortPct != null ? ["Short interest", numCell(m.shortPct, 1, "% of float")] : null].filter(Boolean))}
      ${grp("Growth", [["EPS growth (YoY)", FD.fmt.pct(m.epsGrowth, 1)], ["Revenue growth", FD.fmt.pct(m.revG)], ["Fwd EPS growth", FD.fmt.pct(m.fwdEPS)]])}
      ${grp("Performance & risk", [["1 month", FD.fmt.pct(m.perf1)], ["3 months", FD.fmt.pct(m.perf3m)], ["6 months", FD.fmt.pct(m.perf6)], ["12 months", FD.fmt.pct(m.perf12)], ["RSI(14)", m.rsi == null ? "—" : Math.round(m.rsi)], ["Beta", numCell(m.beta, 2)], ["52-week hi/lo", g.hi52 == null ? "—" : FD.fmt.num(g.hi52, 2) + " / " + FD.fmt.num(g.lo52, 2)], ["Market cap", FD.fmt.cap(m.mcap, s.currency)]])}
    </div>
    <div class="card" style="margin-top:1.1rem"><h3>Relative performance</h3>
      <div class="range-btns" id="rel-basis">
        <button class="tab active" data-basis="universe">vs the universe</button>
        <button class="tab" data-basis="sector">vs ${esc(s.sector)} peers</button>
      </div>
      <canvas class="chart" id="rel-chart" style="height:220px"></canvas>
      <p class="muted small" id="rel-note">cumulative percentage points above or below an equal-weight benchmark, so a flat line means the stock went exactly with it</p>
    </div>
    <div class="card" style="margin-top:1.1rem"><h3>Reported financials, year by year</h3>
      <div id="st-fin"><p class="muted small">loading the statements…</p></div></div>
    <div class="card" style="margin-top:1.1rem"><h3>Dividends, year by year</h3>
      <div id="st-div"><p class="muted small">loading the ex-dividend history…</p></div></div>
    <div class="panel-grid" style="margin-top:1.1rem">
      <div class="card"><h3>Investment points</h3>
        <div class="pts">
          <div class="pt-col good"><h4>What's working</h4>${pt.bull.length ? pt.bull.map(p => `<div class="insight">${esc(p)}</div>`).join("") : `<p class="muted small">Nothing stands out on the bullish side of the rule set.</p>`}</div>
          <div class="pt-col bad"><h4>What could go wrong</h4>${pt.bear.length ? pt.bear.map(p => `<div class="insight bad">${esc(p)}</div>`).join("") : `<p class="muted small">No bearish rule triggered on the published data.</p>`}</div>
        </div>
        <h4 class="pt-watch-h">Things to watch</h4>
        ${pt.watch.map(p => `<div class="insight warn">${esc(p)}</div>`).join("")}
        <p class="small muted">Rule-generated from the metrics on this page — ${FD.stocks.length} live stocks, percentile-blended. Educational, not advice.</p>
      </div>
      <div class="card"><h3>Sector peers by FactorRank</h3>
        ${peers.map(p => `<div class="peer-row" data-t="${p.t}" style="cursor:pointer">
          <span class="tkr">${logoHTML(p, "lg-xs")}${esc(p.t)}</span>
          <div class="bar-track"><div class="bar-fill ${p.t === s.t ? "me" : ""}" style="width:${p.liveRank}%"></div></div>
          <span>${Math.round(p.liveRank)}</span></div>`).join("")}
        <h4 style="margin-top:1rem">Signals the machine sees</h4>
        ${insights.map(i => `<div class="insight ${i.cls || ""}">${i.text}</div>`).join("")}
      </div>
    </div>
    <div class="card" style="margin-top:1.1rem"><h3>What moves this stock</h3>
      <p class="muted small">Every row is a measured relationship between this listing and a published series — the number is real, the link is stated as a correlation, never as a forecast.</p>
      <div id="st-drivers"><p class="muted small">loading the market series…</p></div></div>
    <div class="card" style="margin-top:1.1rem">
      <h3>Plain-English write-up</h3>
      <p class="muted small">Sent only the numbers on this page to the model — no key reaches the browser, and nothing is invented that isn't above.</p>
      ${aiButton("stock", "st", () => stockFacts(s, pos, rows.length))}
      <div class="ai-out" id="st-aiout"></div>
    </div>
    <div class="card" style="margin-top:1.1rem"><h3>Latest on ${esc(s.name)}</h3><div id="st-news"><p class="muted small">loading headlines…</p></div></div>`;

    const series = FD.series(s);
    const cl = series.closes;
    /* Chart state: the universe carries a 260-bar close window, so anything past a year and any
       candle needs the on-demand five-year bar set. Until it arrives the long ranges say
       "loading" rather than drawing the shorter window and letting the label imply otherwise. */
    let bars = null, barsFailed = false, pxN = 252, pxKind = "line";
    const sma = (arr, k) => arr.map((_, i) => (i + 1 >= k
      ? arr.slice(i + 1 - k, i + 1).reduce((a, b) => a + b, 0) / k : null));
    const roll = (k) => sma(cl, k);
    let sma50 = roll(50), sma200 = roll(200);

    function perfStrip(win) {
      const host = $("#px-perf"); if (!host) return;
      const c = win.c, first = c[0], last = c[c.length - 1];
      const chg = (last / first - 1) * 100;
      const hi = Math.max(...win.h), lo = Math.min(...win.l);
      let peak = -Infinity, mdd = 0;
      for (const v of c) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
      const yrs = (win.dates[win.dates.length - 1] - win.dates[0]) / (365.25 * 86400000);
      const ann = yrs > 0.2 && last > 0 && first > 0 ? (Math.pow(last / first, 1 / yrs) - 1) * 100 : null;
      const rets = [];
      for (let i = 1; i < c.length; i++) if (c[i - 1]) rets.push(c[i] / c[i - 1] - 1);
      let vol = null;
      if (rets.length > 2) {
        const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
        const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1));
        vol = sd * Math.sqrt(252) * 100;
      }
      const cell = (label, val, cls) => `<div class="ps"><span>${label}</span><b class="${cls || ""}">${val}</b></div>`;
      host.innerHTML = [
        cell("Sessions", c.length),
        cell("Change", FD.fmt.pct(chg, 1), chg >= 0 ? "pos" : "neg"),
        ann == null ? cell("Annualised", "—") : cell("Annualised", FD.fmt.pct(ann, 1), ann >= 0 ? "pos" : "neg"),
        cell("High", FD.fmt.num(hi, 2)), cell("Low", FD.fmt.num(lo, 2)),
        cell("Worst drawdown", FD.fmt.pct(mdd * 100, 1), "neg"),
        vol == null ? cell("Volatility (ann.)", "—") : cell("Volatility (ann.)", FD.fmt.num(vol, 1) + "%"),
      ].join("") + `<p class="muted small">Measured on the ${win.dates.length} bars in the window you picked, in ${esc(s.currency || "the listing's currency")} — the same series the chart draws, not the platform's 12-month figure. Volatility is the standard deviation of daily returns here, annualised over 252 sessions.</p>`;
    }

    function drawChart() {
      const cv = $("#px-chart"); if (!cv) return;
      const host = $("#px-perf");
      const clear = (msg) => { const p = document.createElement("p"); p.className = "muted small"; p.textContent = msg; cv.replaceWith(p); if (host) host.innerHTML = ""; };
      if (pxKind === "candle" && barsFailed) return clear("This listing does not publish open/high/low bars, so candles cannot be drawn.");
      if (pxKind !== "candle" && pxN > cl.length && barsFailed) return clear("No history beyond the platform's one-year window is published for this listing.");
      if ((pxKind === "candle" || pxN > cl.length) && !bars) {
        if (host) host.innerHTML = '<p class="muted small">loading ' + pxN + " sessions of bar history for " + esc(s.t) + "…</p>";
        FD.bars(s.t).then(b => { if (b) { bars = b; sma50 = sma(b.c, 50); sma200 = sma(b.c, 200); } else barsFailed = true; drawChart(); });
        return;
      }
      const useBars = pxKind === "candle" || pxN > cl.length;
      const src = useBars ? bars : { dates: series.dates, c: cl };
      const start = Math.max(0, src.dates.length - pxN);
      const len = src.dates.length - start;
      const win = { dates: src.dates.slice(start), c: src.c.slice(start),
        h: (src.h || src.c).slice(start), l: (src.l || src.c).slice(start), o: (src.o || src.c).slice(start) };
      perfStrip(win);
      const av = (arr) => arr.slice(Math.max(0, arr.length - len));
      const overlays = [{ values: av(sma50), color: "#8b93a7", label: "50-day avg" },
        { values: av(sma200), color: "#c8a24a", label: "200-day avg" }];
      const marker = chatEntryMarker ? { value: chatEntryMarker.price, label: "Chat entry reference" } : null;
      requestAnimationFrame(() => {
        const el = $("#px-chart"); if (!el || !el.tagName) return;
        if (pxKind === "candle") FD.candleChart(el, win.dates, win, { height: 300, overlays, marker });
        else FD.lineChart(el, win.dates, win.c, { height: 300, overlays, marker });
      });
    }
    drawChart();
    const clearMarker = $("#clear-entry-marker");
    if (clearMarker) clearMarker.onclick = () => {
      chatEntryMarker = null;
      FD.entryMarker = null;
      $("#entry-marker-note").remove();
      drawChart();
    };
    view.querySelectorAll("#ranges .tab").forEach(b => b.onclick = () => {
      view.querySelectorAll("#ranges .tab").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); pxN = +b.dataset.n; drawChart();
    });
    view.querySelectorAll("#kinds .tab").forEach(b => b.onclick = () => {
      view.querySelectorAll("#kinds .tab").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); pxKind = b.dataset.kind; drawChart();
    });
    let relBasis = "universe";
    function drawRel() {
      const cv = $("#rel-chart"), note = $("#rel-note");
      if (!cv || !cv.tagName) return;
      const r = FD.relative(s, relBasis, 270);
      if (!r || r.rel.length < 3) { cv.replaceWith('<p class="muted small">Not enough overlapping price history to compare against a benchmark.</p>'); return; }
      const last = r.rel[r.rel.length - 1];
      requestAnimationFrame(() => FD.lineChart($("#rel-chart"), r.dates, r.rel, { height: 220 }));
      if (note) note.textContent = `${last >= 0 ? "Ahead of" : "Behind"} the benchmark by ${FD.fmt.num(Math.abs(last), 1)} percentage points across ${r.dates.length} trading dates, against ${r.pool} equal-weighted names. Each return is in its own listing's currency, so the gap includes no FX adjustment.`;
    }
    drawRel();
    view.querySelectorAll("#rel-basis .tab").forEach(b => b.onclick = () => {
      view.querySelectorAll("#rel-basis .tab").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); relBasis = b.dataset.basis; drawRel();
    });
    $("#al-field").onchange = () => {
      $("#al-v").value = $("#al-field").value === "price" ? +m.price.toFixed(2) : Math.round(live(s));
    };
    $("#al-btn").onclick = () => {
      const v = parseFloat($("#al-v").value);
      if (!isFinite(v)) return;
      state.alerts.push({ t: s.t, field: $("#al-field").value, op: $("#al-op").value, v });
      FD.store.set("alerts", state.alerts); rerender();
    };
    const labels = ["Quality", "Value", "Momentum", "Growth", "SmallCap"];    FD.radar($("#radar"), labels, labels.map(L => s.factors[L.toLowerCase() === "smallcap" ? "smallcap" : L.toLowerCase()]));
    $("#wl-btn").onclick = () => { FD.watchlist.toggle(s.t); rerender(); };
    $("#pf-btn").onclick = () => addFromStock(s);
    view.querySelectorAll(".peer-row[data-t]").forEach(r => r.onclick = () => location.hash = "#/stock/" + r.dataset.t);
    wireAI();
    FD.news(s.name).then(items => {
      const host = document.getElementById("st-news"); if (!host) return;
      host.innerHTML = items.length ? items.map(newsRow).join("")
        : `<p class="muted small">No recent headlines published for this name.</p>`;
    });

    FD.fundamentals(s.t).then(f => {
      const host = document.getElementById("st-fin"); if (!host) return;
      if (f.error) { host.innerHTML = `<p class="muted small">${esc(f.error)}</p>`; return; }
      if (!f.fin || !f.fin.length) { host.innerHTML = `<p class="muted small">No annual statements are published for this listing — nothing is filled in with an estimate.</p>`; return; }
      host.innerHTML = finTable(s, f.fin);
      const dhost = document.getElementById("st-div");
      if (dhost) dhost.innerHTML = divTable(s, f.divs, f.fin);
    });

    FD.loadMacro().then(() => {
      const host = document.getElementById("st-drivers"); if (!host) return;
      host.innerHTML = driverTable(s);
    });
  }

  function driverTable(s) {
    const d = FD.stockDrivers(s);
    if (!d.rows.length) return `<p class="muted small">No market series could be matched to this listing, so no driver is claimed. The factor scores above use only its own published numbers.</p>`;
    return `<div class="table-wrap"><table class="data drv"><thead><tr><th>Driver</th><th>Measured</th><th>What it means for ${esc(s.t)}</th></tr></thead><tbody>
      ${d.rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="${r.tone}">${esc(r.num)}</td><td class="why wide">${esc(r.why)}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted small">Correlations are read off daily closes on the days both markets were open, in each listing's own currency and without any adjustment for exchange rates. A relationship that held for the last 126 sessions is history, not a law: sectors and currencies decouple, and a stock's own news dominates on the day it lands.</p>`;
  }

  FD.showEntryMarker = (ticker, price) => {
    const t = String(ticker || "").toUpperCase();
    const value = Number(price);
    if (!FD.get(t) || !Number.isFinite(value)) return false;
    FD.entryMarker = { ticker: t, price: value };
    const target = "#/stock/" + encodeURIComponent(t);
    if (location.hash.toUpperCase() === target.toUpperCase()) renderStock(t);
    else location.hash = target;
    return true;
  };

  function divTable(s, dv, fin) {
    const na = '<span class="muted">—</span>';
    const ccy = s.currency || "£";
    if (!dv || !dv.years || !dv.years.length)
      return `<p class="muted small">${s.metrics.divYield
        ? "Yahoo publishes no ex-dividend history for this listing, so nothing is shown — the yield above is its own reported figure."
        : "No dividend on record — Yahoo reports none for this listing."}</p>`;
    const thisYear = new Date().getFullYear();
    const eps = {};
    (fin || []).forEach(r => { if (r.eps != null) eps[String(r.y)] = r.eps; });
    const rows = dv.years.map((r, i) => {
      const p = dv.years[i + 1];
      const partial = r.y === thisYear;
      const grow = !partial && p && p.cps ? (r.cps / p.cps - 1) * 100 : null;
      const e = eps[String(r.y)];
      const cover = !partial && e && r.cps ? e / r.cps : null;
      return `<tr><td>${r.y}${partial ? ` <span class="muted small">part-year</span>` : ""}</td>
        <td>${ccy}${FD.fmt.num(r.cps, 3)}</td><td>${r.n}</td>
        <td>${grow == null ? na : `<span class="${grow >= 0 ? "pos" : "neg"}">${FD.fmt.pct(grow, 1)}</span>`}</td>
        <td>${cover == null ? na : FD.fmt.num(cover, 1) + "x"}</td></tr>`;
    }).join("");
    /* how many of the last full calendar years raised the payout, from the same history */
    const full = dv.years.filter(r => r.y !== thisYear);
    let streak = 0;
    for (let i = 0; i + 1 < full.length; i++) { if (full[i].cps > full[i + 1].cps) streak++; else break; }
    const lastEx = dv.exLast ? new Date(dv.exLast).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
    return `<div style="overflow-x:auto"><table class="data"><thead><tr>
        <th>Calendar year</th><th>Cash per share</th><th>Paid</th><th>Growth</th><th>EPS cover</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="muted small" style="margin-top:.6rem">
        ${dv.ttmN ? `The last ${dv.ttmN} payment${dv.ttmN > 1 ? "s" : ""} — one ordinary dividend cycle for this payer — came to ${ccy}${FD.fmt.num(dv.ttm, 3)} per share${lastEx ? ", the most recent ex-date being " + lastEx : ""}. ` : ""}${streak ? `${streak} consecutive year${streak > 1 ? "s" : ""} of increases in this window. ` : ""}
        Cash amounts are Yahoo's ex-dividend records on the same per-share basis as the price; “EPS cover” divides the fiscal-year diluted EPS from the table above by that year's cash, and reads as “—” when either is not published. Growth compares full calendar years only.</p>`;
  }

  function finTable(s, rows) {
    const ccy = s.currency || "£";
    const na = '<span class="muted">—</span>';
    const big = v => v == null ? na : ccy + (Math.abs(v) >= 1e9 ? FD.fmt.num(v / 1e9, 2) + "bn" : Math.abs(v) >= 1e6 ? Math.round(v / 1e6) + "m" : FD.fmt.num(v, 0));
    const per = v => v == null ? na : ccy + FD.fmt.num(v, 2);
    const pl = v => v == null ? na : FD.fmt.num(v, 1) + "%";
    const sg = v => v == null ? na : `<span class="${v >= 0 ? "pos" : "neg"}">${FD.fmt.pct(v, 1)}</span>`;
    const prev = (i) => rows[i + 1];
    const row = (label, cells) => `<tr><td>${label}</td>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
    const grow = k => rows.map((r, i) => { const p = prev(i); return r[k] != null && p && p[k] ? (r[k] / p[k] - 1) * 100 : null; });
    const margin = rows.map(r => r.net != null && r.rev ? r.net / r.rev * 100 : null);
    /* the same published formula the headline score uses, applied to each year */
    const roce = rows.map((r, i) => {
      const p = prev(i), ce = r.eq != null ? r.eq + (r.debt || 0) : null;
      const was = p && p.eq != null ? p.eq + (p.debt || 0) : ce;
      return r.ebit != null && ce != null && (ce + was) ? r.ebit / ((ce + was) / 2) * 100 : null;
    });
    return `<div style="overflow-x:auto"><table class="data"><thead><tr><th>Fiscal year end</th>
        ${rows.map(r => `<th>${esc(r.y)}</th>`).join("")}</tr></thead><tbody>
        ${row("Revenue", rows.map(r => big(r.rev)))}
        ${row("Operating profit (EBIT)", rows.map(r => big(r.ebit)))}
        ${row("Net income", rows.map(r => big(r.net)))}
        ${row("Diluted EPS", rows.map(r => per(r.eps)))}
        ${row("Shareholders' equity", rows.map(r => big(r.eq)))}
        ${row("Total debt", rows.map(r => big(r.debt)))}
        ${row("Cash and short-term investments", rows.map(r => big(r.cash)))}
        ${row("Revenue growth", grow("rev").map(sg))}
        ${row("Net margin", margin.map(pl))}
        ${row("ROCE (EBIT / average capital employed)", roce.map(pl))}
      </tbody></table></div>
      <p class="muted small">Straight from the company statements Yahoo carries, newest year first — a blank means that line was not reported, and no figure is substituted for it. Per-share and statement amounts are in ${esc(ccy)}, the same basis as the price above.</p>`;
  }

  function addFromStock(s) {
    const qty = prompt(`Shares of ${s.t} you hold (or want to model)?`, "100");
    if (qty == null || !+qty) return;
    const avg = prompt("Average purchase price? (defaults to current)", FD.fmt.px(s, s.metrics.price).replace(/[^0-9.]/g, ""));
    if (avg == null || !+avg) return;
    FD.portfolio.upsert({ t: s.t, qty: +qty, avg: +avg, date: new Date().toISOString().slice(0, 10) });
    toast(`${s.t} added to portfolio`);
  }

  function insightsFor(s, pos, total) {
    const f = s.factors, m = s.metrics, g = FD.signals(s), out = [];
    if (f.quality >= 70 && f.momentum >= 70) out.push({ text: `Q+M leader — both Quality (${Math.round(f.quality)}) and Momentum (${Math.round(f.momentum)}) sit in the top quartile of ${total} live stocks. Historically the densest pocket of outperformance in the universe.`, cls: "" });
    if (f.quality < 35 && f.momentum >= 65) out.push({ text: `Momentum trap warning: price strength (${FD.fmt.pct(m.perf12)} 12m) isn't backed by profitability (${s.roceBasis} ${FD.fmt.num(m.roce)}%). These tend to mean-revert hard.`, cls: "bad" });
    if (f.value >= 65 && f.quality < 40) out.push({ text: `Cheap for a reason: P/E ${FD.fmt.num(m.pe)}x screens as Value, but the health read is ${m.fScore != null ? Math.round(m.fScore) + "/9" : "not published"} and net debt/equity ${FD.fmt.num(m.netDebtEq)}% — possible value trap.`, cls: "warn" });
    if (m.fScore >= 8) out.push({ text: `Health score ${Math.round(m.fScore)}/9 — improving on most fundamental checks simultaneously.`, cls: "" });
    if (m.netDebtEq != null && m.netDebtEq > 100) out.push({ text: `Leverage elevated: net debt/equity ${FD.fmt.num(m.netDebtEq)}% with interest cover only ${FD.fmt.num(m.intCover)}x. Rate shocks hurt here.`, cls: "warn" });
    if (m.rsi > 75) out.push({ text: `RSI(14) at ${Math.round(m.rsi)} — overbought short-term; chasing adds timing risk.`, cls: "warn" });
    if (m.rsi < 25 && f.quality > 60) out.push({ text: `Strong business (Quality ${Math.round(f.quality)}) at an oversold RSI ${Math.round(m.rsi)} — contrarian entry candidates often look like this.`, cls: "" });
    if (g.above200 != null) out.push({ text: `Trading ${g.above200 ? "above" : "below"} its 200-day average (${FD.fmt.px(s, g.sma200)}) with a ${FD.fmt.num(g.vol, 0)}% annualised volatility — ${g.above200 ? "the trend filter is on." : "trend-following rules would sit this one out."}`, cls: g.above200 ? "" : "warn" });
    if (g.cross === "golden" || g.cross === "death") out.push({ text: `${g.cross === "golden" ? "Golden" : "Death"} cross inside the last month — the 50-day average (${FD.fmt.px(s, g.sma50)}) has moved ${g.cross === "golden" ? "above" : "below"} the 200-day. Slow, late, but rarely wrong about the regime.`, cls: g.cross === "golden" ? "" : "warn" });
    if (g.rel3m != null) out.push({ text: `Relative strength vs ${s.sector}: ${FD.fmt.pct(g.rel3m)} over three months, ${FD.fmt.pct(g.rel12m)} over twelve. ${g.rel3m > 0 && g.rel12m > 0 ? "Consistent outperformer of its own industry." : g.rel3m < 0 && g.rel12m < 0 ? "Consistently lagging its industry." : "Mixed — the recent move isn't matched by the annual one."}`, cls: g.rel3m >= 0 ? "" : "warn" });
    if (s.target && m.price) {
      const up = (s.target / m.price - 1) * 100;
      out.push({ text: `Sell-side consensus target ${FD.fmt.px(s, s.target)} implies ${FD.fmt.pct(up, 0)} vs today — a crowd datapoint to weigh against our rank, not a forecast.`, cls: up > 20 ? "" : up < -10 ? "warn" : "" });
    }
    if (s.rec) out.push({ text: `Analyst recommendation: ${s.rec.replace(/_/g, " ")}.`, cls: "" });
    out.push({ text: `Sits at #${pos} of ${total} on your current weight blend (${Object.entries(state.weights).map(([k, v]) => `${k[0].toUpperCase()}:${v}`).join(" ")}).`, cls: "" });
    return out.slice(0, 6);
  }

  /* ---------- watchlist ---------- */
  function renderWatchlist() {
    $("#crumb").textContent = "Watchlist";
    const w = FD.watchlist.all();
    const tickers = Object.keys(w);
    if (!tickers.length) {
      view.innerHTML = `<div class="empty-state"><div class="big">◎</div><h3>Your watchlist is empty</h3>
        <p>Star stocks anywhere in the app — rankings, screener tables or stock reports.</p>
        <a class="btn btn-primary" href="#/rankings">Browse rankings</a></div>` + alertsCard();
      wireAlerts();
      return;
    }
    const rows = tickers.map(t => FD.get(t)).filter(Boolean);
    rows.forEach(s => s.liveRank = live(s));
    view.innerHTML = stockTable(rows) + `
      <h3 style="margin-top:1.4rem">Notes</h3>
      ${rows.map(s => `<div class="card" style="margin-bottom:.7rem;padding:.9rem 1.1rem">
        ${logoHTML(s, "lg-sm")}<b class="tkr">${esc(s.t)}</b> <span class="muted small">${esc(s.name)}</span>
        <input class="note" data-t="${s.t}" value="${esc(w[s.t].note || "")}" placeholder="why are you watching this?" style="width:100%;margin-top:.4rem;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:.45rem .6rem">
      </div>`).join("")}` + alertsCard();
    wireTable();
    wireAlerts();
    view.querySelectorAll("input.note").forEach(inp => inp.onchange = () => FD.watchlist.note(inp.dataset.t, inp.value));
  }

  /* ---------- add-holdings modal (categorized stock picker) ---------- */
  function openAddHoldings() {
    const sel = new Map();            // ticker -> qty
    let groupBy = "sector";
    const today = new Date().toISOString().slice(0, 10);

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Add holdings">
      <div class="modal-head"><h3>Add holdings</h3>
        <button class="modal-close" id="hold-x" aria-label="Close">✕</button></div>
      <div class="modal-body">
        <div class="hold-tools">
          <input type="search" id="hold-q" placeholder="Search ticker or company…" autocomplete="off">
          <label class="small muted" style="display:flex;align-items:center;gap:.35rem">Group by
            <select id="hold-group" class="btn" style="padding:.35rem .5rem">
              <option value="sector">Sector</option><option value="country">Market</option>
            </select></label>
          <label class="small muted" style="display:flex;align-items:center;gap:.35rem">Default qty
            <input id="hold-defqty" type="number" min="1" value="100" class="qty-input"></label>
        </div>
        <div id="hold-list"></div>
      </div>
      <div class="modal-foot">
        <span class="small muted" id="hold-count">Nothing selected — cost basis is today's live price, so each position starts at zero P&amp;L.</span>
        <div style="display:flex;gap:.6rem">
          <button class="btn" id="hold-cancel">Cancel</button>
          <button class="btn btn-primary" id="hold-add" disabled>Add holdings</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(backdrop);

    const listEl = $("#hold-list", backdrop);
    const qEl = $("#hold-q", backdrop);
    const defQtyEl = $("#hold-defqty", backdrop);
    const addBtn = $("#hold-add", backdrop);

    const onKey = e => { if (e.key === "Escape") realClose(); };
    const realClose = () => { document.removeEventListener("keydown", onKey); backdrop.remove(); };
    document.addEventListener("keydown", onKey);
    $("#hold-x", backdrop).onclick = realClose;
    $("#hold-cancel", backdrop).onclick = realClose;
    backdrop.onclick = e => { if (e.target === backdrop) realClose(); };

    function groups() {
      const q = qEl.value.trim().toLowerCase();
      const rows = FD.stocks.filter(s => !q || s.t.toLowerCase().includes(q) || String(s.name || "").toLowerCase().includes(q));
      const by = {};
      for (const s of rows) {
        const k = groupBy === "country" ? (s.country || "Unspecified") : (s.sector || "Unspecified");
        (by[k] = by[k] || []).push(s);
      }
      return Object.entries(by).sort((a, b) => b[1].length - a[1].length)
        .map(([label, stocks]) => ({ label, stocks: stocks.sort((a, b) => live(b) - live(a)) }));
    }

    function itemRow(s) {
      const on = sel.has(s.t);
      const qty = on ? sel.get(s.t) : +defQtyEl.value || 100;
      return `<div class="hold-item${on ? " sel" : ""}" data-t="${esc(s.t)}">
        <input type="checkbox" ${on ? "checked" : ""} aria-label="Select ${esc(s.t)}">
        ${logoHTML(s, "lg-sm")}<span class="tkr">${esc(s.t)}</span><span class="nm">${esc(s.name)}</span>
        <span class="meta"><span class="px">${FD.fmt.px(s, s.metrics.price)}</span>${scorePill(live(s))}
        <input class="qty-input" type="number" min="1" value="${qty}" ${on ? "" : "disabled"}></span></div>`;
    }

    function renderList() {
      const gs = groups();
      listEl.innerHTML = gs.map((g, i) => `<details class="hold-group"${i < 4 ? " open" : ""}>
        <summary>${esc(g.label)}<span class="cnt">${g.stocks.length} names${i < 4 ? "" : " · click to expand"}</span></summary>
        ${g.stocks.map(itemRow).join("")}</details>`).join("")
        || '<p class="muted small">No stocks match that search.</p>';
      const n = sel.size;
      addBtn.disabled = !n;
      addBtn.textContent = n ? `Add ${n} holding${n > 1 ? "s" : ""}` : "Add holdings";
    }

    listEl.addEventListener("change", e => {
      const item = e.target.closest(".hold-item"); if (!item) return;
      const t = item.dataset.t, s = FD.get(t);
      if (e.target.type === "checkbox") {
        if (e.target.checked) sel.set(t, +defQtyEl.value || 100); else sel.delete(t);
        renderList();
      } else if (e.target.classList.contains("qty-input")) {
        sel.set(t, Math.max(1, +e.target.value || 1));
      }
    });
    qEl.addEventListener("input", renderList);
    $("#hold-group", backdrop).onchange = e => { groupBy = e.target.value; renderList(); };
    defQtyEl.addEventListener("input", renderList);

    addBtn.onclick = () => {
      sel.forEach((qty, t) => { const s = FD.get(t); if (s) FD.portfolio.upsert({ t, qty: Math.max(1, qty), avg: s.metrics.price, date: today }); });
      realClose();
      toast(`${sel.size} holding${sel.size > 1 ? "s" : ""} added to portfolio`);
      rerender();
    };

    renderList();
    qEl.focus();
  }

  /* ---------- portfolio ---------- */
  function renderPortfolio() {
    $("#crumb").textContent = "Portfolio";
    const pf = FD.portfolio.all();
    if (!pf.length) {
      view.innerHTML = `<div class="empty-state"><div class="big">▦</div><h3>No holdings yet</h3>
        <p>Add your real positions from a categorized picker, or build a top-ranked basket priced at today's live quote — cost basis equals today's price, so it starts at zero profit rather than an invented one.</p>
        <div style="display:flex;gap:.7rem;justify-content:center">
        <button class="btn btn-primary" id="add-hold">Add holdings</button>
        <a class="btn" href="#/rankings">Browse rankings</a>
        <button class="btn" id="seed-qm">Build top-10 FactorRank basket</button></div></div>`;
      $("#add-hold").onclick = openAddHoldings;
      $("#seed-qm").onclick = () => {
        const today = new Date().toISOString().slice(0, 10);
        rankedAll().slice(0, 10).forEach((s, i) => FD.portfolio.upsert({ t: s.t, qty: Math.round(900 / (i + 1)), avg: s.metrics.price, date: today }));
        rerender();
      };
      return;
    }
    const held = pf.map(p => ({ ...p, s: FD.get(p.t) })).filter(p => p.s);
    held.forEach(p => p.s.liveRank = live(p.s));
    const vals = held.map(p => ({ ...p, mv: p.s.metrics.price * p.qty, cost: p.avg * p.qty }));
    const totalMV = vals.reduce((x, p) => x + p.mv, 0), totalCost = vals.reduce((x, p) => x + p.cost, 0);
    const pl = totalMV - totalCost, plPct = (totalMV / totalCost - 1) * 100;
    const avgRank = vals.reduce((x, p) => x + p.s.liveRank, 0) / vals.length;
    const perfOf = (x) => x.metrics.perf12;
    const uniPerfs = FD.stocks.map(perfOf).filter(v => v != null);
    const uniAvg = uniPerfs.reduce((x, v) => x + v, 0) / uniPerfs.length;
    const pfPerf = plPct;
    const bySector = {};
    vals.forEach(p => bySector[p.s.sector] = (bySector[p.s.sector] || 0) + p.mv);
    const segs = Object.entries(bySector).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    const worst = segs[0];
    const bench = (() => { const xs = vals.map(p => p.s.metrics.perf12).filter(v => v != null); return xs.length ? xs.reduce((x, v) => x + v, 0) / xs.length : null; })();

    view.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.8rem;margin-bottom:.9rem">
      <h2 style="margin:0">Portfolio</h2>
      <button class="btn btn-primary" id="add-hold">Add holdings</button>
    </div>
    <div class="pf-cards">
      <div class="mini-card"><div class="mc-label">Value</div><div class="mc-value">${FD.fmt.num(totalMV / 1000, 1)}k</div><div class="muted small">${vals.length} positions</div></div>
      <div class="mini-card"><div class="mc-label">Profit &amp; loss</div><div class="mc-value ${pl >= 0 ? "pos" : "neg"}">${pl >= 0 ? "+" : ""}${FD.fmt.num(pl / 1000, 1)}k</div><div class="muted small">${FD.fmt.pct(plPct)}</div></div>
      <div class="mini-card"><div class="mc-label">Avg FactorRank</div><div class="mc-value">${Math.round(avgRank)}</div><div class="muted small">universe avg ${Math.round(rankedAll().reduce((a, b) => a + b.liveRank, 0) / FD.stocks.length)}</div></div>
      <div class="mini-card"><div class="mc-label">12m perf vs universe</div><div class="mc-value ${bench >= uniAvg ? "pos" : "neg"}">${FD.fmt.pct(bench, 1)}</div><div class="muted small">universe ${FD.fmt.pct(uniAvg, 1)}</div></div>
    </div>
    <p class="small muted">Holdings mix ${[...new Set(vals.map(p => p.s.currency))].join(", ")} values without FX conversion — treat totals as indicative.</p>
    <div class="panel-grid">
      <div class="table-wrap"><table class="data" style="min-width:640px">
        <thead><tr><th>Stock</th><th>Qty</th><th>Avg cost</th><th>Now</th><th>Value</th><th>P&amp;L</th><th>12m</th><th>Rank</th><th>Wt</th><th></th></tr></thead>
        <tbody>${vals.map(p => `<tr data-t="${p.t}">
          <td style="text-align:left">${logoHTML(p.s, "lg-sm")}<span class="tkr">${esc(p.t)}</span> <span class="nm">${esc(p.s.name)}</span></td>
          <td>${p.qty}</td><td>${p.s.currency}${FD.fmt.num(p.avg, 2)}</td><td>${FD.fmt.px(p.s, p.s.metrics.price)}</td>
          <td>${FD.fmt.num(p.mv / 1000, 1)}k</td>
          <td class="${p.mv - p.cost >= 0 ? "pos" : "neg"}">${FD.fmt.pct((p.mv / p.cost - 1) * 100, 1)}</td>
          <td>${perfCell(p.s.metrics.perf12)}</td><td>${scorePill(p.s.liveRank)}</td>
          <td>${FD.fmt.num(p.mv / totalMV * 100)}%</td>
          <td><button class="del-btn" data-del="${p.t}" title="Remove">✕</button></td></tr>`).join("")}
        </tbody></table></div>
      <div class="card"><h3>Allocation by sector</h3>
        <canvas class="chart" id="alloc"></canvas>
        <div class="small muted">${segs.map(sg => `<div><span style="color:${sg.color || ""}">■</span> ${esc(sg.label)} — ${FD.fmt.num(sg.value / totalMV * 100)}%</div>`).join("")}</div>
        ${worst.value / totalMV > 0.35 ? `<div class="insight warn" style="margin-top:.6rem">Concentration alert: ${esc(worst.label)} is ${FD.fmt.num(worst.value / totalMV * 100)}% of the book. The "3D" discipline rule caps single sectors near 30%.</div>` : `<div class="insight" style="margin-top:.6rem">Diversification looks healthy — largest sector ${esc(worst.label)} at ${FD.fmt.num(worst.value / totalMV * 100)}%.</div>`}
        <div class="insight" id="rank-note">${avgRank >= 60 ? `Your basket's average FactorRank of ${Math.round(avgRank)} sits well above the universe — rules say you're holding odds-favoured names.` : `Average FactorRank ${Math.round(avgRank)} is below 60 — discipline would suggest swapping towards higher-ranked stocks over 80.`}</div>
      </div>
    </div>`;
    FD.donut($("#alloc"), segs, FD.fmt.num(totalMV / 1000, 0) + "k");
    $("#add-hold").onclick = openAddHoldings;
    view.querySelectorAll("[data-del]").forEach(b => b.onclick = e => { e.stopPropagation(); FD.portfolio.remove(b.dataset.del); rerender(); });
    view.querySelectorAll("tr[data-t]").forEach(tr => tr.onclick = e => { if (!e.target.closest(".del-btn")) location.hash = "#/stock/" + tr.dataset.t; });
  }

  /* ---------- analysis (simplified) ---------- */
  function prose(src) {
    const lines = String(src).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let html = "", inList = false;
    for (let l of lines) {
      l = esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      if (/^[-*•]\s+/.test(l)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${l.replace(/^[-*•]\s+/, "")}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${l.replace(/^\d+\.\s*/, "")}</p>`;
    }
    if (inList) html += "</ul>";
    return html;
  }
  const chipRow = (chips) => `<div class="chip-row">${chips.map(c => `<span class="sig ${c.tone}" title="${esc(c.title || "")}">${esc(c.label)}</span>`).join("")}</div>`;

  const MACRO_GROUPS = [["index", "Equity indices"], ["rates", "Rates & yield"], ["vol", "Volatility"], ["sector", "Sector ETFs"], ["commodity", "Commodities"], ["fx", "Currencies"], ["etf", "Style ETFs"], ["crypto", "Crypto"]];

  function macroPanelHTML() {
    if (!FD.macro.length) return `<p class="muted small">Macro feed unavailable — the data service did not answer /api/macro.</p>`;
    return MACRO_GROUPS.filter(([g]) => FD.macroBy(g).length).map(([g, title]) => `
      <details class="macro-group" ${g === "index" || g === "rates" || g === "vol" ? "open" : ""}>
        <summary>${title}<span class="muted small">${FD.macroBy(g).length} instruments</span></summary>
        <table class="data macro-table"><thead><tr><th>Instrument</th><th>Level</th><th>1 day</th><th>1 month</th><th>3 month</th><th>12 month</th><th>Range pos</th></tr></thead><tbody>
        ${FD.macroBy(g).map(x => {
          const pos = x.hi52 > x.lo52 ? (x.v - x.lo52) / (x.hi52 - x.lo52) * 100 : null;
          return `<tr><td class="mn">${esc(x.n)}</td><td>${x.v == null ? "—" : x.v.toLocaleString("en-GB", { maximumFractionDigits: x.v < 10 ? 3 : 1 })}${x.u === "percent" ? "%" : ""}</td>
            <td>${perfCell(x.d)}</td><td>${perfCell(x.m)}</td><td>${perfCell(x.q)}</td><td>${perfCell(x.y)}</td>
            <td><div class="bar-track tiny"><div class="bar-fill" style="width:${pos == null ? 0 : pos}%"></div></div><span class="muted small">${pos == null ? "—" : Math.round(pos) + "%"}</span></td></tr>`;
        }).join("")}
        </tbody></table></details>`).join("");
  }

  function marketNarrative(scope) {
    const { market, p, reg, secs, midx } = scope;
    const out = [];
    if (p.breadth200 != null) {
      const label = p.breadth200 >= 60 ? "Broad" : p.breadth200 >= 40 ? "Mixed" : "Weak";
      out.push({
        tone: p.breadth200 >= 60 ? "pos" : p.breadth200 >= 40 ? "warn" : "bad",
        text: `<b>Long-term trend:</b> ${Math.round(p.breadth200)}% (${p.breadth200Known}/${p.n}) of tracked ${market === "Global" ? "names" : esc(market + " names")} with available data are above their 200-day average. The breadth label is ${label.toLowerCase()} (broad ≥60%, mixed 40–59%, weak &lt;40%); it describes the current sample, not what prices will do next.`,
      });
    } else out.push({ tone: "warn", text: "<b>Long-term trend:</b> not enough published 200-day data to calculate market breadth." });
    if (p.medianPerf != null) out.push({
      tone: p.medianPerf >= 0 ? "pos" : "bad",
      text: `<b>Typical stock:</b> the median 12-month price change is ${FD.fmt.pct(p.medianPerf, 1)} (${p.medianPerfKnown}/${p.n} names with data). This is a historical price change, not a forecast.`,
    });
    if (reg.v != null) out.push({
      tone: reg.tone === "good" ? "pos" : reg.tone === "bad" ? "bad" : "warn",
      text: `<b>Volatility:</b> ${esc(reg.instrument.n)} is ${FD.fmt.num(reg.v, 1)}, categorized as ${reg.label.toLowerCase()}. This is a volatility reading; it does not indicate market direction.`,
    });
    if (midx) out.push({
      tone: "",
      text: `<b>Market index:</b> ${esc(midx.n)} changed ${FD.fmt.pct(midx.q, 1)} over 3 months and ${FD.fmt.pct(midx.y, 1)} over 12 months. These are index returns, not the return of every stock in ${esc(market)}.`,
    });
    if (secs.length) {
      const lead = secs[0], lag = secs[secs.length - 1];
      out.push({
        tone: "",
        text: `<b>Sector range:</b> the strongest 3-month sector average is ${esc(lead.sector)} (${FD.fmt.pct(lead.perf3m, 1)}, ${lead.n} names); the weakest is ${esc(lag.sector)} (${FD.fmt.pct(lag.perf3m, 1)}, ${lag.n} names). These are historical averages for tracked listings.`,
      });
    }
    return out;
  }

  const AI_PAYLOADS = {};
  function aiButton(kind, id, facts) {
    AI_PAYLOADS[id] = { kind, facts };
    return `<div class="ai-row"><button class="btn sm btn-primary" data-ai="${id}">Analyse with AI</button><span class="muted small" id="${id}-ainote"></span></div>`;
  }

  async function renderAnalysis() {
    const my = navSeq;
    $("#crumb").textContent = "Analysis";
    await FD.loadMacro();
    if (my !== navSeq) return;
    const market = FD.marketName(), list = FD.marketList();
    const scope = { list, market, midx: FD.marketIndex(market), mfx: FD.marketFx(market) };
    scope.p = FD.pulse(list); scope.reg = FD.riskRegime(); scope.secs = FD.sectorTable(list);
    const { p, reg, secs, midx } = scope;
    const mv = FD.movers("perf3m", 6, list);
    const narr = marketNarrative(scope);
    const facts = marketFacts(scope);
    const mkCount = (c) => c === "Global" ? FD.stocks.length : FD.stocks.filter(s => s.country === c).length;
    const mkOpts = ["Global", ...FD.MARKETS().map(x => x.country)]
      .map(c => `<option value="${esc(c)}"${c === market ? " selected" : ""}>${esc(c)} — ${mkCount(c)} names</option>`).join("");
    const snapshotTime = FD.liveAsof && !isNaN(FD.liveAsof.getTime())
      ? FD.liveAsof.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "time unavailable";
    const monthBreadth = p.knownPerf1m
      ? `${p.advancers1m} up · ${p.decliners1m} down · ${p.unchanged1m} unchanged`
      : "—";

    view.innerHTML = `
    <div class="card an-head">
      <div>
        <p class="eyebrow" style="margin:.1rem 0 .55rem">Daily market check · descriptive, not a forecast</p>
        <div class="mk-pick">
          <label class="mk-lab" for="mk-pick">Market</label>
          <select id="mk-pick" title="Every figure on this page, and the AI write-up, follow this choice">${mkOpts}</select>
          <span class="muted small">${p.n} of ${FD.stocks.length} tracked names${midx ? " · " + esc(midx.n) : ""}</span>
        </div>
        <h2>${esc(oneLiner(p, reg, secs))}</h2>
      </div>
      <div class="regime-box">
        <div class="mc-label">Snapshot retrieved</div>
        <div class="mc-value">${esc(snapshotTime)}</div>
        <div class="muted small">${esc(FD.dataSrc || "Market data")} · prices delayed</div>
      </div>
    </div>

    <div class="pf-cards">
      <div class="mini-card"><div class="mc-label">Above 200-day average</div><div class="mc-value">${p.breadth200 == null ? "—" : Math.round(p.breadth200) + "%"}</div><div class="muted small">${p.breadth200Known}/${p.n} names with usable data${p.breadth50 == null ? "" : " · above 50d: " + Math.round(p.breadth50) + "%"}</div></div>
      <div class="mini-card"><div class="mc-label">Median 12-month price change</div><div class="mc-value ${p.medianPerf == null ? "" : p.medianPerf >= 0 ? "pos" : "neg"}">${FD.fmt.pct(p.medianPerf, 1)}</div><div class="muted small">${p.medianPerfKnown}/${p.n} names with return data</div></div>
      <div class="mini-card"><div class="mc-label">1-month participation</div><div class="mc-value" style="font-size:1rem">${monthBreadth}</div><div class="muted small">${p.knownPerf1m}/${p.n} names with return data</div></div>
      ${midx ? `<div class="mini-card"><div class="mc-label">${esc(midx.n)} · index return</div><div class="mc-value ${midx.y == null ? "" : midx.y >= 0 ? "pos" : "neg"}">${FD.fmt.pct(midx.y, 1)}</div><div class="muted small">12 months · 3 months ${FD.fmt.pct(midx.q, 1)}</div></div>` : `<div class="mini-card"><div class="mc-label">${reg.instrument ? esc(reg.instrument.n) : "Volatility"}</div><div class="mc-value">${reg.v == null ? "—" : FD.fmt.num(reg.v, 1)}</div><div class="muted small">${reg.v == null ? "No current reading" : "Categorized as " + reg.label.toLowerCase()}</div></div>`}
    </div>

    <div class="panel-grid">
      <div class="card"><h3>What the data shows</h3>
        <p class="muted small">${market === "Global" ? "Figures describe this tracked universe." : `Stock figures below are limited to ${esc(market)} listings.`} Breadth thresholds are descriptive only; they do not predict returns.</p>
        <div class="narr">${narr.map(n => `<div class="insight ${n.tone === "pos" ? "" : n.tone === "bad" ? "bad" : n.tone === "warn" ? "warn" : ""}">${n.text}</div>`).join("")}</div>
        ${aiButton("market", "an", facts)}
        <div class="ai-out" id="an-aiout"></div>
      </div>
      <div class="card"><h3>Sector rotation</h3>
        ${secs.length ? `<div class="peer-row sector-peer-row"><span class="muted small">Sector</span><span></span><span class="muted small" style="text-align:right">12m</span><span class="muted small" style="text-align:right">3m</span></div>` : ""}
        ${secs.map(x => `<div class="peer-row sector-peer-row">
          <span class="small">${esc(x.sector)} <span class="muted">(${x.n})</span></span>
          <div class="bar-track"><div class="bar-fill ${x.perf3m < 0 ? "neg-fill" : ""}" style="width:${Math.min(Math.abs(x.perf3m || 0) / (Math.max(...secs.map(y => Math.abs(y.perf3m || 0))) || 1) * 100, 100)}%"></div></div>
          <span class="muted small" style="text-align:right">${FD.fmt.pct(x.perf12, 0)}</span>
          <span class="${x.perf3m >= 0 ? "pos" : "neg"} small" style="text-align:right">${FD.fmt.pct(x.perf3m, 1)}</span></div>`).join("")}${secs.length ? "" : `<p class="muted small">No sector here has three or more tracked names in ${esc(market)}, so sector averages would be noise.</p>`}
      </div>
    </div>

    <details class="an-more">
      <summary>More market detail <span class="muted small">macro data, largest movers and headlines</span></summary>
      <div class="an-more-content">
        <div class="card"><h3>Macro and cross-asset data</h3>
          <p class="muted small">These global benchmark series are context, not forecasts. ${market === "Global" ? "" : "They are not filtered by the market selection; the selected market's index return is shown above. "}${FD.macroAsof ? "Feed response retrieved " + FD.macroAsof.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " (delayed)." : ""}</p>
          <div id="macro-panel">${macroPanelHTML()}</div>
        </div>
        <div class="panel-grid">
          <div class="card"><h3>Largest 3-month price changes <span class="muted small">· ${esc(market)}</span></h3>
            <h4>Largest rises</h4>${mv.up.map(s => moverRow(s)).join("")}
            <h4>Largest falls</h4>${mv.down.map(s => moverRow(s)).join("")}
          </div>
          <div class="card"><h3>Recent headlines <span class="muted small">· ${esc(market)}</span></h3><div id="an-news"><p class="muted small">loading headlines…</p></div></div>
        </div>
      </div>
    </details>
    <p class="small muted" style="margin-top:1rem">Use this page as a daily review of delayed, historical measurements—not as a promise or signal of future profit. Fundamentals are as-reported and unaudited; missing data is not treated as zero.</p>`;

    view.querySelectorAll("[data-t]").forEach(r => r.onclick = () => location.hash = "#/stock/" + r.dataset.t);
    wireAI();
    $("#mk-pick").onchange = (e) => { FD.store.set("market", e.target.value); rerender(); };
    /* Yahoo's news search is literal — "United Kingdom stock market" returns nothing while
       "UK stocks" or the index name does — so the scope is tried in a few phrasings. */
    const queries = market === "Global" ? ["stock market"]
      : [market + " stocks", midx ? midx.n : null, market].filter(Boolean);
    (async () => {
      let items = [];
      for (const q of queries) { items = await FD.news(q); if (items.length) break; }
      const host = view && document.getElementById("an-news"); if (!host) return;
      host.innerHTML = items.length ? items.map(newsRow).join("")
        : `<p class="muted small">No ${esc(market.toLowerCase())} headlines returned by the feed right now.</p>`;
    })();
  }

  const moverRow = (s) => `<div class="peer-row mover" data-t="${s.t}" style="grid-template-columns:6.6rem 1fr 6rem 3.4rem;cursor:pointer">
    <span class="tkr">${logoHTML(s, "lg-xs")}${esc(s.t)}</span><span class="nm-inline">${esc(s.name)}</span>
    <span class="${s.metrics.perf3m >= 0 ? "pos" : "neg"}">${FD.fmt.pct(s.metrics.perf3m)}</span>
    <span class="rank-cell">${Math.round(s.rank)}</span></div>`;

  function oneLiner(p, reg, secs) {
    if (p.breadth200 == null) return "Long-term market breadth unavailable";
    const trend = p.breadth200 >= 60 ? "Broad" : p.breadth200 >= 40 ? "Mixed" : "Weak";
    return `${trend} trend breadth · ${Math.round(p.breadth200)}% above the 200-day average`;
  }

  function marketFacts(scope) {
    const { p, reg, secs, list, market, midx, mfx } = scope;
    const slim = (x) => ({ name: x.n, level: x.v, chg1d: x.d, chg1m: x.m, chg3m: x.q, chg12m: x.y });
    const mv = FD.movers("perf3m", 5, list);
    const countries = new Set(list.map(s => s.country)).size;
    return {
      market,
      marketNote: market === "Global"
        ? `These facts cover the whole tracked universe: ${p.n} listings from ${countries} countries.`
        : `These facts cover ONLY the ${p.n} ${market}-listed names tracked here, out of ${FD.stocks.length} in the whole universe. Do not call them the whole market, do not compare them with another country, and treat the macro arrays as global context except where domesticIndex and domesticCurrency name the local instrument.`,
      data: FD.dataSrc, asof: p.asof ? p.asof.toISOString() : null, namesInScope: p.n, universeTotal: FD.stocks.length,
      domesticIndex: midx ? slim(midx) : null,
      domesticCurrency: mfx ? slim(mfx) : null,
      breadthPctAbove200d: p.breadth200, breadthPctAbove50d: p.breadth50,
      breadth200DataCount: p.breadth200Known, breadth50DataCount: p.breadth50Known,
      medianStock12m: p.medianPerf, medianStock12mDataCount: p.medianPerfKnown,
      medianStock1m: p.medianPerf1, medianStock1mDataCount: p.medianPerf1Known,
      advancers1m: p.advancers1m, decliners1m: p.decliners1m, unchanged1m: p.unchanged1m, oneMonthDataCount: p.knownPerf1m,
      riskRegime: reg.label, vix: reg.v,
      rates: FD.macroBy("rates").slice(0, 8).map(slim),
      indices: FD.macroBy("index").slice(0, 8).map(slim),
      volatility: FD.macroBy("vol").slice(0, 4).map(slim),
      commodities: FD.macroBy("commodity").slice(0, 6).map(slim),
      currencies: FD.macroBy("fx").slice(0, 6).map(slim),
      sectorRotation3m: secs.slice(0, 5).map(s => ({ sector: s.sector, names: s.n, avg3m: s.perf3m, avg12m: s.perf12 })),
      sectorLaggards3m: secs.slice(-5).map(s => ({ sector: s.sector, names: s.n, avg3m: s.perf3m, avg12m: s.perf12 })),
      fastestMovers3m: mv.up.map(s => ({ t: s.t, name: s.name, sector: s.sector, chg3m: s.metrics.perf3m, chg12m: s.metrics.perf12 })),
      weakestMovers3m: mv.down.map(s => ({ t: s.t, name: s.name, sector: s.sector, chg3m: s.metrics.perf3m, chg12m: s.metrics.perf12 })),
      factorFormula: "Quality 35% / Value 25% / Momentum 25% / Growth 10% / Small cap 5%, each an average of percentile ranks",
    };
  }

  function stockFacts(s, pos, total) {
    const m = s.metrics, g = FD.signals(s), pt = FD.points(s);
    return {
      ticker: s.t, name: s.name, country: s.country, sector: s.sector,
      currency: s.ccy === "GBp" ? "GBP" : (s.ccy || s.currency),
      unitNote: s.ccy === "GBp"
        ? "London listing quoted in pence by Yahoo, but every money figure in this JSON has already been converted to POUNDS per share. Do not divide by 100 and do not describe the price as pence."
        : "Every money figure is per share in the stated currency.",
      data: FD.dataSrc, price: m.price, marketCap_bn: m.mcap,
      factorScores: s.factors, factorRank: s.rank, rankPosition: pos, rankOf: total, classification: s.type,
      valuation: { pe: m.pe, pb: m.pb, dividendYieldPct: m.divYield, payoutRatioPct: m.payout, fcfYieldPct: m.fcfYield, peg: m.peg, earningsYieldPct: m.pe ? 100 / m.pe : null },
      profitability: { basis: s.roceBasis, rocePct: m.roce, grossMarginPct: m.grossMargin, netDebtToEquityPct: m.netDebtEq, interestCoverX: m.intCover, healthScore0to9: m.fScore },
      growth: { epsGrowthPct: m.epsGrowth, revenueGrowthPct: m.revG, fwdEpsGrowthPct: m.fwdEPS },
      technicals: { rsi14: m.rsi, beta: m.beta, pctAbove200dAvg: g.above200, pctAbove50dAvg: g.above50,
        crossSignal: g.cross, pctFrom52wHigh: g.fromHi, pctFrom52wLow: g.fromLo, annualisedVolPct: g.vol, maxDrawdownPct: g.drawdown,
        macd: g.macd, macdSignal: g.macdSignal, rel3mVsSector: g.rel3m, rel12mVsSector: g.rel12m },
      performance: { m1: m.perf1, m3: m.perf3m, m6: m.perf6, m12: m.perf12 },
      sentiment: { analystMeanTarget: s.target, analystConsensus: s.rec, institutionsPct: m.instOwn, insidersPct: m.insider, shortPctOfFloat: m.shortPct, daysToCover: m.shortDays },
      nextEarnings: s.nextEarnings ? new Date(s.nextEarnings).toISOString().slice(0, 10) : null,
      ruleBullPoints: pt.bull, ruleBearPoints: pt.bear, ruleWatchPoints: pt.watch, ruleScore: pt.score, ruleVerdict: pt.verdict.label,
      measuredDrivers: driverFacts(s),
    };
  }

  /* Only the label and the measured number go to the model — the causal sentence
     is written for the screen, and the model must not be handed our phrasing. */
  function driverFacts(s) {
    try {
      const d = FD.stockDrivers(s);
      if (!d || !d.rows || !d.rows.length) return null;
      return d.rows.map(r => ({ driver: r.name, measured: r.num }));
    } catch { return null; }
  }

  function wireAI() {
    view.querySelectorAll("[data-ai]").forEach(btn => {
      const note = document.getElementById(btn.dataset.ai + "-ainote");
      FD.aiStatus().then(st => { if (note) note.textContent = st.key ? "Explains only the figures above" : "AI analysis is off — add a Groq key to .env and restart the server"; });
      btn.onclick = async () => {
        const p = AI_PAYLOADS[btn.dataset.ai] || {};
        const out = document.getElementById(btn.dataset.ai + "-aiout");
        btn.disabled = true; btn.textContent = "Thinking…";
        try {
          const r = await FD.askAI(p.kind, typeof p.facts === "function" ? p.facts() : p.facts);
          if (out) out.innerHTML = `<div class="ai-block">${prose(r.text)}<p class="muted small">Generated from the figures on this page only · model ${esc(r.model || "")} · educational, not advice.</p></div>`;
          btn.textContent = "Rewrite";
        } catch (e) {
          if (out) out.innerHTML = `<div class="insight ${e.needsKey ? "warn" : "bad"}">${esc(e.needsKey ? "AI analysis isn't set up yet — add your Groq key to .env and restart the server. The rule-based points above work without it." : "AI analysis failed: " + e.message)}</div>`;
          btn.textContent = "Try again";
        }
        btn.disabled = false;
      };
    });
  }

  /* ---------- evidence: do these rules actually pay? ---------- */
  let btLeg = null;
  async function renderEvidence() {
    const my = navSeq;
    $("#crumb").textContent = "Evidence";
    view.innerHTML = `<div class="card"><h3>Testing the rules on real prices…</h3>
      <p class="muted small">Every stock's own five years of daily closes, rebalanced roughly monthly. The first run downloads that history, so it can take a minute.</p></div>`;
    const bt = await FD.backtest();
    if (my !== navSeq) return;
    if (!bt || !bt.legs || !bt.legs.length) {
      view.innerHTML = `<div class="empty-state"><div class="big">⚠</div><h3>The test could not run</h3>
        <p class="small muted">${esc(FD.btError || "the price-history endpoint returned nothing")} — usually Yahoo rate-limiting the history download. Nothing here is estimated, so without the data the page stays empty.</p>
        <div style="display:flex;justify-content:center"><button class="btn btn-primary" id="bt-retry">Run again</button></div></div>`;
      const b = document.getElementById("bt-retry");
      if (b) b.onclick = async () => { const seq = navSeq; b.disabled = true; b.textContent = "Running…"; await FD.backtest(true); if (seq !== navSeq) return; if (FD.bt) renderEvidence(); else { b.disabled = false; b.textContent = "Run again"; } };
      return;
    }
    const hz = (l, h) => l.horizons.find(x => x.h === h);
    const pc = (v, dp = 2) => v == null ? '<span class="muted">—</span>' : `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "+" : ""}${FD.fmt.num(v, dp)}%</span>`;
    const clean = bt.legs.filter(l => !l.bias);
    /* only rules clearing t>=2 count as proven — otherwise the noisiest row would win */
    const proven = clean.filter(l => { const b = hz(l, 63); return b && b.excess > 0 && b.t >= 2; });
    const best = (proven.length ? proven : clean).slice()
      .sort((a, b) => ((hz(b, 63) || {}).excess ?? -99) - ((hz(a, 63) || {}).excess ?? -99))[0] || bt.legs[0];
    if (!btLeg || !bt.legs.some(l => l.key === btLeg)) btLeg = best.key;
    const shown = bt.legs.find(l => l.key === btLeg);
    const b3 = hz(shown, 63), b6 = hz(shown, 126);
    const pays = b3 && b3.excess > 0 && b3.t >= 2;

    const verdict = `<div class="card verdict ${pays ? "good" : "warn"}">
      <div><p class="mc-label">Verdict on ${bt.universe} stocks · ${bt.rebalances} rebalances · ${bt.from} to ${bt.to}</p>
      <h2>${pays ? "Yes for " + esc(shown.label.split(" — ")[0]).toLowerCase() + " — it beat the universe by " + FD.fmt.num(b3.excess, 2) + "% every quarter" : esc(shown.label.split(" — ")[0]) + " did not beat the universe by enough to rule out luck"}</h2>
      <p class="muted small">${pays ? `Measured over ${b3.n} non-overlapping quarterly windows, t = ${b3.t}, and the top quintile won ${b3.hit}% of months. On a six-month hold it is ${b6 && b6.excess != null ? FD.fmt.num(b6.excess, 1) + "% per period" : "n/a"}.` : "Read the table below as a description of the past, not an expectation."}</p></div>
      ${aiButton("evidence", "bt-ai", { window: [bt.from, bt.to], stocks: bt.universe, rebalances: bt.rebalances, costBpsPerSide: bt.costBps, limits: bt.caveat, legs: bt.legs.map(l => ({ rule: l.label, excessPct: l.horizons.map(h => h.excess), hitRatePct: l.horizons.map(h => h.hit), tStat: l.horizons.map(h => h.t), annualisedPct: l.curve.annStrat, benchmarkAnnualisedPct: l.curve.annBench, maxDrawdownPct: l.curve.mddStrat, turnoverCostPaidPct: l.curve.costPaid })) })}
      <div class="ai-out" id="bt-ai-aiout"></div>
    </div>`;

    const table = `<div class="card"><h3>Excess return over the equal-weight universe, per rebalance</h3>
      <div style="overflow-x:auto"><table class="data"><thead><tr><th>Rule tested</th><th>1 month</th><th>3 months</th><th>6 months</th><th>Top quintile won</th><th>t-stat (3m)</th><th>Top minus bottom (3m)</th></tr></thead><tbody>
      ${bt.legs.map(l => { const a = hz(l, 21), b = hz(l, 63), c = hz(l, 126); return `<tr><td><b>${esc(l.label.split(" — ")[0])}</b><div class="muted small">${esc(l.label.split(" — ")[1] || "")}</div></td>
        <td>${pc(a && a.excess)}<div class="muted small">n=${a ? a.n : 0}</div></td><td>${pc(b && b.excess)}</td><td>${pc(c && c.excess)}</td>
        <td>${b && b.hit != null ? b.hit + "%" : "—"}</td><td>${b && b.t != null ? `<span class="${b.t >= 2 ? "pos" : b.t <= -2 ? "neg" : "muted"}">${FD.fmt.num(b.t, 2)}</span>` : "—"}</td>
        <td>${pc(b && b.spread)}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted small">t ≥ 2 is the conventional bar for "not luck". A negative t on the reversal row means that rule lost money, and it is shown anyway.</p></div>`;

    const sc = shown.curve;
    const chart = `<div class="card"><h3>${esc(shown.label)} — cumulative ${FD.fmt.num(sc.years, 1)} years, monthly rebalanced, net of ${bt.costBps / 100}% per-side costs</h3>
      <div class="tabs">${bt.legs.map(l => `<button class="btn sm ${l.key === btLeg ? "btn-primary" : ""}" data-leg="${l.key}">${esc(l.label.split(" — ")[0])}</button>`).join("")}</div>
      <canvas id="bt-chart" style="width:100%"></canvas>
      <div class="grid grid-3" style="margin-top:.8rem">
        <div class="mini-card"><span class="mc-label">Rule, annualised</span><span class="mc-value ${sc.annStrat >= sc.annBench ? "pos" : "neg"}">${sc.annStrat == null ? "—" : (sc.annStrat >= 0 ? "+" : "") + sc.annStrat + "%"}</span></div>
        <div class="mini-card"><span class="mc-label">Universe, annualised</span><span class="mc-value">${sc.annBench == null ? "—" : (sc.annBench >= 0 ? "+" : "") + sc.annBench + "%"}</span></div>
        <div class="mini-card"><span class="mc-label">Worst peak-to-trough</span><span class="mc-value neg">${sc.mddStrat}% <span class="muted small">vs ${sc.mddBench}%</span></span></div>
        <div class="mini-card"><span class="mc-label">Costs paid in ${sc.obs} rebalances</span><span class="mc-value">${sc.costPaid}%</span></div>
        <div class="mini-card"><span class="mc-label">Rebalance points</span><span class="mc-value">${sc.obs}</span></div>
        <div class="mini-card"><span class="mc-label">Names ranked each date</span><span class="mc-value">${shown.names}</span></div>
      </div></div>`;

    const limits = `<div class="card"><h3>What this test cannot tell you</h3>
      <div class="insight bad"><b>Survivorship flatters every row.</b> The ${bt.universe} names are companies listed and liquid <i>today</i>. Delisted and broken stocks are absent, so absolute returns are optimistic; the top-minus-bottom spread is the fairer column.</div>
      <div class="insight warn"><b>Fundamentals are not tested at all.</b> ${esc(bt.caveat)}</div>
      <div class="insight"><b>No capacity, no slippage beyond ${bt.costBps / 100}%.</b> Equal-weight quintiles of ${Math.max(5, Math.floor(bt.universe * 0.2))} names ignore size limits, bid-ask on small caps, and tax. A real portfolio earns less than the chart line.</div>
      <div class="insight"><b>One regime, ${FD.fmt.num(sc.years, 1)} years.</b> Overlapping windows are counted once per rebalance, but a single rate cycle still dominates the average. The reversal row losing money is the honest counter-example kept in view.</div>
      <p class="muted small">Sources: ${esc(bt.src || "Yahoo Finance")} daily closes, ${bt.bars} trading dates, ${bt.history} histories fetched, ${bt.skipped} names dropped. Test run ${new Date(bt.asof).toLocaleString("en-GB")}.</p></div>`;

    view.innerHTML = `<p class="eyebrow" style="margin-bottom:.8rem">Backtest · price rules only · point-in-time</p>
      ${verdict}${table}${chart}${limits}`;
    wireAI();
    view.querySelectorAll("[data-leg]").forEach(b => b.onclick = () => { btLeg = b.dataset.leg; renderEvidence(); });
    requestAnimationFrame(() => {
      const cv = document.getElementById("bt-chart");
      if (cv && sc.strat.length > 1) FD.lineChart(cv, sc.dates.map(d => new Date(d)), sc.strat,
        { height: 280, overlays: [{ values: sc.bench, color: "#8b93a7", label: "Equal-weight universe" }] });
    });
  }

  /* ---------- gaps: the space between yesterday's close and today's open ---------- */
  const gapRows = () => FD.stocks.filter(s => s.metrics.gap != null && Math.abs(s.metrics.gap) >= state.gapMin)
    .sort((a, b) => b.metrics.gap - a.metrics.gap);

  function gapRow(s) {
    const up = s.metrics.gap >= 0, a = FD.action(s, live(s));
    const z = s.gapZone;
    const dist = z && z.hi > 0 ? (z.dir === "up" ? (s.metrics.price / z.lo - 1) * 100 : (z.hi / s.metrics.price - 1) * 100) : null;
    return `<tr data-t="${esc(s.t)}">
      <td>${logoHTML(s, "lg-sm")}${star(s.t)} <span class="tkr">${esc(s.t)}</span><div class="nm">${esc(s.name)} · ${esc(s.country)}</div></td>
      <td class="${up ? "pos" : "neg"}">${FD.fmt.pct(s.metrics.gap, 2)}</td>
      <td>${FD.fmt.px(s, s.metrics.price)}</td>
      <td>${perfCell(s.metrics.perf1)}</td>
      <td><span class="rank-cell">${Math.round(live(s))}</span></td>
      <td><span class="act ${a.cls}">${esc(a.tag)}</span></td>
      <td>${z ? `${z.dir === "up" ? "support" : "resistance"} ${FD.fmt.px(s, z.lo)}–${FD.fmt.px(s, z.hi)} <span class="muted small">${z.ago === 0 ? "today" : z.ago + " bar" + (z.ago === 1 ? "" : "s") + " ago"}</span>` : '<span class="muted">filled / none</span>'}</td>
      <td>${s.metrics.gapCount} <span class="muted small">in ${s.closes.length} bars</span></td>
    </tr>`;
  }

  const gapTable = (rows) => `<div class="table-wrap"><table class="data"><thead><tr>
      <th>Stock</th><th>Gap today</th><th>Last</th><th>1 month</th><th>Rank</th><th>Signal</th><th>Unfilled gap zone</th><th>Gap days (1y)</th></tr></thead>
      <tbody>${rows.map(gapRow).join("")}</tbody></table></div>`;

  function renderGaps() {
    $("#crumb").textContent = "Gap scanner";
    const rows = gapRows();
    const ups = rows.filter(s => s.metrics.gap > 0);
    const downs = rows.filter(s => s.metrics.gap < 0).reverse();
    const zones = FD.stocks.filter(s => s.gapZone).sort((a, b) => a.gapZone.ago - b.gapZone.ago).slice(0, 12);
    const chips = [0.5, 1, 2, 3].map(v => `<button class="chip ${state.gapMin === v ? "active" : ""}" data-gap="${v}">${v}%+</button>`).join("");
    const upDown = ups.length + downs.length;
    view.innerHTML = `
      <p class="eyebrow" style="margin-bottom:.8rem">Gap scanner · real open vs prior close, split-adjusted</p>
      <div class="card verdict">
        <div><h3>${upDown} names gapped by ${state.gapMin}% or more on the latest session</h3>
          <p class="muted">${ups.length} up, ${downs.length} down out of ${FD.stocks.filter(s => s.metrics.gap != null).length} listings with a published open. A gap is the price distance between yesterday's close and today's open — nothing traded in between, which is why the edge of an unfilled gap acts as support or resistance.</p></div>
        <div class="ai-row"><span class="controls-row" style="margin:0">${chips}</span></div>
      </div>
      <h3 class="sec-h">Gapped up</h3>${gapTable(ups.slice(0, 20))}
      <h3 class="sec-h">Gapped down</h3>${gapTable(downs.slice(0, 20))}
      <h3 class="sec-h">Unfilled gap zones nearest to being tested</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Stock</th><th>Direction</th><th>Zone</th><th>Price</th><th>Distance to fill</th><th>Bars since</th><th>Signal</th></tr></thead><tbody>
        ${zones.map(s => { const z = s.gapZone, a = FD.action(s, live(s));
          const dist = z.dir === "up" ? (s.metrics.price / z.lo - 1) * 100 : (z.hi / s.metrics.price - 1) * 100;
          return `<tr data-t="${esc(s.t)}"><td>${logoHTML(s, "lg-sm")}<span class="tkr">${esc(s.t)}</span><div class="nm">${esc(s.name)}</div></td>
            <td class="${z.dir === "up" ? "pos" : "neg"}">${z.dir === "up" ? "gap up (support below)" : "gap down (resistance above)"}</td>
            <td>${FD.fmt.px(s, z.lo)}–${FD.fmt.px(s, z.hi)}</td><td>${FD.fmt.px(s, s.metrics.price)}</td>
            <td>${FD.fmt.num(Math.abs(dist), 1)}%</td><td>${z.ago}</td><td><span class="act ${a.cls}">${esc(a.tag)}</span></td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted small">Gaps come from Yahoo's daily open/close bars for each listing's own session, adjusted for splits and dividends on the same basis as the chart. Delayed data, so "today" is the most recent completed session; a zone counts as filled once price trades back to the pre-gap close.</p>`;
    view.querySelectorAll("[data-gap]").forEach(b => b.onclick = () => { state.gapMin = +b.dataset.gap; FD.store.set("gapMin", state.gapMin); rerender(); });
    wireRowClicks();
  }

  /* ---------- buy / hold / sell signals ---------- */
  const TAGS = ["Buy", "Buy on weakness", "Hold", "Trim", "Sell", "Wait for the trend", "Weak watch", "No trend data"];
  function actionRows() {
    return rankedAll().map(s => ({ s, r: live(s), a: FD.action(s, live(s)) }));
  }
  function renderSignals() {
    $("#crumb").textContent = "Buy-sell signals";
    const all = actionRows();
    const count = (t) => all.filter(x => x.a.tag === t).length;
    const rows = state.sigTag ? all.filter(x => x.a.tag === state.sigTag) : all;
    const chips = [`<button class="chip ${state.sigTag ? "" : "active"}" data-tag="">All ${all.length}</button>`]
      .concat(TAGS.filter(t => count(t)).map(t => `<button class="chip ${state.sigTag === t ? "active" : ""}" data-tag="${esc(t)}">${esc(t)} ${count(t)}</button>`)).join("");
    view.innerHTML = `
      <p class="eyebrow" style="margin-bottom:.8rem">Signals · rule-based, every vote shown</p>
      <div class="card verdict"><div><h3>${count("Buy") + count("Buy on weakness")} buys, ${count("Hold")} holds, ${count("Trim") + count("Sell")} to trim or sell</h3>
        <p class="muted">The tag is the sum of the published votes below, using your current factor weights. It is not a forecast — the entry, stop and target are levels that already exist in the price record.</p></div>
        <div class="ai-row"><span class="controls-row" style="margin:0">${chips}</span></div></div>
      <div class="table-wrap signals-table-wrap"><table class="data signals-table" aria-label="Rule-based stock signals, levels and reasons"><colgroup>
        <col class="sig-stock-col"><col class="sig-signal-col"><col class="sig-score-col"><col class="sig-rank-col">
        <col class="sig-price-col"><col class="sig-entry-col"><col class="sig-stop-col"><col class="sig-target-col">
        <col class="sig-risk-col"><col class="sig-rr-col"><col class="sig-why-col">
        </colgroup><thead><tr>
        <th>Stock</th><th>Signal</th><th>Score</th><th>Rank</th><th>Last</th>
        <th>Entry</th><th>Stop</th><th>Target</th><th>Risk</th><th>Reward:risk</th><th>Why</th></tr></thead><tbody>
        ${rows.map(x => {
          const p = x.a.plan || {};
          return `<tr data-t="${esc(x.s.t)}"><td data-label="Stock">${logoHTML(x.s, "lg-sm")}${star(x.s.t)} <span class="tkr">${esc(x.s.t)}</span><div class="nm">${esc(x.s.name)} · ${esc(x.s.sector)}</div></td>
            <td data-label="Signal"><span class="act ${x.a.cls}">${esc(x.a.tag)}</span></td>
            <td data-label="Score">${x.a.score > 0 ? "+" : ""}${x.a.score}</td>
            <td data-label="Rank"><span class="rank-cell">${Math.round(x.r)}</span></td>
            <td data-label="Last">${FD.fmt.px(x.s, x.s.metrics.price)}</td>
            <td data-label="Entry">${p.entry != null ? FD.fmt.px(x.s, p.entry) : "—"}</td>
            <td data-label="Stop">${p.stop != null ? FD.fmt.px(x.s, p.stop) : "—"}</td>
            <td data-label="Target">${p.target != null ? FD.fmt.px(x.s, p.target) : "—"}</td>
            <td data-label="Risk">${p.risk != null ? FD.fmt.num(p.risk, 1) + "%" : "—"}</td>
            <td data-label="Reward:risk">${p.rr != null ? FD.fmt.num(p.rr, 2) + "x" : "—"}</td>
            <td class="why" data-label="Why">${esc((x.a.bull[0] || x.a.bear[0] || x.a.watch[0] || "").slice(0, 130))}</td></tr>`;
        }).join("")}
      </tbody></table></div>
      <div class="grid grid-2" style="margin-top:1.1rem">
        <div class="card"><h3>The votes behind every tag</h3>
          <ul class="rule-list">
            <li><b>+2</b> price above its 200-day average with the 50-day above that, or FactorRank in the top decile</li>
            <li><b>+1</b> MACD above its signal line · P/E under 15x with PEG under 1.5x · free cash flow yield 5%+ · health 7/9+ · RSI under 30 on a highly-ranked name in an uptrend · a gap-down of 3%+ while rank and trend hold</li>
            <li><b>−1</b> P/E above 35x · negative free cash flow yield · health 3/9 or less · MACD below its signal line</li>
            <li><b>−2</b> below the 200-day average · a death cross · FactorRank bottom third · a rally unbacked by returns on capital · a dividend paying out more than 100% of earnings</li>
          </ul>
          <p class="muted small">Tags: Buy from +5 with the trend up, Buy on weakness from +3, Hold +1 to +2, Trim 0 to −1, Sell −2 or worse. A high score with the trend broken is "Wait for the trend" rather than a buy — trend is the filter, not a decoration.</p></div>
        <div class="card"><h3>How to read the levels</h3>
          <p class="muted small">Entry is today's close, or the 50-day average when RSI is above 70 — the arithmetic of not chasing. Stop is the nearest level below the price that already exists in the record: the 200-day or 50-day average, the 52-week low, or the edge of an unfilled gap. Target is the nearest level above: the 52-week high or an unfilled gap overhead. Reward:risk is (target − entry) ÷ (entry − stop). None of it predicts a price; it is the discipline layer that says where the idea is wrong.</p>
          <p class="muted small">Sorted by your live FactorRank. Change the weights on the screener and every tag here moves with them.</p></div>
      </div>`;
    view.querySelectorAll("[data-tag]").forEach(b => b.onclick = () => { state.sigTag = b.dataset.tag; rerender(); });
    wireRowClicks();
  }

  /* ---------- investment opportunities: the strongest rule-based setups, with a plan ---------- */
  const OPP_TAGS = new Set(["Buy", "Buy on weakness"]);
  function opportunityRows() {
    // A plan only counts if its risk is real: a stop sitting a hair below price inflates
    // reward:risk into nonsense (a 200x "opportunity" that is really no downside defined),
    // so the nearest level below must cost at least 2% before the setup is listed.
    return actionRows().filter(x => OPP_TAGS.has(x.a.tag) && x.a.plan && x.a.plan.stop != null
      && x.a.plan.target != null && x.a.plan.rr != null
      && x.a.plan.risk != null && x.a.plan.risk >= 2 && x.a.plan.rr <= 15);
  }
  const OPP_MODES = {
    rr: { label: "Best risk / reward", hint: "reward-to-risk is the payoff arithmetic: the upside to the nearest level above divided by the downside to the nearest level below, both already printed in the price record." },
    rank: { label: "Highest-ranked buys", hint: "sorted by your live FactorRank under the current weights, so the setup is judged on fundamentals first and price second." },
    weak: { label: "Washing out (buy on weakness)", hint: "names the rules put in an uptrend but sold off — RSI stretched-side or gap-downs on a high rank — where the dip is a price change rather than a thesis change." },
    div: { label: "Sector-diversified basket", hint: "the single best setup in each sector, equal-weighted, so no one industry can dominate the idea list." },
  };
  function oppCard(x, w) {
    const p = x.a.plan, s = x.s;
    return `<div class="opp-card" data-t="${esc(s.t)}">
      <div class="opp-head"><span class="tkr">${logoHTML(s, "lg-sm")}${star(s.t)} ${esc(s.t)}</span>
        <span class="act ${x.a.cls}">${esc(x.a.tag)}</span></div>
      <div class="opp-name">${esc(s.name)} · ${esc(s.sector)} · ${esc(s.country)}</div>
      <div class="opp-rr"><b>${FD.fmt.num(p.rr, 2)}x</b><span class="muted small">reward : risk</span>
        ${w != null ? `<span class="opp-w">${Math.round(w * 100)}% of basket</span>` : ""}</div>
      <div class="opp-plan">
        <div><span class="mc-label">Entry</span><b>${FD.fmt.px(s, p.entry)}</b><span class="muted small">${esc(p.entryNote)}</span></div>
        <div><span class="mc-label">Stop</span><b class="neg">${FD.fmt.px(s, p.stop)}</b><span class="muted small">${FD.fmt.num(p.risk, 1)}% · ${esc(p.stopNote)}</span></div>
        <div><span class="mc-label">Target</span><b class="pos">${FD.fmt.px(s, p.target)}</b><span class="muted small">${FD.fmt.num(p.reward, 1)}% · ${esc(p.targetNote)}</span></div>
      </div>
      <p class="opp-why">${esc((x.a.bull[0] || x.a.bear[0] || "").slice(0, 150))}</p>
    </div>`;
  }
  function renderOpportunities() {
    $("#crumb").textContent = "Investment opportunities";
    const mode = OPP_MODES[state.oppMode] ? state.oppMode : "rr";
    let opps = opportunityRows();
    if (mode === "weak") opps = opps.filter(x => x.a.tag === "Buy on weakness");
    opps.sort((a, b) => mode === "rank" ? b.r - a.r : b.a.plan.rr - a.a.plan.rr);

    let cards, basketNote = "";
    if (mode === "div") {
      const bySector = new Map();
      opps.forEach(x => { const k = x.s.sector || "Other"; if (!bySector.has(k)) bySector.set(k, x); });
      const picks = [...bySector.values()].sort((a, b) => b.a.plan.rr - a.a.plan.rr);
      const w = picks.length ? 1 / picks.length : 0;
      cards = picks.map(x => oppCard(x, w)).join("");
      basketNote = `<p class="muted small">Equal weight = ${(w * 100).toFixed(1)}% per name across ${picks.length} sectors. Equal-weighting is a starting discipline, not a sizing model — your own risk per position belongs in the calculator.</p>`;
    } else {
      cards = opps.slice(0, 24).map(x => oppCard(x, null)).join("");
    }

    const medianRR = opps.length ? opps.map(x => x.a.plan.rr).sort((a, b) => a - b)[Math.floor(opps.length / 2)] : null;
    const chips = Object.entries(OPP_MODES).map(([k, v]) =>
      `<button class="chip ${mode === k ? "active" : ""}" data-opp="${k}">${esc(v.label)}</button>`).join("");

    view.innerHTML = `
      <p class="eyebrow" style="margin-bottom:.8rem">Opportunities · actionable setups, each with an entry, stop, target and the arithmetic behind it</p>
      <div class="card verdict">
        <div><h3>${opps.length} setups pass every rule and carry a complete plan</h3>
          <p class="muted">${mode === "div" ? "One best-per-sector shortlist." : "Top of the list."} Median reward:risk ${medianRR != null ? FD.fmt.num(medianRR, 2) + "x" : "—"}, out of ${actionRows().length} scored listings. A name only appears here if its trend, rank and valuation rules agree <i>and</i> the price record already contains a level below (stop) and a level above (target) worth at least 2% of downside — a plan whose stop is a hair below price is not discipline, so degenerate reward:risk ratios are left out rather than shown off.</p></div>
        <div class="ai-row"><span class="controls-row" style="margin:0">${chips}</span></div>
      </div>
      ${opps.length ? `<div class="opp-grid">${cards}</div>${basketNote}
      <p class="muted small" style="margin-top:.4rem">${esc(OPP_MODES[mode].hint)}</p>`
        : `<div class="card"><p class="muted">No listing currently satisfies a Buy rule with both a stop and a target level in its price record. That is an honest result, not a gap in the data — the rule set is allowed to find nothing.</p></div>`}
      <div class="grid grid-2" style="margin-top:1.1rem">
        <div class="card"><h3>What makes something an opportunity here</h3>
          <p class="muted small">Only tags of Buy or Buy on weakness qualify, and only when the plan is complete: a stop that sits below today's price at a level already traded (200-day or 50-day average, the 52-week low, or an unfilled gap edge), and a target above at a level already traded (the 52-week high or a gap overhead). Reward:risk is (target − entry) ÷ (entry − stop). Setups whose stop is less than 2% away are dropped — a near-weightless downside inflates the ratio without adding discipline. Nothing is extrapolated; if a level is absent the name is left out.</p></div>
        <div class="card"><h3>How to use the list</h3>
          <p class="muted small">This is the discipline layer, not a forecast. Pick the setups that fit your horizon, size each one so a hit stop costs the same fraction of capital, and diversify across sectors (the "Sector-diversified basket" mode) so no single industry drives the outcome. Read the entry, stop and target together — an idea you would not buy at the entry, with the stop in place, is not one to take. Educational, not investment advice.</p></div>
      </div>`;
    view.querySelectorAll("[data-opp]").forEach(b => b.onclick = () => {
      state.oppMode = b.dataset.opp; FD.store.set("oppMode", state.oppMode); rerender();
    });
    view.querySelectorAll(".opp-card[data-t]").forEach(c => c.onclick = () => location.hash = "#/stock/" + c.dataset.t);
  }

  /* ---------- portfolio builder: pick a rule, measure what it actually returned ---------- */
  const COST_BP = 20;                       // 20bp of each position's value, paid on entry
  const ENTRY_COST = COST_BP / 100;         // = % taken off a fully-invested basket
  const netOf = (total) => (1 + total / 100) * (1 - ENTRY_COST / 100) * 100 - 100;
  const RULES = [
    { k: "rank", label: "Top FactorRank (your weights)", pick: (rows, n) => rows.slice().sort((a, b) => b.liveRank - a.liveRank).slice(0, n) },
    { k: "buy", label: "Buy signals first", pick: (rows, n) => rows.filter(s => { const t = FD.action(s, live(s)).tag; return t === "Buy" || t === "Buy on weakness"; }).sort((a, b) => live(b) - live(a)).slice(0, n) },
    { k: "quality", label: "Highest return on capital", pick: (rows, n) => rows.filter(s => s.metrics.roce != null).sort((a, b) => b.metrics.roce - a.metrics.roce).slice(0, n) },
    { k: "value", label: "Cheapest earnings", pick: (rows, n) => rows.filter(s => s.metrics.pe > 0).sort((a, b) => a.metrics.pe - b.metrics.pe).slice(0, n) },
    { k: "momentum", label: "Strongest 12-month price", pick: (rows, n) => rows.filter(s => s.metrics.perf12 != null).sort((a, b) => b.metrics.perf12 - a.metrics.perf12).slice(0, n) },
    { k: "garp", label: "Growth at a reasonable price", pick: (rows, n) => rows.filter(s => s.metrics.peg > 0).sort((a, b) => a.metrics.peg - b.metrics.peg).slice(0, n) },
    { k: "dividend", label: "Highest dividend yield", pick: (rows, n) => rows.filter(s => s.metrics.divYield > 0 && !(s.metrics.payout > 100)).sort((a, b) => b.metrics.divYield - a.metrics.divYield).slice(0, n) },
    { k: "lowvol", label: "Lowest beta", pick: (rows, n) => rows.filter(s => s.metrics.beta != null).sort((a, b) => a.metrics.beta - b.metrics.beta).slice(0, n) },
    { k: "size", label: "Smallest by market cap", pick: (rows, n) => rows.filter(s => s.metrics.mcap != null).sort((a, b) => a.metrics.mcap - b.metrics.mcap).slice(0, n) },
    { k: "watchlist", label: "Your watchlist", pick: (rows, n) => rows.filter(s => FD.watchlist.has(s.t)).slice(0, n) },
  ];
  function buildSet(ruleKey, n, cap) {
    const rows = rankedAll();
    const rule = RULES.find(r => r.k === ruleKey) || RULES[0];
    let list = rule.pick(rows, rows.length);
    if (cap) { const used = {}; list = list.filter(s => { const k = s.sector || "—"; used[k] = (used[k] || 0) + 1; return used[k] <= cap; }); }
    return list.slice(0, n);
  }
  function renderBuilder() {
    $("#crumb").textContent = "Portfolio builder";
    const B = state.build;
    const set = buildSet(B.rule, B.n, B.cap);
    const wf = B.weight === "rank" ? (names) => names.map(s => Math.max(live(s), 1)) : null;
    const st = FD.basket(set, B.days, wf);
    const bench = FD.basket(FD.stocks, B.days);
    const money = 1000;
    const ruleRows = RULES.map(r => {
      const list = buildSet(r.k, B.n, B.cap);
      const m = FD.basket(list, B.days, wf);
      return { r, list, m };
    }).filter(x => x.m).sort((a, b) => (b.m.sharpe ?? -9) - (a.m.sharpe ?? -9));

    view.innerHTML = `
      <p class="eyebrow" style="margin-bottom:.8rem">Portfolio builder · measured on real closes</p>
      <div class="controls">
        <div class="controls-row">
          <div class="field">Selection rule<select id="b-rule">${RULES.map(r => `<option value="${r.k}" ${r.k === B.rule ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></div>
          <div class="field">Holdings<select id="b-n">${[5, 10, 15, 20, 30].map(v => `<option ${v === B.n ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field">Max per sector<select id="b-cap">${[0, 2, 3, 4].map(v => `<option value="${v}" ${v === B.cap ? "selected" : ""}>${v === 0 ? "no cap" : v}</option>`).join("")}</select></div>
          <div class="field">Weighting<select id="b-w"><option value="equal" ${B.weight === "equal" ? "selected" : ""}>equal weight</option><option value="rank" ${B.weight === "rank" ? "selected" : ""}>by FactorRank</option></select></div>
          <div class="field">Window<select id="b-days">${[[126, "6 months"], [252, "12 months"], [504, "2 years"]].map(([v, l]) => `<option value="${v}" ${v === B.days ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        </div>
      </div>
      ${st ? `
      <div class="kpi-row">
        <div class="mini-card"><div class="mc-label">Total return, ${B.days >= 504 ? "2 years" : B.days >= 252 ? "12 months" : "6 months"}</div><div class="mc-value ${st.total >= 0 ? "pos" : "neg"}">${FD.fmt.pct(st.total, 1)}</div><div class="muted small">${st.n} names, ${st.sessions} sessions</div></div>
        <div class="mini-card"><div class="mc-label">Annualised</div><div class="mc-value">${FD.fmt.pct(st.ann, 1)}</div><div class="muted small">compounded on daily closes</div></div>
        <div class="mini-card"><div class="mc-label">Volatility</div><div class="mc-value">${FD.fmt.num(st.vol, 1)}%</div><div class="muted small">annualised, log-scale</div></div>
        <div class="mini-card"><div class="mc-label">Return per unit of risk</div><div class="mc-value">${st.sharpe == null ? "—" : FD.fmt.num(st.sharpe, 2)}</div><div class="muted small">annualised return ÷ volatility, no risk-free subtracted</div></div>
        <div class="mini-card"><div class="mc-label">Worst peak-to-trough</div><div class="mc-value neg">${FD.fmt.num(st.mdd, 1)}%</div><div class="muted small">inside this window</div></div>
        <div class="mini-card"><div class="mc-label">Return per £${money.toLocaleString("en-GB")} invested</div><div class="mc-value ${st.total >= 0 ? "pos" : "neg"}">£${Math.round(money * (1 + st.total / 100)).toLocaleString("en-GB")}</div><div class="muted small">before the ${ENTRY_COST}% entry cost deducted below</div></div>
      </div>
      <div class="card" style="margin-top:1.1rem"><h3>This basket's equity curve against the equal-weight universe</h3>
        <canvas class="chart" id="b-chart" style="height:260px"></canvas>
        <p class="muted small">${st.total >= 0 ? "+" : ""}${FD.fmt.num(st.total, 1)}% versus ${bench ? (bench.total >= 0 ? "+" : "") + FD.fmt.num(bench.total, 1) + "% for all " + bench.n + " names" : "no benchmark history"} · average pairwise correlation ${st.corr == null ? "—" : FD.fmt.num(st.corr, 2)}${st.corr > 0.7 ? " — that is one bet, not a portfolio" : st.corr > 0.45 ? " — diversified, but these names still share a market direction" : " — low shared direction for this window"}. ${bench && st.vol != null && bench.vol ? "Volatility " + FD.fmt.num(st.vol, 1) + "% vs the universe's " + FD.fmt.num(bench.vol, 1) + "%." : ""}</p></div>
      <h3 class="sec-h">Constituents</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Stock</th><th>Weight</th><th>For £${money.toLocaleString("en-GB")}</th><th>Window return</th><th>Sector</th><th>Rank</th><th>Signal</th></tr></thead><tbody>
        ${st.per.map(p => { const s = FD.get(p.t), a = s ? FD.action(s, live(s)) : { cls: "na", tag: "—" };
          return `<tr data-t="${esc(p.t)}"><td>${logoHTML(s, "lg-sm")}<span class="tkr">${esc(p.t)}</span><div class="nm">${esc(p.name)}</div></td>
            <td>${FD.fmt.num(p.w * 100, 1)}%</td><td>£${Math.round(p.w * money).toLocaleString("en-GB")}</td>
            <td>${perfCell(p.total)}</td><td>${esc(p.sector)}</td>
            <td><span class="rank-cell">${s ? Math.round(live(s)) : "—"}</span></td>
            <td><span class="act ${a.cls}">${esc(a.tag)}</span></td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted small">Costs assumed: ${(COST_BP / 100).toFixed(1)}% (${COST_BP}bp) of each position's value on entry. Because the basket is fully invested, that is ${(COST_BP / 100).toFixed(1)}% of the portfolio whatever the number of holdings, and it is deducted in the "after entry cost" column below. Returns use each listing's own sessions with the last price held across a day it did not trade, so a holiday in one country is not read as a flat day in another.</p>` : `
      <div class="card"><p class="muted">Not enough published history for ${set.length} name${set.length === 1 ? "" : "s"} in this window — the basket needs at least two stocks with 40+ bars. Try more holdings or a shorter window.</p></div>`}
      <h3 class="sec-h">Every rule measured on the same window</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Selection rule</th><th>Names</th><th>Window return</th><th>After entry cost</th><th>Annualised</th><th>Volatility</th><th>Return per unit of risk</th><th>Worst drawdown</th><th>Avg correlation</th></tr></thead><tbody>
        ${ruleRows.map(x => { const net = netOf(x.m.total);
          return `<tr class="${x.r.k === B.rule ? "row-me" : ""}" data-rule="${x.r.k}" style="cursor:pointer"><td><b>${esc(x.r.label)}</b> <span class="muted small">${x.m.n} names</span></td>
            <td>${x.m.n}</td><td>${perfCell(x.m.total)}</td><td>${perfCell(net)}</td><td>${perfCell(x.m.ann)}</td>
            <td>${FD.fmt.num(x.m.vol, 1)}%</td><td>${x.m.sharpe == null ? "—" : FD.fmt.num(x.m.sharpe, 2)}</td>
            <td class="neg">${FD.fmt.num(x.m.mdd, 1)}%</td><td>${x.m.corr == null ? "—" : FD.fmt.num(x.m.corr, 2)}</td></tr>`; }).join("")}
        ${bench ? `<tr><td><b>Equal-weight universe</b> <span class="muted small">benchmark</span></td><td>${bench.n}</td><td>${perfCell(bench.total)}</td><td>${perfCell(netOf(bench.total))}</td><td>${perfCell(bench.ann)}</td><td>${FD.fmt.num(bench.vol, 1)}%</td><td>${bench.sharpe == null ? "—" : FD.fmt.num(bench.sharpe, 2)}</td><td class="neg">${FD.fmt.num(bench.mdd, 1)}%</td><td>${bench.corr == null ? "—" : FD.fmt.num(bench.corr, 2)}</td></tr>` : ""}
      </tbody></table></div>
      <div class="card limits" style="margin-top:1.1rem"><h3>What this does not tell you</h3>
        <p class="muted small">These are the rules applied to today's data and run backwards over one window — selection happens with knowledge the original buyers did not have, so the spread between the rows is more informative than any single row. The point-in-time test on the Evidence page rebalances monthly using only data available at the time and is the stricter measure. ${B.days >= 504 ? "The 2-year window also straddles a single market regime." : ""}</p></div>`;

    const setSel = (k, v) => { B[k] = v; FD.store.set("build", B); rerender(); };
    ["b-rule", "b-n", "b-cap", "b-w", "b-days"].forEach(id => { const el = $("#" + id); if (el) el.onchange = () => {
      if (id === "b-rule") setSel("rule", el.value);
      else if (id === "b-n") setSel("n", +el.value);
      else if (id === "b-cap") setSel("cap", +el.value);
      else if (id === "b-w") setSel("weight", el.value);
      else setSel("days", +el.value);
    }; });
    view.querySelectorAll("[data-rule]").forEach(tr => tr.onclick = () => setSel("rule", tr.dataset.rule));
    if (st) {
      const c = $("#b-chart");
      if (c) {
        const axis = st.curve.map(p => new Date(p.d));
        const benchMap = new Map((bench && bench.curve || []).map(p => [p.d, p.v]));
        FD.lineChart(c, axis, st.curve.map(p => p.v), {
          height: 260, title: "basket %",
          overlays: bench ? [{ values: st.curve.map(p => benchMap.get(p.d) ?? null), color: "#8a94a6", label: "equal-weight universe" }] : [],
        });
      }
    }
    wireRowClicks();
  }

  /* ---------- investment calculator ---------- */
  function renderCalculator() {
    $("#crumb").textContent = "Calculator";
    const c = state.calc;
    const names = FD.stocks.filter(s => (s.closes || []).length > 60);
    const m = +c.monthly || 0, years = Math.max(1, +c.years || 1), P = +c.start || 0;
    const months = Math.round(years * 12);
    let rate = +c.rate, rateNote = "your own assumption", basis = null;
    if (c.basis === "stock" && c.t) {
      const s = FD.get(c.t);
      if (s && s.metrics.perf12 != null) {
        const g = FD.signals(s);
        rate = s.metrics.perf12; rateNote = `${s.t}'s actual ${Math.round(s.closes.length)}-bar return`; basis = g.vol;
      }
    }
    rate = isFinite(rate) ? rate : 0;
    const series = (annual) => {
      const r = annual / 100 / 12; let v = P; const out = [P];
      for (let i = 1; i <= months; i++) { v = v * (1 + r) + m; out.push(v); }
      return out;
    };
    const band = basis != null ? (basis / 100) : null;
    const mid = series(rate), hi = band != null ? series(rate + band * 100) : null, lo = band != null ? series(rate - band * 100) : null;
    const final = mid[mid.length - 1], inved = P + m * months;
    const mult = inved ? final / inved : null;
    const dates = mid.map((_, i) => { const d = new Date(); d.setMonth(d.getMonth() + i); return d; });

    /* position sizing, straight from the signal engine's own levels */
    const sz = state.sizing;
    const s0 = sz.t ? FD.get(sz.t) : null;
    const plan = s0 ? FD.action(s0, live(s0)).plan : null;
    const entry = plan && plan.entry ? plan.entry : null, stop = plan && plan.stop ? plan.stop : null, tgt = plan && plan.target ? plan.target : null;
    const perUnit = entry != null && stop != null ? Math.max(entry - stop, 0) : null;
    const units = perUnit && +sz.capital && +sz.risk ? Math.floor((+sz.capital * (+sz.risk / 100)) / perUnit) : null;
    const posVal = units != null && entry ? units * entry : null;
    const rr = entry != null && stop != null && tgt != null && entry > stop ? (tgt - entry) / (entry - stop) : null;
    const dbl = rate > 0 ? (72 / rate).toFixed(1) : null;

    view.innerHTML = `
      <p class="eyebrow" style="margin-bottom:.8rem">Investment calculator · arithmetic, not advice</p>
      <div class="grid grid-2">
        <div class="card"><h3>Compounding plan</h3>
          <div class="calc-form">
            <div class="field">Starting amount<input type="number" id="c-start" value="${esc(c.start)}" min="0"></div>
            <div class="field">Added each month<input type="number" id="c-monthly" value="${esc(c.monthly)}" min="0"></div>
            <div class="field">Years<input type="number" id="c-years" value="${esc(c.years)}" min="1" max="45"></div>
            <div class="field">Return basis<select id="c-basis">
              <option value="own" ${c.basis === "own" ? "selected" : ""}>My own annual %</option>
              <option value="stock" ${c.basis === "stock" ? "selected" : ""}>A stock's actual 12-month record</option></select></div>
            <div class="field">Annual return %<input type="number" id="c-rate" value="${esc(c.rate)}" step="0.5" ${c.basis === "stock" ? "disabled" : ""}></div>
            <div class="field">Which stock<select id="c-t"><option value="">—</option>${names.slice(0, 400).map(s => `<option value="${esc(s.t)}" ${c.t === s.t ? "selected" : ""}>${esc(s.t)} · ${esc(s.name)}</option>`).join("")}</select></div>
          </div>
          <div class="calc-out">
            <div><span class="mc-label">Value in ${years} year${years > 1 ? "s" : ""}</span><b>${money(final)}</b></div>
            <div><span class="mc-label">You put in</span><b>${money(inved)}</b></div>
            <div><span class="mc-label">Growth</span><b class="${final >= inved ? "pos" : "neg"}">${money(final - inved)} (${FD.fmt.pct(inved ? (final / inved - 1) * 100 : null, 1)})</b></div>
            <div><span class="mc-label">Per £1 invested</span><b>${mult == null ? "—" : "£" + FD.fmt.num(mult, 2)}</b></div>
            <div><span class="mc-label">Rate used</span><b>${FD.fmt.num(rate, 1)}%</b><div class="muted small">${esc(rateNote)}${band != null ? ", ±" + FD.fmt.num(band * 100, 0) + "% for the stock's own measured volatility" : ""}</div></div>
            ${dbl ? `<div><span class="mc-label">Years to double at this rate</span><b>${FD.fmt.num(+dbl / 1, 1)}</b><div class="muted small">rule of 72 arithmetic</div></div>` : ""}
          </div>
          <canvas class="chart" id="c-chart" style="height:240px"></canvas>
          <p class="muted small">Monthly compounding of a fixed rate${band != null ? "; the band is the same plan run at the stock's actual return ±1 measured volatility, which is a spread of outcomes, not a range of forecasts" : ""}. Real markets are irregular — this answers "what does this arithmetic produce", nothing else.</p>
        </div>
        <div class="card"><h3>Position sizing — how much to buy</h3>
          <div class="calc-form">
            <div class="field">Stock<select id="c-s-t"><option value="">—</option>${FD.stocks.slice(0, 400).map(s => `<option value="${esc(s.t)}" ${sz.t === s.t ? "selected" : ""}>${esc(s.t)} · ${esc(s.name)}</option>`).join("")}</select></div>
            <div class="field">Capital<input type="number" id="c-cap" value="${sz.capital}" min="0"></div>
            <div class="field">Risk on this trade %<input type="number" id="c-risk" value="${sz.risk}" step="0.25" min="0.1"></div>
          </div>
          ${s0 ? `<div class="calc-out">
            <div><span class="mc-label">Signal</span><b>${esc(FD.action(s0, live(s0)).tag)}</b></div>
            <div><span class="mc-label">Entry / stop / target</span><b>${FD.fmt.px(s0, entry)} / ${FD.fmt.px(s0, stop)} / ${FD.fmt.px(s0, tgt)}</b><div class="muted small">from the price record: trend average, gap edge or 52-week level</div></div>
            <div><span class="mc-label">Risk per share</span><b>${perUnit != null ? FD.fmt.px(s0, perUnit) : "—"}</b></div>
            <div><span class="mc-label">Units to buy</span><b>${units == null ? "—" : units.toLocaleString("en-GB")}</b><div class="muted small">so a stop-out costs ${money(+sz.capital * (+sz.risk / 100))}</div></div>
            <div><span class="mc-label">Position value</span><b>${posVal == null ? "—" : money(posVal)}${posVal && +sz.capital ? ` (${FD.fmt.num(posVal / +sz.capital * 100, 0)}% of capital)` : ""}</b></div>
            <div><span class="mc-label">Reward:risk to target</span><b>${rr == null ? "—" : FD.fmt.num(rr, 2) + "x"}</b></div>
          </div>` : `<p class="muted small">Pick a stock to pull its live entry, stop and target into the sizing maths.</p>`}
          <h3 style="margin-top:1rem">Required return</h3>
          ${s0 && entry ? `<div class="calc-out">
            <div><span class="mc-label">From ${FD.fmt.px(s0, entry)} to its 52-week high</span><b>${FD.fmt.pct(tgt ? (tgt / entry - 1) * 100 : null, 1)}</b><div class="muted small">the nearest real level above the price${tgt === s0.week52Hi ? " (the 52-week high)" : ""}</div></div>
            <div><span class="mc-label">Annualised over 2 years</span><b>${FD.fmt.pct(tgt ? (Math.pow(tgt / entry, 1 / 2) - 1) * 100 : null, 1)}</b></div>
            <div><span class="mc-label">Dividend contribution</span><b>${FD.fmt.num(s0.metrics.divYield, 2)}%</b><div class="muted small">the rest has to come from the price</div></div>
          </div>` : `<p class="muted small">Pick a stock above and this shows what the nearest real price level implies in percentage terms.</p>`}
        </div>
      </div>`;
    const set = (k, v) => { c[k] = v; FD.store.set("calc", c); rerender(); };
    ["c-start", "c-monthly", "c-years", "c-rate", "c-basis", "c-t"].forEach(id => { const el = $("#" + id); if (el) el.onchange = () => set(id.slice(2), el.value); });
    const st = $("#c-s-t"), cap = $("#c-cap"), rk = $("#c-risk");
    const sizeSet = (k, v) => { sz[k] = v; FD.store.set("sizing", sz); rerender(); };
    if (st) st.onchange = () => sizeSet("t", st.value);
    if (cap) cap.onchange = () => sizeSet("capital", +cap.value || 0);
    if (rk) rk.onchange = () => sizeSet("risk", +rk.value || 1);
    const cv = $("#c-chart");
    if (cv && mid.length > 2) FD.lineChart(cv, dates, mid, { height: 240, title: "portfolio value", overlays: hi ? [{ values: hi, color: "#7fa8d9", label: "upper band" }, { values: lo, color: "#c98b8b", label: "lower band" }] : [] });
  }
  const money = (v) => v == null || !isFinite(v) ? "—" : "£" + Math.round(v).toLocaleString("en-GB");

  /* ---------- media: every headline the app can actually reach ---------- */
  function feedBlock(el, items, note) {
    if (!el) return;
    el.innerHTML = items && items.length
      ? items.map(newsRow).join("")
      : `<p class="muted small">${esc(note || "Nothing published for this query right now.")}</p>`;
  }
  function renderMedia() {
    $("#crumb").textContent = "Media";
    const wl = Object.keys(FD.watchlist.all()).slice(0, 6);
    const secs = FD.sectorTable().slice(0, 4);
    const cal = FD.stocks.filter(s => s.nextEarnings && s.nextEarnings > Date.now()).sort((a, b) => a.nextEarnings - b.nextEarnings).slice(0, 16);
    view.innerHTML = `
      <p class="eyebrow" style="margin-bottom:.8rem">Media · headlines straight from Yahoo Finance's news feed</p>
      <div class="card verdict"><div><h3>${wl.length ? `${wl.length} watchlist feed${wl.length > 1 ? "s" : ""}, ${secs.length} sector feeds and the market-wide feed` : "Sector feeds and the market-wide feed"}</h3>
        <p class="muted">Every block says what it queried. Nothing here is summarised or rewritten — the app has no invented headlines, and the write-ups on other pages only ever see numbers.</p></div></div>
      <div class="grid grid-2">
        <div class="card"><h3>Market-wide</h3><div id="md-market"><p class="muted small">loading…</p></div></div>
        <div class="card"><h3>Next earnings</h3>
          ${cal.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Stock</th><th>Reports</th><th>In</th><th>Rank</th><th>Signal</th></tr></thead><tbody>
            ${cal.map(s => { const a = FD.action(s, live(s)); const days = Math.round((s.nextEarnings - Date.now()) / 86400000);
              return `<tr data-t="${esc(s.t)}"><td>${logoHTML(s, "lg-lg")}<span class="tkr">${esc(s.t)}</span><div class="nm">${esc(s.name)}</div></td>
                <td>${new Date(s.nextEarnings).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
                <td>${days} day${days === 1 ? "" : "s"}</td><td><span class="rank-cell">${Math.round(live(s))}</span></td>
                <td><span class="act ${a.cls}">${esc(a.tag)}</span></td></tr>`; }).join("")}
          </tbody></table></div>` : `<p class="muted small">No future earnings dates are published for the current universe.</p>`}</div>
      </div>
      ${wl.length ? `<h3 class="sec-h">Your watchlist</h3><div class="grid grid-2">${wl.map(t => `<div class="card"><h3>${esc(t)} <span class="muted small">${esc((FD.get(t) || {}).name || "")}</span></h3><div id="md-${esc(t)}"><p class="muted small">loading…</p></div></div>`).join("")}</div>` : ""}
      <h3 class="sec-h">Sector feeds</h3><div class="grid grid-2">
        ${secs.map(x => `<div class="card"><h3>${esc(x.sector)}</h3><p class="muted small">3-month ${FD.fmt.pct(x.perf3m)} · 12-month ${FD.fmt.pct(x.perf12)} across ${x.n} names</p><div id="mds-${esc(x.sector)}"><p class="muted small">loading…</p></div></div>`).join("")}
      </div>`;
    FD.news("stock market").then(x => feedBlock(document.getElementById("md-market"), x, "The news feed returned nothing."));
    wl.forEach(t => { const s = FD.get(t); if (s) FD.news(s.name).then(x => feedBlock(document.getElementById("md-" + t), x, `No recent headlines for ${t}.`)); });
    secs.forEach(x => FD.news(x.sector + " stocks").then(r => feedBlock(document.getElementById("mds-" + x.sector), r, `No headlines published for ${x.sector}.`)));
    wireRowClicks();
  }

  /* ---------- router ---------- */
  let navSeq = 0;
  const routes = {
    analysis: renderAnalysis,
    evidence: renderEvidence,
    rankings: renderRankings, screener: renderScreener, sugar: renderPresets,
    gaps: renderGaps, signals: renderSignals, builder: renderBuilder,
    opportunities: renderOpportunities,
    calculator: renderCalculator, media: renderMedia,
    watchlist: renderWatchlist, portfolio: renderPortfolio,
  };
  function rerender() { go(location.hash); }
  function go(hash) {
    navSeq++;
    const m = hash.match(/^#\/stock\/(.+)$/);
    const shared = hash.match(/^#\/screener\?(.*)$/);
    if (shared) applyScreenQuery(shared[1]);
    view.classList.remove("flash"); void view.offsetWidth; view.classList.add("flash");
    if (m) renderStock(m[1]);
    else (routes[(hash.replace(/^#\/|\?.*$/g, "")) || "rankings"] || renderRankings)();
    addTableFilters();
    alertFlag();
    const route = hash.replace(/^#\/|\?.*$/g, "");
    const activeRoute = m ? "" : (routes[route] ? route : "rankings");
    document.querySelectorAll(".side-nav a").forEach(a => {
      const on = a.dataset.route === activeRoute;
      a.classList.toggle("active", on);
      a.setAttribute("aria-current", on ? "page" : "false");
    });
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => go(location.hash));

  /* ---------- global search ---------- */
  const search = $("#global-search"), pop = $("#popover");
  function searchUI() {
    const q = search.value.trim().toLowerCase();
    if (!q) { pop.hidden = true; return; }
    const hits = FD.stocks.filter(s => s.t.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).slice(0, 8);
    pop.hidden = false;
    const r = search.getBoundingClientRect();
    pop.style.left = r.left + "px"; pop.style.top = r.bottom + window.scrollY + 6 + "px"; pop.style.width = Math.max(r.width, 260) + "px";
    pop.innerHTML = hits.length ? hits.map(s => `<a href="#/stock/${s.t}" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.45rem .6rem;border-bottom:1px solid var(--line);color:inherit;font-size:.85rem"><span style="display:flex;align-items:center;gap:.5rem">${logoHTML(s, "lg-sm")}<b>${esc(s.t)}</b> ${esc(s.name)}</span><span class="rank-cell">${Math.round(s.rank)}</span></a>`).join("") : `<div style="padding:.6rem;color:var(--muted);font-size:.85rem">No matches</div>`;
    pop.querySelectorAll("a").forEach(a => a.onclick = () => { pop.hidden = true; search.value = ""; });
  }
  search.oninput = searchUI;
  search.onkeydown = e => { if (e.key === "Enter") { const v = search.value.trim(); const s = FD.stocks.find(x => x.t.toLowerCase() === v.toLowerCase()); if (s) { location.hash = "#/stock/" + s.t; pop.hidden = true; search.value = ""; } } if (e.key === "Escape") pop.hidden = true; };
  document.addEventListener("click", e => { if (!e.target.closest("#popover") && !e.target.closest(".search-box")) pop.hidden = true; });
  document.addEventListener("keydown", e => {
    if (/input|select|textarea/i.test(e.target.tagName)) return;
    if (e.key === "/") { e.preventDefault(); widenNav(); search.focus(); }
    if (e.key === "[") { e.preventDefault(); if (RAIL()) setNav(!document.body.classList.contains("nav-collapsed")); }
  });

  /* ---------- sidebar ---------- */
  const RAIL = () => window.matchMedia("(min-width:761px)").matches;
  const DESKTOP = () => window.matchMedia("(min-width:1001px)").matches;
  function setNav(collapsed) {
    document.body.classList.toggle("nav-collapsed", collapsed);
    FD.store.set("navCollapsed", collapsed);
    const rt = $("#rail-toggle");
    if (rt) { rt.title = collapsed ? "Expand sidebar (press [)" : "Collapse sidebar (press [)"; rt.setAttribute("aria-expanded", String(!collapsed)); }
  }
  function widenNav() { if (RAIL() && document.body.classList.contains("nav-collapsed")) setNav(false); }
  function setMobileNav(open) {
    document.body.classList.toggle("nav-open", open);
    $("#menu-btn").setAttribute("aria-expanded", String(open));
  }
  // no stored choice: a docked-but-narrow window starts as a rail so the tables keep their width
  const navPref = FD.store.get("navCollapsed", null);
  setNav(navPref === null ? RAIL() && !DESKTOP() : !!navPref && RAIL());
  $("#rail-toggle").onclick = () => setNav(!document.body.classList.contains("nav-collapsed"));
  $("#menu-btn").onclick = () => { if (RAIL()) setNav(!document.body.classList.contains("nav-collapsed")); else setMobileNav(!document.body.classList.contains("nav-open")); };
  window.addEventListener("hashchange", () => { if (!RAIL()) setMobileNav(false); });
  window.addEventListener("resize", () => { if (!RAIL()) document.body.classList.remove("nav-collapsed"); else setMobileNav(false); });

  /* counts on the Holdings entries come from the user's own stored rows, and the footer
     carries the feed state so it stays legible even when the top badge is scrolled away */
  function paintNavCounts() {
    const set = (k, n) => { const el = document.querySelector('.nav-count[data-count="' + k + '"]'); if (el) { el.textContent = n; el.hidden = !n; } };
    set("watch", Object.keys(FD.watchlist.all()).length);
    set("pf", FD.portfolio.all().length);
  }
  function setNavStatus(text, down) {
    const el = $("#side-status");
    if (!el) return;
    el.classList.toggle("down", !!down);
    el.innerHTML = `<span class="mkt-dot"></span><span>${text}</span>`;
  }
  paintNavCounts();
  for (const [obj, fn] of [[FD.watchlist, "toggle"], [FD.portfolio, "upsert"], [FD.portfolio, "remove"]]) {
    const orig = obj[fn].bind(obj);
    obj[fn] = (arg) => { orig(arg); paintNavCounts(); };
  }

  function toast(msg) {
    const el = document.createElement("div"); el.className = "toast"; el.textContent = msg;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
  }
  $("#theme-toggle").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    FD.store.set("theme", next);
    rerender();
  };
  document.documentElement.dataset.theme = FD.store.get("theme", "light");
  let refreshInProgress = false, lastRefreshError = "", pendingFeedRender = false;
  const refreshButton = $("#refresh-live"), freshness = $("#feed-freshness");
  function feedTime(value) {
    return value && !isNaN(value.getTime())
      ? value.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "time unavailable";
  }
  function paintFeedStatus(message) {
    const badge = $("#src-badge");
    if (badge && FD.source === "live") {
      badge.innerHTML = `<span class="mkt-dot"></span>DELAYED · ${FD.stocks.length} stocks`;
      badge.className = "badge good";
      badge.title = `Snapshot retrieved ${feedTime(FD.liveAsof)} from ${FD.dataSrc}. Quotes are delayed; reported financial metrics change when new filings are published.`;
    }
    if (freshness) {
      freshness.textContent = message || (FD.refreshing
        ? `Source refresh in progress · showing ${feedTime(FD.liveAsof)}`
        : `Snapshot ${feedTime(FD.liveAsof)} · checks every 15 min`);
      freshness.classList.toggle("is-error", !!lastRefreshError);
      freshness.classList.toggle("is-stale", !!lastRefreshError || !!FD.refreshing);
      freshness.title = lastRefreshError || "Market data is delayed, not streaming. The full-universe source snapshot can be cached for up to 6 hours; reported financials update when companies publish filings.";
    }
    setNavStatus(`<b>As of ${feedTime(FD.liveAsof)}</b> · ${FD.dataSrc || "Market data"}, delayed and as-reported`);
  }
  function applyFeedRender() {
    pendingFeedRender = false;
    const scrollY = window.scrollY;
    go(location.hash);
    window.scrollTo(0, scrollY);
  }
  document.addEventListener("focusout", () => {
    if (!pendingFeedRender) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || !active.matches("input, select, textarea")) applyFeedRender();
    }, 0);
  });
  async function refreshMetrics(manual) {
    if (refreshInProgress || FD.source !== "live") return;
    refreshInProgress = true;
    if (refreshButton) { refreshButton.disabled = true; refreshButton.classList.add("is-loading"); }
    if (freshness) { freshness.textContent = "Checking for a newer snapshot…"; freshness.classList.remove("is-error", "is-stale"); }
    const oldLive = FD.liveAsof && FD.liveAsof.getTime();
    const oldMacro = FD.macroAsof && FD.macroAsof.getTime();
    try {
      await Promise.all([FD.loadLive(), FD.loadMacro(true)]);
      lastRefreshError = "";
      const newLive = FD.liveAsof && FD.liveAsof.getTime();
      const newMacro = FD.macroAsof && FD.macroAsof.getTime();
      const liveChanged = newLive && newLive !== oldLive;
      const analysisOpen = /^#\/analysis(?:\?|$)/.test(location.hash);
      const macroChanged = analysisOpen && newMacro && newMacro !== oldMacro;
      const changed = liveChanged || macroChanged;
      paintFeedStatus(changed
        ? `New snapshot ${feedTime(FD.liveAsof)} · quotes delayed`
        : FD.refreshing
          ? `Source refresh in progress · showing ${feedTime(FD.liveAsof)}`
          : `No newer snapshot · checked ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
      if (changed) {
        const active = document.activeElement;
        if (active && active.matches("input, select, textarea")) {
          pendingFeedRender = true;
          if (freshness) freshness.textContent = `Update ready · finish editing to apply`;
        } else applyFeedRender();
      } else if (pendingFeedRender && freshness) {
        freshness.textContent = "Update ready · finish editing to apply";
      } else if (manual && freshness) {
        freshness.textContent = FD.refreshing
          ? `Refresh in progress · showing ${feedTime(FD.liveAsof)}`
          : `Latest snapshot ${feedTime(FD.liveAsof)} · no newer data`;
      }
    } catch (e) {
      lastRefreshError = e.message || "Could not check for new market data.";
      paintFeedStatus(`Update check failed · showing ${feedTime(FD.liveAsof)}`);
      console.error("Market-data refresh failed", e);
    } finally {
      refreshInProgress = false;
      if (refreshButton) { refreshButton.disabled = false; refreshButton.classList.remove("is-loading"); }
    }
  }
  if (refreshButton) refreshButton.onclick = () => refreshMetrics(true);
  async function boot() {
    const badge = $("#src-badge");
    if (badge) { badge.textContent = "loading live data…"; badge.className = "badge"; }
    try {
      const n = await FD.loadLive();
      paintFeedStatus(`Snapshot ${feedTime(FD.liveAsof)} · checks every 15 min`);
      if (badge) badge.title += ` Health score is a 0–9 proxy from published ratios. ${n} tracked stocks.`;
    } catch (e) {
      FD.source = "error";
      const tape = document.getElementById("tape");
      if (tape) { tape.innerHTML = ""; tape.hidden = true; }
      if (badge) { badge.textContent = "DATA FEED DOWN"; badge.className = "badge bad"; badge.title = e.message; }
      lastRefreshError = e.message || "Market data is unavailable.";
      if (freshness) { freshness.textContent = "No market snapshot available"; freshness.classList.add("is-error"); freshness.title = lastRefreshError; }
      setNavStatus("Feed down — no data loaded. Nothing on screen is estimated.", true);
      view.innerHTML = `<div class="empty-state"><div class="big">⚠</div><h3>No market data could be loaded</h3>
        <p>FactorDesk only shows real figures — it will not substitute invented ones, so the tables stay empty until the feed answers.</p>
        <p class="small muted">${esc(e.message)}<br>Start the server with <code>node server.js</code> (it spawns the yfinance datasource on port 8765), or check that <code>http://localhost:3000/api/universe</code> answers.</p>
        <div style="display:flex;gap:.7rem;justify-content:center">
          <button class="btn btn-primary" id="retry-feed">Retry now</button>
          <a class="btn" href="/api/universe" target="_blank" rel="noopener">Inspect the feed</a></div></div>`;
      const btn = document.getElementById("retry-feed");
      if (btn) btn.onclick = async () => { btn.disabled = true; btn.textContent = "Retrying…";
        try { await FD.loadLive(); } catch { }
        if (FD.source === "live") { location.reload(); } else { btn.disabled = false; btn.textContent = "Retry now"; toast("Feed still down"); } };
      return;
    }
    FD.renderTape(document.getElementById("tape"));
    setInterval(() => FD.renderTape(document.getElementById("tape")), 5 * 60000);
    FD.loadMacro().then(m => { if (m.length) { const b = document.getElementById("macro-count"); if (b) b.textContent = m.length + " macro instruments live"; } });
    go(location.hash);
    setInterval(() => { if (document.visibilityState === "visible") refreshMetrics(false); }, 15 * 60000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshMetrics(false);
    });
  }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot); else boot();
})();
