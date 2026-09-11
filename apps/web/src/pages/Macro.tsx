import { useMemo } from 'react';
import { useData, Status } from '../api';
import { ResearchChart } from '../components/ResearchChart';

type Point = { observedAt: string; value: number | null };
type SeriesBlock = { refused: boolean; unavailable: boolean; message: string | null; points: Point[]; latest: Point | null;
  coverage: { seriesId: string; source: string; first: string | null; last: string | null; values: number; missing: number; replayCoverageStart: string | null; classification: string } | null };
type CalendarEvent = { eventType: string; title: string; startsOn: string; endsOn: string; sep: boolean | null; sourceUrl: string; methodologyVersion: string };
type CalendarBlock = { unavailable: boolean; refused: boolean; message: string | null; recordedAt: string | null; events: CalendarEvent[]; note?: string };
type Macro = {
  brazil: { cdi: SeriesBlock & { annualized: Point[] }; ptax: SeriesBlock };
  usMacro: { dfii10: SeriesBlock; dtwexbgs: SeriesBlock; sp500: SeriesBlock; nasdaqcom: SeriesBlock };
  calendar: { fomc: CalendarBlock; cpi: CalendarBlock; employment: CalendarBlock; gdp: CalendarBlock; pce: CalendarBlock; copom: CalendarBlock };
  refusals: { block: string; message: string }[];
  methodology: { cdi: string; ptax: string; usMacro: string; calendar: string };
};

const colors = ['#e8ba68', '#71bcdf', '#b399e2', '#70bca6', '#ce879b'];
const num = (v: number | null | undefined, digits = 2) => v == null ? 'Unavailable' : v.toLocaleString('en-US', { maximumFractionDigits: digits });
const pct = (v: number | null | undefined, digits = 2) => v == null ? 'Unavailable' : `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: digits })}%`;

function seriesChart(block: SeriesBlock, title: string, color: string, attribution: string) {
  if (block.refused) return <p role="alert">{title}: replay refused before this feed's coverage began ({block.message}).</p>;
  if (block.unavailable) return <p>{title}: unavailable.</p>;
  const x = block.points.map(p => Date.parse(p.observedAt) / 1000);
  return <ResearchChart title={title} x={x} lines={[{ label: title, color, values: block.points.map(p => p.value) }]} syncKey="macro-time" height={230} attribution={attribution} />;
}

function CalendarSection({ label, block, gatedNote }: { label: string; block: CalendarBlock; gatedNote: string }) {
  if (block.note) return <div className="macro-calendar-source"><h3>{label}</h3><p>{block.note}</p></div>;
  if (block.refused) return <div className="macro-calendar-source"><h3>{label}</h3><p role="alert">Replay refused before this feed's coverage began ({block.message}).</p></div>;
  if (block.unavailable) return <div className="macro-calendar-source"><h3>{label}</h3><p>{gatedNote}</p></div>;
  return <div className="macro-calendar-source"><h3>{label}</h3>
    {block.events.length === 0 ? <p>No upcoming events archived.</p> : <ul>
      {block.events.map(e => <li key={`${e.eventType}-${e.startsOn}`}>
        {e.startsOn === e.endsOn ? e.startsOn : `${e.startsOn} – ${e.endsOn}`}: {e.title}{e.sep ? ' (SEP)' : ''}{' '}
        <a href={e.sourceUrl} target="_blank" rel="noreferrer">source</a>
      </li>)}
    </ul>}
  </div>;
}

export function Macro() {
  const { result, loading, error, reload } = useData<Macro>('/macro');
  const d = result?.data;
  const cdiChart = useMemo(() => {
    if (!d || d.brazil.cdi.refused || d.brazil.cdi.unavailable) return null;
    const x = d.brazil.cdi.points.map(p => Date.parse(p.observedAt) / 1000);
    return { x, raw: [{ label: 'CDI daily rate (%/business day)', color: colors[0], values: d.brazil.cdi.points.map(p => p.value) }],
      annualized: [{ label: 'CDI annualized ((1+d/100)^252-1)', color: colors[1], values: d.brazil.cdi.annualized.map(p => p.value) }] };
  }, [d]);

  if (loading) return <p>Loading macro data…</p>;
  if (error || !d) return <p role="alert">Unable to load macro data. <button onClick={reload}>Try again</button></p>;

  return <div className="macro-workspace">
    <div className="macro-intro"><span className="eyebrow">MACRO</span><h2>CDI, USD/BRL and US macro context</h2>
      <p>{d.methodology.cdi}</p></div>
    <Status metadata={result?.metadata} />

    <section className="panel" aria-label="Brazil">
      <h2>Brazil</h2>
      <p>{d.methodology.cdi} This is the opportunity-cost benchmark for any capital not deployed into a strategy: idle capital in Brazil earns CDI, not zero.</p>
      {d.brazil.cdi.refused ? <p role="alert">CDI: replay refused before this feed's coverage began ({d.brazil.cdi.message}).</p>
        : d.brazil.cdi.unavailable ? <p>CDI: unavailable.</p>
        : <>
          <div className="btc-kpis">
            <div><span>Latest CDI (daily)</span><strong>{pct((d.brazil.cdi.latest?.value ?? null) !== null ? d.brazil.cdi.latest!.value! / 100 : null, 4)}</strong></div>
            <div><span>Latest CDI (annualized)</span><strong>{pct(d.brazil.cdi.annualized.at(-1)?.value ?? null)}</strong></div>
            <div><span>Archived days</span><strong>{d.brazil.cdi.coverage?.values ?? 0}</strong></div>
          </div>
          {cdiChart && <>
            <ResearchChart title="CDI daily rate" x={cdiChart.x} lines={cdiChart.raw} syncKey="macro-time" height={210} attribution="Banco Central do Brasil (SGS 12) · Public data" />
            <ResearchChart title="CDI annualized" x={cdiChart.x} lines={cdiChart.annualized} syncKey="macro-time" height={210} attribution="(1+d/100)^252-1, business days only" />
          </>}
        </>}
      <p>{d.methodology.ptax}</p>
      {seriesChart(d.brazil.ptax, 'USD/BRL PTAX (sell)', colors[2], 'Banco Central do Brasil (SGS 1) · Public data')}
    </section>

    <section className="panel" aria-label="US Macro">
      <h2>US Macro</h2>
      <p>{d.methodology.usMacro}</p>
      {seriesChart(d.usMacro.dfii10, 'Real 10Y yield (DFII10)', colors[0], 'FRED DFII10 · St. Louis Fed')}
      {seriesChart(d.usMacro.dtwexbgs, 'Broad USD index (DTWEXBGS)', colors[1], 'FRED DTWEXBGS · St. Louis Fed, published weekly')}
      {seriesChart(d.usMacro.sp500, 'S&P 500 (display only, 10-year provider window)', colors[3], 'FRED SP500 · St. Louis Fed, rolling 10-year history')}
      {seriesChart(d.usMacro.nasdaqcom, 'NASDAQ Composite', colors[4], 'FRED NASDAQCOM · St. Louis Fed')}
    </section>

    <section className="panel" aria-label="Macro Calendar">
      <h2>Calendar</h2>
      <p>{d.methodology.calendar}</p>
      <CalendarSection label="FOMC meetings" block={d.calendar.fomc} gatedNote="Not yet archived." />
      <CalendarSection label="CPI release dates" block={d.calendar.cpi} gatedNote="Gated: FRED key not configured." />
      <CalendarSection label="Employment Situation release dates" block={d.calendar.employment} gatedNote="Gated: FRED key not configured." />
      <CalendarSection label="GDP release dates" block={d.calendar.gdp} gatedNote="Gated: FRED key not configured." />
      <CalendarSection label="Personal Income and Outlays (PCE) release dates" block={d.calendar.pce} gatedNote="Gated: FRED key not configured." />
      <CalendarSection label="Copom meetings" block={d.calendar.copom} gatedNote="Not yet sourced." />
    </section>

    {d.refusals.length > 0 && <section className="panel"><h2>Refused blocks</h2><ul>
      {d.refusals.map(r => <li key={r.block}>{r.block}: {r.message}</li>)}
    </ul></section>}
  </div>;
}
