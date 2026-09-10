import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

type Line = { label: string; values: (number | null)[]; color: string };
type Band = { from: number; to: number; color: string };
const groups = new Map<string, Set<uPlot>>();
let synchronizing = false;
export function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResearchChart({ title, x, lines, log = false, time = true, syncKey, bands = [], annotations = [], height = 290,
  attribution = 'Coin Metrics Community · CC BY-NC 4.0 · Historical reconstruction' }:
  { title: string; x: number[]; lines: Line[]; log?: boolean; time?: boolean; syncKey?: string;
    bands?: Band[]; annotations?: { x: number; label: string }[]; height?: number; attribution?: string }) {
  const host = useRef<HTMLDivElement>(null), chart = useRef<uPlot | null>(null);
  const visibleRange = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!host.current || x.length < 2) return;
    const number = (v: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, notation: Math.abs(v) >= 100000 ? 'compact' : 'standard' }).format(v);
    const plot = new uPlot({ width: Math.max(280, host.current.clientWidth), height,
      tzDate: ts => uPlot.tzDate(new Date(ts * 1000), 'UTC'),
      scales: { x: { time }, y: { distr: log ? 3 : 1 } },
      series: [{ label: time ? 'UTC date' : 'Days since halving', value: (_u, v) => v == null ? '—' : time ? new Date(v * 1000).toISOString().slice(0, 10) : String(v) },
        ...lines.map(line => ({ label: line.label, stroke: line.color, width: 1.5, spanGaps: false, points: { show: false },
          value: (_u: uPlot, v: number | null) => v == null ? '—' : number(v) }))],
      axes: [{ stroke: '#9ca9b9', grid: { stroke: '#26303d' }, values: (_u, values) => values.map(v => time ? new Date(v * 1000).toISOString().slice(0, 10) : String(v)), space: time ? 105 : 65 },
        { stroke: '#9ca9b9', size: 72, grid: { stroke: '#26303d' }, values: (_u, values) => values.map(number) }],
      cursor: { drag: { x: true, y: false }, sync: syncKey ? { key: syncKey, scales: ['x', null] } : undefined },
      hooks: {
        drawClear: [u => {
          const ctx = u.ctx, box = u.bbox;
          ctx.save(); ctx.beginPath(); ctx.rect(box.left, box.top, box.width, box.height); ctx.clip();
          for (const band of bands) {
            ctx.fillStyle = band.color;
            const left = u.valToPos(band.from, 'x', true), right = u.valToPos(band.to, 'x', true);
            ctx.fillRect(left, box.top, right - left, box.height);
          }
          ctx.restore();
        }],
        draw: [u => {
          const ctx = u.ctx, box = u.bbox;
          ctx.save(); ctx.beginPath(); ctx.rect(box.left, box.top, box.width, box.height); ctx.clip();
          ctx.strokeStyle = '#8490a2'; ctx.fillStyle = '#c4cedb'; ctx.font = `${11 * devicePixelRatio}px sans-serif`;
          ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
          for (const a of annotations) {
            const left = u.valToPos(a.x, 'x', true); ctx.beginPath(); ctx.moveTo(left, box.top); ctx.lineTo(left, box.top + box.height); ctx.stroke();
            ctx.fillText(a.label, left + 5 * devicePixelRatio, box.top + 15 * devicePixelRatio);
          }
          ctx.restore();
        }],
        setScale: [(u, key) => {
          if (key !== 'x' || u.scales.x.min == null || u.scales.x.max == null) return;
          const format = (v: number) => time ? new Date(v * 1000).toISOString().slice(0, 10) : `${Math.round(v)} days`;
          if (visibleRange.current) visibleRange.current.textContent = `Visible range: ${format(u.scales.x.min)} – ${format(u.scales.x.max)}`;
          if (!syncKey || synchronizing) return;
          synchronizing = true;
          try { for (const sibling of groups.get(syncKey) ?? []) if (sibling !== u) sibling.setScale('x', { min: u.scales.x.min, max: u.scales.x.max }); }
          finally { synchronizing = false; }
        }],
      },
    }, [x, ...lines.map(l => l.values)], host.current);
    chart.current = plot;
    if (syncKey) { if (!groups.has(syncKey)) groups.set(syncKey, new Set()); groups.get(syncKey)!.add(plot); }
    const observer = new ResizeObserver(() => { if (host.current) plot.setSize({ width: Math.max(280, host.current.clientWidth), height }); });
    observer.observe(host.current);
    return () => { observer.disconnect(); if (syncKey) { groups.get(syncKey)?.delete(plot); if (!groups.get(syncKey)?.size) groups.delete(syncKey); } plot.destroy(); chart.current = null; };
  }, [x, lines, log, time, syncKey, bands, annotations, height]);
  const exportPng = () => {
    if (!chart.current) return;
    const source = chart.current.ctx.canvas, canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height + 150;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#111821'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e7edf5'; ctx.font = '20px sans-serif'; ctx.fillText(`${title}${log ? ' · log scale' : ''}`, 20, 30);
    ctx.font = '13px sans-serif'; let left = 20, top = 53;
    for (const [i, line] of lines.entries()) if (chart.current.series[i + 1].show) {
      const width = ctx.measureText(line.label).width + 30;
      if (left + width > canvas.width - 20) { left = 20; top += 20; }
      ctx.fillStyle = line.color; ctx.fillText(`━ ${line.label}`, left, top); left += width;
    }
    ctx.drawImage(source, 0, 106);
    ctx.fillStyle = '#e7edf5';
    ctx.font = '12px sans-serif'; ctx.fillText(attribution, 20, canvas.height - 12);
    const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `${title.replaceAll(' ', '-')}.png`; a.click();
  };
  return <section className="panel research-chart" aria-label={title}>
    <div className="panelhead"><h2>{title}</h2><div><button onClick={() => { if (x.length > 1) chart.current?.setScale('x', { min: x[0], max: x.at(-1)! }); }}>Reset zoom</button><button onClick={exportPng}>Export PNG</button></div></div>
    {x.length < 2 ? <p>Insufficient chart history.</p> : <div ref={host} role="img" aria-label={`${title}; interactive chart with value legend`} />}
    <p className="chart-help" ref={visibleRange} aria-label="Visible chart range" />
    <p className="chart-help">Drag to zoom · Hover for values · Click a legend to toggle a series{syncKey ? ' · Comparison cursors and zoom are linked' : ''}</p>
  </section>;
}
