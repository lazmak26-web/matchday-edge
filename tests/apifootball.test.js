'use strict';
// API-Football (optional 3rd fixtures source): mapping unit tests + an end-to-end run against local mock providers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http'), net = require('node:net'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const af = require('../apifootball');

const iso = minsFromNow => new Date(Date.now() + minsFromNow * 60000).toISOString();
const todayAt = hhmm => new Date().toISOString().slice(0, 10) + 'T' + hhmm + ':00+00:00';
const row = (id, home, away, league, extra = {}) => Object.assign({
  fixture: { id, date: extra.date || todayAt('23:00'), status: { short: extra.short || 'NS', long: '' } },
  league: Object.assign({ id: 1000 + id, name: league, country: 'England', type: 'League' }, extra.league || {}),
  teams: { home: { name: home, logo: 'https://media.api-sports.io/football/teams/1.png' }, away: { name: away, logo: 'javascript:alert(1)' } },
  goals: extra.goals || { home: null, away: null }
});

test('status mapping', () => {
  assert.strictEqual(af.mapStatus('NS'), 'notstarted');
  assert.strictEqual(af.mapStatus('2H'), 'inprogress');
  assert.strictEqual(af.mapStatus('HT'), 'inprogress');
  assert.strictEqual(af.mapStatus('PEN'), 'finished');
  assert.strictEqual(af.mapStatus('PST'), 'canceled');
});

test('toFixtures: shape, filters, priority and cap', () => {
  const rows = [
    row(1, 'Leeds', 'Hull', 'Championship'),
    row(2, 'Brazil', 'Argentina', 'World Cup - Qualification South America', { league: { country: 'World' } }),
    row(3, 'Arsenal U21', 'Chelsea U21', 'Premier League 2 Division One'),
    row(4, 'Lyon', 'Paris FC', 'Coupe de France', { short: 'PST' }),
    row(5, 'Chelsea W', 'Arsenal W', 'FA WSL'),
    row(6, 'Wigan', 'Bolton', 'League One', { short: 'FT', goals: { home: 2, away: 1 } }),
    row(7, 'Real Madrid Castilla', 'Bilbao Athletic', 'Primera División RFEF'),
    row(8, 'Bad', null, 'X'),
  ];
  const out = af.toFixtures(rows, { max: 10, only: new Set() });
  const ids = out.map(f => f.id);
  assert.ok(!ids.includes('af_3'), 'youth dropped');
  assert.ok(!ids.includes('af_4'), 'postponed dropped');
  assert.ok(!ids.includes('af_8'), 'broken row dropped');
  assert.strictEqual(ids[0], 'af_2', 'international matches first');
  const wigan = out.find(f => f.id === 'af_6');
  assert.deepStrictEqual([wigan.rawStatus, wigan.homeScore, wigan.awayScore], ['finished', 2, 1]);
  assert.strictEqual(out.find(f => f.id === 'af_5').women, true);
  const leeds = out.find(f => f.id === 'af_1');
  assert.strictEqual(leeds.league, 'England · Championship');
  assert.strictEqual(leeds.home.logo, 'https://media.api-sports.io/football/teams/1.png');
  assert.strictEqual(leeds.away.logo, null, 'only https logos are kept');
  assert.strictEqual(af.toFixtures(rows, { max: 2, only: new Set() }).length, 2, 'cap');
  assert.deepStrictEqual(af.toFixtures(rows, { max: 10, only: new Set(['1001']) }).map(f => f.id), ['af_1'], 'allow-list');
});

/* ---------- end to end ---------- */
const freePort = () => new Promise((ok, no) => { const s = net.createServer(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
let bzz, afSrv, srv, base, dir, afCalls = 0, out = '';
before(async () => {
  const bzzPort = await freePort(), afPort = await freePort(), port = await freePort();
  const kick = iso(180);
  bzz = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (/\/odds\//.test(req.url)) return res.end(JSON.stringify({ odds: { home_win: '2.10', draw: '3.30', away_win: '3.40' } }));
    res.end(JSON.stringify({ results: [{ id: 1, home_team: 'Leeds United', away_team: 'Hull City', event_date: kick, status: 'notstarted', league_id: 40 }], next: null }));
  }).listen(bzzPort, '127.0.0.1');
  afSrv = http.createServer((req, res) => {
    afCalls++;
    assert.strictEqual(req.headers['x-apisports-key'], 'test-af-key');
    res.setHeader('content-type', 'application/json'); res.setHeader('x-ratelimit-requests-remaining', '97');
    res.end(JSON.stringify({ errors: [], response: [
      row(11, 'Leeds', 'Hull', 'Championship', { date: kick }),                                                   // same match as Bzzoiro
      row(12, 'Brazil', 'Argentina', 'World Cup - Qualification South America', { date: kick, league: { country: 'World' } }),
      row(13, 'Wigan', 'Bolton', 'League One', { date: kick })
    ] }));
  }).listen(afPort, '127.0.0.1');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mde-af-'));
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), HISTORY_FILE: path.join(dir, 'h.json'),
    BZZOIRO_API_KEY: 'x', BZZOIRO_API_BASE: `http://127.0.0.1:${bzzPort}/api`, APIFOOTBALL_KEY: 'test-af-key', APIFOOTBALL_BASE: `http://127.0.0.1:${afPort}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error(out)), 15000); const p = setInterval(() => { if (/Server on/.test(out)) { clearTimeout(t); clearInterval(p); ok(); } }, 50); });
  base = 'http://127.0.0.1:' + port;
});
after(async () => {
  await new Promise(ok => { srv.once('exit', ok); srv.kill('SIGTERM'); });
  bzz.close(); afSrv.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('API-Football matches are added, and a match Bzzoiro already has is merged (not shown twice)', async () => {
  const r = await fetch(base + '/api/public/fixtures').then(x => x.json());
  assert.strictEqual(r.fixtures.length, 3, JSON.stringify(r.fixtures.map(f => f.home.name)));
  const leeds = r.fixtures.filter(f => /^Leeds/.test(f.home.name));
  assert.strictEqual(leeds.length, 1, 'Leeds v Hull from both sources is shown once');
  assert.ok(leeds[0].id.startsWith('bzz_'), 'the merged match keeps the Bzzoiro id (snapshots, odds and settlement use it)');
  assert.ok(r.fixtures.some(f => f.home.name === 'Brazil') && r.fixtures.some(f => f.home.name === 'Wigan'));
  await fetch(base + '/api/public/fixtures');
  assert.strictEqual(afCalls, 1, 'cached: one API-Football call, not one per page view');
  assert.match(out, /API-Football: 3 matches added/);
});
