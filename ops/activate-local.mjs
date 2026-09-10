// Run only after reviewing generated service definitions and passing checks.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename,join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const root=fileURLToPath(new URL('../',import.meta.url));
const service=`gui/${process.getuid()}/local.cryptopanel.worker`;
let installed=false;
try{execFileSync('/bin/launchctl',['print',service],{stdio:'ignore'});installed=true;}catch{}
if(installed){
  execFileSync('/bin/launchctl',['bootout',service],{stdio:'inherit'});
  console.log('Stopped supervised worker before upgrade');
}
const rows=execFileSync('/bin/ps',['-Ao','pid=,comm=,args='],{encoding:'utf8'}).split('\n');
for(const row of rows){
  const match=row.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
  if(!match||basename(match[2])!=='node'||!match[3].includes('src/worker.ts'))continue;
  const cwd=execFileSync('/usr/sbin/lsof',['-a','-p',match[1],'-d','cwd','-Fn'],{encoding:'utf8'});
  if(!cwd.split('\n').includes(`n${join(root,'apps/api')}`))continue;
  const pid=Number(match[1]);process.kill(pid,'SIGTERM');
  const deadline=Date.now()+45000;
  while(true){try{process.kill(pid,0);}catch{break;}if(Date.now()>deadline)throw new Error('Existing worker did not stop cleanly');await setTimeout(250);}
  console.log(`Stopped terminal worker ${pid}`);
}
execFileSync('pnpm',['--filter','@crypto-panel/api','db:migrate'],{cwd:root,stdio:'inherit'});
const {pool}=await import('../apps/api/dist/db.js');
const {retryCurrentFailures}=await import('../apps/api/dist/discovery/queue.js');
try{console.log(`Requeued ${await retryCurrentFailures(pool)} current failed slots within retry limits`);}finally{await pool.end();}
execFileSync(process.execPath,[`--env-file-if-exists=${join(root,'.env')}`,join(root,'ops/backup.mjs')],{cwd:root,stdio:'inherit'});
const container=execFileSync('/usr/local/bin/docker',['compose','ps','-q','postgres'],{cwd:root,encoding:'utf8'}).trim();
if(!/^[a-f0-9]+$/.test(container))throw new Error('Local PostgreSQL container not found');
execFileSync('/usr/local/bin/docker',['update','--restart','unless-stopped',container],{stdio:'ignore'});
execFileSync(process.execPath,[join(root,'ops/supervisor.mjs'),'--install'],{cwd:root,stdio:'inherit'});
