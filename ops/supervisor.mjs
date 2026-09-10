import { mkdir,readFile,writeFile,copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve,join } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=resolve(root,'.reports','supervisor');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const entries=[{label:'local.cryptopanel.worker',script:join(root,'apps/api/dist/worker.js'),worker:true},
  {label:'local.cryptopanel.backup',script:join(root,'ops/backup.mjs'),worker:false}];
const domain=`gui/${process.getuid()}`;
await mkdir(directory,{recursive:true});
for(const entry of entries){
  const args=[process.execPath,`--env-file-if-exists=${join(root,'.env')}`,entry.script,...(entry.worker?[]:['--if-due'])];
  const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${entry.label}</string>
<key>ProgramArguments</key><array>${args.map(arg=>`<string>${escape(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/>
${entry.worker?'<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>':'<key>StartInterval</key><integer>3600</integer>'}
<key>StandardOutPath</key><string>${escape(join(directory,entry.label+'.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(directory,entry.label+'.error.log'))}</string>
</dict></plist>\n`;
  const staged=join(directory,entry.label+'.plist');await writeFile(staged,plist,{mode:0o600});
  execFileSync('/usr/bin/plutil',['-lint',staged],{stdio:'inherit'});
  if(process.argv.includes('--install')){
    const target=join(homedir(),'Library','LaunchAgents',entry.label+'.plist');await mkdir(resolve(target,'..'),{recursive:true});
    try{await copyFile(target,staged+'.previous');}catch(error){if(error.code!=='ENOENT')throw error;}
    try{execFileSync('/bin/launchctl',['bootout',`${domain}/${entry.label}`],{stdio:'ignore'});}catch{}
    await writeFile(target,plist,{mode:0o600});
    execFileSync('/bin/launchctl',['bootstrap',domain,target],{stdio:'inherit'});
    console.log(`Installed ${entry.label}`);
  }
}
console.log(process.argv.includes('--install')?'Personal archive supervision installed; requires this Mac to remain awake and logged in.':`Review service definitions in ${directory}; use --install to activate.`);
