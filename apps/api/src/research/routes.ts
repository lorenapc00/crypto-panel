import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { body,send } from '../http.js';
import { InputError,id,uuid,object } from './validation.js';
import { workspace,watch,saveScreen,saveNote,savePreference,createAlertRule } from './store.js';

export async function researchRoute(database:Pool,req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean> {
  const path=url.pathname.replace('/api/v1',''),method=req.method;
  if(path==='/workspace'&&method==='GET'){send(res,200,{data:await workspace(database)});return true;}
  const watchId=path.match(/^\/watchlist\/([^/]+)$/)?.[1];
  if(watchId&&['PUT','DELETE'].includes(method!)){await watch(database,id(decodeURIComponent(watchId)),method==='PUT');send(res,204,null);return true;}
  if(!path.startsWith('/research/'))return false;
  const [,resource,recordId]=path.split('/').slice(1);
  if(resource==='preferences'&&recordId&&method==='PUT'){send(res,200,{data:await savePreference(database,recordId,await body(req))});return true;}
  if(resource==='notes'){
    if(method==='GET'&&!recordId){const assetId=url.searchParams.get('assetId');send(res,200,{data:(await database.query('select * from research_notes where ($1::text is null or asset_id=$1) order by created_at desc,id limit 500',[assetId===null?null:id(assetId)])).rows});return true;}
    if(method==='POST'&&!recordId||method==='PUT'&&recordId){send(res,method==='POST'?201:200,{data:await saveNote(database,await body(req),recordId)});return true;}
    if(method==='DELETE'&&recordId){await database.query('delete from research_notes where id=$1',[uuid(recordId)]);send(res,204,null);return true;}
  }
  if(resource==='screens'){
    if(method==='GET'&&!recordId){send(res,200,{data:(await database.query('select * from research_screens order by updated_at desc,id')).rows});return true;}
    if(method==='POST'&&!recordId||method==='PUT'&&recordId){send(res,method==='POST'?201:200,{data:await saveScreen(database,await body(req),recordId)});return true;}
    if(method==='DELETE'&&recordId){await database.query('delete from research_screens where id=$1',[uuid(recordId)]);send(res,204,null);return true;}
  }
  if(resource==='alert-rules'){
    if(method==='GET'&&!recordId){send(res,200,{data:(await database.query('select * from research_alert_rules order by created_at desc,id')).rows});return true;}
    if(method==='POST'&&!recordId){send(res,201,{data:await createAlertRule(database,await body(req))});return true;}
    if(method==='PATCH'&&recordId){const row=object(await body(req));if(typeof row.enabled!=='boolean')throw new InputError('Expected enabled boolean');
      const changed=await database.query('update research_alert_rules set enabled=$2,last_match=null where id=$1 returning *',[uuid(recordId),row.enabled]);
      if(!changed.rowCount)throw new InputError('Rule not found',404);send(res,200,{data:changed.rows[0]});return true;}
    if(method==='DELETE'&&recordId){await database.query('delete from research_alert_rules where id=$1',[uuid(recordId)]);send(res,204,null);return true;}
  }
  if(resource==='alerts'){
    if(method==='GET'&&!recordId){send(res,200,{data:(await database.query('select * from research_alerts order by detected_at desc,id desc limit 200')).rows});return true;}
    if(method==='PATCH'&&recordId){if(!/^\d+$/.test(recordId))throw new InputError('Invalid alert ID');
      await database.query('update research_alerts set read_at=coalesce(read_at,clock_timestamp()) where id=$1',[recordId]);send(res,204,null);return true;}
  }
  throw new InputError('Research route or method not supported',404);
}
