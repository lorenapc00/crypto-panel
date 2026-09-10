import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from './db.js';
import { assetDetails, marketData, marketBreadth } from './market.js';
import { fundamentals } from './fundamentals.js';
import { issuance } from './issuance.js';
import { parseMarkets, type Asset } from './snapshots/providers.js';

for (const code of ['ECONNREFUSED', '42P01']) {
  test(`archive failures never trigger live API reads or backfills (${code})`, async t => {
    t.mock.method(pool, 'query', async () => { throw Object.assign(new Error('Archive unavailable'), { code }); });
    const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected provider request'); });
    await assert.rejects(marketData(), { code });
    await assert.rejects(assetDetails('bitcoin'), { code });
    await assert.rejects(fundamentals('ethereum'), { code });
    await assert.rejects(issuance('bitcoin'), { code });
    assert.equal(provider.mock.callCount(), 0);
  });
}

test('breadth preserves unknown changes and counts only the acquired membership', () => {
  const assets = parseMarkets([2, -1, 0, null].map((change, index) => ({ id: String(index), symbol: 'coin', name: 'Coin',
    current_price: null, market_cap: null, price_change_percentage_24h: change }))).members.map(member => member.data as Asset);
  assert.deepEqual(marketBreadth(assets), { advancing: 1, declining: 1, unchanged: 1, unknown: 1, total: 4 });
});
