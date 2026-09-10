import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCapitalHistory, parseCapitalCatalog } from './capital.js';

const row = (day: number, value: unknown = 100) => ({ date: String(Date.UTC(2026, 0, day) / 1000), totalCirculatingUSD: { peggedUSD: value, peggedEUR: 999 }, totalCirculating: { peggedUSD: 888 } });
test('capital feed isolates USD pegs, preserves zero/null, and excludes the live day', () => {
  const sample = parseCapitalHistory([row(1, 0), row(2, null), row(3, undefined), row(4)], '2026-01-04T12:00:00Z');
  assert.equal(sample.series![0].definition.assetId, null);
  assert.deepEqual(sample.series![0].points.map(p => p.value), [0, null, 100]);
  const absent = row(2); delete (absent.totalCirculatingUSD as any).peggedUSD;
  assert.equal(parseCapitalHistory([row(1), absent], '2026-01-04').series![0].points[1].value, null);
});
test('capital feed refuses invalid values, duplicate or irregular timestamps and empty coverage', () => {
  for (const value of [false, '', '100', -1, Infinity]) assert.throws(() => parseCapitalHistory([row(1, value)], '2026-01-04'), /amount/);
  for (const rows of [[row(1), row(1)], [row(2), row(1)], [{ ...row(1), date: '1767225601' }], [row(5)]]) assert.throws(() => parseCapitalHistory(rows, '2026-01-04'), /timestamp/);
  assert.throws(() => parseCapitalHistory([row(1, null)], '2026-01-04'), /No completed/);
});
test('stablecoin catalog retains provider IDs, filters peg types and preserves unknown price/supply', () => {
  const asset = { id: '1', name: 'Dollar', symbol: 'USD', pegType: 'peggedUSD', chains: ['Ethereum'], circulating: { peggedUSD: 0 }, price: null };
  const result = parseCapitalCatalog({ peggedAssets: [asset, { ...asset, id: '2', pegType: 'peggedEUR' }] });
  assert.equal(result.members.length, 1); assert.equal(result.members[0].data.priceUsd, null);
  assert.equal(result.members[0].data.circulatingNative, 0);
  assert.throws(() => parseCapitalCatalog({ peggedAssets: [asset, asset] }), /Duplicate/);
  assert.throws(() => parseCapitalCatalog({ peggedAssets: [{ ...asset, pegType: undefined }] }), /peg/);
});
