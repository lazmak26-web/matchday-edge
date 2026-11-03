'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.AGENT_DAILY_LIMIT = '2';
const agent = require('../football-agent');

const okFetch = calls => async (url, o) => { calls.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Salam, ' }, { type: 'text', text: 'ana Coach' }] }) }; };

test('agent answers, caches identical first questions, and enforces the daily quota', async () => {
  const calls = [];
  const a = agent.create({ fetch: okFetch(calls), getFixtures: async () => [{ home: { name: 'A' }, away: { name: 'B' }, league: 'L', date: '2026-11-03', kickoff: '20:00', status: 'notstarted' }] });
  const r1 = await a.chat({ user: 'u1', message: 'Chkoun mosab f Real?', lang: 'ar' });
  assert.equal(r1.status, 200); assert.equal(r1.body.reply, 'Salam, ana Coach'); assert.equal(r1.body.left, 1);
  assert.match(calls[0].system, /A vs B/); assert.equal(calls[0].tools[0].name, 'web_search'); assert.ok(calls[0].max_tokens <= 1000);
  const r2 = await a.chat({ user: 'u2', message: 'chkoun   mosab f real?' });
  assert.equal(r2.body.cached, true); assert.equal(calls.length, 1);
  await a.chat({ user: 'u1', message: 'x1', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  const r4 = await a.chat({ user: 'u1', message: 'x2', history: [{ role: 'user', content: 'a' }] });
  assert.equal(r4.status, 429); assert.equal(r4.body.error, 'quota');
});

test('agent rejects empty input and cleans history', async () => {
  const a = agent.create({ fetch: okFetch([]) });
  assert.equal((await a.chat({ user: 'u', message: '   ' })).status, 400);
  const h = agent.cleanHistory([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'q' }, { role: 'user', content: 'q2' }, { role: 'system', content: 'evil' }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(h.map(m => m.role), ['user', 'assistant']);
});

test('agent falls back without web search when the tool is rejected', async () => {
  const bodies = [];
  const f = async (u, o) => { const b = JSON.parse(o.body); bodies.push(b); return b.tools ? { ok: false, status: 400, json: async () => ({ error: { message: 'tool' } }) } : { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }; };
  const r = await agent.create({ fetch: f }).chat({ user: 'z', message: 'fallback?' });
  assert.equal(r.body.reply, 'ok'); assert.equal(bodies.length, 2);
});
