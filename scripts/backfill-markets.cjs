/* Backfill missing major-market large caps into datasource/symbols.json.
   Every candidate is live-validated against the running server's /api/stock/<sym>
   (which hits Yahoo) BEFORE it is written, so the universe never gains a dead ticker.
   Usage:  BASE=http://127.0.0.1:3000 node scripts/backfill-markets.cjs
   Re-run is idempotent: already-present symbols are skipped, failures never written. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SYM_FILE = path.join(ROOT, "datasource", "symbols.json");
const BASE = process.env.BASE || "http://127.0.0.1:3000";

/* market label purely from the Yahoo suffix, so the report is correct even if a
   quote's country field is missing */
const SFX = { TO: "Canada", SS: "China", SZ: "China", AS: "Netherlands", ST: "Sweden",
  OL: "Norway", CO: "Denmark", HE: "Finland", SA: "Brazil", TW: "Taiwan" };
const mkt = (t) => SFX[t.slice(-2)] || t.slice(-2);

/* Curated large/liquid names per missing market. Suffixes are the Yahoo ones
   (Amsterdam .AS, Stockholm .ST, Oslo .OL, Copenhagen .CO, Helsinki .HE, B3 .SA,
   TWSE .TW, Shanghai .SS, Shenzhen .SZ, TSX .TO). Anything wrong fails validation. */
const CANDIDATES = [...new Set([
  // Canada (TSX) — banks, energy, rail, gold, insurers, telecom, industrials
  "RY.TO", "TD.TO", "BNS.TO", "BMO.TO", "CM.TO", "GWO.TO", "SHOP.TO", "ENB.TO", "CNQ.TO", "SU.TO",
  "CVE.TO", "TRP.TO", "CNR.TO", "CP.TO", "NSR.TO", "ABX.TO", "AG.TO", "CCO.TO", "SLF.TO", "MFC.TO",
  "POD.TO", "ATD.TO", "MRU.TO", "RCI.B.TO", "BCE.TO", "T.TO", "FTS.TO", "BIP.TO", "GFS.TO", "AME.TO",
  "BIPO.TO", "PBR.TO",
  // China A (Shanghai .SS / Shenzhen .SZ)
  "600519.SS", "000858.SZ", "601318.SS", "601398.SS", "601288.SS", "601939.SS", "601988.SS",
  "300750.SZ", "002594.SZ", "601857.SS", "600028.SS", "000333.SZ", "002415.SZ", "601012.SS",
  "603259.SS", "600276.SS", "000651.SZ", "600887.SS", "601888.SS", "002475.SZ", "300059.SZ",
  "600036.SS", "601166.SS", "000002.SZ", "600048.SS", "002714.SZ",
  // Netherlands (Euronext Amsterdam)
  "ASML.AS", "ING.AS", "PHIA.AS", "UNA.AS", "HEIA.AS", "ALLE.AS", "WKA.AS", "ADY.AS", "KPN.AS",
  "ASMI.AS", "NNA.AS", "AKZA.AS", "LIGHT.AS",
  // Sweden (Nasdaq Stockholm)
  "ATCO-A.ST", "AZN.ST", "ERIC-B.ST", "SEB-A.ST", "SWED-A.ST", "SNDL.ST", "SKF-B.ST", "SWEC-A.ST",
  "HUSQIB.ST", "ELUX-B.ST", "INVEST-B.ST", "SSAB-A.ST", "VOLV-B.ST", "LATO-A.ST", "HEXA-B.ST",
  "NIBE-B.ST", "ATLAS.CO",
  // Norway (Oslo)
  "EQNR.OL", "NHY.OL", "DNB.OL", "TEL.OL", "MOWI.OL", "FERD.OL", "SKEID.OL", "GOL.OL", "YAR.OL", "TOM.OL",
  // Denmark (Nasdaq Copenhagen)
  "NOVO-B.CO", "MAERSK-B.CO", "DANSKE.CO", "CARL-B.CO", "VWS.CO", "EPB.CO", "ILL.CO", "PANDORA.CO", "DLN.CO",
  // Finland (Nasdaq Helsinki)
  "NOKIA.HE", "KNEAV.HE", "KESAVARASTO.HE", "SAMPO.HE", "FORTUM.HE", "NESTE.HE", "METSO.HE", "UPM.HE", "WRT1V.HE",
  // Taiwan (TWSE)
  "2330.TW", "2317.TW", "2454.TW", "2303.TW", "2344.TW", "2633.TW", "2882.TW", "4904.TW", "3042.TW", "2353.TW",
  // Brazil (B3)
  "PETR4.SA", "VALE3.SA", "ITUB4.SA", "BBDC4.SA", "ABEV3.SA", "WEGE3.SA", "RADL3.SA", "B3SA3.SA", "PRIO3.SA", "BBAS3.SA",
])];

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" };
const existing = new Set(require(SYM_FILE).equities);

/* Fast existence check: Yahoo's lightweight chart endpoint returns meta.regularMarketPrice
   for any symbol that actually trades, and an empty result otherwise. Concurrency ~6 with a
   small jitter, because Yahoo throttles hard. This only proves the ticker resolves — the real
   universe build later pulls full fundamentals and drops whatever has nothing to show. */
async function probe(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  const px = meta && (meta.regularMarketPrice ?? meta.chartPreviousClose);
  if (!px || !isFinite(px)) throw new Error("no price");
  return { name: meta.longName || meta.shortName || "", currency: meta.currency || "" };
}

(async () => {
  const queue = CANDIDATES.filter(s => !existing.has(s));
  const skipped = CANDIDATES.length - queue.length;
  const added = [], failed = [];
  let i = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (i < queue.length) {
      const sym = queue[i++];
      try {
        const m = await probe(sym);
        added.push({ sym, country: mkt(sym), name: m.name });
        console.log(`  OK   ${sym}  ${mkt(sym)} · ${m.name || m.currency || ""}`);
      } catch (e) {
        failed.push({ sym, err: String(e.message || e) });
        console.log(`  FAIL ${sym}  ${e.message || e}`);
      }
      await new Promise(r => setTimeout(r, 120 + Math.random() * 200));
    }
  });
  await Promise.all(workers);

  if (!added.length) { console.log("\nNothing resolved — no changes written."); return; }

  const file = require(SYM_FILE);
  file.equities = [...new Set([...file.equities, ...added.map(a => a.sym)])].sort();
  fs.writeFileSync(SYM_FILE, JSON.stringify(file, null, 1) + "\n");

  const byMkt = {};
  for (const a of added) byMkt[a.country] = (byMkt[a.country] || 0) + 1;
  console.log("\n=== SUMMARY ===");
  console.log(`added ${added.length} | failed ${failed.length} | already-present ${skipped}`);
  console.log(`new universe size: ${file.equities.length} (was ${existing.size})`);
  console.log("added by market:", JSON.stringify(byMkt));
  if (failed.length) console.log("FAILED:", failed.map(f => `${f.sym}(${f.err})`).join(", "));
  console.log("\nWrote " + SYM_FILE);
})();
