const fs = require('fs');
const path = require('path');
const config = require('./config');
const { hasVisibleUserTurn, normalizeVisibleTurns } = require('./daily-transcript');

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const DATE_JSON_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

function dateIndexPath(outputDir, dateStr) {
  return path.join(outputDir, '.conversation-index', 'dates', `${dateStr}.json`);
}

function writeDateIndex(outputDir, dateStr, relativePaths) {
  const paths = [...new Set(relativePaths)].sort();
  atomicWrite(dateIndexPath(outputDir, dateStr), `${JSON.stringify({
    version: 1,
    date: dateStr,
    artifacts: paths,
  }, null, 2)}\n`);
}

function updateDateIndex(outputDir, dateStr, jsonPath, add) {
  const indexPath = dateIndexPath(outputDir, dateStr);
  const current = readJson(indexPath, { artifacts: [] });
  const relative = path.relative(outputDir, jsonPath).split(path.sep).join('/');
  const paths = new Set(Array.isArray(current.artifacts) ? current.artifacts : []);
  if (add) paths.add(relative); else paths.delete(relative);
  writeDateIndex(outputDir, dateStr, [...paths]);
}

function sanitizePathComponent(value, fallback = 'unknown') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
    .slice(0, 160);
  return cleaned || fallback;
}

function agentSlug(agentName) {
  return sanitizePathComponent(String(agentName || '').toLowerCase(), 'unknown-agent');
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw err;
  }
}

function formatActivityTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

// Sessions started from another app (e.g. T3 Code) name that app and its
// thread title, so the summary knows where the chat happened.
function clientLines(session) {
  const lines = [];
  if (session.client) lines.push(`- Client: ${session.client}`);
  if (session.title) lines.push(`- Thread title: ${session.title}`);
  return lines;
}

function buildDailyMarkdown(session, dateStr, turns) {
  const lines = [
    `# Cleaned Conversation — ${dateStr}`,
    '',
    `- Agent: ${session.agent}`,
    `- Session: ${session.id}`,
    `- Project: ${session.project || '(unknown)'}`,
    ...clientLines(session),
  ];
  const first = formatActivityTime(session.startTime);
  const last = formatActivityTime(session.activityEndTime);
  if (first) lines.push(`- First activity: ${first}`);
  if (last) lines.push(`- Last activity: ${last}`);
  lines.push('', '---', '', '## Dialogue', '');

  for (const turn of turns) {
    lines.push(turn.role === 'user' ? '### User' : '### Assistant');
    lines.push('');
    lines.push(turn.content.trim());
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function rebuildIndex(sessionDir, session) {
  const dates = fs.readdirSync(sessionDir)
    .filter(name => DATE_FILE_RE.test(name))
    .sort();
  const lines = [
    '# Cleaned Conversation',
    '',
    `- Agent: ${session.agent}`,
    `- Session: ${session.id}`,
    `- Project: ${session.project || '(unknown)'}`,
    ...clientLines(session),
    '',
    '## Active Days',
    '',
    ...dates.map(name => `- [${name.slice(0, 10)}](./${name})`),
    '',
  ];
  atomicWrite(path.join(sessionDir, 'index.md'), lines.join('\n'));
}

function writeConversationArtifact(session, dateStr, turns, outputDir = config.output.directory) {
  if (!hasVisibleUserTurn(turns)) return null;
  const sessionDir = path.join(
    outputDir,
    'conversations',
    agentSlug(session.agent),
    sanitizePathComponent(session.id, 'unknown-session')
  );
  const filePath = path.join(sessionDir, `${dateStr}.md`);
  atomicWrite(filePath, buildDailyMarkdown(session, dateStr, turns));
  atomicWrite(path.join(sessionDir, `${dateStr}.json`), `${JSON.stringify({
    version: 1,
    date: dateStr,
    session: {
      id: session.id,
      agent: session.agent,
      project: session.project || '(unknown)',
      startTime: formatActivityTime(session.startTime),
      activityEndTime: formatActivityTime(session.activityEndTime),
      sessionKey: session.sessionKey || `${session.agent}:${session.id}`,
      ...(session.client ? { client: session.client } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(session.t3ThreadId ? { t3ThreadId: session.t3ThreadId } : {}),
    },
    messages: turns,
  }, null, 2)}\n`);
  updateDateIndex(outputDir, dateStr, path.join(sessionDir, `${dateStr}.json`), true);
  rebuildIndex(sessionDir, session);
  return {
    filePath,
    relativePath: path.relative(outputDir, filePath).split(path.sep).join('/'),
  };
}

function getSessionDir(session, outputDir = config.output.directory) {
  return path.join(
    outputDir,
    'conversations',
    agentSlug(session.agent),
    sanitizePathComponent(session.id, 'unknown-session')
  );
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readConversationArtifactsForDate(dateStr, outputDir = config.output.directory) {
  const index = readJson(dateIndexPath(outputDir, dateStr));
  if (index?.version === 1 && index.date === dateStr && Array.isArray(index.artifacts)) {
    return readIndexedArtifacts(index.artifacts.map(relative => path.resolve(outputDir, relative)), dateStr, outputDir);
  }

  const root = path.join(outputDir, 'conversations');
  const filePaths = [];
  let agents;
  try { agents = fs.readdirSync(root, { withFileTypes: true }); } catch {
    writeDateIndex(outputDir, dateStr, []);
    return [];
  }

  for (const agentDir of agents) {
    if (!agentDir.isDirectory()) continue;
    const agentPath = path.join(root, agentDir.name);
    let sessions;
    try { sessions = fs.readdirSync(agentPath, { withFileTypes: true }); } catch { continue; }
    for (const sessionDir of sessions) {
      if (!sessionDir.isDirectory()) continue;
      const filePath = path.join(agentPath, sessionDir.name, `${dateStr}.json`);
      if (fs.existsSync(filePath)) filePaths.push(filePath);
    }
  }
  const results = readIndexedArtifacts(filePaths, dateStr, outputDir);
  writeDateIndex(outputDir, dateStr, results.map(result => result.filePath)
    .map(filePath => path.relative(outputDir, filePath).split(path.sep).join('/')));
  return results;
}

function readIndexedArtifacts(filePaths, dateStr, outputDir) {
  const results = [];
  for (const filePath of filePaths) {
      const record = readJson(filePath);
      if (!record || record.date !== dateStr || !record.session || !hasVisibleUserTurn(record.messages)) continue;
      const messages = normalizeVisibleTurns(record.messages);
      if (!hasVisibleUserTurn(messages)) continue;
      const sessionDir = path.dirname(filePath);
      results.push({
        session: {
          ...record.session,
          startTime: record.session.startTime ? new Date(record.session.startTime) : new Date(`${dateStr}T00:00:00`),
          activityEndTime: record.session.activityEndTime ? new Date(record.session.activityEndTime) : undefined,
          activityDate: dateStr,
          artifactPath: path.join(sessionDir, `${dateStr}.md`),
          artifactRelativePath: path.relative(outputDir, path.join(sessionDir, `${dateStr}.md`)).split(path.sep).join('/'),
        },
        messages,
        filePath,
      });
  }
  return results.sort((a, b) => a.session.startTime - b.session.startTime);
}

function rebuildDateIndexes(outputDir = config.output.directory) {
  const root = path.join(outputDir, 'conversations');
  const byDate = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && DATE_JSON_RE.test(entry.name)) {
        const dateStr = entry.name.slice(0, 10);
        if (!byDate.has(dateStr)) byDate.set(dateStr, []);
        byDate.get(dateStr).push(path.relative(outputDir, full).split(path.sep).join('/'));
      }
    }
  }
  for (const [dateStr, paths] of byDate) writeDateIndex(outputDir, dateStr, paths);
  return { dates: byDate.size, artifacts: [...byDate.values()].reduce((sum, paths) => sum + paths.length, 0) };
}

function removeDatedArtifactsNotIn(sessionDir, datesToKeep) {
  let names;
  try { names = fs.readdirSync(sessionDir); } catch { return; }
  for (const name of names) {
    if (!DATE_FILE_RE.test(name) && !DATE_JSON_RE.test(name)) continue;
    if (datesToKeep.has(name.slice(0, 10))) continue;
    if (DATE_JSON_RE.test(name)) {
      const outputDir = path.dirname(path.dirname(path.dirname(sessionDir)));
      updateDateIndex(outputDir, name.slice(0, 10), path.join(sessionDir, name), false);
    }
    fs.unlinkSync(path.join(sessionDir, name));
  }
}

module.exports = {
  writeConversationArtifact,
  sanitizePathComponent,
  agentSlug,
  atomicWrite,
  buildDailyMarkdown,
  rebuildIndex,
  getSessionDir,
  readJson,
  readConversationArtifactsForDate,
  rebuildDateIndexes,
  dateIndexPath,
  removeDatedArtifactsNotIn,
};
