import { useEffect,useState } from 'react';
import { useData } from '../api';
type Job={id:string;provider_id:string;state:string;last_success_at:string|null;seconds_since_success:number|null;interval_seconds:number;last_observed_interval_seconds:number|null;replay_coverage_start:string|null;last_run_error:string|null};
type Series={id:string;asset_id:string|null;metric_code:string;source_id:string;state:string;last_success_at:string|null;last_observation_at:string|null;interval_seconds:number;detected_interval_seconds:number|null;irregular_intervals:number;missing_intervals:number;resolved_gaps:number;maximum_detection_latency_seconds:number|null;replay_coverage_start:string|null};
type Health={observedAt:string;jobs:Job[];series:Series[];providers:{provider_id:string;requests_this_month:number;requests_per_month:number;attempts_24h:number;errors_24h:number;unfinished_requests_24h:number;blocked_until:string|null}[];
  gaps:{job_id:string;missing_intervals:number;maximum_detection_latency_seconds:number;last_detected_at:string}[];
  operations:{workers:{id:string;running:boolean;last_seen_at:string}[];lastBackup:{completed_at:string;restore_verified_at:string|null;bytes:number}|null;storage:{database_bytes:string;payloads:number;snapshots:number};retention:string};quotaScope:string;coverage:string};
const date=(value:string|null)=>value?new Date(value).toLocaleString():'Not available';
const duration=(seconds:number|null)=>seconds===null?'Unknown':seconds<60?`${Math.round(seconds)}s`:seconds<3600?`${Math.round(seconds/60)}m`:seconds<86400?`${(seconds/3600).toFixed(1)}h`:`${(seconds/86400).toFixed(1)}d`;
function State({value}:{value:string}){return <span className={`health-state ${value}`}>{value}</span>;}
export function DataHealth(){
  const {result,loading,error,reload}=useData<Health>('/data-health');
  const [provider,setProvider]=useState('all'),[problems,setProblems]=useState(false);
  useEffect(()=>{const timer=setInterval(reload,30000);return()=>clearInterval(timer);},[]);
  if(!result)return <section className="panel research-panel"><p>{loading?'Loading archive health…':'Archive health is unavailable.'}</p>{error&&<button onClick={reload}>Retry</button>}</section>;
  const h=result.data,active=h.operations.workers.filter(w=>w.running).length;
  const jobs=h.jobs.filter(j=>(provider==='all'||j.provider_id===provider)&&(!problems||j.state!=='healthy'));
  const series=h.series.filter(s=>(provider==='all'||s.source_id===provider)&&(!problems||s.state!=='healthy'));
  return <>
    <div className="health-summary"><article><span>Archive worker</span><strong>{active?`${active} running`:'No recent heartbeat'}</strong></article>
      <article><span>Acquisition jobs</span><strong>{h.jobs.filter(j=>j.state==='healthy').length} / {h.jobs.length} healthy</strong></article>
      <article><span>Recorded missed slots</span><strong>{h.gaps.reduce((n,g)=>n+g.missing_intervals,0)}</strong></article>
      <article><span>Latest backup</span><strong>{h.operations.lastBackup?date(h.operations.lastBackup.completed_at):'Not recorded'}</strong></article></div>
    <section className="panel research-panel"><div className="health-toolbar"><label>Source <select value={provider} onChange={e=>setProvider(e.target.value)}><option value="all">All sources</option>{h.providers.map(p=><option key={p.provider_id}>{p.provider_id}</option>)}</select></label>
      <label><input type="checkbox" checked={problems} onChange={e=>setProblems(e.target.checked)}/> Show issues only</label><button onClick={reload}>Refresh health</button></div>
      <p>Checked {date(h.observedAt)}. {h.coverage}. A healthy current request does not erase earlier gaps.</p>
      <h2>Provider quotas and errors</h2><p>{h.quotaScope}. Monthly counters reset at the UTC month boundary.</p>
      <div className="table-scroll"><table className="health-table"><thead><tr><th>Source</th><th>Monthly requests</th><th>Budget used</th><th>24h errors / attempts</th><th>Unfinished</th><th>Backoff until</th></tr></thead><tbody>{h.providers.filter(p=>provider==='all'||p.provider_id===provider).map(p=><tr key={p.provider_id}><td>{p.provider_id}</td><td>{p.requests_this_month} / {p.requests_per_month}</td><td><progress max={p.requests_per_month} value={p.requests_this_month}/>{(100*p.requests_this_month/p.requests_per_month).toFixed(1)}%</td><td>{p.errors_24h} / {p.attempts_24h} ({p.attempts_24h?(100*p.errors_24h/p.attempts_24h).toFixed(1):'0'}%)</td><td>{p.unfinished_requests_24h}</td><td>{date(p.blocked_until)}</td></tr>)}</tbody></table></div>
      <h2>Scheduled datasets</h2><div className="table-scroll"><table className="health-table"><thead><tr><th>Dataset</th><th>State</th><th>Last success / age</th><th>Expected / observed spacing</th><th>Replay starts</th></tr></thead><tbody>{jobs.map(j=><tr key={j.id}><td>{j.id}{j.last_run_error&&<small>{j.last_run_error}</small>}</td><td><State value={j.state}/></td><td>{date(j.last_success_at)}<small>{duration(j.seconds_since_success)} ago</small></td><td>{duration(j.interval_seconds)} / {duration(j.last_observed_interval_seconds)}</td><td>{date(j.replay_coverage_start)}</td></tr>)}</tbody></table></div>
      <h2>Individual series</h2><p>Observed values and acquisition times are separate. Pre-archive history is reconstructed; replay starts only after scheduled collection.</p>
      <div className="table-scroll"><table className="health-table"><thead><tr><th>Asset / series</th><th>State</th><th>Last value / acquired</th><th>Expected / detected interval</th><th>Missing / recovered</th><th>Detection latency</th><th>Replay starts</th></tr></thead><tbody>{series.map(s=><tr key={s.id}><td>{s.asset_id ?? 'Market aggregate'} · {s.metric_code}<small>{s.source_id}</small></td><td><State value={s.state}/></td><td>{date(s.last_observation_at)}<small>Acquired {date(s.last_success_at)}</small></td><td>{duration(s.interval_seconds)} / {duration(s.detected_interval_seconds)}<small>{s.irregular_intervals??0} irregular steps</small></td><td>{s.missing_intervals} / {s.resolved_gaps}</td><td>{duration(s.maximum_detection_latency_seconds)}</td><td>{date(s.replay_coverage_start)}</td></tr>)}</tbody></table></div>
      {!series.length&&<p>No matching normalized series have been archived.</p>}
      <h2>Historical acquisition gaps</h2><div className="table-scroll"><table className="health-table"><thead><tr><th>Dataset</th><th>Missed intervals</th><th>Longest detection latency</th><th>Last detected</th></tr></thead><tbody>{h.gaps.filter(g=>provider==='all'||g.job_id.startsWith(provider+':')).map(g=><tr key={g.job_id}><td>{g.job_id}</td><td>{g.missing_intervals}</td><td>{duration(g.maximum_detection_latency_seconds)}</td><td>{date(g.last_detected_at)}</td></tr>)}</tbody></table></div>
      <h2>Storage and recovery</h2><p>{(Number(h.operations.storage.database_bytes)/1048576).toFixed(1)} MiB · {h.operations.storage.payloads} payloads · {h.operations.storage.snapshots} snapshots.</p>
      <p>{h.operations.retention}</p><p>Backup restore verified: {date(h.operations.lastBackup?.restore_verified_at??null)}.</p>
    </section>
  </>;
}
