import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNamespaces, parseInstruments, parseProtocols, parsePools } from './providers.js';
import { retryDelay } from './queue.js';

test('namespace catalog exposes uncovered namespaces and rejects missing native marker or duplicates', () => {
  const result = parseNamespaces([null, { name: 'xyz' }, { name: 'new-venue' }]);
  assert.deepEqual(result.notes.uncoveredNamespaces, ['new-venue']);
  assert.throws(() => parseNamespaces([{ name: 'xyz' }]), /native/);
  assert.throws(() => parseNamespaces([null, { name: 'xyz' }, { name: 'xyz' }]), /Duplicate/);
});

test('instrument identities retain venue/namespace and OI remains native with unknown quote conversion', () => {
  const parse = (name: string, namespace: string) => parseInstruments([{ universe: [{ name }] }, [{ openInterest: '2', markPx: '10', funding: '0.0001' }]], namespace);
  const native = parse('BTC', '').members[0], named = parse('xyz:BTC', 'xyz').members[0];
  assert.notEqual(native.key, named.key);
  assert.equal(native.data.openInterestNative, 2);
  assert.equal(native.data.estimatedOpenInterestQuote, 20);
  assert.equal(native.data.quoteCurrency, 'unresolved');
  assert.equal(native.data.impactPrices, null);
  assert.equal(native.data.fundingIntervalSeconds, 3600);
  assert.equal(native.data.underlyingAssetId, null);
  assert.throws(() => parse('BTC', 'xyz'), /namespace/);
  assert.throws(() => parseInstruments([{ universe: [{ name: 'BTC' }] }, []], ''), /align/);
  assert.throws(() => parseInstruments([{ universe: [{ name: 'BTC' }] }, [{ openInterest: false }]], ''), /number/);
});

test('missing protocol token link is unknown, and catalog errors cannot become empty membership', () => {
  const result = parseProtocols([{ id: '1', slug: 'sample', name: 'Sample', chains: ['Solana'], gecko_id: null, tvl: 1 }]);
  assert.equal(result.members[0].data.geckoId, null);
  assert.equal(result.members[0].data.tokenStage, 'unknown');
  assert.throws(() => parseProtocols({ error: 'rate limited' }), /array/);
  assert.throws(() => parseProtocols([]), /Empty/);
});

test('pool identities use chain/address, preserve unknown liquidity and distinguish pool creation from token age', () => {
  const pool = { id: 'base_0xAB', attributes: { address: '0xAB', name: 'A/B', reserve_in_usd: null, pool_created_at: '2026-01-01T00:00:00Z' },
    relationships: { base_token: { data: { id: 'base_0xABC' } }, quote_token: { data: { id: 'base_0xDEF' } } } };
  const result = parsePools({ data: [pool] }, 'base').members[0];
  assert.equal(result.data.poolAddress, '0xab');
  assert.equal(result.data.baseTokenAddress, '0xabc');
  assert.equal(result.data.liquidityUsd, null);
  assert.equal(result.data.tokenLaunchAt, null);
  assert.equal(result.data.contractRisk, 'unknown');
  assert.throws(() => parsePools({ data: [pool, { ...pool, id: 'base_0xab', attributes: { ...pool.attributes, address: '0xab' } }] }, 'base'), /Duplicate/);
  assert.throws(() => parsePools({ data: [pool] }, 'solana'), /identity/);
});

test('backoff honors Retry-After seconds and dates without shortening long provider delays', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryDelay('120', now, 1, 0), 120000);
  assert.equal(retryDelay('Thu, 01 Jan 2026 01:00:00 GMT', now, 1, 0), 3600000);
  assert.equal(retryDelay('invalid', now, 2, 0), 10000);
  assert.equal(retryDelay(null, now, 3, 0), 20000);
});
