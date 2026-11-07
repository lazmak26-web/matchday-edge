'use strict';
// Score-matrix model: independent Poisson with the Dixon-Coles low-score correction.
const MAXG = 10;
const fact = [1]; for (let i = 1; i <= MAXG + 5; i++) fact[i] = fact[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact[k];

// Dixon-Coles tau: adjusts 0-0, 1-0, 0-1, 1-1. rho is usually slightly negative (about -0.05..-0.15).
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function scoreMatrix(lh, la, rho = -0.08, offset = { h: 0, a: 0 }) {
  if (!(lh > 0) || !(la > 0) || !isFinite(lh) || !isFinite(la)) throw new RangeError('lambda must be > 0');
  if (!isFinite(rho) || rho < -0.3 || rho > 0.1) throw new RangeError('rho must be within [-0.3, 0.1]');
  const m = []; let sum = 0;
  for (let x = 0; x <= MAXG; x++) {
    m[x] = [];
    for (let y = 0; y <= MAXG; y++) {
      const p = Math.max(0, pois(x, lh) * pois(y, la) * tau(x, y, lh, la, rho));
      m[x][y] = p; sum += p;
    }
  }
  for (const row of m) for (let y = 0; y <= MAXG; y++) row[y] /= sum; // renormalise (truncation + tau)
  return m;
}

// Outcome probabilities from a score matrix; `cur` = goals already scored (live).
function summarize(m, cur = { h: 0, a: 0 }, line = 2.5) {
  let h = 0, d = 0, a = 0, over = 0, over15 = 0, btts = 0, best = { p: -1, s: '0-0' };
  for (let x = 0; x < m.length; x++) for (let y = 0; y < m[x].length; y++) {
    const p = m[x][y], X = x + cur.h, Y = y + cur.a;
    if (X > Y) h += p; else if (X === Y) d += p; else a += p;
    if (X + Y > line) over += p;
    if (X + Y > 1.5) over15 += p;
    if (X > 0 && Y > 0) btts += p;
    if (p > best.p) best = { p, s: X + '-' + Y };
  }
  return { h, d, a, over, under: 1 - over, over15, under15: 1 - over15, btts, top: best.s };
}

// Market-implied Over 1.5. Without real xG there is no model, but the market still prices Over 2.5: find the total-goals rate
// lambda whose Poisson P(goals >= 3) equals that probability and read P(goals >= 2) from it. Returns null outside a sane range.
function impliedOver15(pOver25) {
  if (typeof pOver25 !== 'number' || !isFinite(pOver25) || pOver25 < 0.05 || pOver25 > 0.95) return null;
  const o25 = l => 1 - Math.exp(-l) * (1 + l + l * l / 2);
  let lo = 0.2, hi = 9;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (o25(m) < pOver25) lo = m; else hi = m; }
  const l = (lo + hi) / 2;
  return 1 - Math.exp(-l) * (1 + l);
}
module.exports = { scoreMatrix, summarize, tau, pois, MAXG, impliedOver15 };
