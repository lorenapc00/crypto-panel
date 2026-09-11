import { useMemo } from 'react';
import { useData } from '../api';
import { ResearchChart } from './ResearchChart';

type Point = { observedAt: string; value: number | null };
type CyclePoint = { day: number; date: string; value: number | null };
type Cycle = { date: string; height: number; points: CyclePoint[] };
type Sentiment = {
  points: Point[]; cycles: Cycle[]; latest: Point | null;
  methodology: { version: string; formula: string; coverage: string; cycles: string; sources: string[] };
  coverage: { source: string; first: string | null; last: string | null; values: number; missing: number; replayCoverageStart: string | null; classification: string };
};
const colors = ['#e8ba68', '#71bcdf', '#b399e2', '#70bca6', '#ce879b', '#aeb5c1', '#82a8ff'];
const num = (v: number | null | undefined) => v == null ? 'Unavailable' : v.toFixed(0);

export function FearGreedPanel() {
  const { result, loading, error, reload } = useData<Sentiment>('/btc/sentiment');
  const d = result?.data;
  const chart = useMemo(() => {
    if (!d) return null;
    const x = d.points.map(p => Date.parse(p.observedAt) / 1000);
    return { x, lines: [{ label: 'Fear & Greed Index (0-100)', color: colors[2], values: d.points.map(p => p.value) }] };
  }, [d]);
  const cycles = useMemo(() => {
    if (!d) return null;
    const covered = d.cycles.filter(c => c.points.length > 0);
    const maxDay = Math.max(0, ...covered.map(c => (c.points.at(-1)?.day ?? -1) + 1));
    const x = Array.from({ length: maxDay }, (_, i) => i);
    return { x, lines: covered.map((c, i) => { const byDay = new Map(c.points.map(p => [p.day, p.value])); return { label: c.date, color: colors[i % colors.length], values: x.map(day => byDay.get(day) ?? null) }; }) };
  }, [d]);
  if (loading) return <p>Loading Fear &amp; Greed Index…</p>;
  if (error || !d) return <section className="panel btc-method"><p role="alert">Fear &amp; Greed Index could not load. <button onClick={reload}>Retry</button></p></section>;
  return <>
    <section className="panel btc-method" aria-label="Fear and Greed Index">
      <div className="panelhead"><div><h2>Fear &amp; Greed Index</h2><span>Alternative.me · Daily · 0 = extreme fear, 100 = extreme greed</span></div></div>
      <div className="btc-kpis"><div><span>Latest value</span><strong>{num(d.latest?.value)}</strong></div>
        <div><span>Archived days</span><strong>{d.coverage.values}</strong></div>
        <div><span>Coverage starts</span><strong>{d.coverage.first?.slice(0, 10) ?? 'Unavailable'}</strong></div></div>
      <p>{d.methodology.formula}</p>
      <p>{d.methodology.coverage}</p>
      <p>Source: <a href={d.methodology.sources[0]} target="_blank" rel="noreferrer">Alternative.me</a>. Attribution required next to displayed values; this line is that attribution.</p>
    </section>
    {chart && chart.x.length > 1 && <ResearchChart title="Fear & Greed Index" x={chart.x} lines={chart.lines} syncKey="btc-time" height={210} attribution="Alternative.me · Attribution required next to displayed values" />}
    {cycles && cycles.x.length > 0 && <>
      <p>{d.methodology.cycles}</p>
      <ResearchChart title="Fear & Greed at equivalent cycle stage" x={cycles.x} lines={cycles.lines} time={false} syncKey="btc-cycles" height={230} attribution="Alternative.me · Historical reconstruction" />
    </>}
  </>;
}
