import { setTimeout } from 'node:timers/promises';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { configureExternalProvider, reserveExternalRequest, retryDelay } from './discovery/queue.js';

export function safeEndpoint(value: string | URL) {
  const url = new URL(value);
  url.username = ''; url.password = '';
  for (const key of [...url.searchParams.keys()]) if (/key|token|secret|authorization/i.test(key)) url.searchParams.delete(key);
  return url.toString();
}
export function probeWeight(provider: string, body?: Record<string, unknown>) {
  if (provider !== 'hyperliquid') return 1;
  if (body?.type === 'l2Book') return 2;
  // A seven-day funding probe can return 168 rows. Reserve all response weight
  // up front; the provider maximum of 500 rows costs another 25 units.
  if (body?.type === 'fundingHistory') return 45;
  return 20;
}
export async function meteredFetch(provider: string, input: string | URL, init: RequestInit = {}, options: {
  database?: Pool; fetchImpl?: typeof fetch; purpose?: 'manual-history' | 'capability-probe'; weight?: number;
} = {}) {
  const database = options.database ?? pool, purpose = options.purpose ?? 'manual-history', weight = options.weight ?? 1;
  const source = provider === 'coinmetrics-archive' ? 'coinmetrics' : provider;
  await configureExternalProvider(database,source,weight,purpose === 'capability-probe');
  let reservation;
  const deadline = Date.now()+60000;
  while (true) {
    reservation = await reserveExternalRequest(database,source,weight,purpose,safeEndpoint(input));
    if (reservation.request) break;
    if (Date.now()+reservation.waitMs > deadline) throw new Error(reservation.reason ?? 'Quota unavailable');
    await setTimeout(Math.max(1,reservation.waitMs));
  }
  const request = reservation.request;
  try {
    const response = await (options.fetchImpl ?? fetch)(input,{...init,signal:init.signal ?? AbortSignal.timeout(25000),redirect:'error'});
    // Consume the response under the request timeout; failures remain charged.
    const raw = await response.text();
    await database.query(`update worker_requests set finished_at=clock_timestamp(),http_status=$2,error=$3 where id=$1`,
      [request.id,response.status,response.ok ? null : `HTTP ${response.status}`]);
    if ([408,429].includes(response.status) || response.status >= 500) await database.query(`update worker_provider_state set
      blocked_until=greatest(blocked_until,clock_timestamp()+$2*interval '1 millisecond') where provider_id=$1`,
      [source,retryDelay(response.headers.get('retry-after'),Date.now(),1)]);
    return { response:new Response([204,205,304].includes(response.status)?null:raw,{status:response.status,statusText:response.statusText,headers:response.headers}),requestId:request.id,requestedAt:request.requestedAt };
  } catch {
    await database.query("update worker_requests set finished_at=clock_timestamp(),error='Network request failed' where id=$1",[request.id]);
    throw new Error('Metered provider request failed');
  }
}
