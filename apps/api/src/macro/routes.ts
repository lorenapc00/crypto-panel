import type { Pool } from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cutoff, send } from '../http.js';
import { macroView } from './view.js';

export async function macroRoute(database: Pool, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1/macro')) return false;
  if (url.pathname !== '/api/v1/macro') { send(res, 404, { error: 'Not found' }); return true; }
  if (req.method !== 'GET') { send(res, 405, { error: 'Method not allowed' }); return true; }
  send(res, 200, await macroView(database, cutoff(url.searchParams.get('asOf'))));
  return true;
}
