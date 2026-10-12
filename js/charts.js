/* FactorDesk canvas charts — line, sparkline, radar, donut */
(function () {
  const FD = (window.FD = window.FD || {});
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function prep(canvas, h) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawEntryMarker(ctx, marker, X, Y, x1, x2, latest, minY, maxY) {
    if (!marker || !Number.isFinite(marker.value)) return;
    const y = Y(marker.value);
    const color = css("--gold");
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(X(latest), y, 4, 0, Math.PI * 2);
    ctx.fillStyle = css("--panel"); ctx.fill();
    ctx.strokeStyle = color; ctx.stroke();
    ctx.font = "10px system-ui";
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.fillText(marker.label || "Entry reference", x2 - 3, Math.max(minY + 10, Math.min(maxY - 3, y - 5)));
    ctx.textAlign = "start";
    ctx.restore();
  }

  FD.lineChart = function (canvas, dates, values, opts = {}) {
    const { ctx, w, h } = prep(canvas, opts.height || 300);
    const padL = 46, padR = 10, padT = 12, padB = 24;
    const markerValue = opts.marker && Number.isFinite(opts.marker.value) ? opts.marker.value : null;
    const all = [...values, ...(opts.overlays || []).flatMap(o => o.values.filter(v => v != null)),
      ...(markerValue == null ? [] : [markerValue])];
    const min = Math.min(...all), max = Math.max(...all);
    const X = i => padL + (i / (values.length - 1)) * (w - padL - padR);
    const Y = v => padT + (1 - (v - min) / (max - min || 1)) * (h - padT - padB);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted"); ctx.font = "11px system-ui"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = padT + (g / 4) * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      const val = max - (g / 4) * (max - min);
      ctx.fillText(val >= 100 ? val.toFixed(0) : val.toFixed(1), 4, y + 4);
    }
    const ticks = 5;
    for (let g = 0; g <= ticks; g++) {
      const i = Math.round((g / ticks) * (values.length - 1));
      if (dates[i]) ctx.fillText(FD.fmt.date(dates[i]), Math.min(X(i), w - 54), h - 6);
    }
    const up = values[values.length - 1] >= values[0];
    const col = up ? css("--accent") : css("--bad");
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, col + "44"); grad.addColorStop(1, col + "00");
    ctx.beginPath();
    values.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
    ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.lineTo(X(values.length - 1), h - padB); ctx.lineTo(X(0), h - padB); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    if (opts.markLast !== false) {
      ctx.beginPath(); ctx.arc(X(values.length - 1), Y(values[values.length - 1]), 3.2, 0, 7);
      ctx.fillStyle = col; ctx.fill();
    }
    let legendX = padL + 6;
    (opts.overlays || []).forEach(o => {
      ctx.strokeStyle = o.color; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.beginPath();
      let started = false;
      o.values.forEach((v, i) => {
        if (v == null) return;
        started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
        started = true;
      });
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = o.color; ctx.font = "10px system-ui";
      ctx.fillText(o.label, legendX, padT + 10);
      legendX += ctx.measureText(o.label).width + 12;
    });
    drawEntryMarker(ctx, opts.marker, X, Y, padL, w - padR, values.length - 1, padT, h - padB);
    ctx.font = "11px system-ui"; ctx.fillStyle = css("--muted");
    return { X, Y, min, max };
  };

  /* Candlesticks from real bars — no simulated or interpolated OHLC. A bar whose four legs are
     not all published is dropped upstream, so every candle here is a session that actually traded. */
  FD.candleChart = function (canvas, dates, b, opts = {}) {
    const n = b.c.length;
    const { ctx, w, h } = prep(canvas, opts.height || 300);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui";
    if (n < 2) {
      ctx.fillStyle = css("--muted");
      ctx.fillText("No OHLC history published for this listing.", 12, 20);
      return;
    }
    const padL = 46, padR = 10, padT = 12, padB = 24;
    const markerValue = opts.marker && Number.isFinite(opts.marker.value) ? opts.marker.value : null;
    const all = [Math.min(...b.l), ...(opts.overlays || []).flatMap(o => o.values.filter(v => v != null)),
      ...(markerValue == null ? [] : [markerValue])];
    const top = Math.max(...b.h, ...(markerValue == null ? [] : [markerValue]));
    const min = Math.min(...all), max = top;
    const X = i => padL + ((i + 0.5) / n) * (w - padL - padR);
    const Y = v => padT + (1 - (v - min) / (max - min || 1)) * (h - padT - padB);
    const spanDays = (dates[n - 1] - dates[0]) / 86400000;
    const fmtDay = (d) => d.toLocaleDateString("en-GB", spanDays > 420 ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" });
    ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted"); ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = padT + (g / 4) * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      const val = max - (g / 4) * (max - min);
      ctx.fillText(val >= 100 ? val.toFixed(0) : val.toFixed(1), 4, y + 4);
    }
    for (let g = 0; g <= 5; g++) {
      const i = Math.min(n - 1, Math.round((g / 5) * (n - 1)));
      ctx.fillText(fmtDay(dates[i]), Math.min(X(i), w - 58), h - 6);
    }
    const body = Math.max(1.5, Math.min(13, ((w - padL - padR) / n) * 0.66));
    const up = css("--good"), down = css("--bad");
    for (let i = 0; i < n; i++) {
      const yo = Y(b.o[i]), yc = Y(b.c[i]);
      const green = b.c[i] >= b.o[i];
      ctx.strokeStyle = ctx.fillStyle = green ? up : down;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(i), Y(b.h[i])); ctx.lineTo(X(i), Y(b.l[i])); ctx.stroke();
      const top_ = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      if (body > 2) ctx.fillRect(X(i) - body / 2, top_, body, bh);
      else ctx.fillRect(X(i) - body / 2, top_, Math.max(1, body), bh);
    }
    let legendX = padL + 6;
    (opts.overlays || []).forEach(o => {
      ctx.strokeStyle = o.color; ctx.lineWidth = 1.2; ctx.beginPath();
      let started = false;
      o.values.forEach((v, i) => {
        if (v == null) { started = false; return; }
        started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
        started = true;
      });
      ctx.stroke();
      ctx.fillStyle = o.color; ctx.font = "10px system-ui";
      ctx.fillText(o.label, legendX, padT + 10);
      legendX += ctx.measureText(o.label).width + 12;
      ctx.font = "11px system-ui";
    });
    drawEntryMarker(ctx, opts.marker, X, Y, padL, w - padR, n - 1, padT, h - padB);
    ctx.fillStyle = css("--muted");
    ctx.fillText(body < 2.5 ? n + " bars — too many to draw as bodies, shown as closes"
      : n + " sessions, body = open→close, wick = high/low", padL + 6, h - 6);
  };

  FD.sparkline = function (canvas, values) {
    const { ctx, w, h } = prep(canvas, canvas.clientHeight || 26);
    const min = Math.min(...values), max = Math.max(...values);
    ctx.strokeStyle = max >= min ? css("--accent") : css("--bad");
    ctx.lineWidth = 1.4; ctx.beginPath();
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * w, y = h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };

  FD.radar = function (canvas, labels, values) {
    const { ctx, w, h } = prep(canvas, 220);
    const cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) / 2 - 30;
    const n = labels.length;
    ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted"); ctx.font = "11px system-ui";
    for (let ring = 1; ring <= 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2, r = (ring / 3) * R;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.beginPath();
    values.forEach((v, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2, r = (clamp(v, 0, 100) / 100) * R;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = css("--accent") + "33"; ctx.strokeStyle = css("--accent"); ctx.lineWidth = 1.8;
    ctx.fill(); ctx.stroke();
    labels.forEach((L, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      ctx.fillStyle = css("--muted");
      ctx.textAlign = "center";
      ctx.fillText(L + " " + Math.round(values[i]), cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 14) + 4);
    });
    ctx.textAlign = "start";
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  FD.donut = function (canvas, segments, centerLabel) {
    const { ctx, w, h } = prep(canvas, 190);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6, hole = R * 0.62;
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    let a0 = -Math.PI / 2;
    const palette = ["#2dd4a7", "#38bdf8", "#a78bfa", "#fbbf24", "#fb7185", "#34d399", "#f472b6", "#60a5fa", "#c084fc", "#f59e0b"];
    segments.forEach((s, i) => {
      const a1 = a0 + (s.value / total) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.arc(cx, cy, hole, a1, a0, true); ctx.closePath();
      s.color = palette[i % palette.length];
      ctx.fillStyle = s.color; ctx.fill();
      a0 = a1;
    });
    if (centerLabel) {
      ctx.fillStyle = css("--txt"); ctx.font = "700 13px system-ui"; ctx.textAlign = "center";
      ctx.fillText(centerLabel, cx, cy + 4); ctx.textAlign = "start";
    }
  };
})();
