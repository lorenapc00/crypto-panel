import { createReadStream,createWriteStream } from 'node:fs';
import { mkdir,readdir,readFile,stat,unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve,basename } from 'node:path';
import { pool } from '../apps/api/dist/db.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=resolve(root,'.backups');
function docker(args,{input,output}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.DOCKER_BIN??'/usr/local/bin/docker',['compose','exec','-T','postgres',...args],{cwd:root,stdio:['pipe','pipe','pipe']});
    let result='',error='';
    child.on('error',reject);child.stderr.on('data',data=>{error+=data;});
    if(output)child.stdout.pipe(output);else child.stdout.on('data',data=>{result+=data;});
    if(input)input.pipe(child.stdin);else child.stdin.end();
    child.on('close',code=>code===0?resolve(result):reject(new Error(error||`Database utility exited ${code}`)));
  });
}
async function verify(file) {
  const database=`archive_restore_${randomUUID().replaceAll('-','')}`;
  await docker(['createdb','-U','crypto_panel',database]);
  try {
    await docker(['pg_restore','-U','crypto_panel','--exit-on-error','--no-owner','--dbname',database],{input:createReadStream(file)});
    const result=await docker(['psql','-U','crypto_panel','-d',database,'-At','-c',`select
      (select count(*) from schema_migrations)>0 and (select count(*) from source_payloads)>0
      and (select count(*) from discovery_snapshots)>0 and to_regclass('research_notes') is not null;`]);
    if(result.trim()!=='t')throw new Error('Restored archive failed its integrity check');
  } finally {await docker(['dropdb','-U','crypto_panel',database]);}
}
try {
  const url=new URL(process.env.DATABASE_URL??'postgres://crypto_panel:crypto_panel_dev@127.0.0.1:5432/crypto_panel');
  if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/crypto_panel')throw new Error('This backup command targets the local Compose database only');
  if(process.argv.includes('--if-due')){
    const latest=(await pool.query("select 1 from archive_backups where completed_at>clock_timestamp()-interval '23 hours' and restore_verified_at is not null limit 1")).rowCount;
    if(latest){console.log('Verified daily backup is current');process.exitCode=0;}
    else await backup();
  } else await backup();
} catch(error){console.error(error.message);process.exitCode=1;}finally{await pool.end();}

async function backup() {
  await mkdir(directory,{recursive:true,mode:0o700});
  const filename=`archive-${new Date().toISOString().replaceAll(':','-')}.dump`,file=resolve(directory,filename);
  const output=createWriteStream(file,{flags:'wx',mode:0o600});
  const finished=new Promise((resolve,reject)=>{output.on('finish',resolve);output.on('error',reject);});
  try{await docker(['pg_dump','-U','crypto_panel','-d','crypto_panel','--format=custom'],{output});await finished;}
  catch(error){output.destroy();await unlink(file).catch(()=>{});throw error;}
  const bytes=(await stat(file)).size,sha256=createHash('sha256').update(await readFile(file)).digest('hex');
  await verify(file);
  await pool.query(`insert into archive_backups (id,filename,bytes,sha256,restore_verified_at) values ($1,$2,$3,$4,clock_timestamp())`,[randomUUID(),basename(file),bytes,sha256]);
  const backups=(await readdir(directory)).filter(name=>/^archive-\d{4}-\d{2}-\d{2}T[\d.Z-]+\.dump$/.test(name)).sort().reverse();
  for(const old of backups.slice(7))await unlink(resolve(directory,old));
  console.log(JSON.stringify({filename,bytes,sha256,restoreVerified:true,retainedBackups:Math.min(backups.length,7)}));
}
