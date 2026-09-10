import { useState } from 'react';
import { api,useData } from '../api';
import type { Screen } from '../components/SavedScreens';
type Rule={id:string;asset_id:string;name:string;metric:string;operator:string;threshold:number;enabled:boolean;last_match:boolean|null};
type Alert={id:string;asset_id:string;title:string;detected_at:string;read_at:string|null;evidence:{metric:string;operator:string;threshold:number;value:number;observedAt:string}};
export function Research(){
  const screens=useData<Screen[]>('/research/screens'),rules=useData<Rule[]>('/research/alert-rules'),alerts=useData<Alert[]>('/research/alerts');
  const assets=useData<{id:string;symbol:string;name:string}[]>('/assets');
  const [assetId,setAssetId]=useState('bitcoin'),[name,setName]=useState(''),[metric,setMetric]=useState('priceUsd'),[operator,setOperator]=useState('above'),[threshold,setThreshold]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function mutate(path:string,method:string,body?:unknown){setError('');try{await api(path,{method,...(body?{body:JSON.stringify(body)}:{})});rules.reload();alerts.reload();screens.reload();}catch(error){setError((error as Error).message);}}
  return <>
    <section className="panel research-panel"><h2>Saved research screens</h2><p>Save market filters in Assets, then return to the same selection here.</p>
      {screens.result?.data.length?screens.result.data.map(screen=><div className="research-row" key={screen.id}><a href={`#assets?screen=${screen.id}`}>{screen.name}</a><small>{screen.filters.query||'All tracked assets'} · sort {screen.filters.sort}</small><button onClick={()=>void mutate(`/research/screens/${screen.id}`,'DELETE')}>Remove</button></div>):<p>No saved screens yet. <a href="#assets">Open Assets</a></p>}
    </section>
    <section className="panel research-panel"><h2>Thesis conditions</h2><p>Alerts detect a crossing in archived hourly market snapshots. The first valid observation establishes a baseline. Missing or stale prices do not trigger alerts.</p>
      <form className="rule-form" onSubmit={async e=>{e.preventDefault();setBusy(true);await mutate('/research/alert-rules','POST',{assetId,name,metric,operator,threshold:Number(threshold)});setBusy(false);}}>
        <label>Asset<select value={assetId} onChange={e=>setAssetId(e.target.value)}>{assets.result?.data.map(asset=><option key={asset.id} value={asset.id}>{asset.symbol} · {asset.name}</option>)}</select></label>
        <label>Condition name<input value={name} onChange={e=>setName(e.target.value)} maxLength={100} required/></label>
        <label>Metric<select value={metric} onChange={e=>setMetric(e.target.value)}><option value="priceUsd">Price (USD)</option><option value="marketCapUsd">Market cap (USD)</option><option value="change24h">24h change (%)</option></select></label>
        <label>Crosses<select value={operator} onChange={e=>setOperator(e.target.value)}><option value="above">Above</option><option value="below">Below</option></select></label>
        <label>Threshold<input type="number" step="any" required value={threshold} onChange={e=>setThreshold(e.target.value)}/></label><button disabled={busy||!threshold}>Create condition</button>
      </form>{error&&<p role="alert" className="error-message">{error}</p>}
      {rules.result?.data.map(rule=><div className="research-row" key={rule.id}><div><b>{rule.name}</b><small>{rule.asset_id} · {rule.metric} {rule.operator} {rule.threshold} · {rule.last_match===null?'awaiting baseline':rule.last_match?'currently true':'currently false'}</small></div>
        <button onClick={()=>void mutate(`/research/alert-rules/${rule.id}`,'PATCH',{enabled:!rule.enabled})}>{rule.enabled?'Pause':'Enable'}</button><button onClick={()=>void mutate(`/research/alert-rules/${rule.id}`,'DELETE')}>Remove</button></div>)}
      {rules.error&&<p role="alert">Unable to load conditions. <button onClick={rules.reload}>Retry</button></p>}
    </section>
    <section className="panel research-panel"><h2>In-app alerts</h2><button onClick={alerts.reload}>Refresh alerts</button>
      {alerts.result?.data.length?alerts.result.data.map(alert=><article className={`note ${alert.read_at?'':'unread'}`} key={alert.id}><b>{alert.title}</b><small>{new Date(alert.detected_at).toLocaleString()} · <a href={`#asset/${encodeURIComponent(alert.asset_id)}`}>{alert.asset_id}</a></small>
        <p>{alert.evidence.metric}: {alert.evidence.value} crossed {alert.evidence.operator} {alert.evidence.threshold}. Observed {new Date(alert.evidence.observedAt).toLocaleString()}.</p>
        {!alert.read_at&&<button onClick={()=>void mutate(`/research/alerts/${alert.id}`,'PATCH')}>Mark read</button>}</article>):<p>No condition crossings recorded yet.</p>}
      {alerts.error&&<p role="alert">Unable to load alerts.</p>}
    </section>
  </>;
}
