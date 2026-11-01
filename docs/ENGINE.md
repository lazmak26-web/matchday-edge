# LuciBet prediction engine (server-side, additive)

Modules in `engine/`: `poisson` (Poisson + Dixon-Coles), `elo` (from real finished results), `prematch`, `live`, `upset`, `validate`, `decision` (BET / NO BET), `metrics` (Brier, LogLoss, calibration/ECE, ROI, CLV).

Rules: missing inputs => `null`; xG that the server filled with league averages or h2h guesses (`xgSource` `league-avg`/`h2h`) is refused; NO BET is the default.
Commands: `npm test` (22 tests incl. extreme matches), `npm run evaluate` (model vs market baseline on real finished matches in `data/history.json`).
Known limits: Elo is computed but not yet blended into `p`; `rho=-0.08` and live red-card factors are assumptions, to be tuned/validated with `evaluate` once enough history exists (>=100 matches); CLV needs closing odds that history does not store yet.
Legacy browser `Engine` and the Value Board are unchanged. New route: `GET /api/engine/predictions` (Pro only).
`.claude/` contains a selected subset of Everything Claude Code (MIT, github.com/affaan-m/everything-claude-code): agents planner, architect, tdd-guide, code-reviewer, security-reviewer, silent-failure-hunter; skills tdd-workflow, security-review, api-design, backend-patterns, verification-loop.
