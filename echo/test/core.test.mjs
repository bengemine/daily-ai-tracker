import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localPath, shellQuote, psQuote, resolveSession, runnerText, chooseWorkspace, handoffPrompt, resolveHandoff, noSummaryReason } from '../launcher.mjs';
import { validateResult, authorized, canAutoResume } from '../server.mjs';
const exec = promisify(execFile);
const id = '01234567-1234-1234-1234-012345678901';
process.env.WSL_DISTRO_NAME = 'Ubuntu';

test('shell quoting preserves hostile-looking path text without executing it',async () => {
  const input = "space and ' quote $(echo injected) `echo injected` & ;\nend";
  const result=await exec('bash',['-c',"printf '%s' "+shellQuote(input)]);
  assert.equal(result.stdout,input);
  assert.equal(psQuote("C:\\Jo's notes"),"'C:\\Jo''s notes'");
});

test('maps native paths but never guesses encoded Claude project folders',() => {
  assert.equal(localPath('E:\\my-notes\\test'),'/mnt/e/my-notes/test');
  assert.equal(localPath('\\\\wsl$\\Ubuntu\\home\\dev\\a-b'),'/home/dev/a-b');
  assert.equal(localPath('\\\\wsl$\\OtherDistro\\home\\dev\\a-b'),'');
  assert.equal(localPath('-home-dev-a-b'),'');
});

test('validates exact session metadata and missing working folders',async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'echo-resolve-'));
  try {
    const original=path.join(dir,'session.jsonl');
    await writeFile(original,JSON.stringify({type:'session_meta',payload:{id,cwd:dir}})+'\n');
    const detail={session_id:id,agent:'Codex (WSL)',originals:[original],project:'incorrect-folder'};
    const resolved=await resolveSession(detail);
    assert.equal(resolved.available,true);
    assert.equal(resolved.cwd,dir);
    assert.deepEqual(resolved.command,['codex','resume',id]);
    await writeFile(original,JSON.stringify({type:'session_meta',payload:{id,cwd:dir+'/deleted-worktree'}})+'\n');
    assert.match((await resolveSession(detail)).reason,/no longer exists/);
    assert.equal((await resolveSession({...detail,session_id:'--last'})).available,false);
    assert.equal((await resolveSession({...detail,agent:'Factory'})).available,false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('runner starts in the verified folder and passes only the resume arguments',async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'echo-runner-'));
  try {
    const bin=path.join(dir,'bin'); await mkdir(bin);
    const cwd=path.join(dir,"folder ' with $ and &"); await mkdir(cwd);
    const receipt=path.join(dir,'args.txt');
    await writeFile(path.join(bin,'codex'),"#!/bin/bash\nprintf '%s\\n' \"$PWD\" \"$@\" > "+shellQuote(receipt)+'\n',{mode:0o700});
    const runner=path.join(dir,'run.sh');
    await writeFile(runner,runnerText({windows:false,agent:'codex',diskCwd:cwd,command:['codex','resume',id]},path.join(dir,'opened')));
    await new Promise((resolve,reject) => {
      const child=execFile('bash',[runner],{env:{...process.env,PATH:bin+':'+process.env.PATH},timeout:10000},error => error ? reject(error) : resolve());
      child.stdin.end();
    });
    assert.equal(await readFile(receipt,'utf8'),cwd+'\nresume\n'+id+'\n');
    assert.equal(await readFile(path.join(dir,'opened'),'utf8'),'exited:0');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('results reject invented shapes and duplicate session choices',() => {
  const match={sessionKey:'Codex:'+id,confidence:'high',reason:'A match',evidence:'Some original conversation evidence'};
  assert.equal(validateResult({outcome:'single',explanation:'Found',question:'',matches:[match]}).matches.length,1);
  assert.throws(()=>validateResult({outcome:'single',explanation:'Found',question:'',matches:[]}));
  assert.throws(()=>validateResult({outcome:'multiple',explanation:'Found',question:'',matches:[match,match]}));
  assert.throws(()=>validateResult({outcome:'none',explanation:'No',question:'More?',matches:[match]}));
});

test('local server rejects foreign hosts, foreign origins and unauthenticated mutations',() => {
  assert.equal(authorized({method:'GET',headers:{host:'localhost:4317'}}),true);
  assert.equal(authorized({method:'GET',headers:{host:'attacker.example:4317'}}),false);
  assert.equal(authorized({method:'GET',headers:{host:'localhost:4317',origin:'https://attacker.example'}}),false);
  assert.equal(authorized({method:'POST',headers:{host:'localhost:4317'}}),false);
  assert.equal(authorized({method:'POST',headers:{host:'localhost:4317','x-echo-token':'é'.repeat(64)}}),false);
});

test('automatic opening needs one strong match with verified evidence and an original session',() => {
  const match={confidence:'high',evidenceVerified:true,resume:{available:true}};
  assert.equal(canAutoResume({outcome:'single',matches:[match]}),true);
  assert.equal(canAutoResume({outcome:'single',matches:[{...match,confidence:'medium'}]}),false);
  assert.equal(canAutoResume({outcome:'single',matches:[{...match,evidenceVerified:false}]}),false);
  assert.equal(canAutoResume({outcome:'single',matches:[{...match,resume:{available:false}}]}),false);
  assert.equal(canAutoResume({outcome:'multiple',matches:[match,match]}),false);
  assert.equal(canAutoResume({outcome:'none',matches:[]}),false);
});

test('Herdr workspace selection prefers identity folders, then the nearest project parent',() => {
  const snapshot={workspaces:[{workspace_id:'home',focused:true},{workspace_id:'main'},{workspace_id:'worktree'}],panes:[{workspace_id:'home',cwd:os.homedir()},{workspace_id:'main',cwd:'/projects/app'},{workspace_id:'worktree',cwd:'/projects/app-worktrees/fix'}]};
  const saved=[{id:'home',identity_cwd:os.homedir()},{id:'main',identity_cwd:'/projects/app'},{id:'worktree',identity_cwd:'/projects/app-worktrees/fix'}];
  assert.equal(chooseWorkspace(snapshot,saved,'/projects/app').workspace_id,'main');
  assert.equal(chooseWorkspace(snapshot,saved,'/projects/app/views').workspace_id,'main');
  assert.equal(chooseWorkspace(snapshot,saved,'/projects/app-worktrees/fix').workspace_id,'worktree');
  assert.equal(chooseWorkspace(snapshot,saved,'/projects/app-worktrees/other'),null);
  assert.equal(chooseWorkspace(snapshot,saved,os.homedir()+'/unrelated-project'),null);
});

test('Herdr runner preserves the new pane context and does not open another terminal',() => {
  const script=runnerText({windows:false,agent:'codex',diskCwd:'/tmp',command:['codex','resume',id]},'/tmp/ack');
  assert.doesNotMatch(script,/unset HERDR/);
  assert.doesNotMatch(script,/wt\.exe|new-tab/);
  assert.match(script,/unset CODEX_THREAD_ID CLAUDECODE/);
});

test('summary handoff always starts a fresh Claude chat in the verified folder',async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'echo-handoff-'));
  try {
    const original=path.join(dir,'session.jsonl');
    await writeFile(original,JSON.stringify({type:'session_meta',payload:{id,cwd:dir}})+'\n');
    const detail={session_id:id,agent:'Codex (WSL)',originals:[original],title:'Fix the timer',date:'2026-04-02',firstDate:'2026-04-01'};
    const handoff={summaries:[{date:'2026-04-01',title:'Fix the timer',summary:'The timer was changed to 5 minutes.'}],transcripts:['/tracker/conversations/codex/'+id+'/2026-04-01.md']};
    const resolved=await resolveHandoff(detail,handoff);
    assert.equal(resolved.available,true);
    assert.equal(resolved.agent,'claude');
    assert.equal(resolved.windows,false);
    assert.equal(resolved.diskCwd,dir);
    assert.equal(resolved.command.length,2);
    assert.equal(resolved.command[0],'claude');
    assert.doesNotMatch(resolved.command.join(' '),/--resume|resume /);
    assert.match(resolved.command[1],/The timer was changed to 5 minutes\./);
    assert.match(resolved.command[1],/2026-04-01\.md/);
    assert.match(resolved.command[1],/Dates: 2026-04-01 to 2026-04-02/);
    assert.match(resolved.command[1],/wait for my next instruction/);
    assert.deepEqual(await resolveHandoff(detail,{summaries:[],transcripts:[]}),{available:false,reason:noSummaryReason});
    const unknown=await resolveHandoff({...detail,agent:'Factory',project:dir+'/deleted'},handoff);
    assert.equal(unknown.diskCwd,os.homedir());
    assert.match(unknown.command[1],/original folder is unknown/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('handoff runner passes the whole multi-line summary as one Claude argument',async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'echo-handoff-runner-'));
  try {
    const bin=path.join(dir,'bin'); await mkdir(bin);
    const receipt=path.join(dir,'args.txt');
    await writeFile(path.join(bin,'claude'),"#!/bin/bash\nprintf '%s|%s' \"$#\" \"$1\" > "+shellQuote(receipt)+'\n',{mode:0o700});
    const prompt=handoffPrompt({agent:'Claude Code (WSL)',title:"It's $(echo injected)",date:'2026-04-01'},{summaries:[{date:'2026-04-01',title:'T',summary:'Line one\nLine `two` & "three"'}],transcripts:[]},dir);
    const runner=path.join(dir,'run.sh');
    await writeFile(runner,runnerText({windows:false,agent:'claude',diskCwd:dir,command:['claude',prompt]},path.join(dir,'opened')));
    await new Promise((resolve,reject) => {
      const child=execFile('bash',[runner],{env:{...process.env,PATH:bin+':'+process.env.PATH},timeout:10000},error => error ? reject(error) : resolve());
      child.stdin.end();
    });
    assert.equal(await readFile(receipt,'utf8'),'1|'+prompt);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Windows sessions need ECHO_WINDOWS_HOME when the tracker did not record the original file',async () => {
  const previous=process.env.ECHO_WINDOWS_HOME;
  delete process.env.ECHO_WINDOWS_HOME;
  try {
    const resolved=await resolveSession({session_id:id,agent:'Codex',originals:[]});
    assert.equal(resolved.available,false);
    assert.match(resolved.reason,/ECHO_WINDOWS_HOME/);
  } finally { if (previous!==undefined) process.env.ECHO_WINDOWS_HOME=previous; }
});
