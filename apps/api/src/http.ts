import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { InputError } from './research/validation.js';

export function send(res:ServerResponse,status:number,body:unknown) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(status===204?undefined:JSON.stringify(body));
}
export async function body(req:IncomingMessage):Promise<unknown> {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new InputError('Expected application/json',415);
  let size=0,value='';
  for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size<=16000)value+=chunk;}
  if(size>16000)throw new InputError('Request body exceeds 16 KB',413);
  try{return JSON.parse(value);}catch{throw new InputError('Invalid JSON');}
}
export function authorize(req:IncomingMessage,token=process.env.WORKSPACE_TOKEN) {
  const allowed=new Set((process.env.WEB_ORIGINS??'http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:3100,http://localhost:3100').split(','));
  if(req.headers.origin&&!allowed.has(req.headers.origin))throw new InputError('Origin not allowed',403);
  if(token){const actual=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(token);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new InputError('Workspace access token required',401);}
}
export function cutoff(value:string|null){
  if(value!==null&&(!value||!Number.isFinite(Date.parse(value))))throw new InputError('Invalid replay cutoff');
  return value??undefined;
}
