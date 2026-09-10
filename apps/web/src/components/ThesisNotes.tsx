import { useState } from 'react';
import { api,useData } from '../api';
type Note={id:string;asset_id:string;body:string;version:number;created_at:string;updated_at:string};

export function ThesisNotes({assetId}:{assetId:string}) {
  const notes=useData<Note[]>(`/research/notes?assetId=${encodeURIComponent(assetId)}`);
  const [body,setBody]=useState(''),[editing,setEditing]=useState<Note|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function save(){setBusy(true);setError('');try{
    await api(`/research/notes${editing?`/${editing.id}`:''}`,{method:editing?'PUT':'POST',body:JSON.stringify({assetId,body,...(editing?{version:editing.version}:{})})});
    setBody('');setEditing(null);notes.reload();
  }catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <section className="panel research-panel"><h2>Dated thesis notes</h2><p>Notes and their revisions are stored in your personal workspace.</p>
    <form onSubmit={e=>{e.preventDefault();void save();}}><label htmlFor="thesis">{editing?'Edit note':'New note'}</label>
      <textarea id="thesis" value={body} onChange={e=>setBody(e.target.value)} maxLength={10000} rows={5} required placeholder="Thesis, evidence, and what would change your view"/>
      <button disabled={busy||!body.trim()}>{editing?'Save revision':'Save note'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setBody('');}}>Cancel</button>}
    </form>{error&&<p role="alert" className="error-message">{error}</p>}
    {notes.loading?<p>Loading notes…</p>:notes.error?<p role="alert">Unable to load notes. <button onClick={notes.reload}>Retry</button></p>:notes.result?.data.length?notes.result.data.map(note=><article key={note.id} className="note">
      <small>{new Date(note.created_at).toLocaleString()} · revision {note.version}{note.version>1?` · edited ${new Date(note.updated_at).toLocaleString()}`:''}</small>
      <p>{note.body}</p><button onClick={()=>{setEditing(note);setBody(note.body);}}>Edit</button>
      <button onClick={async()=>{try{await api(`/research/notes/${note.id}`,{method:'DELETE'});notes.reload();}catch(error){setError((error as Error).message);}}}>Remove from notes</button>
    </article>):<p>No notes for this asset yet.</p>}
  </section>;
}
