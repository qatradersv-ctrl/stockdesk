/* FactorDesk landing page behaviour */
(async function () {
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const root = document.documentElement;
  root.dataset.theme = FD.store.get("theme", "light");
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.onclick = () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    FD.store.set("theme", next);
    drawDeciles();
  };

  let feedOk = true;
  try { await FD.loadLive(); } catch { feedOk = false; FD.source = "error"; }
  FD.renderTape(document.getElementById("tape"));

  const statEl = document.getElementById("stat-universe");
  statEl.textContent = feedOk ? FD.stocks.length.toLocaleString() : "feed down";
  const srcNote = document.querySelector(".hero-points");
  if (srcNote && feedOk) {
    const li = document.createElement("li");
    const paint = (macroN) => { li.textContent = `✓ Delayed snapshot: ${FD.stocks.length} real stocks${macroN ? " + " + macroN + " macro instruments" : ""} (${FD.dataSrc})`; };
    paint(0); srcNote.appendChild(li);
    FD.loadMacro().then(m => paint(m.length));
  }

  if (!feedOk) {
    document.getElementById("hero-cards").innerHTML = `<div class="card" style="grid-column:1/-1">
      <h3>No market data loaded</h3>
      <p>FactorDesk refuses to show invented numbers. Run <code>node server.js</code> — it starts the yfinance datasource with it — then reload this page.</p></div>`;
    document.getElementById("demo-ticker").textContent = "Nothing to score yet";
    document.getElementById("demo-rows").innerHTML = "";
  } else {
    /* hero stock cards — live from the scoring engine */
    const top = FD.rankedWith(FD.DEFAULT_WEIGHTS);
    const picks = [top[0], top[1], top[Math.floor(top.length * 0.12)], top[top.length - 1]];
    const sparkline = (s) => {
      const values = s.closes.slice(-42).filter(Number.isFinite);
      if (values.length < 2) return "";
      const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
      const points = values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(1)},${(17 - (v - lo) / span * 15).toFixed(1)}`).join(" ");
      const positive = values[values.length - 1] >= values[0];
      return `<svg viewBox="0 0 100 18" preserveAspectRatio="none" role="img" aria-label="Recent price trend">
        <polyline points="${points}" fill="none" stroke="${positive ? "#61d492" : "#f08b8f"}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    };
    document.getElementById("hero-cards").innerHTML = picks.map(s => {
      const words = String(s.name || s.t).replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
      const initials = (words.length > 1 ? words[0][0] + words[1][0] : s.t.slice(0, 2)).toUpperCase();
      const threeMonth = s.metrics.perf3m;
      return `
      <a class="stock-card" href="app.html#/stock/${encodeURIComponent(s.t)}" aria-label="Open ${esc(s.name)} stock report">
        <div class="sc-top"><span class="sc-logo" data-fallback="${esc(initials)}"><img src="/api/logo/${encodeURIComponent(s.t)}" alt="" loading="eager" decoding="async"></span>
          <span class="sc-id"><span class="sc-ticker">${esc(s.t)}</span><span class="sc-name">${esc(s.name)}</span></span>
        </div>
        <div class="sc-tag">${esc(s.type)} · ${esc(s.sector)}</div>
        <div class="sc-scores">
          <span>Quality<b>${Math.round(s.factors.quality)}</b></span>
          <span>Value<b>${Math.round(s.factors.value)}</b></span>
          <span>Momentum<b>${Math.round(s.factors.momentum)}</b></span>
          <span class="sc-rank">Rank<b>${Math.round(s.liveRank)}</b></span>
        </div>
        <div class="sc-performance">${sparkline(s)}<span>3-month change</span><b class="${threeMonth == null ? "" : threeMonth >= 0 ? "pos" : "neg"}">${FD.fmt.pct(threeMonth, 1)}</b></div>
      </a>`;
    }).join("");
    document.querySelectorAll(".sc-logo img").forEach(img => img.addEventListener("error", () => {
      const logo = img.parentElement;
      if (logo) logo.textContent = logo.dataset.fallback || "";
    }, { once: true }));

    const lead = top[0];
    document.getElementById("demo-ticker").textContent = `${lead.name} (${lead.t})`;
    document.getElementById("demo-rows").innerHTML =
      [["Quality", lead.factors.quality], ["Value", lead.factors.value], ["Momentum", lead.factors.momentum],
       ["Growth", lead.factors.growth], ["Small Cap", lead.factors.smallcap], ["FactorRank", lead.liveRank]]
        .map(([L, v]) => `<div class="peer-row"><span>${L}</span><div class="bar-track"><div class="bar-fill" style="width:${v}%"></div></div><b>${Math.round(v)}</b></div>`).join("");
  }

  /* decile evidence chart — computed from the live universe */
  function drawDeciles() {
    const host = document.getElementById("decile-chart");
    if (!FD.stocks.length) { host.innerHTML = '<p class="muted small">Needs the live feed.</p>'; return; }
    const rows = FD.decileTable();
    const max = Math.max(...rows.map(r => Math.abs(r.perf)));
    host.innerHTML = rows.map(r => `
      <div class="peer-row" style="grid-template-columns:5.5rem 1fr 4.5rem">
        <span class="muted small">D${r.decile} ${r.decile === 1 ? "(top)" : ""}</span>
        <div class="bar-track" style="height:16px"><div class="bar-fill" style="width:${Math.abs(r.perf) / max * 100}%;background:${r.perf >= 0 ? "var(--accent)" : "var(--bad)"}"></div></div>
        <span class="${r.perf >= 0 ? "pos" : "neg"}" style="text-align:right">${FD.fmt.pct(r.perf, 1)}</span>
      </div>`).join("");
    document.getElementById("decile-note").textContent = `Realised 12-month price change, averaged by FactorRank decile across ${FD.stocks.length} live stocks (D1 = highest-ranked; delayed Yahoo Finance data). Not a backtest — it only measures the last twelve months of one universe. Past performance is not a reliable indicator of future results.`;
  }
  drawDeciles();

  const newsHost = document.getElementById("landing-news");
  if (newsHost) {
    FD.news("stock market").then(items => {
      if (!document.getElementById("landing-news")) return;
      newsHost.innerHTML = items.length ? items.slice(0, 3).map(item => {
        const link = /^https:\/\//i.test(item.u || "") ? item.u : "#";
        const image = /^https:\/\//i.test(item.i || "")
          ? `<img src="${esc(item.i)}" alt="" loading="lazy" decoding="async">`
          : `<span class="news-placeholder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 19h18M5 16l4-5 3 3 4-7 3 4"/></svg></span>`;
        const date = item.ts ? new Date(item.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
        return `<a class="landing-news-card" href="${esc(link)}" target="_blank" rel="noopener">
          <span class="landing-news-image">${image}</span><span class="landing-news-copy">
            <span class="landing-news-meta">${esc(item.p || "Yahoo Finance")}${date ? " · " + date : ""}</span>
            <b>${esc(item.t)}</b><span class="landing-news-link">Read the source <span aria-hidden="true">↗</span></span>
          </span></a>`;
      }).join("") : `<p class="muted news-empty">No market headlines were returned by the feed just now.</p>`;
    }).catch(() => {
      newsHost.innerHTML = `<p class="muted news-empty">Market headlines are temporarily unavailable.</p>`;
    });
  }

  /* FAQ */
  const FAQ = [
    ["Is this real market data?", "Yes, and only that. Quotes, fundamentals, analyst data and a year of price history come from Yahoo Finance through the yfinance library (delayed ~15 min) across a global universe of listed companies, plus macro instruments — indices, yields, volatility, commodities, currencies and sector ETFs. London quotes are converted from pence to pounds before any ratio is taken, ROCE and interest cover are computed from filed statements rather than borrowed, and anything a company does not publish is scored neutrally instead of estimated. If the feed is unreachable the app says so and shows nothing — it will not substitute demo numbers. All figures are as-reported and unaudited."],
    ["Why transparent scoring instead of a proprietary index?", "Because you can't fix what you can't inspect. We publish every input, every percentile and every weight, and let you change the blend. A black-box score is a tip with a nicer UI."],
    ["What are Quality, Value, Momentum and Growth?", "Decades of academic finance (Fama-French, Novy-Marx, Asness, the Piotroski F-Score literature) point to the same return drivers. We rank each stock against the universe on those drivers and blend them into one FactorRank."],
    ["How is FactorRank different from the default ranking?", "It isn't a fixed number — drag the weight sliders in the screener and every ranking, insight and portfolio statistic recalculates instantly to match *your* strategy."],
    ["What does the Analysis page actually add?", "One screen that answers \"what is the market doing and why should I care\": trend breadth, the volatility regime, the yield level that discounts every valuation, sector rotation, the fastest movers and live headlines — each stated with the number behind it. Optionally, a Groq-powered plain-English write-up that is only allowed to reuse the figures on the page."],
    ["Do I need an account?", "No. Watchlists, portfolios and your weight blend persist in your browser's local storage. Nothing leaves your machine except the numbers you ask to have explained."],
    ["Is any of this investment advice?", "No. Everything here is educational. Prices are delayed, fundamentals are unaudited and the rule-based points are arithmetic, not foresight. Past performance is not a reliable indicator of future results. Do your own research or consult a qualified adviser."],
    ["Which metrics can I screen on?", "Country, sector, market cap, P/E, ROCE, dividend yield, health score and 12-month performance — plus every factor score itself. More filters ship as the formula list grows."],
    ["Why free?", "Screening tools commoditised years ago; the paywalls on them are marketing, not cost. FactorDesk is a demonstration of what an open research desk looks like when nothing is proprietary except the discipline."],
  ];
  document.getElementById("faq-list").innerHTML = FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("");
})();
