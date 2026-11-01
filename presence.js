'use strict';
/* ═══════════════════════════════════════════════════════════
   LIVE PRESENCE  (feeds the landing-page globe)
   - Browsers send a heartbeat (POST /api/presence { sid }) every ~45s.
   - The server turns the request IP into an APPROXIMATE position
     (rounded to ~10 km) and keeps only { cell, lastSeen } per session id.
   - The IP itself is never stored on a session and never sent to the browser.
   - GET /api/presence returns { online, points: [{ lat, lng, n }] }.

   Location source (first one that works):
     1. Cloudflare visitor-location headers, only if TRUST_CF_GEO=1
     2. the optional "geoip-lite" package (offline database, nothing leaves the server)
   With neither, visitors still count as "online" but no point is drawn.
   ═══════════════════════════════════════════════════════════ */

const SID_RE = /^[a-z0-9]{8,32}$/;
const TTL_MS = 2 * 60 * 1000;      // a session counts as online for 2 min after its last heartbeat
const MAX_SESSIONS = 5000;         // hard cap so the map can't be flooded
const MAX_POINTS = 300;
const WRITE_LIMIT = 20;            // heartbeats per IP per minute
const READ_LIMIT = 60;             // snapshots per IP per minute

function round1(n) { return Math.round(n * 10) / 10; }
function validLL(lat, lng) { return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180; }

function isPrivateIp(ip) {
  if (!ip) return true;
  ip = String(ip).replace(/^::ffff:/, '');
  return ip === '::1' || ip === '127.0.0.1' || /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
}

function createPresence(opts) {
  opts = opts || {};
  const lookup = typeof opts.lookup === 'function' ? opts.lookup : null;
  const trustCf = !!opts.trustCfGeo;
  const now = opts.now || Date.now;

  const sessions = new Map();      // sid -> { lat, lng, seen }  (lat/lng null when unknown)
  const hits = new Map();          // "w:ip" / "r:ip" -> count in the current minute
  setInterval(() => hits.clear(), 60 * 1000).unref();

  function limited(kind, ip, max) {
    const key = kind + ':' + (ip || 'unknown');
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n > max;
  }

  function purge() {
    const cutoff = now() - TTL_MS;
    for (const [sid, s] of sessions) if (s.seen < cutoff) sessions.delete(sid);
  }

  function locate(req) {
    if (trustCf) {
      const lat = parseFloat(req.headers['cf-iplatitude']), lng = parseFloat(req.headers['cf-iplongitude']);
      if (validLL(lat, lng)) return { lat: round1(lat), lng: round1(lng) };
    }
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    if (lookup && !isPrivateIp(ip)) {
      try {
        const r = lookup(String(ip).replace(/^::ffff:/, ''));
        if (r && Array.isArray(r.ll) && validLL(r.ll[0], r.ll[1])) return { lat: round1(r.ll[0]), lng: round1(r.ll[1]) };
      } catch (e) { /* unknown location: still counted as online */ }
    }
    return null;
  }

  function ping(req, res) {
    if (limited('w', req.ip, WRITE_LIMIT)) return res.status(429).end();
    const sid = req.body && typeof req.body.sid === 'string' ? req.body.sid : '';
    if (!SID_RE.test(sid)) return res.status(400).end();

    const known = sessions.has(sid);
    if (!known && sessions.size >= MAX_SESSIONS) {
      purge();
      if (sessions.size >= MAX_SESSIONS) return res.status(503).end();
    }
    // Location only needs resolving for a new session (or one that never had one).
    const prev = sessions.get(sid);
    const loc = prev && prev.lat !== null ? prev : locate(req);
    sessions.set(sid, { lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, seen: now() });
    res.status(204).end();
  }

  function snapshot(req, res) {
    if (limited('r', req.ip, READ_LIMIT)) return res.status(429).json({ error: 'Too many requests', online: 0, points: [] });
    purge();
    const cells = new Map();
    for (const s of sessions.values()) {
      if (s.lat === null) continue;
      const key = s.lat + ',' + s.lng;
      const c = cells.get(key);
      if (c) c.n++; else cells.set(key, { lat: s.lat, lng: s.lng, n: 1 });
    }
    const points = Array.from(cells.values()).sort((a, b) => b.n - a.n).slice(0, MAX_POINTS);
    res.json({ online: sessions.size, points });
  }

  return { ping, snapshot, _sessions: sessions };
}

module.exports = createPresence;
