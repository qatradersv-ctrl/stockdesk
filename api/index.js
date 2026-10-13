/* Vercel catch-all serverless function for every route.
   vercel.json rewrites all non-static paths here ("/(.*)" -> "/api"), which preserves the original
   req.url, so this single function can reuse FactorDesk's own HTTP handler (server.js) and the live
   endpoints — news, bars, stock, fundamentals, macro, tickers, the Groq proxy — behave exactly as
   they do under `node server.js`. A file named api/[...path].js would NOT work here: Vercel's
   non-Next Functions runtime treats it as a single dynamic segment, so multi-part routes like
   /api/stock/AAPL never reach it. The one exception below is /api/universe: building all 334 names
   hits Yahoo once per symbol and takes minutes, which no serverless function may run for, so it is
   served from a real point-in-time snapshot bundled with this function. The snapshot's `src` and
   `asof` are passed through so the UI shows it honestly as a dated snapshot, never a live stream. */
const { handler } = require("../server.js");
const snapshot = require("./universe-snapshot.json");

module.exports = (req, res) => {
  const url = decodeURIComponent((req.url || "").split("?")[0]);
  if (url === "/api/universe" || url === "/api/universe/") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
    res.end(JSON.stringify({
      asof: snapshot.asof,
      count: snapshot.stocks.length,
      src: `${snapshot.src} · static snapshot`,
      stocks: snapshot.stocks,
    }));
    return;
  }
  return handler(req, res);
};
