import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { body, cutoff, send } from '../http.js';
import { InputError, object, uuid } from '../research/validation.js';
import { ReplayCoverageError } from '../archive.js';
import { BACKTEST_TEMPLATES, findTemplate } from './templates.js';
import { backtestCoverage, replayComposition, loadRegimeInputs } from './archive.js';
import { runBacktests } from './executor.js';
import { dcaMatrix } from './matrix.js';

export async function backtestRoute(database: Pool, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname.replace('/api/v1', '');
  if (!path.startsWith('/backtest/')) return false;

  if (path === '/backtest/templates') {
    if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
    return send(res, 200, {
      data: {
        templates: BACKTEST_TEMPLATES.map(({ parse, ...rest }) => rest),
        coverage: await backtestCoverage(database),
        modes: ['historical-replay', 'signal-study', 'strategy-test'],
      },
    }), true;
  }

  if (path === '/backtest/replay') {
    if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
    const asOf = cutoff(url.searchParams.get('asOf'));
    if (!asOf) throw new InputError('Historical replay requires an asOf date');
    try {
      const composition = await replayComposition(database, asOf);
      if (composition.everyWorkspaceRefused)
        throw new InputError('Historical replay predates production coverage for the BTC regime at this cutoff; no earlier dataset is replayable', 409);
      return send(res, 200, { data: composition }), true;
    } catch (error) {
      if (error instanceof ReplayCoverageError) throw new InputError(error.message, 409);
      throw error;
    }
  }

  if (path === '/backtest/dca-matrix') {
    if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
    try {
      return send(res, 200, { data: await dcaMatrix(database, cutoff(url.searchParams.get('asOf'))) }), true;
    } catch (error) {
      if (error instanceof ReplayCoverageError) throw new InputError(error.message, 409);
      throw error;
    }
  }

  if (path === '/backtest/runs') {
    if (req.method === 'GET') {
      const rows = (await database.query(`select id, template_key, methodology_version, status, created_at,
        started_at, finished_at, error from backtest_runs order by created_at desc, id desc limit 50`)).rows;
      return send(res, 200, { data: rows }), true;
    }
    if (req.method !== 'POST') throw new InputError('Method not allowed', 405);
    if (url.search) throw new InputError('Backtest options belong in the request body');
    const input = object(await body(req));
    const template = findTemplate(input.templateKey);
    if (template.status === 'deferred') throw new InputError(template.gate ?? 'This template is deferred', 422);
    const params = template.parse ? template.parse(input.params) : {};

    // The dataset coverage start is folded into the hash so a run's reproducibility is
    // scoped to the archive it actually reads, not just the parameters typed.
    const datasetCoverageStart = (await loadRegimeInputs(database)).dataset.replayCoverageStart;
    const frozen = { templateKey: template.key, methodologyVersion: template.methodologyVersion, params, datasetCoverageStart };
    const inputHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');

    const existing = (await database.query(
      `select id, status, created_at, finished_at, result from backtest_runs
       where input_hash=$1 and status='succeeded' order by finished_at asc limit 1`, [inputHash])).rows[0];
    if (existing) return send(res, 200, { data: { ...existing, status: 'succeeded', reproduced: true, inputHash } }), true;

    const runId = randomUUID();
    const created = (await database.query(
      `insert into backtest_runs (id, template_key, methodology_version, input_hash, input)
       values ($1,$2,$3,$4,$5) returning id, status, created_at`,
      [runId, template.key, template.methodologyVersion, inputHash, frozen])).rows[0];
    return send(res, 202, { data: { ...created, inputHash } }), true;
  }

  const runId = path.match(/^\/backtest\/runs\/([^/]+)$/)?.[1];
  if (runId) {
    if (req.method !== 'GET') throw new InputError('Method not allowed', 405);
    const row = (await database.query('select * from backtest_runs where id=$1', [uuid(runId)])).rows[0];
    return send(res, row ? 200 : 404, row ? { data: row } : { error: 'Backtest run not found' }), true;
  }

  throw new InputError('Backtest route not supported', 404);
}

/** Exposed for the isolated browser fixture, which runs the queue once after seeding. */
export { runBacktests };
