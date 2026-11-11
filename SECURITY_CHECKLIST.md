# Security Checklist — ongoing maintenance

Use this before every release and on a regular schedule. See `SECURITY_AUDIT_REPORT.md` for background and open items.

## Every pull request
- [ ] `npm ci && npm test` passes (includes `tests/security.test.js`).
- [ ] `npm audit --omit=dev` shows no High/Critical.
- [ ] New route? It has the right guard: `authMiddleware`, `requirePro` or `requireAdmin` (admin routes answer **404** to others), plus a rate limiter.
- [ ] New input? Type, length and range are validated on the server; client-sent balances, plans, prices or results are never trusted.
- [ ] New HTML rendering? Every dynamic value goes through `esc()`; nothing user- or provider-supplied ends up in an inline `onclick`/`style`/URL without validation.
- [ ] New third-party script? Do not load it from a CDN: pin the version and self-host it in `public/vendor/` (the CSP allows only `'self'`).
- [ ] New outbound request? Fixed host, `encodeURIComponent` for parameters, timeout set, API keys never sent to a host taken from a response.
- [ ] New privileged action? Call `auditLog()` (never with secrets).
- [ ] No secrets, `.env` files or `data/` files in the diff.

## Every release / deploy
- [ ] `NODE_ENV=production`, `REQUIRE_OTP=1`, `RESEND_API_KEY` set (otherwise the admin dashboard is refused by design).
- [ ] `ADMIN_EMAIL` set explicitly; `ADMIN_TOKEN` ≥ 32 random characters (or unset when not needed — the owner endpoints then answer 404).
- [ ] `ADMIN_ALLOW_NO_OTP` and `MAIL_API_URL` are **not** set in production.
- [ ] Data files (`USERS_FILE`, `LICENSES_FILE`, sessions, discover, demo-arena, uploads) are on a persistent disk that is not publicly served.
- [ ] Start-up log shows no `ADMIN_TOKEN is shorter…` or `DATA FOLDER NOT WRITABLE` warnings.
- [ ] Response headers on `/` include CSP, HSTS, `nosniff`, `X-Frame-Options: DENY`.
- [ ] Proxy chain unchanged (one proxy → `trust proxy 1`). If Cloudflare or another proxy is added in front, update the hop count.

## Monthly
- [ ] `npm outdated` / `npm audit`; update `express`, `multer`, `geoip-lite` and re-run tests.
- [ ] Re-check the `ip-address` override in `package.json` is still needed / still the patched line.
- [ ] Review `AUDIT` lines in the host logs: unexpected `admin_token_rejected`, `upload_rejected`, plan or license changes.
- [ ] Review the Demo Arena admin audit log and settlement failures.
- [ ] Remove stale Pro grants and unused license keys.
- [ ] Rotate `ADMIN_TOKEN`; rotate provider keys if anyone with access has left.

## Quarterly
- [ ] Back up and test a restore of the data folder (users, licenses, sessions, demo arena).
- [ ] Run OWASP ZAP baseline against **staging**, plus Semgrep and gitleaks over the repository.
- [ ] Review the open risks table in `SECURITY_AUDIT_REPORT.md` (unsafe-inline, cookie sessions, scrypt cost, admin 2FA, password reset).
- [ ] Update vendored front-end libraries in `public/vendor/` (Chart.js, cobe, Lenis, GSAP) from the npm registry and note versions in `public/vendor/NOTICE.txt`.

## If a secret leaks
1. Rotate it at the provider first (KeyAuth, Resend, football-data, Bzzoiro, Odds API, SportsAPIPro, `ADMIN_TOKEN`).
2. Update the hosting environment variables and redeploy.
3. If the admin account may be affected: delete `sessions.json` entries for it (or all sessions) and restart.
4. Removing a secret from git history does not make it safe — rotation does.
