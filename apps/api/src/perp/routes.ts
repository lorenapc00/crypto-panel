import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { body, cutoff, send } from '../http.js';
import { InputError, object } from '../research/validation.js';
import { coveredNamespaces } from '../discovery/providers.js';
import { perpProjectsArchive, perpListingsArchive, perpAlerts, acknowledgePerpAlert } from './archive.js';

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
function search(value: string | null) {
  if (value === null) return undefined;
  if (!value.trim() || value.length > 100) throw new InputError('Invalid search term');
  return value.trim();
}

export async function perpRoute(database: Pool, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname.replace('/api/v1', '');
  if (!path.startsWith('/perp/')) return false;
  const parameters = url.searchParams;
  if (path === '/perp/projects') {
    if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
    return send(res, 200, await perpProjectsArchive(database, cutoff(parameters.get('asOf')), {
      window: choice(parameters.get('window'), ['all', 'early'] as const, 'project window'),
      stage: choice(parameters.get('stage'), ['live-token', 'provider-linked-token', 'unknown'] as const, 'token stage'),
      venue: choice(parameters.get('venue'), ['hyperliquid'] as const, 'venue'),
      search: search(parameters.get('search')), limit: count(parameters.get('limit'), 'limit', 500),
    })), true;
  }
  if (path === '/perp/listings') {
    if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
    const namespace = parameters.get('namespace');
    if (namespace !== null && !coveredNamespaces.includes(namespace === 'native' ? '' : namespace)) throw new InputError('Namespace is outside the budgeted venue coverage');
    return send(res, 200, await perpListingsArchive(database, cutoff(parameters.get('asOf')), {
      screen: choice(parameters.get('screen'), ['new', 'all'] as const, 'listing screen'),
      underlying: choice(parameters.get('underlying'), ['verified', 'all'] as const, 'underlying filter'),
      namespace: namespace === null ? null : namespace === 'native' ? '' : namespace,
      windowDays: count(parameters.get('windowDays'), 'listing window', 365),
      search: search(parameters.get('search')), limit: count(parameters.get('limit'), 'limit', 1000),
    })), true;
  }
  if (path === '/perp/alerts') {
    if (req.method === 'GET') return send(res, 200, await perpAlerts(database, { limit: count(parameters.get('limit'), 'limit', 200),
      unreadOnly: parameters.get('unread') === 'true' })), true;
    if (req.method === 'POST') {
      const input = object(await body(req));
      for (const field of ['datasetId', 'snapshotId', 'entityKey']) if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 300) throw new InputError(`Invalid ${field}`);
      if (!/^\d+$/.test(input.snapshotId as string)) throw new InputError('Invalid snapshotId');
      try { await acknowledgePerpAlert(database, input.datasetId as string, input.snapshotId as string, input.entityKey as string); }
      catch (error) { throw error instanceof Error && error.message === 'Alert not found' ? new InputError('Alert not found', 404) : error; }
      return send(res, 204, null), true;
    }
    throw new InputError('Method not allowed', 405);
  }
  throw new InputError('Perp discovery route not supported', 404);
}
