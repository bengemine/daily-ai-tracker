/**
 * Summarization pipeline for Daily AI Tracker.
 *
 * compressHighlights() — pure function, formats Highlights into a compact text prompt
 * callClaude()         — internal, spawns `claude -p` with stdin pipe
 * summarizeConversation() — orchestrates compress + trim + call, returns fallback on error
 *
 * Phase 3f: trimmer integration.
 * Before building the LLM prompt, raw transcripts are passed through trimTranscript()
 * to strip tool calls, thinking blocks, and system noise. The cleaned User/Assistant
 * prose is appended to the prompt alongside existing highlights. Stats are reported
 * as trimStats on the returned result object and as a single log line to stderr.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { FactoryAdapter } = require('./adapters/factory');
const { trimTranscript } = require('./trimmer');
const { filterTurnsForDate, hasVisibleUserTurn, highlightsFromTurns } = require('./daily-transcript');

// --- Constants ---

/**
 * Hard cap on cleaned-transcript chars sent to LLM.
 * If the cleaned transcript exceeds this, keep first 5 000 + last 30 000 chars
 * with a "[... trimmed middle ...]" marker.
 */
const TOPIC_MAX_CHARS = 500;
const MESSAGE_MAX_CHARS = 300;
const MAX_USER_MESSAGES = 15;
const MAX_FILE_PATHS = 20;
const MAX_LAST_EXCHANGES = 5;
const EXCHANGE_MAX_CHARS = 300;
const DEFAULT_CLAUDE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const MAX_ERROR_PATH_CHARS = 240;
const LOCAL_FALLBACK_MAX_MESSAGES = 5;
const LOCAL_FALLBACK_MAX_FILES = 10;

const SYSTEM_PROMPT = `You summarize one day's visible dialogue between a user and an AI agent. Respond in EXACTLY this format:

TITLE: <one-line description of what the user was trying to accomplish, 8-15 words, active voice>
BODY:
<2-3 sentence summary of what the user asked and what the agent visibly reported or delivered. Be specific. Do not include preamble or meta-commentary.>

Use only the supplied visible dialogue. Do not infer hidden reasoning, commands, tools, skills, file changes, or outcomes that the agent did not state in its visible replies.

Rules for the TITLE line:
- Describe the ACTUAL INTENT / GOAL of the chat (what the user was trying to accomplish).
- Use past tense or past participle phrasing (e.g. "Mapped X and drafted Y", "Fixed auth bug in Z", "Investigated sub-agent leak and wired filter").
- 8-15 words. If the session is tiny or narrow, fewer words are OK but must still be specific.
- Do NOT use any of these generic words in the title: session, summary, overview, untitled, various, miscellaneous, chat, conversation.
- Example: TITLE: Mapped team hierarchy and drafted capacity-tracking Google Sheet for sub-leads`;

/**
 * Forbidden title patterns for the structured TITLE: parser.
 * These mirror the STOCK_TITLE_PATTERNS blacklist in journal.js but are used
 * here to detect when the LLM ignored the new prompt format and fell back to
 * old-style stock headings.
 */
const TITLE_FORBIDDEN_PATTERNS = [
  /^session summary$/i,
  /^summary$/i,
  /^overview$/i,
  /^what (was|we) (accomplished|worked on|did)$/i,
  /^accomplishments?$/i,
  /^tasks? (completed|done)$/i,
  /^topic$/i,
  /^summary of work$/i,
  /^results?$/i,
  /^outcome$/i,
  /^untitled.*$/i,
];

// --- Helpers ---

/**
 * Truncate a string to maxLen chars, appending "…" if truncated.
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidate.command.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function getClaudeTimeoutMs(env = process.env, cfg = config) {
  const envTimeout = parsePositiveInteger(
    env.CLAUDE_SUMMARIZER_TIMEOUT_MS ?? env.CLAUDE_TIMEOUT_MS
  );
  if (envTimeout !== null) return envTimeout;

  const configTimeout = parsePositiveInteger(cfg.summarizer?.claudeTimeoutMs);
  return configTimeout ?? DEFAULT_CLAUDE_TIMEOUT_MS;
}

function getClaudeCommandCandidates(env = process.env, platform = process.platform) {
  const override = env.CLAUDE_CLI_PATH?.trim();
  if (override) {
    return [{ command: override, source: 'CLAUDE_CLI_PATH', required: true }];
  }

  const candidates = [];
  if (platform === 'win32') {
    const distro = env.AI_TRACKER_WSL_DISTRO || config.wsl.distro;
    const windowsWrapper = path.win32.resolve(__dirname, 'run-claude-wsl.sh');
    const driveMatch = windowsWrapper.match(/^([A-Za-z]):\\(.*)$/);
    const wslWrapper = driveMatch
      ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
      : windowsWrapper;
    candidates.push({
      command: 'wsl.exe',
      source: `WSL ${distro}`,
      // --exec bypasses the WSL login shell, so '&' and spaces in args survive.
      prefixArgs: ['-d', distro, '--exec', 'bash', wslWrapper],
    });
  }
  candidates.push(
    { command: 'claude', source: 'PATH' },
    { command: 'claude.cmd', source: 'PATH' },
  );

  const pathForPlatform = platform === 'win32' ? path.win32 : path;
  const userProfile = env.USERPROFILE || env.HOME || '';
  if (platform === 'win32') {
    const roamingBases = [
      env.APPDATA,
      userProfile ? pathForPlatform.join(userProfile, 'AppData', 'Roaming') : '',
    ].filter(Boolean);
    const localBases = [
      env.LOCALAPPDATA,
      userProfile ? pathForPlatform.join(userProfile, 'AppData', 'Local') : '',
    ].filter(Boolean);

    for (const base of roamingBases) {
      candidates.push({ command: pathForPlatform.join(base, 'npm', 'claude.cmd'), source: 'APPDATA npm' });
      candidates.push({ command: pathForPlatform.join(base, 'npm', 'claude'), source: 'APPDATA npm' });
    }
    for (const base of localBases) {
      candidates.push({ command: pathForPlatform.join(base, 'npm', 'claude.cmd'), source: 'LOCALAPPDATA npm' });
      candidates.push({ command: pathForPlatform.join(base, 'npm', 'claude'), source: 'LOCALAPPDATA npm' });
      candidates.push({ command: pathForPlatform.join(base, 'Programs', 'npm', 'claude.cmd'), source: 'LOCALAPPDATA Programs npm' });
    }

    // nvm4w (Node Version Manager for Windows) installs node globals under
    // C:\nvm4w\nodejs by default. That is NOT under APPDATA\npm, so we must
    // check it explicitly.
    // Placed after APPDATA/USERPROFILE paths so that env-var-based candidates
    // (which tests can override) are tried before hardcoded machine paths.
    const nvm4wNodejsDir = 'C:\\nvm4w\\nodejs';
    candidates.push({ command: pathForPlatform.join(nvm4wNodejsDir, 'claude.cmd'), source: 'nvm4w nodejs' });
    candidates.push({ command: pathForPlatform.join(nvm4wNodejsDir, 'claude'), source: 'nvm4w nodejs' });
  } else {
    if (userProfile) {
      candidates.push({ command: path.join(userProfile, '.npm-global', 'bin', 'claude'), source: 'npm global bin' });
      candidates.push({ command: path.join(userProfile, '.local', 'bin', 'claude'), source: 'local bin' });
    }
    candidates.push({ command: '/usr/local/bin/claude', source: 'usr local bin' });
    candidates.push({ command: '/opt/homebrew/bin/claude', source: 'homebrew bin' });
  }

  return dedupeCandidates(candidates);
}

function isFilePathCommand(command) {
  return path.isAbsolute(command) || command.includes(path.sep) || command.includes('/');
}

function shouldUseShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/**
 * On Windows, npm-generated .cmd wrappers run node with a target .js file.
 * Spawning them with shell:true breaks stdin piping. Instead, read the .cmd
 * file to extract the node executable and JS target, then spawn node directly.
 *
 * Returns { command: nodeExe, args: [jsPath, ...rest] } when parsing succeeds,
 * or null when the .cmd does not match the expected npm-wrapper pattern.
 */
function resolveNpmCmdWrapper(cmdPath, extraArgs = []) {
  if (!path.isAbsolute(cmdPath)) return null;
  let contents;
  try {
    contents = fs.readFileSync(cmdPath, 'utf-8');
  } catch {
    return null;
  }
  // Match: "%_prog%"  "C:\...\cli.js" or  node  "C:\...\cli.js"
  const jsMatch = contents.match(/(?:"%_prog%"|node(?:\.exe)?)\s+"([^"]+\.js)"/i)
    || contents.match(/(?:"%_prog%"|node(?:\.exe)?)\s+([^\s%]+\.js)/i);
  if (!jsMatch) return null;

  // Expand %dp0% / %~dp0 bat variable references to the cmd's own directory.
  const dir = path.dirname(cmdPath);
  const jsPath = jsMatch[1].replace(/%~?dp0%?/gi, dir);
  const nodeExe = fs.existsSync(path.join(dir, 'node.exe'))
    ? path.join(dir, 'node.exe')
    : process.execPath;

  return { command: nodeExe, args: [jsPath, ...extraArgs] };
}

function isWindowsShellNotFound(command, stderr) {
  return (
    shouldUseShell(command) &&
    !isFilePathCommand(command) &&
    /not recognized as an internal or external command/i.test(stderr || '')
  );
}

function describeCandidate(candidate) {
  const command = candidate.command.length > MAX_ERROR_PATH_CHARS
    ? `${candidate.command.slice(0, MAX_ERROR_PATH_CHARS)}...`
    : candidate.command;
  return `${command} (${candidate.source})`;
}

function buildNotFoundError(attempts, env = process.env) {
  const tried = attempts.length > 0
    ? attempts.join('; ')
    : getClaudeCommandCandidates(env).map(describeCandidate).join('; ');
  const pathHint = env.PATH
    ? ` PATH entries: ${env.PATH.split(path.delimiter).filter(Boolean).length}.`
    : ' PATH is empty or unavailable.';
  return new Error(
    `claude CLI not found. Tried: ${tried}.${pathHint} ` +
    'Set CLAUDE_CLI_PATH to the full Claude executable path if this runs from Task Scheduler.'
  );
}

function runClaudeCommand(candidate, args, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? getClaudeTimeoutMs();
    let timedOut = false;

    // On Windows, spawning .cmd files with shell:true breaks stdin piping.
    // Resolve npm .cmd wrappers to their underlying node + cli.js invocation
    // so we can spawn without a shell and preserve stdin correctly.
    let spawnCommand = candidate.command;
    let spawnArgs = [...(candidate.prefixArgs || []), ...args];
    let useShell = shouldUseShell(candidate.command);
    if (useShell) {
      const resolved = resolveNpmCmdWrapper(candidate.command, spawnArgs);
      if (resolved) {
        spawnCommand = resolved.command;
        spawnArgs = resolved.args;
        useShell = false;
      }
    }

    const child = spawn(spawnCommand, spawnArgs, {
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {
      // The CLI may exit before reading stdin when it fails during startup.
    });

    child.on('error', error => {
      clearTimeout(timer);
      error.stderr = stderr;
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(
          `claude CLI timed out after configured timeout ${timeoutMs / 1000}s using ${describeCandidate(candidate)}`
        ));
        return;
      }
      if (code !== 0) {
        const msg = stderr.trim() || `process exited with signal ${signal || 'none'}`;
        const error = new Error(`claude CLI exited with code ${code} using ${describeCandidate(candidate)}: ${msg}`);
        error.code = isWindowsShellNotFound(candidate.command, stderr) ? 'ENOENT' : code;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(prompt);
  });
}

function compactString(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasRawHighlights(highlights) {
  if (!highlights) return false;
  if (compactString(highlights.topic)) return true;
  if (Array.isArray(highlights.userMessages) && highlights.userMessages.some(compactString)) return true;
  if (Array.isArray(highlights.toolCalls) && highlights.toolCalls.length > 0) return true;
  if (Array.isArray(highlights.filePaths) && highlights.filePaths.some(compactString)) return true;
  if (Array.isArray(highlights.lastExchanges) && highlights.lastExchanges.some(compactString)) return true;
  return false;
}

function cleanLocalTitleSource(value) {
  let text = compactString(value);
  if (!text) return '';

  text = text
    .replace(/^local fallback:\s*/i, '')
    .replace(/^[>|\-+\s]+$/g, '')
    .replace(/[╭╮╰╯│─═]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function chooseLocalFallbackTitle(highlights, session) {
  const topic = cleanLocalTitleSource(highlights?.topic);
  const firstMessage = Array.isArray(highlights?.userMessages)
    ? cleanLocalTitleSource(highlights.userMessages.find(cleanLocalTitleSource))
    : '';
  const project = cleanLocalTitleSource(session?.project);
  const source = topic || firstMessage || (project ? path.basename(project) || project : '') || compactString(session?.agent) || 'session';
  return truncate(source, 100);
}

function buildLocalFallbackSummary(highlights, session, error) {
  if (!hasRawHighlights(highlights)) {
    return { title: '', body: '[Empty session — no content to summarize]', summarySource: 'local' };
  }

  const lines = [];
  const topic = compactString(highlights.topic);
  if (topic) lines.push(`Topic: ${truncate(topic, TOPIC_MAX_CHARS)}`);

  if (Array.isArray(highlights.userMessages) && highlights.userMessages.some(compactString)) {
    const messages = highlights.userMessages.map(compactString).filter(Boolean);
    if (lines.length > 0) lines.push('');
    lines.push('The user asked:');
    messages.slice(0, LOCAL_FALLBACK_MAX_MESSAGES).forEach((message, i) => {
      lines.push(`${i + 1}. ${truncate(message, MESSAGE_MAX_CHARS)}`);
    });
  }

  if (Array.isArray(highlights.lastExchanges) && highlights.lastExchanges.some(compactString)) {
    const allExchanges = highlights.lastExchanges.map(compactString).filter(Boolean);
    const labeledAssistant = allExchanges.filter(exchange => /^assistant:/i.test(exchange));
    const exchanges = labeledAssistant.length > 0 ? labeledAssistant : allExchanges;
    if (exchanges.length > 0) lines.push('', 'The agent reported:');
    exchanges.slice(0, MAX_LAST_EXCHANGES).forEach(exchange => {
      lines.push(`- ${truncate(exchange.replace(/^assistant:\s*/i, ''), EXCHANGE_MAX_CHARS)}`);
    });
  }

  return {
    title: chooseLocalFallbackTitle(highlights, session),
    body: lines.join('\n'),
    summarySource: 'local',
    diagnostic: error?.message || '',
  };
}

// --- Trimmer integration ---

/**
 * Maps detection adapter agent names to trimmer adapter names.
 *
 * Agent names come from config (e.g. 'Claude Code', 'Codex', 'Cursor', …).
 * Trimmer adapter names are the module filenames under src/trimmer/adapters/.
 *
 * cursor: trimmer needs a SQLite DB handle, not reconstructable here → skipped.
 */
const AGENT_TO_TRIMMER_ADAPTER = {
  'Claude Code': 'claude-code',
  'Claude Code (WSL)': 'claude-code',
  'Codex':       'codex',
  'Codex (WSL)': 'codex',
  'Cursor':      null,      // needs SQLite handle — skip
  'Factory':     'factory',
  'Grok':        'grok',
  'Grok (WSL)':  'grok',
  'OpenCode':    null,      // parsed from SQLite by OpenCodeAdapter.extractCleanTurns
};

/**
 * Encode a project filesystem path to the directory name Claude Code uses.
 * Mirrors ClaudeCodeAdapter.encodeProjectPath() without importing that class.
 *
 * @param {string} projectPath
 * @returns {string}
 */
function encodeClaudeProjectPath(projectPath) {
  let encoded = projectPath;
  encoded = encoded.replace(/^([A-Za-z]):[\\\/]/, '$1--');
  encoded = encoded.replace(/[\\\/. ]/g, '-');
  return encoded;
}

function getSessionSourceFile(session) {
  if (!session || typeof session.filePath !== 'string' || !session.filePath.trim()) {
    return null;
  }
  return session.filePath;
}

function isMissingOrDenied(err) {
  return err && ['ENOENT', 'EACCES', 'EPERM'].includes(err.code);
}

function safeStatPath(targetPath) {
  if (!targetPath) return null;
  try {
    return fs.statSync(targetPath);
  } catch (err) {
    if (isMissingOrDenied(err)) return null;
    throw err;
  }
}

function walkFactoryJsonlFiles(dirPath) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if (isMissingOrDenied(err)) return results;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) continue;

    try {
      const nested = fs.readdirSync(fullPath, { withFileTypes: true });
      for (const sub of nested) {
        if (sub.isFile() && sub.name.endsWith('.jsonl')) {
          results.push(path.join(fullPath, sub.name));
        }
      }
    } catch (err) {
      if (!isMissingOrDenied(err)) throw err;
    }
  }

  return results;
}

/**
 * Attempt to resolve the raw transcript source for a given session.
 *
 * For claude-code sessions: prefers the explicit session.filePath when present,
 *   otherwise resolves the per-session .jsonl file path using the session UUID
 *   and project path (same encoding logic as ClaudeCodeAdapter). Falls back to
 *   passing the project directory so the adapter can walk all jsonl files.
 *
 * For codex sessions: resolves the per-session .jsonl from ~/.codex/sessions/YYYY/MM/DD/.
 *
 * For factory sessions: passes ~/.factory/sessions/ so the adapter can scan.
 *
 * For opencode: passes the DB path from config.
 *
 * For cursor: returns null (trimmer requires a database-aware session lookup).
 *
 * @param {string} adapterName - Trimmer adapter name (e.g. 'claude-code').
 * @param {{ id: string, agent: string, project: string, startTime: Date }} session
 * @param {object} [cfg] - config object (injectable for testing)
 * @returns {string|null} - Source path/string for the trimmer, or null to skip.
 */
function resolveTranscriptSource(adapterName, session, cfg = config) {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';

  const explicitSource = getSessionSourceFile(session);
  if (explicitSource && safeStatPath(explicitSource)) {
    return explicitSource;
  }

  if (adapterName === 'claude-code') {
    const isWsl = /\(WSL\)$/.test(session?.agent || '');
    const claudeStorage = (isWsl ? cfg.agents?.claudeCodeWsl?.storagePath : cfg.agents?.claudeCode?.storagePath)
      || path.join(userProfile, '.claude');
    const projectsDir = path.join(claudeStorage, 'projects');
    const encodedProject = encodeClaudeProjectPath(session.project || '');
    const exactFile = path.join(projectsDir, encodedProject, `${session.id}.jsonl`);
    if (safeStatPath(exactFile)) return exactFile;
    // Fall back to project directory — adapter will walk all jsonl files.
    const projectDir = path.join(projectsDir, encodedProject);
    if (safeStatPath(projectDir)) return projectDir;
    return null;
  }

  if (adapterName === 'codex') {
    const isWsl = /\(WSL\)$/.test(session?.agent || '');
    const codexStorage = (isWsl ? cfg.agents?.codexWsl?.storagePath : cfg.agents?.codex?.storagePath)
      || path.join(userProfile, '.codex');
    const sessionsDir = path.join(codexStorage, 'sessions');
    if (!session.startTime) return null;
    const d = session.startTime instanceof Date ? session.startTime : new Date(session.startTime);
    const year  = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day   = String(d.getDate()).padStart(2, '0');
    const dayDir = path.join(sessionsDir, year, month, day);
    if (!safeStatPath(dayDir)) return null;
    // Find the specific session file by ID within the day directory.
    try {
      const match = fs.readdirSync(dayDir).find(
        f => f.includes(session.id) && f.endsWith('.jsonl')
      );
      if (match) return path.join(dayDir, match);
      // Fall back to the day directory so adapter scans all files for that day.
      return dayDir;
    } catch {
      return null;
    }
  }

  if (adapterName === 'factory') {
    const factoryStorage = cfg.agents?.factory?.storagePath
      || path.join(userProfile, '.factory');
    const sessionsDir = path.join(factoryStorage, 'sessions');
    if (!safeStatPath(sessionsDir)) return null;

    const encodedProject = session.project && session.project !== '(unknown)'
      ? FactoryAdapter.encodeProjectPath(session.project)
      : null;
    if (encodedProject) {
      const exactFile = path.join(sessionsDir, encodedProject, `${session.id}.jsonl`);
      if (safeStatPath(exactFile)) return exactFile;
      const projectDir = path.join(sessionsDir, encodedProject);
      if (safeStatPath(projectDir)) return projectDir;
    }

    const looseFile = path.join(sessionsDir, `${session.id}.jsonl`);
    if (safeStatPath(looseFile)) return looseFile;

    // Factory sessions dir — adapter will match by session ID pattern.
    // Try to find the specific file first, then walk project dirs.
    try {
      const allFiles = walkFactoryJsonlFiles(sessionsDir);
      const match = allFiles.find(f => path.basename(f, '.jsonl') === session.id);
      return match || null;
    } catch {
      return null;
    }
  }

  if (adapterName === 'opencode') {
    const dbPath = cfg.agents?.openCode?.dbPath
      || path.join(userProfile, '.local', 'share', 'opencode', 'opencode.db');
    return fs.existsSync(dbPath) ? dbPath : null;
  }

  return null;
}

/**
 * Convert CleanTurn[] to a plain-text transcript string in User:/Assistant: format.
 * This is deliberately complete. The deterministic cleaner removes tool and
 * reasoning noise; it must not remove visible user or assistant dialogue.
 *
 * @param {import('./trimmer/types').CleanTurn[]} turns
 * @returns {string}
 */
function formatCleanTranscript(turns) {
  const lines = [];
  for (const turn of turns) {
    const role = turn.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${role}: ${turn.content}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Attempt to trim a raw transcript for the given session.
 * Returns null on any failure (adapter missing, file not found, trimmer throws).
 * Emits exactly one log line to stderr reporting the outcome.
 *
 * @param {{ id: string, agent: string, project: string, startTime: Date }} session
 * @param {object} [cfg] - config (injectable for testing)
 * @returns {Promise<{ cleanText: string, trimStats: object }|null>}
 */
async function tryTrimSession(session, cfg = config) {
  const agentName = session.agent || '';
  const trimmerName = AGENT_TO_TRIMMER_ADAPTER[agentName];
  const sessionId = (session.id || '').slice(0, 12);

  if (trimmerName === undefined) {
    // Unknown agent — not in our map at all
    console.error(
      `[summarizer] trim=skip agent="${agentName}" session=${sessionId} reason=unknown-agent`
    );
    return null;
  }

  if (trimmerName === null) {
    // Cursor is parsed directly by its detection adapter when reliable bubble
    // timestamps are available.
    return null;
  }

  const source = resolveTranscriptSource(trimmerName, session, cfg);
  if (!source) {
    console.error(
      `[summarizer] trim=skip adapter=${trimmerName} session=${sessionId} reason=source-not-found`
    );
    return null;
  }

  let result;
  try {
    result = await trimTranscript(source, trimmerName, {
      includeTimestamps: true,
      targetDate: session.activityDate,
    });
  } catch (err) {
    console.error(
      `[summarizer] trim=error adapter=${trimmerName} session=${sessionId} error="${err.message}"`
    );
    return null;
  }

  const messages = session.activityDate
    ? filterTurnsForDate(result?.messages, session.activityDate)
    : (result?.messages || []);

  if (!result || messages.length === 0 || !hasVisibleUserTurn(messages)) {
    console.error(
      `[summarizer] trim=empty adapter=${trimmerName} session=${sessionId}`
    );
    return null;
  }

  const stats = result.stats || {};
  const cleanedChars = messages.reduce((total, turn) => total + turn.content.length, 0);
  const origKB = ((stats.originalBytes || 0) / 1024).toFixed(1);
  const cleanKB = (cleanedChars / 1024).toFixed(1);
  const ratio = stats.originalBytes > 0
    ? (stats.originalBytes / Math.max(cleanedChars, 1)).toFixed(1)
    : '?';

  console.error(
    `[summarizer] adapter=${trimmerName} session=${sessionId} trim=${origKB}KB→${cleanKB}KB (${ratio}x)`
  );

  const cleanText = formatCleanTranscript(messages);
  return {
    messages,
    cleanText,
    trimStats: {
      originalBytes: stats.originalBytes || 0,
      cleanedChars,
      ratio:         parseFloat(ratio) || 0,
    },
    warnings: result.warnings || [],
  };
}

// --- Core functions ---

/**
 * Compress highlights and session metadata into a compact text prompt.
 * Returns null when there's nothing meaningful to summarize (empty topic AND empty messages).
 *
 * @param {{ topic: string, userMessages: string[], toolCalls: { name: string, count: number }[], filePaths: string[], lastExchanges: string[] }} highlights
 * @param {{ agent: string, project: string }} session
 * @returns {string|null} Compressed prompt text, or null to skip
 */
function compressHighlights(highlights, session) {
  const { topic, userMessages, toolCalls, filePaths, lastExchanges } = highlights;

  // Skip when there's nothing to summarize
  if ((!topic || topic.trim() === '') && (!userMessages || userMessages.length === 0)) {
    return null;
  }

  const lines = [];

  // Header
  lines.push(`Agent: ${session.agent}`);
  lines.push(`Project: ${session.project}`);

  // Topic — truncated to 500 chars
  if (topic && topic.trim()) {
    lines.push(`Topic: ${truncate(topic.trim(), TOPIC_MAX_CHARS)}`);
  }

  // Tools Used — omit entire section when empty
  if (toolCalls && toolCalls.length > 0) {
    const toolList = toolCalls.map(t => `${t.name} (${t.count}x)`).join(', ');
    lines.push('');
    lines.push(`Tools Used: ${toolList}`);
  }

  // Files — omit entire section when empty
  if (filePaths && filePaths.length > 0) {
    const capped = filePaths.slice(0, MAX_FILE_PATHS);
    const total = filePaths.length;
    lines.push('');
    lines.push(`Files (${total}): ${capped.join(', ')}`);
  }

  // User Messages — cap count and truncate each
  if (userMessages && userMessages.length > 0) {
    const capped = userMessages.slice(0, MAX_USER_MESSAGES);
    lines.push('');
    lines.push(`User Messages (${userMessages.length} total):`);
    capped.forEach((msg, i) => {
      lines.push(`${i + 1}. ${truncate(msg.trim(), MESSAGE_MAX_CHARS)}`);
    });
  }

  // Final Context — last exchanges for recency context
  if (lastExchanges && lastExchanges.length > 0) {
    const capped = lastExchanges.slice(0, MAX_LAST_EXCHANGES);
    lines.push('');
    lines.push('Final Context:');
    capped.forEach(ex => {
      lines.push(truncate(ex.trim(), EXCHANGE_MAX_CHARS));
    });
  }

  lines.push('');
  lines.push('Summarize what was accomplished in this session.');

  return lines.join('\n');
}

/**
 * Spawn `claude -p` with the given prompt on stdin.
 * Internal — not exported. Throws on any error.
 *
 * @param {string} prompt - User message to send
 * @param {string} systemPrompt - System prompt via --system-prompt flag
 * @returns {Promise<string>} Trimmed stdout from claude
 */
function callClaude(prompt, systemPrompt) {
  const args = [
    '-p',
    '--no-session-persistence',
    '--tools', '',
    '--model', 'sonnet',
    '--system-prompt', systemPrompt,
  ];

  const attempts = [];
  const candidates = getClaudeCommandCandidates();
  const timeoutMs = getClaudeTimeoutMs();

  return (async () => {
    for (const candidate of candidates) {
      if (isFilePathCommand(candidate.command) && !fs.existsSync(candidate.command)) {
        attempts.push(`${describeCandidate(candidate)}: missing`);
        if (candidate.required) throw buildNotFoundError(attempts);
        continue;
      }

      try {
        attempts.push(describeCandidate(candidate));
        return await runClaudeCommand(candidate, args, prompt, { timeoutMs });
      } catch (error) {
        if (error.code === 'ENOENT') {
          attempts[attempts.length - 1] = `${describeCandidate(candidate)}: ENOENT`;
          if (candidate.required) throw buildNotFoundError(attempts);
          continue;
        }
        throw error;
      }
    }

    throw buildNotFoundError(attempts);
  })();
}

function shouldUseLocalSummaryOnly() {
  return /^(1|true|yes)$/i.test(process.env.AI_TRACKER_LOCAL_SUMMARY_ONLY || '');
}

/**
 * Stock heading phrases that indicate the LLM ignored the TITLE: instruction
 * and fell back to generic section headings.  Shared with extractMeaningfulTitle.
 */
const STOCK_TITLE_PATTERNS = [
  /^session summary$/i,
  /^summary$/i,
  /^overview$/i,
  /^what (was|we) (accomplished|worked on|did)$/i,
  /^accomplishments?$/i,
  /^tasks? (completed|done)$/i,
  /^topic$/i,
  /^summary of work$/i,
  /^results?$/i,
  /^outcome$/i,
  /^untitled.*$/i,
];

/**
 * Walk a multi-line markdown string and return the first title-worthy text:
 * 1. Numbered sub-heading:  ### 1. Some Title  →  "Some Title"
 * 2. Any `## Title` / `# Title` that is NOT a stock phrase  →  title text
 * 3. First prose line with >= 4 words that is NOT a stock phrase
 *
 * Returns up to 100 chars (+ ellipsis) or "(untitled)" if nothing usable.
 *
 * @param {string} rawContent
 * @returns {string}
 */
function extractMeaningfulTitle(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '(untitled)';

  const lines = rawContent.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Numbered sub-heading: ### 1. Some Title or ## 1. Some Title
    const numberedSubheading = trimmed.match(/^#{1,6}\s+\d+[.)]\s+(.+)/);
    if (numberedSubheading) {
      const candidate = numberedSubheading[1].trim();
      if (candidate && !STOCK_TITLE_PATTERNS.some(p => p.test(candidate))) {
        return candidate.length > 100 ? candidate.slice(0, 100) + '\u2026' : candidate;
      }
    }

    // Any heading line — extract the heading text
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      const candidate = headingMatch[1].trim();
      // Skip if it's a stock phrase
      if (STOCK_TITLE_PATTERNS.some(p => p.test(candidate))) continue;
      // Use if it has enough substance (>= 3 words)
      if (candidate.split(/\s+/).length >= 3) {
        return candidate.length > 100 ? candidate.slice(0, 100) + '\u2026' : candidate;
      }
      continue;
    }

    // Skip blockquote lines
    if (/^>/.test(trimmed)) continue;

    // Prose line: must have >= 4 words and not be a stock phrase
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 4 && !STOCK_TITLE_PATTERNS.some(p => p.test(trimmed))) {
      return trimmed.length > 100 ? trimmed.slice(0, 100) + '\u2026' : trimmed;
    }
  }

  return '(untitled)';
}

/**
 * Parse a claude response into { title, body }.
 *
 * Priority chain:
 *   1. TITLE: line match (new structured format)
 *   2. extractMeaningfulTitle() — skips stock headings, digs for subtitle
 *   3. Existing flattenTitle-style fallback (first sentence or first 60 chars)
 *   4. "(untitled)"
 *
 * @param {string} raw - Raw LLM output string
 * @returns {{ title: string, body: string }}
 */
function parseResponse(raw) {
  const trimmed = raw.trim();

  // 1. Try structured TITLE: / BODY: format (new prompt)
  const titleMatch = trimmed.match(/^TITLE:\s*(.+?)(?:\r?\n|$)/i);
  if (titleMatch) {
    const parsedTitle = titleMatch[1].trim();
    const restAfterTitle = trimmed.slice(titleMatch[0].length);
    const bodyMatch = restAfterTitle.match(/^\s*BODY:\s*([\s\S]*)$/i);
    const body = bodyMatch ? bodyMatch[1].trim() : restAfterTitle.trim();
    return { title: parsedTitle, body: body || trimmed };
  }

  // Legacy: Try to extract "Title: ..." from the first line (old prompt format)
  const legacyTitleMatch = trimmed.match(/^Title:\s*(.+)/i);
  if (legacyTitleMatch) {
    const title = legacyTitleMatch[1].trim();
    const bodyStart = trimmed.indexOf('\n');
    const body = bodyStart !== -1 ? trimmed.slice(bodyStart).trim() : '';
    return { title, body: body || trimmed };
  }

  // 2. No structured prefix — walk content and extract meaningful title
  const meaningfulTitle = extractMeaningfulTitle(trimmed);
  if (meaningfulTitle !== '(untitled)') {
    return { title: meaningfulTitle, body: trimmed };
  }

  // 3. Last resort: first sentence as title
  const firstSentence = trimmed.match(/^[^.!?]+[.!?]?/);
  const fallbackTitle = firstSentence
    ? firstSentence[0].trim().replace(/\.$/, '')
    : trimmed.slice(0, 60);
  if (fallbackTitle) return { title: fallbackTitle, body: trimmed };

  // 4. Give up
  return { title: '(untitled)', body: trimmed };
}

/**
 * Summarize a conversation session. Compresses highlights, optionally prepends a
 * cleaned transcript (via trimTranscript), pipes through claude, and returns a
 * structured result with title, body, and trimStats.
 *
 * Never throws — returns a fallback on any error.
 *
 * @param {{ topic: string, userMessages: string[], toolCalls: { name: string, count: number }[], filePaths: string[], lastExchanges: string[] }} highlights
 * @param {{ agent: string, project: string, id: string, startTime: Date }} session
 * @param {object} [_deps] - Injectable deps for testing: { tryTrim }
 * @returns {Promise<{ title: string, body: string, trimStats?: object }>}
 */
async function summarizeConversation(highlights, session, _deps = {}) {
  const trimFn = _deps.tryTrim || tryTrimSession;
  let trimResult = session.cleanedTranscript || null;

  if (!trimResult) {
    try {
      trimResult = await trimFn(session);
    } catch (err) {
      console.error(`[summarizer] trim=unexpected-error session=${(session.id || '').slice(0, 12)} error="${err.message}"`);
    }
  }

  const effectiveHighlights = trimResult?.messages
    ? highlightsFromTurns(trimResult.messages)
    : highlights;
  const compressed = compressHighlights(effectiveHighlights, session);

  if (compressed === null) {
    return buildLocalFallbackSummary(
      effectiveHighlights,
      session,
      new Error('No visible user messages available for summarization')
    );
  }

  let prompt = compressed;
  if (trimResult?.cleanText) {
    prompt = [
      `Agent: ${session.agent}`,
      `Project: ${session.project}`,
      session.activityDate ? `Date: ${session.activityDate}` : '',
      '',
      '--- Visible user and assistant dialogue for this date ---',
      '',
      trimResult.cleanText,
      '',
      '--- End of visible dialogue ---',
      '',
      'Summarize what the user asked and what outcome the agent reported.',
    ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
  }

  if (shouldUseLocalSummaryOnly()) {
    const fallback = buildLocalFallbackSummary(
      effectiveHighlights,
      session,
      new Error('Local summary mode enabled')
    );
    if (trimResult) {
      fallback.trimStats = trimResult.trimStats;
    }
    return fallback;
  }

  try {
    const invokeClaude = _deps.callClaude || callClaude;
    const raw = await invokeClaude(prompt, SYSTEM_PROMPT);
    const parsed = parseResponse(raw);
    parsed.summarySource = 'claude';
    if (trimResult) {
      parsed.trimStats = trimResult.trimStats;
    }
    return parsed;
  } catch (error) {
    console.warn(`[summarizer] ${error.message}`);
    const fallback = buildLocalFallbackSummary(effectiveHighlights, session, error);
    if (trimResult) {
      fallback.trimStats = trimResult.trimStats;
    }
    return fallback;
  }
}

/**
 * Create one summarizer for a tracker run. The first Claude failure opens a
 * circuit for that run, so later sessions fall back without spawning Claude.
 */
function createRunSummarizer(_deps = {}) {
  let claudeFailure = null;
  const invokeClaude = _deps.callClaude || callClaude;

  return async (highlights, session) => {
    if (claudeFailure) {
      const fallback = buildLocalFallbackSummary(highlights, session, claudeFailure);
      if (session.cleanedTranscript) fallback.trimStats = session.cleanedTranscript.trimStats;
      return fallback;
    }

    return summarizeConversation(highlights, session, {
      ..._deps,
      callClaude: async (...args) => {
        try {
          return await invokeClaude(...args);
        } catch (error) {
          claudeFailure = error;
          throw error;
        }
      },
    });
  };
}

module.exports = {
  compressHighlights,
  summarizeConversation,
  createRunSummarizer,
  parseResponse,
  buildLocalFallbackSummary,
  getClaudeCommandCandidates,
  getClaudeTimeoutMs,
  runClaudeCommand,
  shouldUseShell,
  shouldUseLocalSummaryOnly,
  // Title extraction helpers (exported for testing)
  extractMeaningfulTitle,
  STOCK_TITLE_PATTERNS,
  SYSTEM_PROMPT,
  // Phase 3f exports (for testing)
  AGENT_TO_TRIMMER_ADAPTER,
  resolveTranscriptSource,
  formatCleanTranscript,
  tryTrimSession,
};
