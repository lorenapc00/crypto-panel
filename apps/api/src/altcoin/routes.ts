import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { cutoff, send } from '../http.js';
import { InputError } from '../research/validation.js';
import { emergingArchive, launchesArchive, launchChains } from './archive.js';

function choice<T extends string>(value: string | null, allowed: readonly T[], field: string): T | undefined {
  if (value === null) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new InputError(`Unsupported ${field}`);
  return value as T;
}
function count(value: string | null, field: string, max: number) {
  if (value === null) return undefined;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > max) throw new InputError(`Invalid ${field}`);
  return Number(value);
}
/** A whole-dollar research threshold. Rejecting an unparseable value keeps a typo from
 *  silently widening the screen instead of narrowing it. */
function money(value: string | null, field: string, max: number) {
  if (value === null) return undefined;
  if (!/^\d{1,15}$/.test(value) || Number(value) > max) throw new InputError(`Invalid ${field}`);
  return Number(value);
}
function search(value: string | null) {
  if (value === null) return undefined;
  if (!value.trim() || value.length > 100) throw new InputError('Invalid search term');
  return value.trim();
}
function flag(value: string | null, field: string) {
  if (value === null) return undefined;
  if (value !== 'true' && value !== 'false') throw new InputError(`Invalid ${field}`);
  return value === 'true';
}

export async function altcoinRoute(database: Pool, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname.replace('/api/v1', '');
  if (!path.startsWith('/altcoin/')) return false;
  if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
  const parameters = url.searchParams;
  if (path === '/altcoin/emerging') {
    const minMarketCapUsd = money(parameters.get('minMarketCap'), 'minimum market cap', 1e13);
    const maxMarketCapUsd = money(parameters.get('maxMarketCap'), 'maximum market cap', 1e13);
    if (minMarketCapUsd !== undefined && maxMarketCapUsd !== undefined && minMarketCapUsd > maxMarketCapUsd)
      throw new InputError('Minimum market cap exceeds the maximum');
    return send(res, 200, await emergingArchive(database, cutoff(parameters.get('asOf')), {
      screen: choice(parameters.get('screen'), ['eligible', 'all'] as const, 'screen'),
      minMarketCapUsd, maxMarketCapUsd,
      minMedianVolumeUsd: money(parameters.get('minMedianVolume'), 'minimum median volume', 1e13),
      minHistoryDays: count(parameters.get('minHistoryDays'), 'minimum history', 3650),
      search: search(parameters.get('search')), limit: count(parameters.get('limit'), 'limit', 500),
    })), true;
  }
  if (path === '/altcoin/launches') {
    return send(res, 200, await launchesArchive(database, cutoff(parameters.get('asOf')), {
      screen: choice(parameters.get('screen'), ['new', 'all'] as const, 'screen'),
      chain: choice(parameters.get('chain'), launchChains, 'chain') ?? null,
      windowDays: count(parameters.get('windowDays'), 'launch window', 365),
      minLiquidityUsd: money(parameters.get('minLiquidity'), 'minimum liquidity', 1e13),
      includeUnknownLiquidity: flag(parameters.get('includeUnknownLiquidity'), 'unknown-liquidity flag'),
      search: search(parameters.get('search')), limit: count(parameters.get('limit'), 'limit', 1000),
    })), true;
  }
  throw new InputError('Altcoin discovery route not supported', 404);
}
