/* Vercel catch-all serverless function for every /api/* route.
   It reuses FactorDesk's own HTTP handler (server.js) so the live endpoints — news, bars, stock,
   fundamentals, macro, tickers, the Groq proxy — behave exactly as they do under `node server.js`.
   The one exception is /api/universe: building all 334 names hits Yahoo once per symbol and takes
   minutes, which no serverless function may run for, so it is served from a real point-in-time
   snapshot bundled with this function. The snapshot's `src` and `asof` are passed through so the UI
   shows it honestly as a dated snapshot, never as a live stream. */
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
