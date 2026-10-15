import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const state = process.env.ECHO_STATE || path.join(os.homedir(), '.local/state/conversation-finder');
const appRoot = path.dirname(fileURLToPath(import.meta.url));
const herdrBin = process.env.ECHO_HERDR_BIN || path.join(os.homedir(), '.local/bin/herdr');
const herdrSession = 'default';
// Windows user folder as seen from WSL, for example /mnt/c/Users/me. Needed only for Windows sessions.
const windowsHome = () => process.env.ECHO_WINDOWS_HOME || '';
const wslDistro = () => process.env.WSL_DISTRO_NAME || 'Ubuntu';
let launchQueue = Promise.resolve();

function herdrEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_') || ['CODEX_THREAD_ID','CLAUDECODE'].includes(key)) delete env[key];
  }
  return env;
}

async function herdr(...args) {
  const { stdout } = await exec(herdrBin, ['--session', herdrSession, ...args], { env: herdrEnv(), timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const response = stdout.trim() ? JSON.parse(stdout) : {};
  if (response.error) throw new Error(response.error.message || 'Herdr could not complete the request.');
  return response.result || response;
}

export function chooseWorkspace(snapshot, savedWorkspaces, cwd) {
  const normalize = value => (localPath(value || '') || value || '').replace(/(.+)\/$/, '$1');
  const target = normalize(cwd);
  const generic = new Set(['', '/', '/tmp', '/mnt', '/mnt/c', '/mnt/e', '/var', '/var/www', os.homedir()]);
  let best = null;
  let bestScore = -1;
  for (const workspace of snapshot.workspaces) {
    const saved = savedWorkspaces.find(item => item.id === workspace.workspace_id);
    const folders = [saved?.identity_cwd, ...snapshot.panes.filter(pane => pane.workspace_id === workspace.workspace_id).map(pane => pane.cwd)];
    let score = -1;
    for (const folder of folders) {
      const candidate = normalize(folder);
      if (!candidate) continue;
      if (candidate === target) score = Math.max(score, 100000 + candidate.length + (saved?.identity_cwd === folder ? 1000 : 0));
      else if (!generic.has(candidate) && target.startsWith(candidate + '/')) score = Math.max(score, candidate.length);
    }
    if (score >= 0 && (score > bestScore || (score === bestScore && workspace.focused))) { best = workspace; bestScore = score; }
  }
  return best;
}

async function findOpenConversation(snapshot, agent, sessionId) {
  const candidates = snapshot.panes.filter(pane => pane.agent === agent || pane.agent_session?.value === sessionId);
  for (const pane of candidates) {
    const response = await herdr('pane','process-info','--pane',pane.pane_id).catch(() => null);
    const processes = response?.process_info?.foreground_processes || [];
    const running = processes.some(process => {
      const args = process.argv || [];
      const executable = args.some(arg => path.basename(arg).replace(/\.exe$/i,'') === agent);
      return executable && (args.includes(sessionId) || pane.agent_session?.value === sessionId);
    });
    if (running) return pane;
  }
  return null;
}

export function localPath(value) {
  if (/^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(value)) {
    const parts = value.split('\\').filter(Boolean);
    if (parts[1].toLowerCase() !== wslDistro().toLowerCase()) return '';
    return '/' + parts.slice(2).join('/');
  }
  if (/^[a-z]:[\\/]/i.test(value)) return '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replaceAll('\\', '/');
  return value.startsWith('/') ? value : '';
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function findSession(root, id, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(id + '.jsonl')) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'subagents') {
      const result = await findSession(path.join(root, entry.name), id, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

async function originalMetadata(file, id, agent) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > 150) break;
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      if (agent === 'codex' && data.type === 'session_meta' && data.payload?.id === id && data.payload.cwd) return data.payload.cwd;
      if (agent === 'claude' && data.sessionId === id && data.cwd) return data.cwd;
    }
  } finally { lines.close(); stream.destroy(); }
  return null;
}

export async function resolveSession(detail) {
  const agent = /^Codex(?: \(WSL\))?$/.test(detail.agent) ? 'codex' : /^Claude Code(?: \(WSL\))?$/.test(detail.agent) ? 'claude' : null;
  if (!agent) return { available: false, reason: 'Saved conversation available. Automatic resume currently supports Claude and Codex.' };
  if (!uuid.test(detail.session_id)) return { available: false, reason: 'This record has no valid original session ID.' };
  const windows = !detail.agent.includes('(WSL)');
  const home = windows ? windowsHome() : os.homedir();
  let original = null;
  for (const candidate of detail.originals || []) {
    const file = localPath(candidate);
    if (file && await exists(file)) { original = file; break; }
  }
  if (!original && home) {
    const roots = agent === 'codex' ? ['.codex/sessions', '.codex/archived_sessions'] : ['.claude/projects'];
    for (const folder of roots) {
      original = await findSession(path.join(home, folder), detail.session_id);
      if (original) break;
    }
  }
  if (!original && !home) return { available: false, reason: 'Set ECHO_WINDOWS_HOME to find and resume Windows sessions.' };
  if (!original) return { available: false, reason: 'The saved dialogue is here, but the original agent session file is missing.' };
  const cwd = await originalMetadata(original, detail.session_id, agent);
  if (!cwd) return { available: false, reason: 'The original working folder could not be verified from the session.' };
  const diskCwd = localPath(cwd);
  if (!diskCwd || !(await exists(diskCwd)) || !(await stat(diskCwd)).isDirectory()) return { available: false, reason: 'The original working folder no longer exists: ' + cwd };
  if (windows && !/^[a-z]:[\\/]/i.test(cwd)) return { available: false, reason: 'This Windows session has an unsupported working-folder format.' };
  const command = agent === 'codex' ? ['codex', 'resume', detail.session_id] : ['claude', '--resume', detail.session_id];
  return { available: true, agent, windows, cwd, diskCwd, original, command };
}

export const noSummaryReason = 'No saved summary yet. The tracker writes one each day at 11:30 AM.';

async function isDirectory(folder) {
  try { return (await stat(folder)).isDirectory(); } catch { return false; }
}

export function handoffPrompt(detail, handoff, cwd) {
  const days = detail.firstDate && detail.firstDate !== detail.date ? detail.firstDate + ' to ' + detail.date : detail.date || 'an earlier day';
  const summaries = handoff.summaries.map(item => '### ' + item.date + ' — ' + item.title + '\n\n' + item.summary).join('\n\n');
  const transcripts = handoff.transcripts.length
    ? 'The full saved conversation is in these files. Read them only if the summary is not enough:\n' + handoff.transcripts.map(file => '- ' + file).join('\n')
    : 'There is no saved full conversation for this chat.';
  return 'I am continuing work from an earlier AI chat. Below is the saved summary of that chat.\n\n' +
    'Earlier chat: ' + (detail.title || 'Untitled') + '\nAgent: ' + detail.agent + '\nDates: ' + days + '\n' +
    (cwd ? 'Original folder: ' + cwd : 'The original folder is unknown.') + '\n\n' +
    summaries + '\n\n' + transcripts + '\n\n' +
    'Things may have changed since then. Check the current files before you act on anything in the summary.\n\n' +
    'Reply with one short line saying you have read this. Then wait for my next instruction.';
}

// A fresh WSL Claude chat seeded with the tracker summary, whatever agent the original chat used.
export async function resolveHandoff(detail, handoff) {
  if (!handoff?.summaries?.length) return { available: false, reason: noSummaryReason };
  const original = await resolveSession(detail);
  let cwd = original.available ? original.cwd : '';
  let diskCwd = original.available ? original.diskCwd : '';
  if (!diskCwd) {
    const guess = localPath(detail.project || '');
    if (guess && await isDirectory(guess)) { cwd = detail.project; diskCwd = guess; }
  }
  return { available: true, agent: 'claude', windows: false, cwd: cwd || os.homedir(), diskCwd: diskCwd || os.homedir(), command: ['claude', handoffPrompt(detail, handoff, cwd)] };
}

export function runnerText(resolved, acknowledgement) {
  if (resolved.windows) {
    return "$ErrorActionPreference = 'Stop'\nSet-Location -LiteralPath " + psQuote(resolved.cwd) + '\n' +
      '$agentCommand = Get-Command ' + psQuote(resolved.agent) + ' -ErrorAction Stop\n' +
      '[IO.File]::WriteAllText(' + psQuote(acknowledgement) + ", 'starting')\ntry {\n  & $agentCommand " + resolved.command.slice(1).map(psQuote).join(' ') + '\n  [IO.File]::WriteAllText(' + psQuote(acknowledgement) + ", 'exited:' + $LASTEXITCODE)\n} catch {\n  [IO.File]::WriteAllText(" + psQuote(acknowledgement) + ", 'exited:1')\n  throw\n}\n";
  }
  return '#!/usr/bin/env bash\nset -u\nunset CODEX_THREAD_ID CLAUDECODE\n' +
    'cd -- ' + shellQuote(resolved.diskCwd) + ' || exit 1\n' +
    'command -v ' + resolved.agent + ' >/dev/null || exit 1\n' +
    "printf starting > " + shellQuote(acknowledgement) + '\n' +
    resolved.command.map(shellQuote).join(' ') + '\n' +
    "exit_status=$?\nprintf 'exited:%s' \"$exit_status\" > " + shellQuote(acknowledgement) + '\n' +
    "printf '\\nAgent closed. This terminal is still available.\\n'\nexec bash -l\n";
}

async function waitForAgent(paneId, acknowledgement, resolved, sessionId) {
  for (let attempt=0; attempt<60; attempt++) {
    await new Promise(resolve => setTimeout(resolve,500));
    const phase = await readFile(acknowledgement,'utf8').catch(() => '');
    if (!phase) continue;
    const { stdout: visible } = await exec(herdrBin,['--session',herdrSession,'pane','read',paneId,'--source','visible','--lines','45'],{env:herdrEnv(),timeout:5000});
    if (/already has an active writer|session.*already.*running/i.test(visible)) throw new Error('This conversation is already open in another agent. Its new Herdr tab shows the resume error; close the other copy before trying again.');
    if (phase.startsWith('exited:')) throw new Error('The Herdr tab opened, but ' + resolved.agent + ' exited before it was ready. Check the message in that tab.');
    const { pane } = await herdr('pane','get',paneId);
    if (pane.agent === resolved.agent && pane.agent_status === 'blocked') return { ready:false, needsInput:true };
    if (!sessionId && attempt >= 2 && pane.agent === resolved.agent && ['idle','done','working'].includes(pane.agent_status)) return { ready:true, needsInput:false };
    if (pane.agent_session?.value === sessionId && ['idle','done','working','blocked'].includes(pane.agent_status)) return { ready:pane.agent_status !== 'blocked', needsInput:pane.agent_status === 'blocked' };
    if (attempt >= 3 && pane.agent === resolved.agent && ['idle','done'].includes(pane.agent_status) && visible.trim() && !/model:\s*loading|Resuming session|Starting MCP/i.test(visible)) {
      const { process_info: info } = await herdr('pane','process-info','--pane',paneId);
      if (info.foreground_processes.some(process => (process.argv || []).includes(sessionId))) return { ready:true, needsInput:false };
    }
  }
  const phase = await readFile(acknowledgement,'utf8').catch(() => '');
  if (phase === 'starting') return { ready:false, needsInput:true };
  throw new Error('The Herdr tab opened, but the agent did not start. Check the agent installation in that tab.');
}

async function ensureHerdr(marker) {
  try {
    const result = await herdr('terminal','title','set',marker);
    if (result.reason !== 'no_foreground_client') return;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Herdr is not installed at ' + herdrBin);
  }
  await exec('which',['wt.exe']);
  const command = 'exec ' + shellQuote(herdrBin);
  const child = spawn('wt.exe',['new-tab','--title','Herdr','wsl.exe','-d',wslDistro(),'--','bash','-lic',command],{env:herdrEnv(),stdio:'ignore',detached:true});
  let spawnError;
  child.on('error',error => { spawnError=error; });
  child.unref();
  for (let attempt=0; attempt<60; attempt++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve,250));
    try {
      const result = await herdr('terminal','title','set',marker);
      if (result.reason !== 'no_foreground_client') return;
    } catch {}
  }
  throw new Error('Herdr could not start. Open Herdr once, then try opening the conversation again.');
}

async function showHerdr(marker) {
  const script = localPath(appRoot).startsWith('/mnt/')
    ? (await exec('wslpath',['-w',path.join(appRoot,'show-herdr.ps1')])).stdout.trim()
    : '\\\\wsl.localhost\\' + wslDistro() + path.join(appRoot,'show-herdr.ps1').replaceAll('/','\\');
  try {
    const { stdout } = await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Title',marker],{timeout:15000});
    return JSON.parse(stdout).shown === true;
  } catch { return false; }
}

async function openInHerdr(detail, resolved, { fresh = false } = {}) {
  const sessionId = fresh ? null : detail.session_id;
  const agentLabel = fresh ? 'Claude Code (WSL)' : detail.agent;
  const prefix = fresh ? 'handoff-' : 'resume-';
  let runner;
  let ack;
  let command;
  const title = ((fresh ? '✦ ' : '↺ ') + (detail.title || resolved.agent + ' conversation')).replace(/[\r\n\x00-\x1f]/g,' ').slice(0,56);
  if (resolved.windows) {
    if (!windowsHome()) throw new Error('Set ECHO_WINDOWS_HOME to resume Windows sessions.');
    const folder = path.join(windowsHome(), 'AppData/Local/Echo/runners');
    await mkdir(folder, { recursive: true });
    const dir = await mkdtemp(path.join(folder, prefix));
    runner = path.join(dir, 'resume.ps1');
    ack = path.join(dir, 'opened');
    const win = file => {
      const drive = file.match(/^\/mnt\/([a-z])\/(.*)$/i);
      if (!drive) throw new Error('ECHO_WINDOWS_HOME must be a /mnt/<drive>/ path.');
      return drive[1].toUpperCase() + ':\\' + drive[2].replaceAll('/', '\\');
    };
    await writeFile(runner, runnerText(resolved, win(ack)));
    command = ['powershell.exe','-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',win(runner)].map(shellQuote).join(' ');
  } else {
    const folder = path.join(state, 'runners');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(folder, prefix));
    runner = path.join(dir, 'resume.sh');
    ack = path.join(dir, 'opened');
    await writeFile(runner, runnerText(resolved, ack), { mode: 0o700 });
    command = 'bash ' + shellQuote(runner);
  }
  const marker = 'Echo-Herdr-' + path.basename(path.dirname(runner));
  let tabId;
  let paneId;
  let workspace;
  let createdWorkspace = false;
  let commandSubmitted = false;
  try {
    await ensureHerdr(marker);
    const { snapshot } = await herdr('api','snapshot');
    const existing = sessionId ? await findOpenConversation(snapshot,resolved.agent,sessionId) : null;
    if (existing) {
      await herdr('tab','focus',existing.tab_id);
      const shown = await showHerdr(marker);
      workspace = snapshot.workspaces.find(item => item.workspace_id === existing.workspace_id);
      return { opened:true, shown, reused:true, ready:existing.agent_status !== 'blocked', needsInput:existing.agent_status === 'blocked', cwd:resolved.cwd, agent:agentLabel, sessionId, workspace:workspace.label, workspaceId:existing.workspace_id, tabId:existing.tab_id, paneId:existing.pane_id };
    }
    const sessions = await herdr('session','list','--json');
    const sessionDir = sessions.sessions.find(item => item.name === herdrSession)?.session_dir;
    const saved = sessionDir ? await readFile(path.join(sessionDir,'session.json'),'utf8').then(JSON.parse).catch(() => ({})) : {};
    workspace = chooseWorkspace(snapshot,saved.workspaces || [],resolved.diskCwd);
    if (!workspace) {
      const created = await herdr('workspace','create','--cwd',resolved.diskCwd,'--label',path.basename(resolved.diskCwd),'--no-focus');
      workspace = created.workspace;
      createdWorkspace = true;
      const { snapshot: fresh } = await herdr('api','snapshot');
      const pane = fresh.panes.find(item => item.workspace_id === workspace.workspace_id);
      if (!pane) throw new Error('Herdr created the workspace but its initial tab is not ready.');
      paneId = pane.pane_id;
      tabId = pane.tab_id;
      await herdr('tab','rename',tabId,title);
    } else {
      const created = await herdr('tab','create','--workspace',workspace.workspace_id,'--cwd',resolved.diskCwd,'--label',title,'--no-focus');
      tabId = created.tab.tab_id;
      paneId = created.root_pane.pane_id;
    }
    await herdr('pane','run',paneId,command);
    commandSubmitted = true;
    await herdr('tab','focus',tabId);
    const shown = await showHerdr(marker);
    const startup = await waitForAgent(paneId,ack,resolved,sessionId);
    return { opened:true, shown, ...startup, cwd:resolved.cwd, agent:agentLabel, sessionId, workspace:workspace.label, workspaceId:workspace.workspace_id, tabId, paneId };
  } catch (error) {
    if (!commandSubmitted) {
      if (createdWorkspace && workspace) await herdr('workspace','close',workspace.workspace_id).catch(() => {});
      else if (tabId) await herdr('tab','close',tabId).catch(() => {});
    }
    throw error;
  } finally {
    await herdr('terminal','title','clear').catch(() => {});
  }
}

function queueLaunch(task) {
  const result = launchQueue.catch(() => {}).then(task);
  launchQueue = result;
  return result;
}

export function launchSession(detail) {
  return queueLaunch(async () => {
    const resolved = await resolveSession(detail);
    if (!resolved.available) throw new Error(resolved.reason);
    return openInHerdr(detail, resolved);
  });
}

export function launchHandoff(detail, handoff) {
  return queueLaunch(async () => {
    const resolved = await resolveHandoff(detail, handoff);
    if (!resolved.available) throw new Error(resolved.reason);
    return openInHerdr(detail, resolved, { fresh: true });
  });
}
