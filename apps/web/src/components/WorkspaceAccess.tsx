import { useEffect,useState,type ReactNode } from 'react';

export function WorkspaceAccess({children}:{children:ReactNode}) {
  const [required,setRequired]=useState(false),[token,setToken]=useState(''),[error,setError]=useState('');
  async function check(value=sessionStorage.getItem('workspace-token')??'') {
    try {
      const response=await fetch('/api/v1/workspace',{headers:value?{authorization:`Bearer ${value}`}:{}});
      setRequired(response.status===401);
      if(response.status===401){setError('Enter the access token configured for this workspace.');return;}
      if(response.ok&&value)sessionStorage.setItem('workspace-token',value);
    } catch { /* The normal page displays connection failures. */ }
  }
  useEffect(()=>{void check();},[]);
  if(!required)return children;
  return <main className="access"><h1>Personal workspace</h1><form onSubmit={event=>{event.preventDefault();void check(token);}}>
    <label htmlFor="access-token">Workspace access token</label><input id="access-token" type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="current-password"/>
    <button type="submit">Unlock workspace</button><p role="status">{error}</p>
  </form></main>;
}
