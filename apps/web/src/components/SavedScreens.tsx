import { useEffect,useState } from 'react';
import { api,useData } from '../api';
export type Selection={query:string;sort:'rank'|'cap'|'change';minCap:number|null;maxCap:number|null};
export type Screen={id:string;name:string;filters:Selection;version:number};
export function SavedScreens({selection,apply}:{selection:Selection;apply:(selection:Selection)=>void}){
  const screens=useData<Screen[]>('/research/screens');
  const [name,setName]=useState(''),[error,setError]=useState(''),[ready,setReady]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void api<{preferences:Record<string,Selection>;screens:Screen[]}>('/workspace').then(result=>{
    if(!active)return;const requested=new URLSearchParams(location.hash.split('?')[1]??'').get('screen');
    const value=result.data.screens.find(s=>s.id===requested)?.filters??result.data.preferences['asset-screen'];if(value)apply(value);setReady(true);
  }).catch(error=>{if(active){setError(error.message);setReady(true);}});return()=>{active=false;};},[]);
  const serialized=JSON.stringify(selection);
  useEffect(()=>{if(!ready)return;const timer=setTimeout(()=>{void api('/research/preferences/asset-screen',{method:'PUT',body:serialized}).catch(error=>setError(error.message));},600);return()=>clearTimeout(timer);},[serialized,ready]);
  return <div className="saved-screens"><label>Saved screen <select defaultValue="" onChange={e=>{const screen=screens.result?.data.find(s=>s.id===e.target.value);if(screen)apply(screen.filters);}}><option value="">Choose a screen</option>{screens.result?.data.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api('/research/screens',{method:'POST',body:JSON.stringify({name,filters:selection})});setName('');screens.reload();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}}>
      <input aria-label="New screen name" placeholder="Name this screen" maxLength={100} value={name} onChange={e=>setName(e.target.value)} required/>
      <button disabled={busy}>Save screen</button></form>{error&&<p role="alert">{error}</p>}
  </div>;
}
