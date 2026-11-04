# LuciBet prediction engine (server-side, additive)

Modules in `engine/`: `poisson` (Poisson + Dixon-Coles), `elo` (from real finished results), `prematch`, `upset`, `validate`, `decision` (BET / NO BET), `metrics` (Brier, LogLoss, calibration/ECE, ROI, CLV).

Rules: missing inputs => `null`; xG that the server filled with league averages or h2h guesses (`xgSource` `league-avg`/`h2h`) is refused; NO BET is the default.
Commands: `npm test` (22 tests incl. extreme matches), `npm run evaluate` (model vs market baseline on real finished matches in `data/history.json`).
Known limits: `rho=-0.08` is an assumption, to be tuned/validated with `evaluate` once enough history exists (>=100 matches); CLV needs closing odds that history does not store yet.
Legacy browser `Engine` and the Value Board are unchanged. New route: `GET /api/engine/predictions` (Pro only).
`.claude/` contains a selected subset of Everything Claude Code (MIT, github.com/affaan-m/everything-claude-code): agents planner, architect, tdd-guide, code-reviewer, security-reviewer, silent-failure-hunter; skills tdd-workflow, security-review, api-design, backend-patterns, verification-loop.

## Stage 2
- History rows now keep `openOdds` (odds first seen before kickoff, frozen) next to `odds` (latest pre-kickoff = closing). `npm run evaluate` uses them for CLV.
- Elo blend exists (`eloWeight`, default 0 = off, max 0.5). Evaluate builds Elo only from matches before each match (no look-ahead).
- The Value Board still uses the legacy browser model. Switch only if the blend's Brier beats market-only on >=100 real matches.

## Stage 3 (odds aggregation)
- `engine/odds.js` (also served to the browser at `/odds-core.js`): per-book de-vig, outlier filter (robust 2-sigma around the median, needs >=4 books), sharpness-weighted consensus (sharp 0.50 / mid 0.25 / recreational 0.15), best price per outcome from surviving books, Kelly (full + quarter, full capped at 10%).
- `prematch.market()` and `decision.bestPrices()` use it (with <4 books the old median caps still apply). Picks now carry `kelly:{full,quarter}`.
- `oddsapi.js`: The Odds API as a second source, 1 credit per league call, cached, daily cap + reserve. Optional (`ODDS_API_KEY`).
