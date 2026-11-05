/* Odds aggregation core. Pure functions, no I/O. Works in Node (require) and in the browser (window.OddsCore).
 *   1. de-vig every bookmaker on its own            (fair prob = (1/o) / sum(1/o))
 *   2. drop stale / erroneous prices                (robust z-score > 2 around the median)
 *   3. sharpness-weighted consensus                 (Pinnacle & co count more than recreational books)
 *   4. best price per outcome (line shopping), taken only from books that survived step 2
 * Missing data stays null. Nothing is invented. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OddsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const isNum = x => typeof x === 'number' && isFinite(x);
  const ok = x => isNum(x) && x > 1;

  // Weight by bookmaker "sharpness" (how much its price reflects real money, not recreational margin).
  // Matching is on a lowercase alphanumeric key, so "Pinnacle", "pinnacle" and "Betfair Exchange" all resolve.
  const SHARP = 0.5, MID = 0.25, REC = 0.15;
  const TIERS = [
    [/pinnacle|sbobet|matchbook|smarkets|betfairex|betfairexchange|betcris|circa|singbet|isn/, SHARP],
    [/marathon|1xbet|betsson|nordic|coolbet|unibet|williamhill|betfairsb/, MID],
  ];
  const key = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function weightOf(book) {
    const k = key(book);
    for (const [re, w] of TIERS) if (re.test(k)) return w;
    return REC;   // unknown or recreational (bet365, DraftKings, ...) and aggregated feeds such as "Bzzoiro"
  }

  const median = a => { const x = a.slice().sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };

  // Robust "2 standard deviations": sample SD is useless with few books (with n=5 no point can exceed 1.79 SD),
  // so use median +/- 1.4826*MAD, with a floor of 4% of the median so that identical prices do not give sigma = 0.
  // Needs at least 4 books, otherwise nothing can be judged an outlier.
  function outlierMask(values, zMax = 2, minN = 4) {
    const n = values.length, mask = new Array(n).fill(false);
    if (n < minN) return mask;
    const m = median(values), sigma = Math.max(1.4826 * median(values.map(v => Math.abs(v - m))), 0.04 * m);
    values.forEach((v, i) => { if (Math.abs(v - m) / sigma > zMax) mask[i] = true; });
    return mask;
  }

  function devig(odds) {
    const inv = odds.map(o => 1 / o), s = inv.reduce((a, b) => a + b, 0);
    return { fair: inv.map(x => x / s), margin: s - 1 };
  }

  /* consensus(books) -> null | {
   *   fair:{h,d,a}, ou:{over,under}|null, margin, n, used:[book], dropped:[{book,reason}],
   *   best:{home:{odds,book},draw:{...},away:{...},over:{...}|null,under:{...}|null} } */
  function consensus(books, opts = {}) {
    const zMax = isNum(opts.zMax) ? opts.zMax : 2;
    const all = (Array.isArray(books) ? books : []).filter(b => b && ok(b.home) && ok(b.draw) && ok(b.away));
    if (!all.length) return null;
    const dropped = [], bad = new Set();
    for (const k of ['home', 'draw', 'away']) {
      const mask = outlierMask(all.map(b => b[k]), zMax);
      mask.forEach((m, i) => { if (m && !bad.has(i)) { bad.add(i); dropped.push({ book: all[i].book || 'unknown', reason: `${k} price ${all[i][k]} is an outlier vs the median` }); } });
    }
    const kept = all.filter((_, i) => !bad.has(i));
    if (!kept.length) return null;
    let h = 0, d = 0, a = 0, wSum = 0, margin = 0;
    for (const b of kept) {
      const w = weightOf(b.book), v = devig([b.home, b.draw, b.away]);
      h += w * v.fair[0]; d += w * v.fair[1]; a += w * v.fair[2]; margin += w * v.margin; wSum += w;
    }
    const best = { home: null, draw: null, away: null, over: null, under: null };
    for (const k of ['home', 'draw', 'away']) for (const b of kept) if (!best[k] || b[k] > best[k].odds) best[k] = { odds: b[k], book: b.book || 'unknown' };
    // Over/Under 2.5, same weighting (books without totals are simply absent from it)
    const ouAll = (Array.isArray(books) ? books : []).filter(b => b && ok(b.over25) && ok(b.under25));
    let ou = null;
    if (ouAll.length) {
      const mk = outlierMask(ouAll.map(b => b.over25), zMax), ouKept = ouAll.filter((_, i) => !mk[i]);
      if (ouKept.length) {
        let o = 0, ws = 0;
        for (const b of ouKept) { const w = weightOf(b.book); o += w * devig([b.over25, b.under25]).fair[0]; ws += w; if (!best.over || b.over25 > best.over.odds) best.over = { odds: b.over25, book: b.book || 'unknown' }; if (!best.under || b.under25 > best.under.odds) best.under = { odds: b.under25, book: b.book || 'unknown' }; }
        ou = { over: o / ws, under: 1 - o / ws };
      }
    }
    return { fair: { h: h / wSum, d: d / wSum, a: a / wSum }, ou, margin: margin / wSum, n: kept.length, used: kept.map(b => b.book || 'unknown'), dropped, best };
  }

  // Kelly on the blended probability. Returns fractions of bankroll (0 when there is no edge). `cap` limits full Kelly (default 10%).
  function kelly(p, odds, cap = 0.1) {
    if (!isNum(p) || !ok(odds)) return null;
    const b = odds - 1, f = Math.max(0, (p * b - (1 - p)) / b), full = Math.min(f, cap);
    return { full, quarter: full / 4, raw: f };
  }
  const ev = (p, odds) => p * (odds - 1) - (1 - p);

  return { consensus, devig, weightOf, outlierMask, kelly, ev, median };
});
