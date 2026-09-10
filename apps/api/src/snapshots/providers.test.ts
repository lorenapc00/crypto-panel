import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkets, parseGlobal, parseFundamental, parseBitcoinTip, parseSolanaInflation, fundamentalProfiles, snapshotJobs } from './providers.js';
import { providerStale } from './archive.js';

const now = '2026-09-09T12:00:00Z';
const asset = { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: null, market_cap: null,
  market_cap_rank: null, price_change_percentage_24h: null, last_updated: null };

test('market pages retain null metrics, timestamps and exact membership; reject malformed and duplicate pages', () => {
  const sample = parseMarkets([asset], now);
  assert.equal(sample.members[0].data.priceUsd, null);
  assert.equal(sample.members[0].data.rank, null);
  assert.equal(sample.members[0].data.observedAt, null);
  assert.equal(sample.notes.completePage, false);
  for (const payload of [[], {}, [asset, asset], [{ ...asset, current_price: '1' }], [{ ...asset, market_cap: -1 }],
    [{ ...asset, last_updated: '2027-01-01' }], [{ id: 'broken' }]]) assert.throws(() => parseMarkets(payload, now));
});

test('global metrics use provider USD totals and percentages, preserving unavailable fields', () => {
  const sample = parseGlobal({ data: { total_market_cap: { usd: 1000 }, total_volume: { usd: null },
    market_cap_percentage: { btc: 55, eth: null }, updated_at: Date.parse(now) / 1000 } }, now);
  assert.equal(sample.members[0].data.globalMarketCapUsd, 1000);
  assert.equal(sample.members[0].data.btcDominance, 55);
  assert.equal(sample.members[0].data.volume24hUsd, null);
  assert.throws(() => parseGlobal({ data: { total_market_cap: { eur: 100 } } }, now));
});

test('fundamental snapshots preserve scope and unknown publication times; TVL spacing is not relabeled daily', () => {
  const chain = fundamentalProfiles[0], protocol = fundamentalProfiles[2];
  const fees = parseFundamental({ total24h: null }, chain, 'fees_24h_usd', now).members[0].data;
  assert.equal(fees.value, null);
  assert.equal(fees.observedAt, null);
  assert.match(String(fees.coverage), /not native-token revenue/);
  const tvl = parseFundamental({ tvl: [{ date: 10, totalLiquidityUSD: 1 }, { date: 99, totalLiquidityUSD: 2 }] }, protocol, 'tvl_usd', now);
  assert.equal(tvl.members[0].data.observedAt, '1970-01-01T00:01:39.000Z');
  assert.throws(() => parseFundamental({ error: 'Unavailable' }, protocol, 'fees_24h_usd', now));
  assert.throws(() => parseFundamental([{ date: 100, tvl: 2 }, { date: 99, tvl: 1 }], chain, 'tvl_usd', now));
  assert.equal(snapshotJobs.filter(job => job.kind === 'fundamental').length, 7);
  assert.ok(!snapshotJobs.some(job => /ethereum:revenue|solana:revenue|aave|uniswap/.test(job.id)));
});

test('issuance validates RPC and height inputs and derives subsidy using integer satoshis', () => {
  assert.equal(parseBitcoinTip(840000).members[0].data.subsidyBtc, 3.125);
  assert.equal(parseBitcoinTip(210000 * 33).members[0].data.subsidyBtc, 0);
  for (const value of [null, -1, 1.5, '', '840000']) assert.throws(() => parseBitcoinTip(value));
  assert.equal(parseSolanaInflation({ jsonrpc: '2.0', id: 1, result: { total: 0.04, epoch: 99 } }).members[0].data.total, 0.04);
  assert.throws(() => parseSolanaInflation({ jsonrpc: '2.0', id: 1, result: { total: 0.04 } }));
  assert.throws(() => parseSolanaInflation({ jsonrpc: '2.0', id: 1, error: {}, result: { total: 0.04, epoch: 1 } }));
});

test('provider freshness does not reset when an old value is acquired again', () => {
  assert.equal(providerStale('2026-09-08T12:00:00Z', Date.parse(now), 3600), true);
  assert.equal(providerStale(null, Date.parse(now), 3600), true);
  assert.equal(providerStale(null, Date.parse(now), 86400, false), false);
});
