# Planned work — CDI/macro feeds and Python signal research

Recorded 2026-09-11. Two plans agreed with the user during the same session,
in execution order. Stage A is approved and about to be implemented on the
current stack; Stage B is parked until Stage A ships and a free `FRED_API_KEY`
is obtained.

**Revised 2026-09-11 after a critical review.** Every correction below was
checked against the code or a live probe the same day. Main changes:

- CDI accrues on **business days only** (252/year). The original "carry the
  prior rate over weekends" was wrong and would have inflated the hurdle from
  13.9% to 20.7%/yr at the current rate.
- The FRED key is passed only in the URL, and endpoints are archived in
  append-only tables. The key must be added **at request time only**, never
  stored in `job.endpoint`.
- `SP500` on FRED is capped at 10 years (first value 2016-09-12); `NASDAQCOM`
  is added (history from 1971-02-05).
- "These FRED series are never revised" was an unverified assertion that
  contradicted `INVESTMENT_RESEARCH_PLAN.md` §3/§5. It is replaced by a real
  `series/vintagedates` probe.
- The macro calendar is built from **real sources** (the official FOMC
  calendar page and FRED release dates) and stored as snapshots, instead of
  an empty table with frozen rows.
- USD/BRL PTAX is added: Stage B accounts in **BRL**, and the original excess-return
  formula mixed a USD return with a BRL return.
- Stage B moves from a buy-only pool to a **daily target allocation**. The
  objective keeps Sharpe but adds an exposure-matched guardrail. Publication
  lags, stationary features, fixed folds, controls for trying many configs,
  and a stricter exit rule are added. Python no longer fetches data; everything
  comes from the Stage A archive.

---

## Stage A (active): CDI, USD/BRL and US macro data — production feeds and a new Macro tab

### Context

Before the Python ML research (Stage B, parked below), the user wants CDI,
USD/BRL and US macro data **in the current stack**, ingested the same way
every other feed in this project is: archived, versioned and replay-guarded.
The user also wants a new frontend tab showing these series and a calendar of
upcoming important US macro dates (FOMC meetings and major data releases).
This unblocks the future ML export (same archive, same `readSeries`). It also
works on its own as a context panel next to BTC Cycles, following the Fear &
Greed precedent (`apps/api/src/feeds/sentiment.ts`,
`apps/api/src/btc/sentiment.ts`).

### Capability findings (probed 2026-09-11)

**CDI: usable, free, no key.**
`GET https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=DD/MM/AAAA&dataFinal=DD/MM/AAAA`
returns the **daily** CDI rate as a percent **per business day** (e.g.
`0.051660` = 0.051660% for that business day, Aug–Sep 2026). History is
confirmed back to 2010. **Hard cap: 10-year window per request** (probed: a
2010–2026 request returns a 406 naming this limit), so a deep backfill must be
paged in ≤10-year chunks. **Business days only, and that is how CDI accrues:**
weekends and Brazilian holidays earn nothing. Annualized rate = `(1 + d/100)^252 − 1`.
Probe: 0.051660%/day → **13.9%/yr**. Compounding the same rate over 365
calendar days would wrongly give 20.7%/yr. Never forward-fill CDI in the
archive or in any accrual.

**USD/BRL PTAX: usable, free, no key.** Same SGS endpoint, series `1`
(PTAX sell rate, BRL per USD). Probe: `5.1149` on 2026-09-10. Business days
only (probe: 2026-09-07 holiday absent). Needed because Stage B accounts in BRL.

**US macro (FRED): half-wired, gated on a key.** `sources` already has a
`fred` row (migration `0006`, license note "Series-specific terms; verify
before use"). `docs/data/quota-budget.json` already reserves a `fred` provider
(`enabled: false`). Turning it on needs a **free `FRED_API_KEY`**
(self-service, <https://fred.stlouisfed.org/docs/api/api_key.html>; not set in
this environment). Probed coverage via FRED's public CSV:

| Series | First value | Notes |
|---|---|---|
| `DFII10` | 2003-01-02 | H.15, daily. Missing days are marked `"."` (probe: blank on 2026-09-07) |
| `DTWEXBGS` | 2006-01-02 | H.10, **published weekly**: on 2026-09-11 the latest value was 2026-09-04 |
| `SP500` | **2016-09-12** | FRED note: "10 years of daily history for Standard & Poors and Dow Jones Averages series". Rolling window: old values disappear from the provider |
| `NASDAQCOM` | 1971-02-05 | Full history; added as the long-history equity series |

**Revisions have not been verified.** The earlier claim that these series are
"published once, not revised" was never probed. It contradicts
`INVESTMENT_RESEARCH_PLAN.md` ("need a free FRED key and successful vintage
checks"; "Use ALFRED vintages for macro inputs in historical tests") and the
budget note ("Verify license and vintage coverage per series"). Once the key
exists, call `fred/series/vintagedates` for each of the four series and record
the result in this document. Until then, backfilled FRED history is
`historical-reconstruction` (already the default classification). Real
point-in-time coverage starts with the first live archive run.

**Vintage probe results (recorded 2026-09-11, `fred/series/vintagedates`):**

| Series | Vintage dates | First | Last |
|---|---|---|---|
| `DFII10` | 5,088 | 2005-10-12 | 2026-09-10 |
| `DTWEXBGS` | 397 | 2019-02-04 | 2026-09-08 |
| `SP500` | 0 | — | — |
| `NASDAQCOM` | 2,996 | 2014-05-19 | 2026-09-10 |

Raw counts only — **not yet interpreted as revision-vs-extension**. A FRED
vintage date fires both when a past value is corrected and when the series is
simply extended with a new observation; telling these apart requires pulling
at least two vintages for the same `observation_date` and diffing the value,
which was not done in this pass. The counts are at least consistent with
"mostly extension, not correction" for the three daily/weekly series (rough
publication-count order of magnitude for their date ranges), and `SP500`
returning zero vintages confirms FRED does not track point-in-time history
for it at all — consistent with its rolling-10-year, display-only treatment
above. Treat backfilled history for all four series as
`historical-reconstruction` until an actual revision diff is run; this is a
real open item, not resolved by the counts alone.

**FRED release IDs resolved 2026-09-11** via a live `fred/releases` probe
(332 releases returned, matched by exact name, not hardcoded from memory):
`10`=Consumer Price Index, `50`=Employment Situation, `53`=Gross Domestic
Product, `54`=Personal Income and Outlays.

**FRED key handling (security).** FRED accepts the key only as the
`api_key` query parameter. The worker writes `job.endpoint` to
`source_payloads.endpoint` and `worker_requests.endpoint`, and
`source_payloads` is append-only (`reject_archive_mutation`). A key embedded
in `job.endpoint` would therefore be stored permanently and could never be
removed. The key must be added **only to the URL passed to `fetch`**, at
request time.

**FOMC meeting calendar: official page, no RSS/ICS.** The Fed publishes no
calendar-specific RSS or ICS feed. The official page
<https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm> is
reachable and lists the **2026 and 2027** meetings in regular HTML (probe
parsed 2026: January 27-28, March 17-18\*, April 28-29, June 16-17\*, …; `*`
marks a meeting with a Summary of Economic Projections). Scraping this page
with its URL and payload sha256 as evidence is an official, verifiable source.
Hand-recalled dates remain forbidden: **never write FOMC dates from memory
into a migration or seed.**

**Data release dates: FRED `fred/release/dates`.** It returns scheduled dates
for a release (CPI, Employment Situation, GDP, Personal Income and Outlays /
PCE). Future scheduled dates are returned **only with
`include_release_dates_with_no_data=true`** (parameter confirmed in the FRED
docs). Release IDs must be resolved with a `fred/releases` probe once the key
exists, not hardcoded from memory.

**Copom (Brazil) meeting dates:** not researched in this pass.

### Migration `0014_macro.sql`

- `sources`: insert `bcb` (`Banco Central do Brasil`, `https://api.bcb.gov.br`,
  license note that SGS data is public) and `federalreserve`
  (`Board of Governors of the Federal Reserve System`,
  `https://www.federalreserve.gov`, public-domain US government
  publication). `fred` already exists, so no insert.
- `metric_definitions`, all `scope='macro_indicator'`, `asset_id` null,
  mirroring the Fear & Greed precedent:
  - `cdi_daily_rate` (unit `pct_per_business_day`)
  - `usd_brl_ptax_sell` (unit `brl_per_usd`)
  - `real_yield_10y` (DFII10, unit `pct`)
  - `broad_usd_index` (DTWEXBGS, unit `index`)
  - `sp500_index` (SP500, unit `index`)
  - `nasdaq_composite_index` (NASDAQCOM, unit `index`)
- Widen the existing `data_series_subject_scope` check (already widened for
  `crypto_market_sentiment` in `0013`) to also allow `'macro_indicator'`.
- Calendar, stored as **append-only snapshots** rather than frozen event rows,
  because schedules change (emergency meetings, releases delayed by a
  government shutdown). A later snapshot must never change an earlier
  point-in-time answer:
  - `macro_calendar_snapshots` (id, `source_id` → `sources`, `payload_id` →
    `source_payloads`, `recorded_at`).
  - `macro_calendar_events` (id, `snapshot_id` → snapshots, `event_type`
    check in `('fomc-meeting','copom-meeting','cpi-release',
    'employment-release','gdp-release','pce-release')`, `title`,
    `starts_on date`, `ends_on date`, `sep boolean` (FOMC only, null
    otherwise), `source_url`, `methodology_version`).
  - Both tables get the `reject_archive_mutation()` trigger.
  - Use **`date`, not `timestamptz`**: neither source provides a time of day,
    so none is invented.

### Worker changes

- **`apps/api/src/discovery/worker.ts` (`executeRun`):**
  - For `job.provider === 'fred'`, append `api_key=${process.env.FRED_API_KEY}`
    only to the URL passed to `fetchImpl` (next to the existing CoinGecko
    header injection). `job.endpoint`, which is what gets archived, stays
    key-free.
  - Error messages must never include the request URL (the existing
    `'Network request failed'` already doesn't).
- **`apps/api/src/discovery/providers.ts` (`DiscoveryJob`):** add optional
  `responseFormat?: 'json' | 'text'` (default `'json'`). For `'text'`,
  `executeRun` skips the JSON check, passes the raw body to `parse`, and sends
  `Accept: text/html`. `source_payloads.raw_body` already keeps provenance.
  Confirm the FOMC page serves without a redirect (the worker uses
  `redirect: 'error'`).
- **Calendar archiving:** `parse` returns calendar events alongside (or instead
  of) series. Extend the sample shape and `discovery/archive.ts` so a calendar
  snapshot and its events are written in the same transaction as the payload.
  Confirm the exact shape against `archiveDiscovery` when implementing.

### Worker feeds

- `apps/api/src/feeds/bcb.ts` (new, mirrors `feeds/sentiment.ts`): `cdiSeriesId`,
  `ptaxSeriesId`, one shared `parseSgs` (BCB `DD/MM/AAAA` → UTC date label;
  strictly ascending; positive finite values; excludes the same-day value;
  rejects malformed payloads), and `bcbJobs: DiscoveryJob[]` (CDI and PTAX,
  daily). Both use the existing **`request` hook** (precedents:
  `feeds/venue.ts`, `feeds/spot.ts`) to compute dynamic `DD/MM/AAAA` windows:
  while the archive has not reached 2010-01-01, fetch the oldest missing
  ≤10-year chunk; after that, fetch a 400-day recent window. Confirm that
  business-day absences are not recorded as archive gaps.
- `apps/api/src/feeds/macro.ts` (new): `macroSeriesId(code)`, `parseFred`
  (FRED `series/observations` JSON → points; **`"."` values are skipped**, not
  stored and not forward-filled), and `macroJobs: DiscoveryJob[]` with one
  daily job each for `DFII10`, `DTWEXBGS`, `SP500` and `NASDAQCOM`.
  Endpoint:
  `https://api.stlouisfed.org/fred/series/observations?series_id=<code>&file_type=json&observation_start=2010-01-01`,
  resending that window daily and relying on `appendSeries` to dedupe, like
  Fear & Greed.
- `apps/api/src/feeds/calendar.ts` (new):
  - `fomcCalendarJob`: provider `federalreserve`, weekly,
    `responseFormat: 'text'`. `parseFomcCalendar` extracts year, month, day
    range and the SEP marker. It **throws if zero meetings parse for the
    current year** (so a layout change fails loudly instead of archiving an
    empty calendar).
  - `fredReleaseDateJobs`: one weekly job per release (CPI, Employment
    Situation, GDP, Personal Income and Outlays), using
    `fred/release/dates?release_id=<id>&include_release_dates_with_no_data=true&file_type=json`.
    IDs come from the `fred/releases` probe.
- **Job list:** FRED jobs (series and release dates) join the worker's list
  **only when `process.env.FRED_API_KEY` is set**:
  `...(process.env.FRED_API_KEY ? [...macroJobs, ...fredReleaseDateJobs] : [])`.
  BCB and FOMC jobs are always on.
- **`docs/data/quota-budget.json`,** in the same commit
  (`configureWorker` in `discovery/queue.ts` throws
  `Provider not enabled in budget` otherwise):
  - `bcb` (new): 2 requests/day (CDI + PTAX, 62 per 31 days),
    `bootstrapRequests: 4` (two ≤10-year chunks per series), local limit
    5/minute, 100/month.
  - `federalreserve` (new): 1 request/week (~5/month), local limit 1/minute,
    10/month.
  - `fred`: set `enabled: true`. Replace the reserved
    `three-series-vintage-window` job with the real jobs: 4 series × 1/day
    plus 4 release-date calls × 1/week ≈ 144 per 31 days, under the existing
    250/month local limit. Set `bootstrapRequests: 13` (4 series, 4 release
    calls, 4 `series/vintagedates` probes, 1 `fred/releases` probe).
- Wire everything into `apps/api/src/worker.ts` and
  `apps/api/test/browser-server.ts` (fixture payloads, including a saved FOMC
  HTML fixture).

### Server — `apps/api/src/macro/` (new directory, mirrors `apps/api/src/btc/`)

- `macro/view.ts`: `macroView(database, asOf)` reads each block independently,
  so one feed's refusal or absence doesn't blank the others (same `block` /
  `refusals` pattern as `backtest/archive.ts` and `altcoin/archive.ts`):
  - `brazil.cdi`: raw business-day points plus the derived annualized rate
    `(1+d/100)^252−1`.
  - `brazil.ptax`.
  - `usMacro.{dfii10, dtwexbgs, sp500, nasdaqcom}` via `readSeries`.
  - `calendar`: for each calendar source, the latest snapshot with
    `recorded_at ≤ asOf` (or now), keeping events with `ends_on ≥` the cutoff
    date, sorted ascending. A source with no snapshot yet is reported as
    `unavailable` (e.g. FRED releases without a key), not as "no events".
  - Plus `methodology` and `coverage`.
- `macro/routes.ts`: `GET /api/v1/macro` (guarded `asOf`), wired into
  `server.ts` next to the other route modules.

### Frontend — new "Macro" tab

- `apps/web/src/pages/Macro.tsx` (new), three sections:
  - **US Macro:** four `ResearchChart`s (real 10Y yield, broad USD index,
    S&P 500 with a note about its 10-year provider window, NASDAQ Composite),
    each with FRED attribution. When no key is configured, an honest
    "unavailable: FRED key not configured" state.
  - **Brazil:** CDI (current daily rate, annualized rate and chart; plain-language
    note that this is the opportunity-cost benchmark for the research work) and
    USD/BRL PTAX (chart).
  - **Calendar:** upcoming events sorted by date, with type, SEP marker for
    FOMC and a source link. States are per source: FOMC always attempted;
    FRED releases shown as gated without a key; Copom listed as "not yet
    sourced".
- `apps/web/src/main.tsx`: add `{ id: "macro", label: "Macro" }` to the nav
  and `Page` type, render `<Macro />`.

### What ships now vs. what's honestly deferred

| Piece | This pass |
|---|---|
| CDI daily series | ✅ live feed |
| USD/BRL PTAX | ✅ live feed |
| DFII10 / DTWEXBGS / SP500 / NASDAQCOM | ✅ live feed, gated on `FRED_API_KEY` |
| FRED vintage check per series | ✅ one-off `series/vintagedates` probe, result recorded here |
| FOMC meeting dates | ✅ weekly scrape of the official calendar page, snapshot-archived |
| CPI/NFP/GDP/PCE release dates | ✅ FRED `release/dates` with future dates, gated on `FRED_API_KEY` |
| Copom (Brazil) meeting dates | ❌ not researched this pass |

**Implementation and live verification, recorded 2026-09-11.** Stage A shipped in
this session: migration `0014_macro.sql`, `feeds/bcb.ts`/`feeds/macro.ts`/
`feeds/calendar.ts`, `macro/view.ts`/`macro/routes.ts`, the Macro frontend tab,
and a Keychain-backed launch wrapper (`apps/api/scripts/run-worker.sh`) so
`FRED_API_KEY` is pulled from macOS Keychain at worker start, never written to
`.env` or the plist. Verified against the real running worker and the real
local API server (not just fixtures):

- BCB CDI backfilled to 2010-01-04 (4,192 points); latest 2026-09-10 =
  `0.05166`%/day, annualizing to `13.8999%`/yr via `(1+d/100)^252-1` — matches
  this document's earlier probe exactly.
- BCB PTAX backfilling (reached 2016-09-26 so far; continues on its own daily
  schedule); latest 2026-09-10 = `5.1149`, also matching the earlier probe.
- FRED DFII10/DTWEXBGS/NASDAQCOM backfilled to 2010-01-04; SP500 correctly
  capped at its 2016-09-12 provider window (`unavailable:false`, display-only,
  not a feature elsewhere).
- FOMC calendar scraped live: 11 upcoming meetings across 2026–2027 with
  correct SEP markers, matching this document's earlier probe.
- CPI/Employment/GDP/PCE release-date jobs succeeded live with real FRED
  release IDs (10/50/53/54, resolved via a live `fred/releases` probe this
  session — see the Stage A body above for the full vintage-probe results).
- Key-leak guard confirmed on real archived rows, not just the test suite:
  zero `source_payloads.endpoint` or `worker_requests.endpoint` rows for the
  `fred` source contain `api_key` or the literal key.
- One transient `bcb` "Network request failed" on the first live attempt for
  each BCB job self-healed on the existing retry/backoff path (attempts=2,
  succeeded) — not a bug, the mechanism worked as designed.
- Full test suite: 139 unit + 70 integration (`apps/api`), 21/21 Playwright
  scenarios (`apps/web`, including two new Macro-tab scenarios), all passing
  against a real Postgres (not mocked).

### Tests

- `apps/api/src/feeds/bcb.test.ts`: SGS parsing (date labels, ascending
  order, value ranges, same-day exclusion, malformed payload rejection);
  request-hook chunk selection (oldest missing ≤10-year window during
  backfill, 400-day window afterwards); annualization uses 252 business days.
- `apps/api/src/feeds/macro.test.ts`: FRED parsing, `"."` skipped, malformed
  payload rejected.
- `apps/api/src/feeds/calendar.test.ts`: FOMC HTML fixture parses the
  expected meetings and SEP markers; a layout-changed fixture is rejected;
  FRED release-dates parsing including future dates.
- `apps/api/src/macro/view.test.ts`: independent refusal per block;
  unavailable calendar source vs. empty calendar kept distinct.
- `apps/api/test/macro.test.ts` (integration):
  - migration applied;
  - worker archives synthetic BCB, FRED and FOMC payloads;
  - `GET /api/v1/macro` returns populated blocks;
  - a cutoff before coverage is refused per block, not for the whole route;
  - **calendar replay**: a later snapshot doesn't change an earlier `asOf`
    answer;
  - **key-leak guard**: with `FRED_API_KEY` set to a sentinel value, no row in
    `source_payloads` (`endpoint`, `raw_body`) or `worker_requests.endpoint`
    contains `api_key` or the sentinel;
  - `configureWorker` accepts the new budget entries.
- Bump `apps/api/scripts/test.mjs` minimums; add one browser scenario for the
  Macro tab (mirrors the Fear & Greed browser-server fixture pattern).

### Verification

1. `pnpm --filter @crypto-panel/api build && pnpm --filter @crypto-panel/web build`.
2. `pnpm --filter @crypto-panel/api test`; `TEST_DATABASE_URL=… test:db`.
3. `pnpm --filter @crypto-panel/api db:migrate` locally → `0014` applied.
4. Rebuild + restart the worker (`launchctl kickstart -k …`).
5. Without `FRED_API_KEY`: confirm FRED jobs are absent from the schedule and
   the Macro tab shows US macro and FRED releases as unavailable, not broken.
6. Confirm real CDI and PTAX acquisitions against the live BCB endpoint. The
   backfill reaches 2010 in ≤4 requests, and the annualized CDI on the tab
   matches `(1+d/100)^252−1`.
7. Confirm a real FOMC calendar acquisition: the 2026 and 2027 meetings appear
   with SEP markers and a source link.
8. With a real key exported:
   - DFII10/DTWEXBGS/SP500/NASDAQCOM acquisitions succeed;
   - release IDs are resolved via `fred/releases` and release-date jobs return
     future dates;
   - the `series/vintagedates` results for all four series are recorded in this
     document;
   - the archived `endpoint` values contain no key.
9. `pnpm --filter @crypto-panel/web exec playwright test`.
10. Commit; then resume the parked Python ML plan below, which exports
    everything from this archive.

---

## Stage B (parked): BTC signal research — Python, BRL/CDI-aware, offline-only

### Context

After the DCA matrix sweeps (see `docs/data/BACKTEST_LAB.md` and the
"BTC DCA Matrix" artifact, https://claude.ai/code/artifact/fe23fbca-0334-4057-b113-fe13334a6396),
the honest conclusion was that hand-picked fixed thresholds (Mayer≥2.4,
MVRV≤1.0) don't survive cross-cycle scrutiny. "Predict the cycle top" can't be
answered from ~4 historical halvings. Reframed as **risk-adjusted profit over
the user's real opportunity cost**, the problem becomes a short-horizon
allocation task. Two things must be modeled correctly:

- **Idle capital in Brazil earns CDI** (13.9%/yr annualized as of Aug–Sep
  2026; always read from the series, never a constant), not 0%.
- **The investor lives in BRL.** BTC is priced in USD, so the USD/BRL move is
  part of the return.

**Honest prior:** a robust, cost-surviving daily timing edge on BTC from these
features is unlikely. The most probable outcome is a documented negative
result. The phase is still worth running because it is cheap and the exit
criteria below are fixed before any result is seen.

**Decisions locked with the user (revised 2026-09-11):**

- **Currency:** accounting in **BRL** (primary), USD also reported.
  `r_btc_brl = (1 + r_btc_usd)(1 + r_usdbrl) − 1`, using PTAX. CDI is native
  BRL. The USD view converts CDI to USD the same way. **Go/no-go is judged in
  BRL only.**
- **Action space:** each day the policy sets a **target BTC share of total
  wealth** `w_t ∈ {0, 0.25, 0.5, 0.75, 1}`. It **can sell back into CDI**. A
  no-trade band applies: rebalance only when
  `|w_target − w_current| ≥ band`. Every rebalance pays a per-side cost on
  turnover `|Δw|`. The rest of the wealth earns CDI, and CDI earns **zero on
  non-business days**.
- **Contributions:** R$10,000 is credited to the CDI cash leg on day 1 of each
  month. Contributions are shown as an **illustrative wealth path** using the
  same `w_t`. They don't enter the objective, which is computed on time-weighted
  daily returns. Folds are therefore independent of accumulated holdings.
- **Objective (v1):** maximize the annualized **Sharpe ratio of daily BRL excess
  return over CDI**:
  `e_t = w_t·(r_btc_brl,t − r_cdi,t) − c·|Δw_t|`,
  `Sharpe = mean(e)/std(e)·√365`.
  - **Guardrail, required for go:** Sharpe is scale-invariant, so a rule that
    is rarely invested can win on Sharpe while earning less. The model must
    therefore also beat a **constant mix at its own average `w`**.
  - Always reported, not constrained: ending BRL wealth, CAGR, max drawdown,
    average `w`, turnover.
- **Precise language on RL:** the sizing layer is a *score-conditioned
  allocation rule*. Its thresholds and no-trade band are tuned by walk-forward
  grid search on historical replay. That is **direct policy search over a rule
  with a few parameters**: a close relative of reinforcement learning, but with
  no value function, no learned simulator and no PPO/DQN. The only link between
  days is transaction cost. (Earlier drafts called this "contextual-bandit-style".
  That label is dropped: it would have been inaccurate under the original
  buy-only pool, where today's deployment changes tomorrow's available cash.)
- **Stack:** all modeling and research in **Python**, fully isolated from the
  Node/TS app: no production DB writes, no migration, no worker job, no
  Backtest Lab change in this phase. TS's only role is exporting archived data
  to CSV. **Python never touches Postgres and makes no network calls.**
- **Scope v1:** BTC only, plus CDI, USD/BRL and US macro as context features.
  No cross-asset data yet.
- **Taxes:** not modeled in v1, on either side. The report states the gap
  (Brazil: 15% on BTC gains when monthly sales exceed R$35k; IR on
  CDI-indexed fixed income 15–22.5% by holding period). The gap matters
  because the policy can sell.
- **Research only:** the deliverable is a walk-forward report with an explicit
  go/no-go verdict, not a shipped feature. Phase 2 (serving) is out of scope and
  undecided until Phase 1 clears the exit criteria.

### Data inputs (all from the Stage A archive)

Every series comes from the archive through the export script: raw
observations only, stamped with their observation date and never filled.
Python applies the **publication lags** below before any as-of join, so a
feature at decision day *t* only uses values that were actually published by
the end of *t−1*.

| Series | Role | Lag applied to features |
|---|---|---|
| BTC close, Mayer, SMA200, MVRV, weekly RSI, regime, Fear & Greed (`loadRegimeInputs`) | returns + features | none beyond the engine's existing *t−1* convention |
| CDI (SGS 12) | accrual + feature | +1 business day (feature). Accrual on day *t* uses *t*'s rate, which is set in advance by the Selic target |
| USD/BRL PTAX (SGS 1) | BRL conversion + feature | +1 business day (feature) |
| `DFII10` | feature | +1 business day (H.15) |
| `DTWEXBGS` | feature | **+10 calendar days** (weekly H.10 publication) |
| `NASDAQCOM` | feature | +1 day |
| `SP500` | **not a feature** | history starts 2016-09-12 (FRED 10-year cap); display only |

Stated approximations:

- PTAX is fixed at ~13:00 BRT while BTC's daily close is 00:00 UTC. The
  timestamps are therefore not aligned within the day.
- On weekends PTAX is frozen, so the weekend FX move lands on the next business
  day.
- Backfilled FRED history is the latest revised data, not what was known at
  the time. Lags fix publication delays, not revisions. The Stage A
  `series/vintagedates` result decides whether that caveat is minor (no or
  immaterial revisions) or requires ALFRED vintages before Stage B runs.

### Repo layout — new, isolated Python project

`research/btc-signal/` (not part of the pnpm workspace, own `requirements.txt`
or `pyproject.toml`: pandas, numpy, scikit-learn, lightgbm, matplotlib; **no
HTTP client**):

```
research/btc-signal/
  data/                    # gitignored CSV exports from TS (never fetched by Python)
  src/
    features.py            # load exports, apply publication lags, as-of joins, causal features
    labels.py              # 30d forward BRL log excess-return target
    walkforward.py         # expanding-window folds, 30d purge, inner tuning window, holdout
    portfolio.py           # daily BRL/USD wealth sim: target w, no-trade band, cost, 252-day CDI accrual
    policy.py              # score percentile -> target w rule, grid over cutoffs + band
    model.py               # ridge (baseline of record), LightGBM (challenger)
    evaluate.py            # Sharpe, baselines, block bootstrap, random-timing test, DSR, per-fold report
  scripts/
    run_experiment.py      # entry point: load -> features -> walk-forward -> report + trial log
  README.md                # exact repro steps, python version, how to produce the exports
```

#### Data bridge (TS owns Postgres, Python never touches it)

New `apps/api/scripts/export-ml-features.mts`, run once (or re-run to refresh),
writes two dated files:

- `research/btc-signal/data/btc_signals_<date>.csv`: reuses `loadRegimeInputs`
  (`apps/api/src/backtest/archive.ts`) to get the same `signals` array the
  backtest engine uses (`observedAt, close, regime, mayer, sma200, mvrv,
  weeklyRsi, fearGreed`).
- `research/btc-signal/data/macro_observations_<date>.csv`: long format
  (`series, observed_on, value`) with the raw archived observations for CDI,
  PTAX, DFII10, DTWEXBGS, SP500 and NASDAQCOM via `readSeries`. No wide join,
  no fill: lags and as-of joins happen in Python.

This is the **only** new TS code in this phase: no migration, no new job, no
route.

### Features (v1)

All causal at decision day *t*, after the publication lags above:

- **BTC:**
  - log returns (1/7/30/90d) and realized volatility (30/90d), computed in BRL;
  - Mayer multiple, raw **and** rolling percentile-rank over a trailing 3-year
    window. Raw Mayer/MVRV ceilings fall cycle over cycle, so the
    self-normalizing version is a first-class feature;
  - MVRV, raw and rolling 3-year percentile-rank;
  - weekly Wilder RSI;
  - confirmed regime (one-hot: bullish/bearish/transitional);
  - Fear & Greed, with an explicit missing-indicator before 2018-02-01 (no
    imputation).
- **Brazil:**
  - CDI level (annualized, 252-day) and 90d change. A higher hurdle should
    make the model more reluctant to hold BTC, all else equal;
  - USD/BRL 30d log return.
- **US macro:** only stationary transforms, never raw index levels, which
  trend and go stale for the same reason fixed Mayer/MVRV thresholds did:
  - `DFII10` level + 30d change;
  - `DTWEXBGS` 30d change;
  - `NASDAQCOM` 30d log return + drawdown from its trailing 1-year high.

### Two-stage model

1. **Score model** (supervised):
   - **Target:** 30-day forward BRL log excess return over CDI,
     `log((1+R_btc_brl,30d)/(1+R_cdi,30d))`. The horizon N=30 is **fixed in
     advance**; changing it counts as extra configs tried.
   - **Baseline of record:** ridge regression, with features standardized on
     training-fold statistics.
   - **Challenger:** LightGBM, adopted only if it beats ridge out-of-sample
     under the same protocol. Don't add model capacity the data can't support.
2. **Allocation rule** (simple, auditable):
   - Score percentile maps to target `w` through a monotone bucket rule
     (`0 / 0.25 / 0.5 / 0.75 / 1`).
   - **Percentile cutoffs come from training-fold scores only.**
   - Cutoffs and the no-trade band are chosen by grid search on an **inner
     tuning window** (the last 12 months of each training window, after the
     purge), never on the test fold.
   - `portfolio.py` ports the accounting discipline of
     `apps/api/src/backtest/portfolio.ts` (no look-ahead, cost on every trade,
     no forward-fill of prices) to Python. It adds the BRL conversion, target
     allocation with a band, and business-day CDI accrual. Nothing is shared
     with the TS code, since the stacks are intentionally separate in this
     phase.

### Validation protocol

- **Folds:**
  - Training starts **2014-01-01** (excludes the illiquid Mt.Gox-era data) and
    the window grows with each fold. The first training window is 3 years.
  - **Test folds:** calendar years 2017, 2018, … 2024, plus
    2025-01-01 → 2025-09-10 (9 folds).
  - **Purge:** drop the last 30 days of each training window, since their
    labels overlap the test period.
  - Each fold's simulation starts fresh.
- **Final holdout:** 2025-09-11 → 2026-09-10, used **exactly once**, after
  every modeling decision is frozen. Never used to pick features, horizon,
  cutoffs or band.
- **Honest sample size:** 30-day labels overlap. There are ≈140 independent
  30-day observations before the holdout and ≈12 inside it. The holdout can
  catch a wrong sign; it cannot establish an edge on its own. The folds cover
  two full bull/bear transitions (2017→2018, 2021→2022) plus the 2023–2025
  advance. Read results accordingly.
- **Baselines**, all under identical BRL, 252-day CDI and cost accounting:
  - (a) 100% CDI. Its excess-return Sharpe is **undefined (0/0), not ≈0**,
    so "beating CDI" means mean excess return > 0 after costs;
  - (b) monthly DCA, buy on contribution and hold;
  - (b2) DCA spread evenly across the month;
  - (c) buy and hold, `w = 1`;
  - (d) **constant mix at the model's average `w`** (the exposure-matched
    guardrail);
  - (e) **random-timing test:** model scores shuffled within each fold, keeping
    the same bucket mix, 1,000 shuffles. It tests whether the score carries
    information beyond how much the policy is invested;
  - reference only, not a hurdle: lump sum with hindsight (it needs future
    contributions, so it can't actually be done).
- **Report per fold, not just cumulative:** an aggregate number can hide a
  strategy that only worked in one window.
- **Uncertainty:** circular block bootstrap (30-day blocks, 5,000 resamples)
  of ΔSharpe vs. (d) on pooled out-of-sample days.
- **Controls for trying many configs:** every config tried (feature set,
  cutoffs, band, model class) is appended to a trial log. The report shows the
  number of trials and the **Deflated Sharpe Ratio** of the selected config.
- **Cost sensitivity:** 25 bps per side headline; 50 and 100 bps always
  reported.

### Exit criteria (go/no-go, stated up front so we don't move the goalposts)

Phase 1 ends with a written verdict. **Go requires all of:**

1. In a majority of the 9 test folds, the model beats **both** (b) monthly
   DCA and (d) the exposure-matched constant mix on BRL Sharpe-vs-CDI, net of
   25 bps.
2. The block-bootstrap 90% CI of pooled out-of-sample ΔSharpe vs. (d) lies
   entirely above 0.
3. Random-timing test p < 0.05.
4. Criteria 1–2 still hold at 50 and 100 bps.
5. On the holdout, ΔSharpe vs. (d) is not negative.
6. Deflated Sharpe Ratio is reported (no fixed cutoff, but a DSR that doesn't
   support the headline must be called out in the verdict).

If any of 1–5 fails, Phase 1 stops as a documented negative result, and no
Phase 2 (serving) work starts.

### Explicit non-goals for this phase

- No PPO/DQN, no value-function RL, no learned-simulator agent. The allocation
  layer stays a rule with a few parameters, tuned by walk-forward grid search.
- No production DB/migration/worker/API/Backtest Lab changes (Stage A covers
  the feeds).
- No macro beyond the series listed above. No CPI/GDP/employment *values*:
  those need ALFRED vintages and are a later step if the simple series prove
  useful.
- No event-date features (e.g. days to next FOMC) in v1, even though Stage A
  archives the calendar. They would add configs to test; that is a v2
  candidate.
- No cross-asset data yet. No tax modeling. No live execution. No shared code
  between `apps/api` and `research/btc-signal` beyond the CSV export.

### Verification

1. `apps/api/scripts/export-ml-features.mts` runs against the local archive:
   - `btc_signals_<date>.csv` has the expected row count (~5,900 BTC days from
     2010-07-18), with nulls only in documented places (Fear & Greed before
     2018-02-01, indicator warm-up windows);
   - `macro_observations_<date>.csv` contains raw observations only: CDI and
     PTAX on business days, DTWEXBGS showing its weekly publication, no filled
     rows.
2. `research/btc-signal`: `pip install -r requirements.txt` in a fresh venv,
   then `python scripts/run_experiment.py` runs end to end with no Postgres,
   no Node app and no network access.
3. Accounting unit checks:
   - compounding CDI daily over a year of business days reproduces
     `(1+d/100)^252−1`, and weekends accrue zero;
   - the BRL conversion matches `(1+r_usd)(1+r_usdbrl)−1`;
   - a `DTWEXBGS` observation is never visible to a feature before
     observation date + 10 days;
   - percentile cutoffs are computed without test-fold rows.
4. The walk-forward report shows, per fold and pooled:
   - model Sharpe-vs-CDI in BRL (USD alongside);
   - baselines (a)–(e);
   - ending BRL wealth, CAGR, max drawdown, average `w`, turnover;
   - sample count and cost sensitivity;
   - bootstrap CI, random-timing p-value, trial count and Deflated Sharpe
     Ratio;
   - the final go/no-go verdict against the exit criteria above.
