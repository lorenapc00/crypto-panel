import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate, loadMigrations } from '../src/migrations.js';
import { configureWorker, claim } from '../src/discovery/queue.js';
import { executeRun } from '../src/discovery/worker.js';
import { bcbJobs, cdiSeriesId } from '../src/feeds/bcb.js';
import { macroJobs } from '../src/feeds/macro.js';
import { fomcCalendarJob, fredReleaseDateJobs, RELEASES, parseFomcCalendar } from '../src/feeds/calendar.js';
import { apiServer } from '../src/server.js';

async function isolated(run: (database: Pool) => Promise<void>) {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const schema = `macro_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try { await admin.query(`create schema ${schema}`); await migrate(database); await run(database); }
  finally { await database.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
}

async function withServer(database: Pool, use: (base: string) => Promise<void>) {
  const server = apiServer(database).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  try { await use(base); } finally { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}

const pad = (n: number) => String(n).padStart(2, '0');
// Business days going back from (today - endOffsetDays), so fixtures stay valid no
// matter what day the test suite actually runs on.
function businessDaysBack(count: number, endOffsetDays = 1): Date[] {
  const dates: Date[] = [];
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - endOffsetDays);
  while (dates.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.reverse();
}
const sgsPayload = (base = 0.0516) => businessDaysBack(20).map((d, i) => ({
  data: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, valor: (base + i * 0.0001).toFixed(6) }));
const ptaxPayload = (base = 5.11) => businessDaysBack(20).map((d, i) => ({
  data: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, valor: (base + i * 0.001).toFixed(4) }));
const fredPayload = (base = 1.8) => ({ observations: businessDaysBack(20).map((d, i) => ({
  date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, value: (base + i * 0.01).toFixed(2) })) });
const releaseDatesPayload = (releaseId: number) => ({ release_dates: [
  { release_id: releaseId, date: '2026-01-14' }, { release_id: releaseId, date: '2026-09-11' }, { release_id: releaseId, date: '2026-10-13' } ] });

// Real, trimmed excerpts of the official FOMC calendar page (fetched 2026-09-11): the
// full 2026 panel (8 meetings) and a "short" variant with December dropped (7
// meetings), used to exercise calendar replay across two snapshots.
const PANEL_2026_SHORT = "<div class=\"panel panel-default\"><div class=\"panel-heading\"><h4><a id=\"42828\">2026 FOMC Meetings</a></h4></div>\n\n\n\n\n\n\n        <div class=\"row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>January</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">27-28</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n               <strong>Statement:</strong><br>\n               <a href=\"/monetarypolicy/files/monetary20260128a1.pdf\">PDF</a> | <a href=\"/newsevents/pressreleases/monetary20260128a.htm\">HTML</a><br>\n               \n                \n                <a href=\"/newsevents/pressreleases/monetary20260128a1.htm\">Implementation Note</a>\n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                <a href=\"/monetarypolicy/fomcpressconf20260128.htm\">Press Conference</a><br>\n                \n                <br>\n                <a href=\"/newsevents/pressreleases/monetary20260128b.htm\">Statement on Longer-Run Goals and Monetary Policy Strategy</a>\n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n                <strong>Minutes:</strong><br>\n                \n                <a href=\"/monetarypolicy/files/fomcminutes20260128.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcminutes20260128.htm\">HTML</a>\n                <br> (Released February 18, 2026)\n                \n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"fomc-meeting--shaded row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting--shaded fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>March</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">17-18*</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n               <strong>Statement:</strong><br>\n               <a href=\"/monetarypolicy/files/monetary20260318a1.pdf\">PDF</a> | <a href=\"/newsevents/pressreleases/monetary20260318a.htm\">HTML</a><br>\n               \n                \n                <a href=\"/newsevents/pressreleases/monetary20260318a1.htm\">Implementation Note</a>\n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                <a href=\"/monetarypolicy/fomcpresconf20260318.htm\">Press Conference</a><br>\n                \n                <strong>Projection Materials</strong><br>\n                <a href=\"/monetarypolicy/files/fomcprojtabl20260318.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcprojtabl20260318.htm\">HTML</a>\n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n                <strong>Minutes:</strong><br>\n                \n                <a href=\"/monetarypolicy/files/fomcminutes20260318.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcminutes20260318.htm\">HTML</a>\n                <br> (Released April 08, 2026)\n                \n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>April</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">28-29</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n               <strong>Statement:</strong><br>\n               <a href=\"/monetarypolicy/files/monetary20260429a1.pdf\">PDF</a> | <a href=\"/newsevents/pressreleases/monetary20260429a.htm\">HTML</a><br>\n               \n                \n                <a href=\"/newsevents/pressreleases/monetary20260429a1.htm\">Implementation Note</a>\n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                <a href=\"/monetarypolicy/fomcpresconf20260429.htm\">Press Conference</a><br>\n                \n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n                <strong>Minutes:</strong><br>\n                \n                <a href=\"/monetarypolicy/files/fomcminutes20260429.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcminutes20260429.htm\">HTML</a>\n                <br> (Released May 20, 2026)\n                \n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"fomc-meeting--shaded row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting--shaded fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>June</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">16-17*</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n               <strong>Statement:</strong><br>\n               <a href=\"/monetarypolicy/files/monetary20260617a1.pdf\">PDF</a> | <a href=\"/newsevents/pressreleases/monetary20260617a.htm\">HTML</a><br>\n               \n                \n                <a href=\"/newsevents/pressreleases/monetary20260617a1.htm\">Implementation Note</a>\n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                <a href=\"/monetarypolicy/fomcpresconf20260617.htm\">Press Conference</a><br>\n                \n                <strong>Projection Materials</strong><br>\n                <a href=\"/monetarypolicy/files/fomcprojtabl20260617.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcprojtabl20260617.htm\">HTML</a>\n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n                <strong>Minutes:</strong><br>\n                \n                <a href=\"/monetarypolicy/files/fomcminutes20260617.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcminutes20260617.htm\">HTML</a>\n                <br> (Released July 08, 2026)\n                \n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>July</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">28-29</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n               <strong>Statement:</strong><br>\n               <a href=\"/monetarypolicy/files/monetary20260729a1.pdf\">PDF</a> | <a href=\"/newsevents/pressreleases/monetary20260729a.htm\">HTML</a><br>\n               \n                \n                <a href=\"/newsevents/pressreleases/monetary20260729a1.htm\">Implementation Note</a>\n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                <a href=\"/monetarypolicy/fomcpresconf20260729.htm\">Press Conference</a><br>\n                \n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n                <strong>Minutes:</strong><br>\n                \n                <a href=\"/monetarypolicy/files/fomcminutes20260729.pdf\">PDF</a> | <a href=\"/monetarypolicy/fomcminutes20260729.htm\">HTML</a>\n                <br> (Released August 19, 2026)\n                \n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"fomc-meeting--shaded row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting--shaded fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>September</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">15-16*</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                \n                \n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"row fomc-meeting\" \">\n        \n            <div class=\"fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>October</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">27-28</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                \n                \n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n            </div>\n        </div>\n        \n\n\n\n\n        <div class=\"fomc-meeting--shaded row fomc-meeting\" \">\n        \n";
const PANEL_2026_FULL = PANEL_2026_SHORT + "            <div class=\"fomc-meeting--shaded fomc-meeting__month col-xs-5 col-sm-3 col-md-2\"><strong>December</strong></div>\n                \n            <div class=\"fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1\">8-9*</div>\n            <div class=\"col-xs-12 col-md-4 col-lg-2\">\n        \n               \n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-3\">\n                \n                \n                <br>\n                \n                \n            </div>\n            <div class=\"col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes\">\n                \n            </div>\n        </div>\n        \n<div class=\"panel-footer\">* Meeting associated with a Summary of Economic Projections.  </div>\n</div>\n";
const fomcHtml = (panel: string) => `<html><body>${panel}</body></html>`;

async function run(database: Pool, job: (typeof bcbJobs)[number], payload: unknown) {
  await database.query('update worker_provider_state set tokens=1,updated_at=clock_timestamp(),blocked_until=null where provider_id=$1', [job.provider]);
  await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
  const claimed = await claim(database); assert.ok(claimed);
  const result = await executeRun(database, claimed, job, async () => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  assert.equal(result.status, 'succeeded', `${job.id}: ${JSON.stringify(result)}`);
}

test('migration 0014 registers the bcb and federalreserve sources and the six macro metrics', async () => isolated(async database => {
  const applied = (await database.query('select count(*)::int as n from schema_migrations')).rows[0].n;
  assert.equal(applied, (await loadMigrations()).length);
  assert.equal((await database.query("select 1 from sources where id='bcb'")).rowCount, 1);
  assert.equal((await database.query("select 1 from sources where id='federalreserve'")).rowCount, 1);
  for (const code of ['cdi_daily_rate', 'usd_brl_ptax_sell', 'real_yield_10y', 'broad_usd_index', 'sp500_index', 'nasdaq_composite_index'])
    assert.equal((await database.query('select 1 from metric_definitions where code=$1', [code])).rowCount, 1, code);
}));

test('configureWorker accepts the bcb, federalreserve and fred budget entries', async () => isolated(async database => {
  await configureWorker(database, [...bcbJobs, fomcCalendarJob, ...macroJobs, ...fredReleaseDateJobs]);
}));

test('the worker archives synthetic BCB, FRED and FOMC payloads, and GET /api/v1/macro returns them populated', async () => isolated(async database => {
  const jobs = [...bcbJobs, fomcCalendarJob, ...macroJobs, ...fredReleaseDateJobs];
  await configureWorker(database, jobs);
  for (const job of bcbJobs) await run(database, job, job.id === cdiSeriesId ? sgsPayload() : ptaxPayload());
  await run(database, fomcCalendarJob, fomcHtml(PANEL_2026_FULL));
  for (const job of macroJobs) await run(database, job, fredPayload());
  for (let i = 0; i < fredReleaseDateJobs.length; i++) await run(database, fredReleaseDateJobs[i], releaseDatesPayload(RELEASES[i].releaseId!));

  // The live (no-asOf) calendar view only shows meetings still upcoming as of "today" —
  // ends_on >= today, same invariant macro/view.ts's calendarBlock enforces — so the
  // expected count is derived from the same parser, not a count of everything archived.
  const today = new Date().toISOString().slice(0, 10);
  const expectedFomcEvents = parseFomcCalendar(fomcHtml(PANEL_2026_FULL), new Date().toISOString()).calendar!.events.filter(e => e.endsOn >= today);
  assert.ok(expectedFomcEvents.length > 0, 'fixture must contain at least one still-upcoming meeting');

  await withServer(database, async base => {
    const { data } = await fetch(`${base}/macro`).then(r => r.json()) as any;
    assert.ok(data.brazil.cdi.points.length > 0);
    assert.equal(data.brazil.cdi.annualized.length, data.brazil.cdi.points.length);
    const firstPoint = data.brazil.cdi.points[0], firstAnnualized = data.brazil.cdi.annualized[0];
    assert.ok(Math.abs(firstAnnualized.value - (Math.pow(1 + firstPoint.value / 100, 252) - 1)) < 1e-9);
    assert.ok(data.brazil.ptax.points.length > 0);
    for (const code of ['dfii10', 'dtwexbgs', 'sp500', 'nasdaqcom']) {
      assert.ok(data.usMacro[code].points.length > 0, code);
      assert.equal(data.usMacro[code].unavailable, false, code);
    }
    assert.equal(data.calendar.fomc.events.length, expectedFomcEvents.length);
    assert.ok(data.calendar.fomc.events.some((e: any) => e.sep === true));
    assert.ok(data.calendar.fomc.events.every((e: any) => e.eventType === 'fomc-meeting'));
    for (const block of ['cpi', 'employment', 'gdp', 'pce']) assert.ok(data.calendar[block].events.length > 0, block);
    assert.equal(data.calendar.copom.unavailable, true);
    assert.equal(data.calendar.copom.note, 'Not yet sourced');
    assert.equal(data.refusals.length, 0);
  });
}));

test('a feed this installation never configured reports unavailable, distinct from refused', async () => isolated(async database => {
  // PTAX is deliberately left unseeded to exercise readSeries returning null for an
  // unconfigured series (no data_series row), vs. a ReplayCoverageError refusal.
  const jobs = [bcbJobs.find(j => j.id === cdiSeriesId)!];
  await configureWorker(database, jobs);
  await run(database, jobs[0], sgsPayload());
  await withServer(database, async base => {
    const { data } = await fetch(`${base}/macro`).then(r => r.json()) as any;
    assert.ok(data.brazil.cdi.points.length > 0);
    assert.equal(data.brazil.ptax.unavailable, true);
    assert.equal(data.brazil.ptax.refused, false);
    assert.equal(data.usMacro.dfii10.unavailable, true);
    assert.equal(data.calendar.fomc.unavailable, true);
    assert.equal(data.calendar.fomc.refused, false);
  });
}));

test("a cutoff before any block's coverage refuses only that block, not the whole response", async () => isolated(async database => {
  const jobs = [...bcbJobs, fomcCalendarJob];
  await configureWorker(database, jobs);
  for (const job of bcbJobs) await run(database, job, job.id === cdiSeriesId ? sgsPayload() : ptaxPayload());
  await run(database, fomcCalendarJob, fomcHtml(PANEL_2026_FULL));
  await withServer(database, async base => {
    const response = await fetch(`${base}/macro?asOf=2010-01-01`);
    assert.equal(response.status, 200);
    const { data } = await response.json() as any;
    assert.equal(data.brazil.cdi.refused, true);
    assert.equal(data.brazil.ptax.refused, true);
    assert.equal(data.calendar.fomc.refused, true);
    assert.ok(data.refusals.length >= 3);
    assert.ok(data.refusals.some((r: any) => r.block === 'brazil.cdi'));
    assert.ok(data.refusals.some((r: any) => r.block === 'calendar.fomc'));
  });
}));

test('a later FOMC snapshot does not change an earlier asOf answer', async () => isolated(async database => {
  await configureWorker(database, [fomcCalendarJob]);
  await run(database, fomcCalendarJob, fomcHtml(PANEL_2026_SHORT));
  const cutoff = (await database.query('select clock_timestamp()::text as cutoff')).rows[0].cutoff;
  await run(database, fomcCalendarJob, fomcHtml(PANEL_2026_FULL));
  // Both calls filter to meetings still upcoming as of "today" (same invariant as above);
  // what must differ between them is which snapshot (7 vs 8 archived meetings) is read.
  const today = new Date().toISOString().slice(0, 10);
  const expectedBefore = parseFomcCalendar(fomcHtml(PANEL_2026_SHORT), new Date().toISOString()).calendar!.events.filter(e => e.endsOn >= today).length;
  const expectedLatest = parseFomcCalendar(fomcHtml(PANEL_2026_FULL), new Date().toISOString()).calendar!.events.filter(e => e.endsOn >= today).length;
  assert.ok(expectedLatest > expectedBefore, 'the fixture must actually add an upcoming meeting between snapshots');
  await withServer(database, async base => {
    const before = await fetch(`${base}/macro?asOf=${encodeURIComponent(cutoff)}`).then(r => r.json()) as any;
    assert.equal(before.data.calendar.fomc.events.length, expectedBefore);
    const latest = await fetch(`${base}/macro`).then(r => r.json()) as any;
    assert.equal(latest.data.calendar.fomc.events.length, expectedLatest);
  });
}));

test('the FRED key is added only to the fetched URL, never archived in source_payloads or worker_requests', async () => isolated(async database => {
  const sentinel = 'sentinel-test-key-should-never-be-archived';
  const previous = process.env.FRED_API_KEY;
  process.env.FRED_API_KEY = sentinel;
  try {
    const job = macroJobs[0];
    await configureWorker(database, [job]);
    await database.query('update worker_provider_state set tokens=1,updated_at=clock_timestamp(),blocked_until=null where provider_id=$1', [job.provider]);
    await database.query('insert into worker_runs (job_id,scheduled_at) values ($1,clock_timestamp())', [job.id]);
    const claimed = await claim(database); assert.ok(claimed);
    let fetchedUrl = '';
    const result = await executeRun(database, claimed, job, async (url: any) => { fetchedUrl = String(url); return new Response(JSON.stringify(fredPayload())); });
    assert.equal(result.status, 'succeeded');
    assert.ok(fetchedUrl.includes(`api_key=${sentinel}`), 'the key must reach the actual fetch');
    const rows = await database.query('select endpoint, raw_body from source_payloads');
    for (const row of rows.rows) { assert.ok(!row.endpoint.includes('api_key'), row.endpoint); assert.ok(!row.endpoint.includes(sentinel), row.endpoint); assert.ok(!String(row.raw_body ?? '').includes(sentinel)); }
    const requests = await database.query('select endpoint from worker_requests');
    for (const row of requests.rows) { assert.ok(!row.endpoint.includes('api_key'), row.endpoint); assert.ok(!row.endpoint.includes(sentinel), row.endpoint); }
  } finally { if (previous === undefined) delete process.env.FRED_API_KEY; else process.env.FRED_API_KEY = previous; }
}));
