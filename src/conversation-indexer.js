'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { trimTranscript } = require('./trimmer');
const { normalizeWhitespace } = require('./trimmer');
const { extractText: extractGrokText } = require('./trimmer/adapters/grok');
const { detectSubAgent } = require('./adapters/sub-agent-filter');
const { openDatabase } = require('./utils/sqlite');
const { loadT3SessionMap, hasT3RuntimeMarker } = require('./t3-sessions');
const { normalizeVisibleTurns, hasVisibleUserTurn } = require('./daily-transcript');
const { formatWorkDate } = require('./utils/date');
const {
  chooseScanMode,
  selectChangedDescriptors,
  writeSuccessfulScanState,
} = require('./conversation-scan');
const {
  atomicWrite,
  getSessionDir,
  readJson,
  writeConversationArtifact,
  removeDatedArtifactsNotIn,
  rebuildIndex,
  agentSlug,
  rebuildDateIndexes,
} = require('./conversation-artifacts');

const PREFIX_BYTES = 4096;
const STORE_CLEANING_VERSION = 5;
const CLAUDE_CLASSIFICATION_VERSION = 2;
const CLAUDE_DIALOGUE_VERSION = 3;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readRange(filePath, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function readPrefix(filePath, length) {
  return readRange(filePath, 0, length);
}

function readAppendedLines(filePath, previous = {}) {
  const stat = fs.statSync(filePath);
  const oldOffset = Number(previous.offset) || 0;
  const unchanged = oldOffset === stat.size &&
    Number(previous.size) === stat.size &&
    Number(previous.mtimeMs) === stat.mtimeMs;
  if (unchanged) {
    return {
      text: '',
      reset: false,
      bytesRead: 0,
      state: previous,
    };
  }
  const oldPrefixLength = Number(previous.prefixLength) || 0;
  const prefixChanged = oldPrefixLength > 0 &&
    hash(readPrefix(filePath, Math.min(oldPrefixLength, stat.size))) !== previous.prefixHash;
  const oldAnchorLength = Number(previous.anchorLength) || 0;
  const anchorChanged = oldAnchorLength > 0 && stat.size >= oldOffset &&
    hash(readRange(filePath, Number(previous.anchorStart) || 0, oldAnchorLength)) !== previous.anchorHash;
  const reset = oldOffset > stat.size || prefixChanged || anchorChanged;
  const offset = reset ? 0 : oldOffset;
  const carry = reset ? '' : (previous.carry || '');
  const length = stat.size - offset;
  let appended = '';

  if (length > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buffer, 0, length, offset);
      appended = buffer.subarray(0, bytes).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  const combined = carry + appended;
  const lastNewline = combined.lastIndexOf('\n');
  const completeText = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : '';
  const nextCarry = lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined;
  const prefixLength = Math.min(PREFIX_BYTES, stat.size);
  const anchorLength = Math.min(PREFIX_BYTES, stat.size);
  const anchorStart = Math.max(0, stat.size - anchorLength);

  return {
    text: completeText,
    reset,
    bytesRead: length,
    state: {
      offset: stat.size,
      carry: nextCarry,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      prefixLength,
      prefixHash: hash(readPrefix(filePath, prefixLength)),
      anchorStart,
      anchorLength,
      anchorHash: hash(readRange(filePath, anchorStart, anchorLength)),
    },
  };
}

function walkFiles(root, predicate, options = {}) {
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!options.skipDirectory || !options.skipDirectory(fullPath, entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath, entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function firstJsonObject(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  return null;
}

function metadataFromChunk(parserName, text, descriptor, existing = {}) {
  let id = existing.id || descriptor.id;
  let project = existing.project || descriptor.project || '(unknown)';
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (parserName === 'codex' && row.type === 'session_meta') {
      id = row.payload?.id || id;
      project = row.payload?.cwd || project;
      break;
    }
    if (parserName === 'claude-code') {
      id = row.sessionId || row.session_id || row.uuid || id;
      project = row.cwd || row.project || project;
      if (project !== '(unknown)') break;
    }
    if (parserName === 'factory' && row.type === 'session_start') {
      id = row.id || row.sessionId || id;
      project = row.cwd || row.project || descriptor.project || project;
      break;
    }
  }
  return { id, project };
}

function turnKey(turn) {
  return hash(`${turn.timestamp || ''}\0${turn.role}\0${turn.content}`);
}

function mergeTurns(existing, added) {
  const results = [];
  const seen = new Set();
  for (const turn of [...(existing || []), ...(added || [])]) {
    if (!turn || !['user', 'assistant'].includes(turn.role) || !turn.timestamp || !turn.content?.trim()) continue;
    const timestamp = new Date(turn.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    const clean = { role: turn.role, content: turn.content.trim(), timestamp: timestamp.toISOString() };
    const key = turnKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(clean);
  }
  return results.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function canonicalPath(sessionDir) {
  return path.join(sessionDir, 'canonical.json');
}

function statePath(sessionDir) {
  return path.join(sessionDir, '.source-state.json');
}

function writeCanonicalAndDaily(session, turns, sourceState, outputDir, options = {}) {
  const sessionDir = getSessionDir(session, outputDir);
  fs.mkdirSync(sessionDir, { recursive: true });
  const visibleTurns = normalizeVisibleTurns(turns);
  const hasConversation = hasVisibleUserTurn(visibleTurns);
  if (hasConversation) {
    atomicWrite(canonicalPath(sessionDir), `${JSON.stringify({ version: 1, session, messages: visibleTurns }, null, 2)}\n`);
  }

  const grouped = new Map();
  for (const turn of visibleTurns) {
    const dateStr = formatWorkDate(new Date(turn.timestamp));
    if (!grouped.has(dateStr)) grouped.set(dateStr, []);
    grouped.get(dateStr).push(turn);
  }
  const datesToKeep = new Set();
  for (const [dateStr, dailyTurns] of grouped) {
    const normalized = normalizeVisibleTurns(dailyTurns);
    if (!hasVisibleUserTurn(normalized)) continue;
    datesToKeep.add(dateStr);
    const times = dailyTurns.map(turn => Date.parse(turn.timestamp)).filter(Number.isFinite);
    writeConversationArtifact({
      ...session,
      startTime: new Date(Math.min(...times)),
      activityEndTime: new Date(Math.max(...times)),
      activityDate: dateStr,
    }, dateStr, normalized, outputDir);
  }
  if (options.reset) removeDatedArtifactsNotIn(sessionDir, datesToKeep);
  if (hasConversation) {
    rebuildIndex(sessionDir, session);
  } else if (options.reset) {
    for (const generatedName of ['canonical.json', 'index.md']) {
      try { fs.unlinkSync(path.join(sessionDir, generatedName)); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  atomicWrite(statePath(sessionDir), `${JSON.stringify(sourceState, null, 2)}\n`);
}

function migrateConversationStore(outputDir) {
  const indexDir = path.join(outputDir, '.conversation-index');
  const markerPath = path.join(indexDir, 'cleaning.json');
  const previous = readJson(markerPath, {});
  if (Number(previous.version) >= STORE_CLEANING_VERSION) return { migrated: 0, removedTurns: 0 };
  const requiresWorkdayRegroup = Number(previous.version) < STORE_CLEANING_VERSION;

  const root = path.join(outputDir, 'conversations');
  const files = walkFiles(root, (_full, name) => name === 'canonical.json');
  let migrated = 0;
  let removedTurns = 0;
  for (const filePath of files) {
    const canonical = readJson(filePath);
    if (!canonical?.session || !Array.isArray(canonical.messages)) continue;
    const normalized = normalizeVisibleTurns(canonical.messages);
    const changed = JSON.stringify(normalized) !== JSON.stringify(canonical.messages);
    if (!changed && !requiresWorkdayRegroup) continue;
    const sessionDir = path.dirname(filePath);
    const sourceState = readJson(statePath(sessionDir), {});
    removedTurns += Math.max(0, canonical.messages.length - normalized.length);
    writeCanonicalAndDaily(canonical.session, normalized, sourceState, outputDir, { reset: true });
    migrated++;
  }

  fs.mkdirSync(indexDir, { recursive: true });
  atomicWrite(markerPath, `${JSON.stringify({
    version: STORE_CLEANING_VERSION,
    migratedAt: new Date().toISOString(),
    sessionsRewritten: migrated,
    removedTurns,
  }, null, 2)}\n`);
  return { migrated, removedTurns };
}

function loadSessionRecord(descriptor, outputDir) {
  const provisional = { id: descriptor.id, agent: descriptor.agent, project: descriptor.project || '(unknown)' };
  const sessionDir = getSessionDir(provisional, outputDir);
  const canonical = readJson(canonicalPath(sessionDir), { session: provisional, messages: [] });
  const state = readJson(statePath(sessionDir), {});
  return { sessionDir, canonical, state };
}

function loadSessionState(descriptor, outputDir) {
  const provisional = { id: descriptor.id, agent: descriptor.agent, project: descriptor.project || '(unknown)' };
  const sessionDir = getSessionDir(provisional, outputDir);
  return {
    sessionDir,
    provisional,
    state: readJson(statePath(sessionDir), {}),
  };
}

function loadCanonical(sessionDir, provisional) {
  return readJson(canonicalPath(sessionDir), { session: provisional, messages: [] });
}

async function indexJsonlSource(descriptor, outputDir) {
  const loaded = loadSessionState(descriptor, outputDir);
  const classificationReset = descriptor.parserName === 'claude-code' &&
    Number(loaded.state.classificationVersion || 0) < CLAUDE_CLASSIFICATION_VERSION;
  const dialogueReset = descriptor.parserName === 'claude-code' &&
    Number(loaded.state.dialogueVersion || 0) < CLAUDE_DIALOGUE_VERSION;
  // T3 Code runs Claude through the Agent SDK, whose transcripts look headless.
  // Two independent proofs mark a T3 chat: T3's database links the thread to
  // this session (descriptor.t3), and the transcript holds T3's runtime note.
  // Re-read in full the first time we see its T3 thread.
  const t3 = descriptor.t3 || null;
  const t3Reset = Boolean(t3) && loaded.state.t3ThreadId !== t3.threadId;
  const fullReset = classificationReset || dialogueReset || t3Reset;
  let read = readAppendedLines(descriptor.filePath, fullReset ? {} : (loaded.state.cursor || {}));
  if (fullReset) read.reset = true;
  if (!read.reset && !read.text) return { changed: false, bytesRead: read.bytesRead };

  const t3Marker = hasT3RuntimeMarker(descriptor.parserName, read.text);
  // Excluded earlier, before the T3 note was seen: index the whole file now.
  const t3Recovered = t3Marker && !read.reset && loaded.state.excluded === true;
  if (t3Recovered) {
    read = readAppendedLines(descriptor.filePath, {});
    read.reset = true;
  }
  const t3Evidence = [
    ...(t3 ? ['t3-database'] : []),
    ...(t3Marker || (!read.reset && loaded.state.t3Evidence?.includes('transcript-runtime-note'))
      ? ['transcript-runtime-note'] : []),
  ];
  const fromT3 = t3Evidence.length > 0;

  let canonical = read.reset ? { session: {}, messages: [] } : loadCanonical(loaded.sessionDir, loaded.provisional);
  const first = firstJsonObject(read.text);
  const pathMarksSubagent = descriptor.parserName === 'claude-code' &&
    descriptor.filePath.split(/[\\/]/).includes('subagents');
  const detected = first ? detectSubAgent(descriptor.parserName, first) : { isSubAgent: false };
  const headlessClaude = !fromT3 && descriptor.parserName === 'claude-code' && first?.type === 'queue-operation';
  const previouslyExcluded = classificationReset || t3Reset || t3Recovered ? false : loaded.state.excluded;
  const excluded = pathMarksSubagent || detected.isSubAgent || headlessClaude || previouslyExcluded;
  const sourceState = {
    version: 1,
    format: descriptor.parserName,
    sourcePath: descriptor.filePath,
    cursor: read.state,
    excluded,
    ...(descriptor.parserName === 'claude-code' ? { classificationVersion: CLAUDE_CLASSIFICATION_VERSION } : {}),
    ...(descriptor.parserName === 'claude-code' ? { dialogueVersion: CLAUDE_DIALOGUE_VERSION } : {}),
    ...(headlessClaude ? { exclusionReason: 'claude-headless-queue-operation' } : {}),
    ...(t3 ? { t3ThreadId: t3.threadId } : {}),
    ...(fromT3 ? { t3Evidence } : {}),
  };
  if (excluded) {
    const session = { id: descriptor.id, agent: descriptor.agent, project: descriptor.project || '(unknown)' };
    writeCanonicalAndDaily(session, [], sourceState, outputDir, { reset: true });
    return { changed: true, bytesRead: read.bytesRead, excluded: true };
  }

  const parsed = await trimTranscript(read.text, descriptor.parserName, { includeTimestamps: true });
  const meta = metadataFromChunk(descriptor.parserName, read.text, descriptor, canonical.session);
  const session = {
    id: meta.id || descriptor.id,
    agent: descriptor.agent,
    project: meta.project || '(unknown)',
    sessionKey: `${descriptor.agent}:${meta.id || descriptor.id}`,
    ...(fromT3 ? {
      client: 'T3 Code',
      title: t3?.title || canonical.session?.title || undefined,
      t3ThreadId: t3?.threadId || canonical.session?.t3ThreadId || undefined,
    } : {}),
  };
  const messages = mergeTurns(canonical.messages, parsed.messages);
  writeCanonicalAndDaily(session, messages, sourceState, outputDir, { reset: read.reset });
  return { changed: true, bytesRead: read.bytesRead, turnsAdded: parsed.messages.length, warnings: parsed.warnings };
}

function discoverJsonlSources(cfg = config) {
  const sources = [];
  const definitions = [
    [cfg.agents.claudeCode, 'claude-code', 'projects'],
    [cfg.agents.claudeCodeWsl, 'claude-code', 'projects'],
    [cfg.agents.codex, 'codex', 'sessions'],
    [cfg.agents.codexWsl, 'codex', 'sessions'],
    [cfg.agents.factory, 'factory', cfg.agents.factory.sessionsDir || 'sessions'],
  ];
  for (const [agentConfig, parserName, childDir] of definitions) {
    if (!agentConfig?.storagePath) continue;
    const root = path.join(agentConfig.storagePath, childDir);
    const files = walkFiles(root, (_full, name) => name.endsWith('.jsonl'), {
      skipDirectory: (_full, name) => name === 'subagents',
    });
    for (const filePath of files) {
      const basename = path.basename(filePath, '.jsonl');
      const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      sources.push({
        type: 'jsonl',
        parserName,
        agent: agentConfig.name,
        id: uuidMatch?.[1] || basename,
        project: path.basename(path.dirname(filePath)),
        filePath,
      });
    }
  }
  return sources;
}

function discoverGrokSources(cfg = config) {
  const results = [];
  for (const agentConfig of [cfg.agents.grok, cfg.agents.grokWsl]) {
    if (!agentConfig?.storagePath) continue;
    const root = path.join(agentConfig.storagePath, agentConfig.sessionsDir || 'sessions');
    let projects;
    try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(root, project.name);
      let sessions;
      try { sessions = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(projectDir, entry.name);
        const eventsPath = path.join(sessionDir, 'events.jsonl');
        const historyPath = path.join(sessionDir, 'chat_history.jsonl');
        if (!fs.existsSync(eventsPath) || !fs.existsSync(historyPath)) continue;
        let projectName = project.name;
        try { projectName = decodeURIComponent(project.name); } catch { /* keep encoded value */ }
        results.push({ type: 'grok', agent: agentConfig.name, id: entry.name, project: projectName, sessionDir, eventsPath, historyPath });
      }
    }
  }
  return results;
}

async function indexGrokSource(descriptor, outputDir) {
  const loaded = loadSessionState(descriptor, outputDir);
  let state = loaded.state || {};
  let eventsRead = readAppendedLines(descriptor.eventsPath, state.eventsCursor || {});
  let historyRead = readAppendedLines(descriptor.historyPath, state.historyCursor || {});
  const reset = eventsRead.reset || historyRead.reset;
  if (reset) {
    eventsRead = readAppendedLines(descriptor.eventsPath, {});
    historyRead = readAppendedLines(descriptor.historyPath, {});
    state = {};
  }
  if (!eventsRead.text && !historyRead.text) {
    return { changed: false, bytesRead: eventsRead.bytesRead + historyRead.bytesRead };
  }

  const turnTimes = reset ? {} : { ...(state.turnTimes || {}) };
  for (const line of eventsRead.text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'turn_started' && Number.isInteger(event.turn_number) && event.ts &&
        (!event.session_relationship || event.session_relationship === 'primary')) {
      turnTimes[event.turn_number] = event.ts;
    }
  }

  let currentPrompt = reset ? null : state.currentPrompt;
  const added = [];
  for (const line of historyRead.text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'user' && Number.isInteger(row.prompt_index)) {
      currentPrompt = {
        index: row.prompt_index,
        timestamp: turnTimes[row.prompt_index] || null,
        synthetic: Boolean(row.synthetic_reason),
      };
      if (!currentPrompt.synthetic && currentPrompt.timestamp) {
        const content = extractGrokText(row.content);
        if (content) added.push({ role: 'user', content, timestamp: currentPrompt.timestamp });
      }
      continue;
    }
    if (row.type === 'assistant' && currentPrompt?.timestamp) {
      const content = extractGrokText(row.content);
      if (content) added.push({ role: 'assistant', content, timestamp: currentPrompt.timestamp });
    }
  }

  const canonical = reset ? { messages: [] } : loadCanonical(loaded.sessionDir, loaded.provisional);
  const session = {
    id: descriptor.id,
    agent: descriptor.agent,
    project: descriptor.project,
    sessionKey: `${descriptor.agent}:${descriptor.id}`,
  };
  const sourceState = {
    version: 1,
    format: 'grok',
    sourcePath: descriptor.sessionDir,
    eventsCursor: eventsRead.state,
    historyCursor: historyRead.state,
    turnTimes,
    currentPrompt,
  };
  const messages = mergeTurns(canonical.messages, added);
  writeCanonicalAndDaily(session, messages, sourceState, outputDir, { reset });
  return { changed: true, bytesRead: eventsRead.bytesRead + historyRead.bytesRead, turnsAdded: added.length };
}

function parseOpenCodePart(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function indexOpenCodeDatabase(agentConfig, outputDir) {
  if (!agentConfig?.dbPath) return { changed: false, bytesRead: 0, turnsAdded: 0 };
  let stat;
  try { stat = fs.statSync(agentConfig.dbPath); } catch { return { changed: false, bytesRead: 0, turnsAdded: 0 }; }
  const indexDir = path.join(outputDir, '.conversation-index');
  const globalStatePath = path.join(indexDir, `${agentSlug(agentConfig.name)}.json`);
  const previous = readJson(globalStatePath, {});
  if (previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
    return { changed: false, bytesRead: 0, turnsAdded: 0 };
  }

  const db = openDatabase(agentConfig.dbPath);
  if (!db) return { changed: false, bytesRead: 0, turnsAdded: 0 };
  try {
    const hasMessage = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'").get();
    const hasPart = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='part'").get();
    if (!hasMessage || !hasPart) return { changed: false, bytesRead: 0, turnsAdded: 0 };

    const sessionColumns = db.prepare('PRAGMA table_info(session)').all().map(row => row.name);
    const parentColumn = sessionColumns.includes('parent_id') ? 'parent_id'
      : sessionColumns.includes('parentID') ? 'parentID' : null;
    const maxRow = db.prepare('SELECT MAX(time_created) AS max_time FROM message').get();
    const maxTime = Number(maxRow?.max_time) || 0;
    const reset = Number(previous.lastTime) > maxTime;
    const lastTime = reset ? 0 : (Number(previous.lastTime) || 0);
    const seenAtBoundary = new Set(reset ? [] : (previous.idsAtLastTime || []));
    const parentSelect = parentColumn ? `, s.${parentColumn} AS parent_id` : ', NULL AS parent_id';
    const rows = db.prepare(`
      SELECT m.id, m.session_id, m.data, m.time_created,
             s.title, s.time_created AS session_created, p.worktree
             ${parentSelect}
      FROM message m
      JOIN session s ON s.id = m.session_id
      LEFT JOIN project p ON p.id = s.project_id
      WHERE m.time_created >= ?
      ORDER BY m.time_created ASC, m.id ASC
    `).all(lastTime);

    const grouped = new Map();
    let newestTime = lastTime;
    let newestIds = new Set(seenAtBoundary);
    for (const row of rows) {
      const time = Number(row.time_created) || 0;
      if (time === lastTime && seenAtBoundary.has(row.id)) continue;
      if (time > newestTime) {
        newestTime = time;
        newestIds = new Set([row.id]);
      } else if (time === newestTime) {
        newestIds.add(row.id);
      }
      if (row.parent_id) continue;
      let messageData;
      try { messageData = JSON.parse(row.data); } catch { continue; }
      if (!['user', 'assistant'].includes(messageData.role)) continue;
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC').all(row.id);
      const content = normalizeWhitespace(parts.map(part => {
        const parsed = parseOpenCodePart(part.data);
        return parsed?.type === 'text' && typeof parsed.text === 'string' ? parsed.text : '';
      }).filter(Boolean).join('\n'));
      if (!content) continue;
      if (messageData.role === 'user' && (content.startsWith('/') || content.startsWith('<command-') || content.startsWith('<bash-'))) continue;
      if (!grouped.has(row.session_id)) grouped.set(row.session_id, { row, turns: [] });
      grouped.get(row.session_id).turns.push({
        role: messageData.role,
        content,
        timestamp: new Date(time).toISOString(),
      });
    }

    let turnsAdded = 0;
    for (const [sessionId, group] of grouped) {
      const descriptor = { id: sessionId, agent: agentConfig.name, project: group.row.worktree || '(unknown)' };
      const loaded = loadSessionRecord(descriptor, outputDir);
      const session = {
        id: sessionId,
        agent: agentConfig.name,
        project: group.row.worktree || loaded.canonical.session?.project || '(unknown)',
        sessionKey: `${agentConfig.name}:${sessionId}`,
      };
      const messages = mergeTurns(reset ? [] : loaded.canonical.messages, group.turns);
      writeCanonicalAndDaily(session, messages, {
        version: 1,
        format: 'opencode',
        sourcePath: agentConfig.dbPath,
        lastMessageTime: newestTime,
      }, outputDir, { reset });
      turnsAdded += group.turns.length;
    }

    fs.mkdirSync(indexDir, { recursive: true });
    atomicWrite(globalStatePath, `${JSON.stringify({
      version: 1,
      dbPath: agentConfig.dbPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lastTime: newestTime,
      idsAtLastTime: [...newestIds].sort(),
    }, null, 2)}\n`);
    return { changed: grouped.size > 0, bytesRead: 0, turnsAdded };
  } finally {
    db.close();
  }
}

async function indexAllConversations(options = {}) {
  const cfg = options.config || config;
  const outputDir = options.outputDir || cfg.output.directory;
  const scanStartedAt = options.now instanceof Date ? new Date(options.now) : new Date(options.now || Date.now());
  const migration = migrateConversationStore(outputDir);
  const allDescriptors = options.sources || [
    ...discoverJsonlSources(cfg),
    ...discoverGrokSources(cfg),
  ];
  const includeConfiguredDatabases = options.sources === undefined;
  const managesCheckpoint = options.sources === undefined;
  let scanMode = managesCheckpoint
    ? chooseScanMode({ outputDir, cfg, now: scanStartedAt, forceFullScan: options.fullScan })
    : { fullScan: true, reason: 'explicit-sources', state: {}, fingerprint: '' };
  let descriptors = allDescriptors;
  if (managesCheckpoint && !scanMode.fullScan) {
    try {
      const selectCandidates = options.selectChangedDescriptors || selectChangedDescriptors;
      descriptors = selectCandidates(allDescriptors, cfg, scanMode.cutoff, {
        execFileSync: options.execFileSync,
      });
    } catch (err) {
      scanMode = { ...scanMode, fullScan: true, reason: `candidate-discovery-failed: ${err.message}` };
      descriptors = allDescriptors;
    }
  }

  // Tag Claude/Codex sessions that T3 Code started. T3 sessions are few, so
  // always re-check them; this tags sessions indexed before T3 was known.
  const t3Sessions = options.t3Sessions || (options.sources === undefined
    ? loadT3SessionMap(cfg.agents.t3Code)
    : new Map());
  if (t3Sessions.size > 0) {
    const selected = new Set(descriptors);
    for (const descriptor of allDescriptors) {
      if (descriptor.type !== 'jsonl' || !['claude-code', 'codex'].includes(descriptor.parserName)) continue;
      const t3 = t3Sessions.get(String(descriptor.id).toLowerCase());
      if (!t3) continue;
      descriptor.t3 = t3;
      if (!selected.has(descriptor)) descriptors = [...descriptors, descriptor];
    }
  }

  const prefilteredUnchanged = allDescriptors.length - descriptors.length;
  const stats = {
    sources: allDescriptors.length + (includeConfiguredDatabases ? 1 : 0),
    candidates: descriptors.length + (includeConfiguredDatabases ? 1 : 0),
    scanMode: scanMode.fullScan ? 'full' : 'fast',
    scanReason: scanMode.reason,
    changed: 0,
    unchanged: prefilteredUnchanged,
    excluded: 0,
    bytesRead: 0,
    turnsAdded: 0,
    migrated: migration.migrated,
    removedNoiseTurns: migration.removedTurns,
    t3Sessions: descriptors.filter(descriptor => descriptor.t3).length,
    errors: [],
  };
  const indexJsonl = options.indexJsonlSource || indexJsonlSource;
  const indexGrok = options.indexGrokSource || indexGrokSource;
  for (const descriptor of descriptors) {
    try {
      const result = descriptor.type === 'grok'
        ? await indexGrok(descriptor, outputDir)
        : await indexJsonl(descriptor, outputDir);
      stats.bytesRead += result.bytesRead || 0;
      stats.turnsAdded += result.turnsAdded || 0;
      if (result.changed) stats.changed++; else stats.unchanged++;
      if (result.excluded) stats.excluded++;
    } catch (err) {
      stats.errors.push({ agent: descriptor.agent, id: descriptor.id, error: err.message });
    }
  }
  if (includeConfiguredDatabases) {
    try {
      const result = await indexOpenCodeDatabase(cfg.agents.openCode, outputDir);
      stats.turnsAdded += result.turnsAdded || 0;
      if (result.changed) stats.changed++; else stats.unchanged++;
    } catch (err) {
      stats.errors.push({ agent: cfg.agents.openCode?.name || 'OpenCode', id: 'database', error: err.message });
    }
  }
  if (stats.errors.length > 0) {
    const error = new Error(`${stats.errors.length} conversation source(s) failed indexing`);
    error.stats = stats;
    throw error;
  }
  if (scanMode.fullScan) stats.dateIndex = rebuildDateIndexes(outputDir);
  if (managesCheckpoint) {
    writeSuccessfulScanState({ outputDir, mode: scanMode, scanStartedAt });
    stats.checkpointAdvanced = true;
  }
  return stats;
}

module.exports = {
  readAppendedLines,
  mergeTurns,
  discoverJsonlSources,
  discoverGrokSources,
  indexJsonlSource,
  indexGrokSource,
  indexAllConversations,
  indexOpenCodeDatabase,
  writeCanonicalAndDaily,
  migrateConversationStore,
};
