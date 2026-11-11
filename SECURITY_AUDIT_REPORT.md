# Security Audit Report — Matchday Edge / LuciBet

**Date:** 2026-11-11
**Scope:** the whole repository on branch `claude/eager-turing-g4qrt1` (base commit `a0588f3`): `server.js`, `demo-arena.js`, `presence.js`, `oddsapi.js`, `status.js`, `matching.js`, `fdstats.js`, `engine/*`, `worker.js` (Cloudflare Worker), `public/*` (front end), `Dockerfile`, dependency manifest, git history.
**Method:** manual code review of every server route and every front-end HTML sink, dependency audit, secret scan of the full git history, local SAST, HTTP-level regression tests against a running server, and a headless-browser check.
**Out of scope / not done:** no testing against the production deployment, its hosting dashboard (Railway), DNS, TLS configuration or Cloudflare settings. No DAST crawler (OWASP ZAP) was run. Those systems were not reachable or not authorized from this environment.

> This report does **not** claim the application is fully secure. It lists what was checked, what was fixed and proven fixed by a test, and what is still open.

---

## 1. Executive summary

The application had already been through serious security work: session tokens are random 256-bit values stored only as SHA-256 hashes, admin and license secrets are compared in constant time, there are per-IP and per-account rate limits, email OTP protects the admin role, every front-end render path escapes data, the virtual-credit wallet uses integer cents and a synchronous validate-then-deduct step, and there is a strict set of security headers.

The audit found **no Critical issues** and **no SQL injection, RCE, path traversal, SSRF to internal hosts, IDOR or privilege escalation** in the current code. It found and fixed **7 issues** (1 Medium-High, 3 Medium, 3 Low) plus 1 functional regression, and documents **9 open items** that need an owner decision or infrastructure access.

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| F-01 | **Medium-High** | Unpinned third-party script (Chart.js from jsDelivr, no version, no SRI) on a page that keeps the bearer token in `localStorage` | Fixed + tested |
| F-02 | **Medium** | A sign-up waiting for its email code could be re-registered with a different password | Fixed + tested (reproduced before fix) |
| F-03 | **Medium** | Admin image upload trusted the browser's MIME type only | Fixed + tested |
| F-04 | **Medium** | Unmaintained `multer` 1.x (upload parser) and a vulnerable transitive `ip-address` | Fixed (`npm audit`: 0) |
| F-05 | Low | Provider pagination links followed to any host, with the API key attached | Fixed |
| F-06 | Low | No audit trail for owner/admin actions (plans, license keys, uploads, posts) | Fixed + tested |
| F-07 | Low | One account could fill a post's whole comment allowance | Fixed + tested |
| F-08 | Informational | Idempotency keys such as `constructor`/`__proto__` resolved to inherited object members | Hardened + tested |
| R-01 | (regression) | Discover feed did not render (client read `likes.includes` on a number) | Fixed + browser-verified |

---

## 2. Application architecture

```
Browser (public/index.html + public/*.js, single-page app)
   │  Bearer token in localStorage ("mde:token")  —  no cookies
   ▼
Express 4 monolith (server.js, Node 20, one process)
   ├─ security headers, method guard (GET/HEAD/POST/OPTIONS), Origin check on writes, JSON body ≤ 10 kB
   ├─ in-memory rate limiters (per IP, per account), trust proxy = 1
   ├─ Auth: email+password (scrypt) + email OTP (Resend)   |   KeyAuth (third-party license login)
   ├─ Plans: free / pro (license keys, KeyAuth subscriptions, owner endpoint with ADMIN_TOKEN)
   ├─ Admin dashboard (role = ADMIN_EMAIL + verified + OTP enabled)
   ├─ Discover feed (admin posts + image upload, user likes/comments)
   ├─ Demo Arena (demo-arena.js): virtual-credit predictions, wallet, settlement, admin config
   ├─ Presence globe (presence.js): heartbeat, approximate geo (geoip-lite)
   └─ Data feeds: football-data.org, Bzzoiro, The Odds API, SportsAPIPro, TheSportsDB, KeyAuth (all outbound HTTPS, fixed hosts)
Storage: JSON files on a persistent disk (users, sessions, licenses, discover, demo-arena, history, uploads/) written atomically with mode 0600
Cloudflare Worker (worker.js): optional read-only fixtures proxy, origin allow-list, fail-closed
Deployment: Dockerfile (node:20-alpine, non-root user), hosted on Railway
```

**No SQL database, no real-money payments, no payment webhooks.** "Pro" is granted by license keys, KeyAuth subscriptions or the owner endpoint. The Demo Arena uses virtual credits only (no deposits, no withdrawals).

### Attack surface (all routes)

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register`, `/login`, `/verify-otp`, `/resend-otp` | none | rate limited per IP + per account |
| `GET /api/auth/verify`, `POST /api/auth/logout` | session | |
| `GET /api/public/fixtures`, `GET /api/history`, `GET/POST /api/presence` | none | public by design |
| `GET /api/fixtures`, `/api/engine/predictions` | session + Pro | |
| `POST /api/license/activate` | session | per-account lockout |
| `GET /api/admin/users`, `/stats`, `/tracking` | session + admin | 404 for non-admins |
| `POST /api/admin/plan`, `/api/admin/license` | `x-admin-token` (ADMIN_TOKEN) | 404 when unset |
| `POST /api/upload`, `POST /api/discover`, `/api/discover/:id/delete` | session + admin | |
| `GET /api/discover`, `POST /api/discover/:id/like|dislike|comment` | session | |
| `/api/demo/*` (me, matches, predict, predictions, transactions, recover, analytics) | session | per-user limits |
| `/api/demo/admin/*` | session + admin | |
| `GET /uploads/*` | none | sandboxed CSP |

---

## 3. Findings and fixes

### F-01 — Unpinned third-party scripts (Medium-High) — FIXED

* **Where:** `public/index.html` (`loadChartLib`: `https://cdn.jsdelivr.net/npm/chart.js`), `public/live-globe.js` (cobe and Lenis from jsDelivr), CSP in `server.js` allowing `cdn.jsdelivr.net` and `cdnjs.cloudflare.com`.
* **Problem:** Chart.js was loaded as "whatever the latest npm version is", with no Subresource Integrity. The session token lives in `localStorage`, so any script that runs on the page can read it. A compromised npm release, a jsDelivr incident or a hijacked package would run with full access to every logged-in user's session, including the admin's. The CSP allow-listed the whole of jsDelivr, so *any* package on it was allowed to run.
* **Fix:** Chart.js 4.6.1 and cobe 2.0.1 (both MIT) are now pinned and self-hosted in `public/vendor/` (fetched from the npm registry). Lenis already had a local copy; the globe now reuses it. The CSP is now `script-src 'self' 'unsafe-inline'` — no third-party script origin is trusted. Privacy and cookie pages updated so they stay accurate.
* **Verification:** `tests/security.test.js` "CSP trusts no third-party script host…" (fails on the old code, passes now). A headless Chromium run confirmed: Chart.js and the globe load, **0 requests** to jsDelivr/cdnjs, **0 CSP violations**.

### F-02 — Pending sign-up could be re-registered with another password (Medium) — FIXED

* **Where:** `server.js`, `POST /api/auth/register`.
* **Problem:** With OTP on, a new account stays `verified: false` until its code is entered. A second registration of the same email replaced the stored password while the first code was still valid. Attack: the victim signs up; the attacker immediately re-registers the same address with their own password; the victim types the code from their inbox and verifies an account whose password the attacker chose. The victim is then locked out. (The attacker still cannot log in without the victim's mailbox, because login needs a fresh OTP, which limits the impact to account integrity and denial of service.)
* **Reproduced:** on the original code (with only the test mail hook added) the hijacking request returned **200**; with the fix it returns **409** `signup_pending`.
* **Fix:** while a sign-up's code is still valid, a re-registration is accepted only with the **same** password (the same person retrying gets a code re-sent); a different password is refused. The check is repeated after the async password hash so two parallel sign-ups cannot race past it. When a stale unverified record is replaced later, its old code is deleted.
* **Verification:** `tests/security.test.js` "OTP on: a pending sign-up cannot be re-registered…", also checks that the victim's password is the one in force and the attacker's fails.
* **Test support:** OTP flows could not be tested offline before. `MAIL_API_URL` lets the tests use a local fake mail server; it is honoured **only** when `NODE_ENV=test` and only for `http://127.0.0.1:<port>/` (asserted by a test).

### F-03 — Upload trusted the browser's MIME type (Medium, admin-only) — FIXED

* **Where:** `server.js`, `POST /api/upload`.
* **Problem:** multer's `fileFilter` only checks `file.mimetype`, which the client chooses. Any bytes (HTML, SVG, scripts) could be stored as `.png`. Existing protections already limited the damage (admin-only route, random file names, `nosniff`, `sandbox` CSP on `/uploads`), so this is defence in depth against a stolen admin session or a future serving change.
* **Fix:** after saving, the first 12 bytes must match the declared type (JPEG `FF D8 FF`, PNG signature, `GIF87a/89a`, `RIFF....WEBP`); otherwise the file is deleted and the request refused (and audit-logged).
* **Verification:** tests upload HTML labelled `image/png` and GIF bytes labelled `image/jpeg` (both 400, file removed from disk) and a real PNG (200, served with `sandbox` CSP and `nosniff`); non-admins still get 404.

### F-04 — Dependencies (Medium) — FIXED

* `multer` 1.4.5-lts.2 is the end-of-life 1.x line; the maintainers ship security fixes (several DoS advisories in 2025) only in 2.x. Upgraded to `^2.0.2` (resolved 2.5.0). Same API for our use; all upload tests pass.
* `npm audit` reported a **High** in `ip-address` (via optional `geoip-lite`). Analysis: `geoip-lite` 1.4.10 lists it but never `require()`s it, so the vulnerable code was not reachable. It is now forced to the patched `^10.7.6` through `overrides` (geoip-lite 2.x was not used because it needs Node 24; the image is Node 20). `geoip-lite` lookups were re-checked.
* `package-lock.json` is now committed and the Dockerfile uses `npm ci --omit=dev --ignore-scripts`, so builds use the exact audited versions and dependency install scripts cannot run (none of the current dependencies need one).
* `.dockerignore` now excludes `data/` so local builds can never bake `users.json`/`sessions.json` into an image.
* **Result:** `npm audit` → **0 vulnerabilities**.

### F-05 — Provider pagination links followed anywhere (Low) — FIXED

* **Where:** three Bzzoiro pagination loops in `server.js`.
* **Problem:** the `next` URL from the provider's JSON was fetched as-is with `Authorization: Token <BZZOIRO_API_KEY>`. A compromised or malicious response could point it at another host and collect the key.
* **Fix:** `bzzNextUrl()` follows a link only when its origin is exactly `https://sports.bzzoiro.com`.
* **Verification:** code review; existing feed tests still pass. (No test against the live provider.)

### F-06 — No audit trail for privileged actions (Low) — FIXED

* **Fix:** `auditLog()` writes one JSON line (`AUDIT {...}`) to stdout, collected by the host's logs, for: owner plan changes, license key creation (count/days/note, never the keys), license activation, rejected `ADMIN_TOKEN` attempts, uploads and rejected uploads, Discover posts and deletions. No secrets are logged. The Demo Arena already had its own audit log.
* A startup warning is printed when `ADMIN_TOKEN` is shorter than 32 characters.
* **Verification:** tests assert the `upload` and `discover_post` audit lines.

### F-07 — Comment flooding (Low) — FIXED

* **Problem:** each Discover post accepts 200 comments in total; a single free account could post all 200 and close the thread for everyone.
* **Fix:** at most 10 comments per account per post. **Verification:** test (10 accepted, 11th → 429, another account still accepted).

### F-08 — Prototype-named idempotency keys (Informational) — HARDENED

* **Where:** `demo-arena.js`, `DemoStore.place()`.
* **Problem:** `w.idem[requestId]` with `requestId = "constructor"` read the inherited `Object` function; `"__proto__"` could not be stored. No balance impact was found (the test also passes on the old code), but the lookup was wrong by construction.
* **Fix:** own-property checks only; `__proto__` is ignored as an idempotency key. **Verification:** unit test incl. ledger check (sum of transactions = balance).

### R-01 — Discover feed regression (functional) — FIXED

An earlier privacy fix made the server send like/dislike **counts** instead of voter lists, but the client still called `p.likes.includes(...)`, which throws on a number: the feed never rendered. The client now uses the counts plus `isLiked`/`isDisliked`. Verified in Chromium (the feed renders; HTML in post text is displayed as text, not executed).

---

## 4. Controls reviewed and found sound (no change needed)

* **Injection:** no SQL/NoSQL database; no `eval`, `new Function`, `child_process`; no file path built from request data (uploads use random names, deletes use `path.basename`). Outbound URLs are fixed hosts with `encodeURIComponent` for parameters.
* **XSS:** every `innerHTML` in `public/index.html` and `public/demo-arena.js` was checked; all user or provider data goes through `esc()`. Only server-generated hex IDs reach inline `onclick` handlers. Email addresses are restricted by a strict regex.
* **Sessions:** 256-bit random tokens, only their SHA-256 hash is stored (memory and disk, verified by a test), 7-day idle / 30-day absolute expiry, max 2 sessions per user, server-side logout. Tokens travel in the `Authorization` header, so classic cookie CSRF does not apply; writes additionally require a same-origin `Origin` when present.
* **Passwords:** scrypt with a random 16-byte salt, constant-time compare, dummy hash for unknown users (no timing oracle), 8–128 characters, concurrency-capped hashing (DoS guard). See O-03 about cost parameters.
* **Brute force:** per-IP login limit (10 / 10 min), per-account lockout (8 failures, independent of IP), OTP: 6 digits, HMAC-stored, 5 tries per code, 6 codes per hour, 10-minute expiry, single use.
* **Authorization:** admin = configured email **and** verified **and** OTP enabled (never without OTP outside tests); admin routes answer 404 to others; Pro checks on the server for fixtures, predictions and Demo Arena analytics; Demo Arena identity comes from the session only — client-sent balances, plans and results are ignored (existing tests).
* **Financial logic (virtual credits):** integer cents, validate → record → deduct in one synchronous step (no race in Node's single thread), server-side odds with a change check, stake limits, max open predictions, idempotent settlement only on verified final scores after a stability delay, voiding with refund, ledger tests.
* **License keys:** 80-bit random keys, stored hashed, single use enforced before any `await`; KeyAuth path re-checks ownership after the network call.
* **Headers:** CSP, HSTS, `nosniff`, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, `no-store` on API responses, `x-powered-by` hidden; errors never return stack traces.
* **Infrastructure in repo:** container runs as the non-root `node` user; data files are written atomically with mode `0600`; the Cloudflare Worker fails closed without `ALLOWED_ORIGINS` and hides upstream errors.
* **Secrets:** full git history (104 commits) scanned — no real credentials committed; `.env` files are git- and docker-ignored. Only test placeholders were found.

---

## 5. Security testing performed

| Activity | Tool | Result |
|---|---|---|
| Manual review of all routes, auth, admin, uploads, wallet, front-end sinks | reading the code | findings above |
| Dependency scan | `npm audit` | before: 1 high + 1 moderate → after: **0** |
| SAST | Semgrep 1.x with a local rule set (the public rule registry was blocked by this environment's network policy) | 7 hits, all false positives (feature flags compared with `'1'`, cosmetic `Math.random`) |
| Secret scan | `git log -p` over all history, regexes for common key formats | none found (gitleaks/trufflehog not installed) |
| Regression tests | `node --test` | before: 132 tests; after: **143/143 pass** (11 new) |
| Before/after proof | new tests run against the original code | 7 of the new tests fail on the old code (F-01, F-02, F-03 + F-06, F-07, mail-hook guard, and the admin-OTP test). With only the test mail hook added to the old code, the admin-OTP and wrong-code tests **pass** (those controls were already correct) and the F-02 test still fails (200 instead of 409). All pass after the fixes. |
| Browser check | Playwright + Chromium | self-hosted scripts load, 0 third-party script requests, 0 CSP violations, Discover renders, HTML escaped |

**Not available / not run:** OWASP ZAP, CodeQL, Trivy (no container runtime), gitleaks — not installed, and the environment cannot reach their registries. Nothing was run against production.

---

## 6. Open risks (not fixed — need a decision or access)

| ID | Severity | Item | Why not changed / recommendation |
|---|---|---|---|
| O-01 | Medium | **Session token in `localStorage` + `'unsafe-inline'` scripts.** Any XSS would steal sessions; CSP cannot block inline injection today. | `index.html` relies on many inline `<script>` blocks and `onclick=` attributes; removing `'unsafe-inline'` means moving them to files / `addEventListener` and using CSP nonces. Longer-term: an `HttpOnly; Secure; SameSite=Strict` session cookie (needs CSRF tokens). Escaping is currently consistent, which is what keeps this at Medium. |
| O-02 | Medium | **`trust proxy` is fixed at 1.** Correct behind exactly one proxy (Railway). If the app is ever exposed directly, or behind two proxies (e.g. Cloudflare → Railway), clients can choose their own IP via `X-Forwarded-For` and bypass every per-IP limit. | Confirm the proxy chain in production and set the hop count accordingly. Per-account lockouts still apply regardless. |
| O-03 | Low-Medium | **scrypt cost is Node's default (N=2^14, 16 MiB)**, below current OWASP guidance (N=2^17) and not Argon2id. | Raising it multiplies memory per login (×8 at 2^17, ×3 concurrent) and could crash a small container. Plan: store parameters per hash, rehash on next successful login, and size N to the container's memory (or adopt Argon2id via a native module). |
| O-04 | Low | **Default `ADMIN_EMAIL` is a real address hard-coded in `server.js` and `env.example`.** It is protected by OTP, but publishes who the admin is (phishing target). | Set `ADMIN_EMAIL` explicitly in production and remove the default afterwards. Not changed here because removing it would silently disable the current admin dashboard. |
| O-05 | Low | **Admin is single-role, email-OTP based; no TOTP/WebAuthn; no re-authentication for sensitive actions.** | Add TOTP or passkeys for the admin email and ask for a fresh OTP before admin config changes. |
| O-06 | Low | **No password reset / password change / "log out everywhere".** | Not a vulnerability, but users cannot recover from a leaked password themselves. If added: single-use, hashed, 15–30 min tokens, and revoke all sessions on change. |
| O-07 | Low | **KeyAuth API calls send the app secret and the user's password in the URL query string** (their v1.3 GET API). | Query strings can end up in proxy/provider logs. Use KeyAuth's POST form if supported. |
| O-08 | Info | **Account enumeration** on sign-up (409 "already registered"). | Common trade-off; the login path is uniform. Could reply "check your inbox" for both cases when OTP is on. |
| O-09 | Info | **`GET /api/history` is public** and includes the engine's frozen pre-match picks of finished matches. | Business decision (past results, used for the public track record). Restrict if those picks are a paid feature. |

Other notes: `index.html` links a `/solid.css` that does not exist in the repository (pre-existing 404, not security-related). Production TLS, HSTS preload, firewall, SSH, backups and Railway settings could not be inspected from here.

---

## 7. Recommended next steps

1. Deploy this branch; set `ADMIN_EMAIL` explicitly and make `ADMIN_TOKEN` ≥ 32 random characters (`openssl rand -hex 32`); set `REQUIRE_OTP=1`.
2. Confirm the proxy hop count in production (O-02).
3. Plan the scrypt/Argon2id migration with re-hash on login (O-03).
4. Remove `'unsafe-inline'` from `script-src` step by step, then consider cookie sessions (O-01).
5. Add TOTP/passkeys for the admin and a password-reset flow (O-05, O-06).
6. Add CI: `npm ci`, `npm test`, `npm audit --omit=dev`, Semgrep and gitleaks on every pull request; enable GitHub secret scanning and Dependabot.
7. Run OWASP ZAP baseline against a staging deployment (not production).
