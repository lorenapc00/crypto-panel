import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../apps/api/dist/db.js';
import { dataHealth } from '../apps/api/dist/discovery/archive.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const service=`gui/${process.getuid()}/local.cryptopanel.worker`;
const inspect=()=>execFileSync('/bin/launchctl',['print',service],{encoding:'utf8'});
const pid=()=>Number(inspect().match(/\bpid = (\d+)/)?.[1]);
const countBy=(rows,key)=>Object.fromEntries([...new Set(rows.map(row=>row[key]))].map(value=>[value,rows.filter(row=>row[key]===value).length]));

try {
  const before=pid();
  if(!before)throw new Error('Supervised worker is not running');
  let restart=null;
  if(process.argv.includes('--restart-test')){
    const started=Date.now();
    process.kill(before,'SIGTERM');
    while(Date.now()-started<45000){
      await setTimeout(1000);
      const after=pid();
      if(after&&after!==before){restart={previousPid:before,newPid:after,elapsedSeconds:(Date.now()-started)/1000};break;}
    }
    if(!restart)throw new Error('Worker did not restart within 45 seconds');
    await setTimeout(2000);
  }
  const health=await dataHealth(pool);
  const migrations=(await pool.query('select version,applied_at from schema_migrations order by version')).rows;
  const requests=(await pool.query(`select purpose,provider_id,count(*)::int as requests,
    count(*) filter(where http_status between 200 and 299 and error is null)::int as successful,
    count(*) filter(where error is not null)::int as errors from worker_requests group by purpose,provider_id order by purpose,provider_id`)).rows;
  const services=['worker','backup'].map(name=>{
    const value=execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/local.cryptopanel.${name}`],{encoding:'utf8'});
    return {name,state:value.match(/\bstate = ([^\n]+)/)?.[1],pid:Number(value.match(/\bpid = (\d+)/)?.[1])||null,
      lastExitCode:value.match(/last exit code = (\d+)/)?.[1]??null};
  });
  const container=execFileSync('/usr/local/bin/docker',['compose','ps','-q','postgres'],{cwd:root,encoding:'utf8'}).trim();
  if(!/^[a-f0-9]+$/.test(container))throw new Error('PostgreSQL container not found');
  const postgresRestart=execFileSync('/usr/local/bin/docker',['inspect','--format','{{.HostConfig.RestartPolicy.Name}}',container],{encoding:'utf8'}).trim();
  const endpoints=[];
  for(const path of ['/workspace','/overview','/assets','/assets/bitcoin','/data-health','/research/notes?assetId=bitcoin']){
    const response=await fetch(`http://127.0.0.1:3100/api/v1${path}`,{signal:AbortSignal.timeout(10000),
      headers:process.env.WORKSPACE_TOKEN?{authorization:`Bearer ${process.env.WORKSPACE_TOKEN}`}:{}});
    endpoints.push({path,status:response.status});await response.arrayBuffer();
  }
  const report={checkedAt:health.observedAt,timezone:'America/Sao_Paulo',scope:'Local supervised Mac; continuous hosting remains unverified',
    migrations,services,restartTest:restart,postgresRestart,endpoints,
    summary:{jobs:health.jobs.length,jobStates:countBy(health.jobs,'state'),latestRunStatuses:countBy(health.jobs,'last_run_status'),
      series:health.series.length,seriesStates:countBy(health.series,'state')},
    jobs:health.jobs.map(({id,state,last_run_status,last_run_error,replay_coverage_start,last_success_at})=>({id,state,last_run_status,last_run_error,replay_coverage_start,last_success_at})),
    series:health.series,providers:health.providers,gaps:health.gaps,operations:health.operations,requestPurposes:requests,
    limitations:['Historical acquisition gaps and provider errors are retained.','Empty spot slots skip without quota or replay coverage.',
      'Historical TVL spacing is irregular where supplied; timestamps are never shifted to fabricate daily bars.',
      'This Mac must remain awake and logged in with Docker running. Local backups do not protect against machine loss.']};
  const outputArg=process.argv.indexOf('--output');
  const output=resolve(root,outputArg>=0?process.argv[outputArg+1]:'.reports/stage1-verification.json');
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,...report.summary,services,restartTest:restart,endpoints,backupVerified:!!health.operations.lastBackup?.restore_verified_at},null,2));
  if(!health.operations.workers.some(worker=>worker.running)||endpoints.some(endpoint=>endpoint.status!==200))process.exitCode=1;
} finally {await pool.end();}
