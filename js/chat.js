/* FactorDesk assistant — a floating chat that is only as smart as the numbers on the screen.
   Every answer is conditioned on a FACTS block computed here from the live record using the same
   rule engine the pages use, so a buy/hold/sell word is a relay of a measured verdict rather than
   a model opinion. The Groq key stays on the server: the browser sends facts and nothing else. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const r1 = (v) => (v == null ? null : +v.toFixed(1));
  const r2 = (v) => (v == null ? null : +v.toFixed(2));
  const shortModel = (m) => String(m || "assistant").replace(/^openai\//, "");

  const fab = $("#chat-fab"), dock = $("#chat-dock");
  if (!fab || !dock) return;
  const log = $("#chat-log"), form = $("#chat-form"), input = $("#chat-input"),
    chips = $("#chat-chips"), ctxEl = $("#chat-ctx");
  const dotEl = $("#chat-dot"), statusEl = $("#chat-status");
  const MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>';
  let open = false, busy = false;

  const hist = () => FD.store.get("chat", []);
  const save = (h) => FD.store.set("chat", h.slice(-30));
  const push = (role, content) => { const h = hist(); h.push({ role, content, at: Date.now() }); save(h); return h; };

  /* markdown-lite — escaped before anything is interpolated */
  function md(src) {
    const lines = String(src).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let html = "", inList = false;
    for (let l of lines) {
      l = esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[\[([^\]|]{1,24})\]\]/g, "$1");
      if (/^[-*•]\s+/.test(l)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${l.replace(/^[-*•]\s+/, "")}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p class="c-para">${l.replace(/^\d+\.\s+/, "")}</p>`;
    }
    return inList ? html + "</ul>" : html;
  }
  /* the model may cite a verdict as [[Buy|HSBA.L]] so the ticker stays clickable */
  const actCls = (tag) => /^buy/i.test(tag) ? "buy" : tag === "Hold" ? "hold" : tag === "Trim" ? "trim"
    : tag === "Sell" ? "sell" : /^no /i.test(tag) ? "na" : "watch";
  function relink(html) {
    const hasStockTag = /\[\[[^\]|]{1,24}\|[A-Za-z0-9._-]{1,16}\]\]/.test(html);
    const rankOf = hasStockTag ? rankedMap(weights()).of : null;
    return html.replace(/\[\[([^\]|]{1,24})\|([A-Za-z0-9._-]{1,16})\]\]/g, (m0, tag, t) => {
      const up = t.toUpperCase();
      const stock = FD.get(up);
      if (!stock) return `${esc(tag)} ${esc(up)}`;
      const action = FD.action(stock, rankOf.get(up) || 0);
      const plan = action.plan;
      const mark = plan && Number.isFinite(plan.entry)
        ? `<button class="c-entry-marker" type="button" data-entry-ticker="${esc(up)}" data-entry-price="${esc(plan.entry)}" aria-label="Show the current rule entry level for ${esc(up)} on its chart">Current entry · ${esc(FD.fmt.px(stock, plan.entry))}</button>`
        : "";
      return `<a href="#/stock/${encodeURIComponent(up)}" class="c-tkr" data-pick="1"><span class="act ${actCls(tag)}">${esc(tag)}</span>${esc(up)}</a>${mark}`;
    });
  }

  const TIER = ["Buy", "Buy on weakness", "Wait for the trend", "Hold", "Weak watch", "Trim", "Sell", "No trend data"];
  const weights = () => ({ ...FD.DEFAULT_WEIGHTS, ...FD.store.get("weights", {}) });
  /* FD.rankedWith is the single place the blend is scored, so the chat reads rank from it */
  function rankedMap(w) { const arr = FD.rankedWith(w); return { arr, of: new Map(arr.map(s => [s.t, s.liveRank])) }; }

  function verdictOf(s, rank, prose) {
    const a = FD.action(s, rank), g = FD.signals(s), m = s.metrics;
    const plain = (t) => String(t || "").replace(/<[^>]*>/g, "");
    const v = { t: s.t, name: s.name, sector: s.sector, country: s.country, currency: s.currency,
      rank: Math.round(rank), tag: a.tag, score: a.score, price: r1(m.price),
      perf3m: r1(m.perf3m), perf12: r1(m.perf12), vol: r2(g.vol), beta: r2(m.beta), rsi: r1(m.rsi) };
    if (prose) { v.pe = r1(m.pe); v.divYield = r1(m.divYield); v.roce = r1(m.roce);
      v.bull = plain(a.bull[0]); v.bear = plain(a.bear[0]); }
    if (a.plan) {
      v.entry = r1(a.plan.entry); v.stop = r1(a.plan.stop); v.target = r1(a.plan.target);
      v.riskPct = r1(a.plan.risk); v.rewardPct = r1(a.plan.reward);
      v.rr = a.plan.rr == null || a.plan.rr > 10 ? null : r2(a.plan.rr);
      if (a.plan.rr > 10) v.rrNote = "the stop sits within a hair of today's price, so a risk/reward ratio off it is meaningless — use the stop and target levels themselves";
      if (prose) { v.stopNote = a.plan.stopNote; v.targetNote = a.plan.targetNote; }
    }
    return v;
  }

  /* An allocation is arithmetic on two measured inputs — the engine's rank and realised volatility
     — under the same sector cap the builder uses. Weight = FactorRank / volatility, no name over
     15% of the money, amounts rounded to the nearest 10 at the price shown. Nothing is invented. */
  function plan(capital, pool, capPerSector, maxNames) {
    const used = {}, picked = [];
    for (const s of pool) {
      const sec = s.sector || "—";
      if ((used[sec] || 0) >= capPerSector) continue;
      used[sec] = (used[sec] || 0) + 1; picked.push(s);
      if (picked.length >= maxNames) break;
    }
    if (picked.length < 2) return null;
    let w = picked.map(s => { const g = FD.signals(s); return Math.max(s.liveRank, 1) * (g.vol ? Math.min(1, 25 / g.vol) : 1); });
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    w = w.map(x => x / sum);
    for (let i = 0; i < 8; i++) {
      const over = w.map((x, j) => x > 0.15 ? j : -1).filter(j => j >= 0);
      if (!over.length) break;
      let excess = 0;
      over.forEach(j => { excess += w[j] - 0.15; w[j] = 0.15; });
      const rest = w.reduce((a, x, j) => over.includes(j) ? a : a + x, 0);
      if (rest <= 0) break;
      w = w.map((x, j) => over.includes(j) ? x : x + excess * x / rest);
    }
    const positions = picked.map((s, j) => { const amt = Math.round(capital * w[j] / 10) * 10;
      return { t: s.t, name: s.name, sector: s.sector, country: s.country, currency: s.currency,
        rank: Math.round(s.liveRank), tag: FD.action(s, s.liveRank).tag, price: r1(s.metrics.price),
        weightPct: r1(w[j] * 100), amount: amt, amountLabel: s.currency + amt, vol: r2(FD.signals(s).vol) }; });
    const basket = FD.basket(picked, 252, () => w);
    const fold = (key) => { const o = {}; positions.forEach(p => o[key(p)] = r1((o[key(p)] || 0) + p.weightPct)); return o; };
    return {
      method: `Weight = FactorRank / annualised volatility, then no position above 15% of the money and no more than ${capPerSector} names per sector. Amounts are that percentage of the stated total in each listing's own currency, rounded to the nearest 10 — they are a currency split, not a claim that a whole share can be bought at the listed price.`,
      capital, positions,
      largestPositionPct: Math.max(...positions.map(p => p.weightPct)),
      sectorSplit: fold(p => p.sector), countrySplit: fold(p => p.country),
      measured: basket ? { names: basket.n, sessions: basket.sessions, totalReturnPct: r1(basket.total),
        annualisedPct: r1(basket.ann), volatilityPct: r1(basket.vol), returnPerRisk: r2(basket.sharpe),
        worstDrawdownPct: r1(basket.mdd), avgPairwiseCorr: r2(basket.corr),
        window: [new Date(basket.from).toISOString().slice(0, 10), new Date(basket.to).toISOString().slice(0, 10)] } : null,
    };
  }

  function capitalFrom(text) {
    const m = String(text || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k|m|million|bn|b)?\b/i);
    if (!m) return null;
    let v = parseFloat(m[1]);
    const u = (m[2] || "").toLowerCase();
    if (u === "k") v *= 1000; else if (u === "m" || u === "million") v *= 1e6; else if (u === "bn" || u === "b") v *= 1e9;
    return v >= 100 && v <= 1e10 ? Math.round(v) : null;
  }
  function buildFacts(question) {
    const w = weights(), rm = rankedMap(w), rankOf = (t) => rm.of.get(t) || 0;
    const market = FD.marketName();
    const scope = market === "Global" ? rm.arr : rm.arr.filter(s => s.country === market);
    const list = market === "Global" ? FD.stocks : FD.stocks.filter(s => s.country === market);
    const p = FD.pulse(list), secs = FD.sectorTable(list), reg = FD.riskRegime();
    const midx = FD.marketIndex(market), mfx = FD.marketFx(market);
    const tagOf = (s) => FD.action(s, rankOf(s.t)).tag;
    const counts = {}; TIER.forEach(t => counts[t] = 0);
    scope.forEach(s => { const t = tagOf(s); counts[t] = (counts[t] || 0) + 1; });
    const buyPool = scope.filter(s => tagOf(s) === "Buy" || tagOf(s) === "Buy on weakness");
    const cap = capitalFrom(question) || FD.store.get("sizing", {}).capital || 10000;
    /* key order matters — the facts are sent as one JSON string and the decision-critical
       blocks must survive before the long per-name arrays fill the budget */
    const alloc = plan(cap, buyPool.length >= 2 ? buyPool : scope, 3, 10);
    const lean = (s) => { const v = verdictOf(s, s.liveRank); delete v.name; return v; };
    const f = {
      generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
      source: `${FD.dataSrc || "live feed"} — prices delayed ~15 min, fundamentals as-reported and unaudited`,
      scope: { market, namesInScope: scope.length, universeTotal: FD.stocks.length,
        weights: Object.entries(w).map(([k, v]) => `${k} ${v}%`).join(", "),
        note: market === "Global" ? "Scope is the whole tracked universe."
          : `Scope is ${market} listings only — the ${scope.length} names below, not the world.` },
      verdictTagMeaning: "Buy / Buy on weakness = the rules favour owning it. Wait for the trend / Weak watch = odds reasonable, timing not. Hold = no edge either way, no new money. Trim / Sell = the rules are against it. Entry, stop and target are prices already in the record (a moving average, the 52-week high or low, a gap edge) — never forecasts.",
      useThisAllocation: alloc ? "proposedAllocation IS FactorDesk's own split for this screen. Quote its positions, weightPct and amount unchanged, name its method, and quote its measured figures next to it. Do not derive a competing weighting from the rank arrays."
        : "No allocation could be computed on this screen (too few names pass the rules), so say that and describe what the facts do support.",
      proposedAllocation: alloc,
      capitalNote: `The money figure in use is ${cap}. Use each position's amountLabel as written — it already carries that listing's own currency symbol, and listings in one screen can trade in several currencies. Never convert, and never add amounts across currencies. If the user names a different total, rescale the same weightPct values proportionally.`,
      verdictCounts: counts,
      tape: { breadthAbove200Pct: r1(p.breadth200), median12mPerfPct: r1(p.medianPerf),
        advancers1m: p.advancers1m, decliners1m: p.decliners1m,
        volatilityRegime: reg.v == null ? null : `${reg.label} (VIX ${r1(reg.v)})`,
        domesticIndex: midx ? { name: midx.n, threeMonthPct: r1(midx.q), oneYearPct: r1(midx.y) } : null,
        currency: mfx ? { name: mfx.n, oneMonthPct: r1(mfx.m), threeMonthPct: r1(mfx.q) } : null },
      sectors: { leading: secs.slice(0, 3).map(s => ({ sector: s.sector, names: s.n, threeMonthPct: r1(s.perf3m), twelveMonthPct: r1(s.perf12) })),
        lagging: secs.slice(-3).map(s => ({ sector: s.sector, names: s.n, threeMonthPct: r1(s.perf3m), twelveMonthPct: r1(s.perf12) })) },
      buyTagged: buyPool.slice(0, 8).map(s => verdictOf(s, s.liveRank, true)),
      topRanked: scope.slice(0, 6).map(lean),
      avoid: scope.filter(s => tagOf(s) === "Trim" || tagOf(s) === "Sell").map(s => lean(s)).sort((a, b) => a.score - b.score).slice(0, 6),
      weakestRanked: scope.slice(-3).map(lean),
    };

    const pf = FD.portfolio.all().map(e => ({ ...e, s: FD.get(e.t) })).filter(e => e.s);
    if (pf.length) {
      const vals = pf.map(e => ({ ...e, mv: e.s.metrics.price * e.qty, cost: e.avg * e.qty }));
      const total = vals.reduce((a, e) => a + e.mv, 0);
      const held = FD.basket(FD.stocks.filter(s => pf.some(e => e.t === s.t)), 252);
      const bySec = vals.reduce((o, e) => { o[e.s.sector] = (o[e.s.sector] || 0) + e.mv; return o; }, {});
      f.holdings = {
        count: vals.length, value: r1(total), currencies: [...new Set(vals.map(e => e.s.currency))].join(", "),
        exitRule: "Sell or Trim means reduce or leave. Hold or Weak watch means keep it, add nothing. Buy means the rules still favour owning it. Each row's stop is the price at which the trend rule says the reason for owning the name has gone.",
        positions: vals.map(e => ({ ...verdictOf(e.s, rankOf(e.t), true), qty: e.qty, avgCost: r1(e.avg),
          value: r1(e.mv), weightPct: r1(e.mv / total * 100), plPct: r1((e.mv / e.cost - 1) * 100) })),
        sectorConcentration: Object.entries(bySec).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([sec, v]) => ({ sector: sec, pct: r1(v / total * 100) })),
        measured: held ? { names: held.n, totalReturnPct: r1(held.total), annualisedPct: r1(held.ann),
          volatilityPct: r1(held.vol), worstDrawdownPct: r1(held.mdd), avgPairwiseCorr: r2(held.corr) } : null,
      };
    } else {
      f.holdings = { count: 0, note: "The portfolio is empty — nothing is held, so there is no exit to advise on and no concentration to measure. Point at proposedAllocation instead." };
    }

    const wl = Object.keys(FD.watchlist.all());
    if (wl.length) f.watchlist = { count: wl.length, names: wl.slice(0, 12).map(t => {
      const s = FD.get(t);
      return s ? { t, rank: Math.round(rankOf(t)), tag: tagOf(s) } : { t, note: "no longer in the tracked universe" }; }) };

    const fm = (location.hash.match(/#\/stock\/([\w.\-]+)/) || [])[1];
    const focus = fm && FD.get(fm);
    if (focus) {
      const pts = FD.points(focus);
      f.focusStock = { ...verdictOf(focus, rankOf(focus.t), true),
        factors: Object.entries(focus.factors).map(([k, v]) => `${k} ${Math.round(v)}`).join(", "),
        mcapBn: r1(focus.metrics.mcap), netDebtEq: r1(focus.metrics.netDebtEq), peg: r2(focus.metrics.peg),
        payout: r1(focus.metrics.payout), fScore: focus.metrics.fScore, shortPct: r1(focus.metrics.shortPct),
        revGrowth: r1(focus.metrics.revG), epsGrowth: r1(focus.metrics.epsGrowth), fcfYield: r1(focus.metrics.fcfYield),
        from52wHighPct: r1(FD.signals(focus).fromHi), stockType: focus.type,
        nextEarnings: focus.nextEarnings ? new Date(focus.nextEarnings).toISOString().slice(0, 10) : null,
        positives: pts.bull.slice(0, 4), negatives: pts.bear.slice(0, 4), watchItems: pts.watch.slice(0, 3),
        measuredDrivers: (FD.stockDrivers(focus).rows || []).slice(0, 5).map(d => ({ relationship: d.name, measured: d.num })) };
      f.focusPeers = FD.stocks
        .filter(s => s.sector === focus.sector && s.t !== focus.t && s.metrics.perf3m != null)
        .sort((a, b) => b.metrics.perf3m - a.metrics.perf3m).slice(0, 3)
        .map(s => ({ t: s.t, name: s.name, threeMonthPct: r1(s.metrics.perf3m), rank: Math.round(rankOf(s.t)) }));
    }

    f.evidence = FD.bt ? {
      tested: `${FD.bt.from} to ${FD.bt.to}, ${FD.bt.rebalances} monthly rebalances, ${FD.bt.universe} names, ${FD.bt.costBps}bp cost per leg`,
      caveat: FD.bt.caveat,
      legs: (FD.bt.legs || []).map(l => { const h = (l.horizons || [])[1] || (l.horizons || [])[0] || {};
        return { rule: l.label, topBasketPct: h.top, universePct: h.uni, excessPct: h.excess, tStat: h.t,
          hitRatePct: h.hit, bottomBasketExcessPct: h.botExcess }; }),
      factorDeciles: FD.decileTable().map(d => ({ decile: d.decile, twelveMonthPerfPct: r1(d.perf), names: d.n })),
    } : { note: "The point-in-time backtest has not been run in this session, so quote no historical rule performance. The user can run it on the Evidence page." };
    /* Groq's rate tier refuses an over-large request outright, so the payload is held to a budget
       by shedding the least decision-critical blocks. What was shed is named inside the facts, so
       the answer can say the detail was missing instead of quietly inventing one. */
    const BUDGET = 15000, shed = [], size = () => JSON.stringify(f).length;
    const drops = [
      ["the factor decile table", () => delete f.evidence.factorDeciles],
      ["the weakest-ranked names", () => delete f.weakestRanked],
      ["the top-ranked list", () => delete f.topRanked],
      ["the watchlist", () => delete f.watchlist],
      ["the peer comparison", () => delete f.focusPeers],
      ["the stock's own reason lists", () => { if (f.focusStock) { delete f.focusStock.measuredDrivers; delete f.focusStock.positives; delete f.focusStock.negatives; delete f.focusStock.watchItems; } }],
      ["the backtest legs", () => delete f.evidence.legs],
      ["part of the avoid list", () => { f.avoid = f.avoid.slice(0, 3); }],
      ["buy reasoning beyond five names", () => { f.buyTagged = f.buyTagged.slice(0, 5).map(v => { delete v.bull; delete v.bear; return v; }); }],
      ["allocation beyond eight positions", () => { if (f.proposedAllocation) f.proposedAllocation.positions = f.proposedAllocation.positions.slice(0, 8); }],
      ["holdings beyond eight positions", () => { if (f.holdings.positions) { f.holdings.positions = f.holdings.positions.slice(0, 8).map(v => { delete v.bull; delete v.bear; return v; }); } }],
    ];
    for (const [label, fn] of drops) { if (size() <= BUDGET) break; fn(); shed.push(label); }
    if (shed.length) f.shedDetail = `Left out of this request to fit the model's size limit: ${shed.join(", ")}. If the question needed one of those, say the detail is not in front of you rather than filling the gap.`;
    return f;
  }
  function bubble(m, i) {
    const div = document.createElement("div");
    div.className = "c-msg " + (m.role === "user" ? "c-user" : "c-ai");
    const time = new Date(m.at || Date.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const del = `<button class="c-del" data-del="${i}">delete</button>`;
    if (m.role === "assistant") {
      const copy = `<button class="c-copy" data-copy="${i}">copy</button>`;
      div.innerHTML = `<span class="c-ava" aria-hidden="true">${MARK}</span><div class="c-col">`
        + `<span class="c-who">FactorDesk</span>`
        + `<div class="c-body"><div class="c-ans">${relink(md(m.content))}</div></div>`
        + `<div class="c-meta"><span class="c-model">${esc(shortModel(m.model))}</span> · from the measured facts only · ${time} · ${copy} · ${del}</div></div>`;
    } else {
      div.innerHTML = `<div class="c-body"><p class="c-para">${esc(m.content)}</p></div>`;
    }
    return div;
  }
  function wireMsg(scope) {
    scope.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { const x = hist(); x.splice(+b.dataset.del, 1); save(x); draw(); });
    scope.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => {
      const txt = (hist()[+b.dataset.copy] || {}).content || "";
      const ok = () => { b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok).catch(() => { b.textContent = "copy failed"; setTimeout(() => { b.textContent = "copy"; }, 1600); });
      else { b.textContent = "copy failed"; setTimeout(() => { b.textContent = "copy"; }, 1600); }
    });
    scope.querySelectorAll("[data-pick]").forEach(a => a.onclick = () => { if (window.innerWidth <= 760) setOpen(false); });
    scope.querySelectorAll("[data-entry-ticker]").forEach(b => b.onclick = () => {
      const shown = FD.showEntryMarker(b.dataset.entryTicker, b.dataset.entryPrice);
      if (!shown) {
        b.disabled = true;
        b.textContent = "Entry reference unavailable";
        return;
      }
      if (window.innerWidth <= 760) setOpen(false);
    });
  }
  /* the answer arrives as one block (a reasoning model), so it is revealed paragraph-by-paragraph
     with a caret to feel live — relink keeps tickers clickable exactly as the final render does */
  function reveal(stream, fullHtml, done) {
    const tmp = document.createElement("div"); tmp.innerHTML = fullHtml;
    const nodes = Array.prototype.slice.call(tmp.childNodes);
    stream.innerHTML = '<span class="c-caret"></span>';
    let i = 0;
    (function step() {
      const caret = stream.querySelector(".c-caret");
      if (i < nodes.length) { stream.insertBefore(nodes[i++], caret); log.scrollTop = log.scrollHeight; setTimeout(step, 70); }
      else { if (caret) caret.remove(); done && done(); }
    })();
  }
  function renderAssistant(text, model, done) {
    const div = document.createElement("div");
    div.className = "c-msg c-ai";
    div.innerHTML = `<span class="c-ava" aria-hidden="true">${MARK}</span><div class="c-col"><span class="c-who">FactorDesk</span>`
      + `<div class="c-body"><div class="c-ans"><div class="c-stream"></div></div></div>`
      + `<div class="c-meta"><span class="c-model">${esc(shortModel(model))}</span> · from the measured facts only</div></div>`;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
    reveal(div.querySelector(".c-stream"), relink(md(text)), done);
  }
  function draw() {
    const h = hist();
    log.innerHTML = "";
    if (!h.length) {
      const w = document.createElement("div");
      w.className = "c-welcome";
      w.innerHTML = `<div class="c-welcome-kicker"><span></span> YOUR RESEARCH DESK</div>`
        + `<h4 class="c-greet">Make sense of<br>the market.</h4>`
        + `<p class="c-sub">Ask about a company, compare opportunities or put your portfolio in context. Every answer is grounded in the live figures on this screen.</p>`
        + `<div class="c-welcome-note"><span class="c-note-mark">i</span><span>No invented figures. No buy-call hype. Just the numbers, explained.</span></div>`;
      log.appendChild(w);
    } else h.forEach((m, i) => log.appendChild(bubble(m, i)));
    wireMsg(log);
    log.scrollTop = log.scrollHeight;
    $("#chat-clear").disabled = !h.length;
  }

  async function ask(text) {
    text = String(text || "").trim();
    if (busy || !text) return;
    if (FD.source !== "live") { push("assistant", "No live data is loaded, so there is nothing to reason about. Start the feed with `node server.js` — FactorDesk will not answer from invented numbers."); draw(); return; }
    push("user", text); draw();
    busy = true; $("#chat-send").disabled = true; dock.classList.add("c-busy");
    const thinking = document.createElement("div");
    thinking.className = "c-msg c-ai";
    thinking.innerHTML = '<span class="c-ava" aria-hidden="true">' + MARK + '</span><div class="c-col"><span class="c-who">FactorDesk</span><div class="c-body"><p class="c-para c-typing"><span>Thinking</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></p></div></div>';
    log.appendChild(thinking); log.scrollTop = log.scrollHeight;
    let out;
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: hist().slice(-12).map(m => ({ role: m.role, content: m.content })),
          facts: buildFacts(text) }),
      });
      out = await res.json().catch(() => ({}));
    } catch (e) { out = { error: "the server did not answer: " + e.message }; }
    thinking.remove();
    if (out.error) {
      busy = false; dock.classList.remove("c-busy"); $("#chat-send").disabled = false;
      push("assistant", (out.needsKey ? "The assistant is switched off — no Groq key is configured in .env. " : "") + out.error);
      draw(); input.focus(); return;
    }
    const answer = out.text || "(the model returned no text — press Ask again)";
    renderAssistant(answer, out.model, () => {
      const h = hist(); h.push({ role: "assistant", content: answer, at: Date.now(), model: out.model }); save(h);
      draw();
      busy = false; dock.classList.remove("c-busy"); $("#chat-send").disabled = false; input.focus();
    });
  }

  function setOpen(v) {
    open = v;
    dock.hidden = !v;
    fab.classList.toggle("on", v);
    fab.setAttribute("aria-expanded", String(v));
    if (v) { syncChips(); draw(); input.focus(); }
  }
  function syncChips() {
    const market = FD.marketName();
    const fm = (location.hash.match(/#\/stock\/([\w.\-]+)/) || [])[1];
    const pfN = FD.portfolio.all().length;
    const qs = fm ? [
      [`Review ${fm}`, `Is ${fm} a buy, hold or sell right now?`, "Signal, strengths & risks"],
      ["Exit conditions", `What would make me get out of ${fm}?`, "Know what could change the view"],
      ["Find top ideas", `What should I buy in ${market === "Global" ? "this universe" : "this market"}?`, "Highest-ranked names right now"],
      ["Build a basket", "Split 10,000 across the strongest names here", "A measured, diversified allocation"],
    ] : [
      ["Find top ideas", `What should I buy in ${market === "Global" ? "this universe" : "this market"}?`, "Highest-ranked names right now"],
      ["Build a basket", "Split 10,000 across the strongest names here", "A measured, diversified allocation"],
      ["Check diversification", "How do I diversify without diluting the idea?", "Explore sector & country exposure"],
      [pfN ? "Review my holdings" : "Find names to avoid", pfN ? "Should I trim or sell anything I hold?" : "Which names should I avoid, and why?", pfN ? "See what may need attention" : "Understand the risks behind the ranks"],
    ];
    chips.innerHTML = qs.map(([label, q, hint]) => `<button class="c-chip" data-q="${esc(q)}"><span class="c-chip-title">${esc(label)}</span><span class="c-chip-hint">${esc(hint)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button>`).join("");
    chips.querySelectorAll("[data-q]").forEach(b => b.onclick = () => ask(b.dataset.q));
    ctxEl.textContent = `${market} · ${FD.marketList().length} names · blend ${Object.values(weights()).join("/")} · `
      + (pfN ? pfN + " holdings" : "no holdings") + (fm ? " · viewing " + fm : "");
    const live = FD.source === "live";
    if (dotEl) dotEl.classList.toggle("off", !live);
    if (statusEl) statusEl.textContent = live ? "Online now" : "Feed offline";
  }

  const autoGrow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 150) + "px"; };
  fab.onclick = () => setOpen(!open);
  $("#chat-close").onclick = () => setOpen(false);
  const maxBtn = $("#chat-max");
  if (maxBtn) maxBtn.onclick = () => { const wide = dock.classList.toggle("wide"); maxBtn.title = wide ? "Shrink assistant" : "Expand to full screen"; if (wide) input.focus(); };
  $("#chat-clear").onclick = () => { save([]); draw(); };
  form.onsubmit = (e) => { e.preventDefault(); const t = input.value; input.value = ""; autoGrow(); ask(t); };
  input.oninput = autoGrow;
  input.onkeydown = (e) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const t = input.value; if (t.trim()) { input.value = ""; autoGrow(); ask(t); } }
  };
  /* show which Groq model is writing, so the "powered by Groq" claim in the header is verifiable */
  function refreshStatus() {
    const el = $("#chat-powered"); if (!el) return;
    fetch("/api/ai/status").then(r => r.json()).then(s => {
      const model = String((s && s.model) || "").replace(/^openai\//, "");
      if (s && s.key) { el.textContent = model ? "Groq · " + model : "Groq"; el.title = "Answers are written by " + (model || "Groq") + " from the measured facts on this screen"; el.classList.remove("off"); }
      else { el.textContent = "Groq off"; el.title = "No Groq key on the server — the assistant cannot write answers"; el.classList.add("off"); }
    }).catch(() => { el.textContent = "Groq off"; el.classList.add("off"); });
  }
  refreshStatus();
  document.addEventListener("hashchange", () => { if (open) syncChips(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) { setOpen(false); return; }
    if (/input|select|textarea/i.test(e.target.tagName)) return;
    /* "c" for the chat, alongside the app's other single-key shortcuts (/ and [) */
    if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setOpen(!open); }
  });
  /* the context line follows the SPA as it moves between screens */
  setInterval(() => { if (open) syncChips(); }, 4000);
})();
