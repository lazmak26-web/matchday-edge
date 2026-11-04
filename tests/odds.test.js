'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const O = require('../engine/odds'), { predict } = require('../engine/prematch'), { decide, bestPrices } = require('../engine/decision');
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) < t, a + ' vs ' + b);

test('devig sums to 1 and removes margin', () => { const v = O.devig([2.0, 3.5, 4.0]); near(v.fair.reduce((a, b) => a + b), 1); assert.ok(v.margin > 0); });
test('sharp book outweighs recreational ones', () => {
  const books = [{ book: 'Pinnacle', home: 2.10, draw: 3.40, away: 3.60 }, { book: 'bet365', home: 1.90, draw: 3.30, away: 3.80 }];
  const c = O.consensus(books), flat = (O.devig([1.9, 3.3, 3.8]).fair[0] + O.devig([2.1, 3.4, 3.6]).fair[0]) / 2;
  assert.ok(Math.abs(c.fair.h - O.devig([2.1, 3.4, 3.6]).fair[0]) < Math.abs(flat - O.devig([2.1, 3.4, 3.6]).fair[0]));
  near(c.fair.h + c.fair.d + c.fair.a, 1);
});
test('stale price is dropped from consensus AND best price', () => {
  const b = n => ({ book: n, home: 2.0, draw: 3.4, away: 3.8 });
  const books = [b('A'), b('B'), b('C'), b('D'), { book: 'Stale', home: 3.2, draw: 3.4, away: 3.8 }];
  const c = O.consensus(books); assert.equal(c.n, 4); assert.equal(c.dropped[0].book, 'Stale'); assert.equal(c.best.home.odds, 2.0);
});
test('few books: nothing is dropped', () => { assert.equal(O.consensus([{ book: 'A', home: 2, draw: 3.4, away: 3.8 }, { book: 'B', home: 3, draw: 3.4, away: 3.8 }]).n, 2); });
test('best price = max across kept books', () => {
  const c = O.consensus([{ book: 'A', home: 2.0, draw: 3.4, away: 3.8 }, { book: 'B', home: 2.05, draw: 3.3, away: 3.9 }, { book: 'C', home: 2.02, draw: 3.45, away: 3.7 }]);
  assert.deepEqual([c.best.home.book, c.best.draw.book, c.best.away.book], ['B', 'C', 'B']);
});
test('kelly: no edge => 0, quarter = full/4, capped', () => {
  assert.equal(O.kelly(0.4, 2.0).full, 0); near(O.kelly(0.6, 2.0).raw, 0.2); near(O.kelly(0.6, 2.0).full, 0.1); near(O.kelly(0.6, 2.0).quarter, 0.025);
  assert.equal(O.kelly(null, 2), null);
});
test('missing totals => ou null, never invented', () => { assert.equal(O.consensus([{ book: 'A', home: 2, draw: 3.4, away: 3.8 }]).ou, null); });
test('decide() exposes kelly on the pick', () => {
  const fx = { status: 'notstarted', xgSource: 'direct', home: { name: 'H', xgFor: 1.6, xgAgainst: 1.1 }, away: { name: 'A', xgFor: 1.2, xgAgainst: 1.4 },
    odds: [{ book: 'Pinnacle', home: 2.1, draw: 3.5, away: 3.7 }, { book: 'Other', home: 2.4, draw: 3.5, away: 3.9 }] };
  const d = decide(fx, predict(fx, { marketWeight: 0.5 }), { minEV: 0, minBooks: 2 });
  assert.ok(d.best && d.best.kelly && d.best.kelly.quarter <= d.best.kelly.full);
});
