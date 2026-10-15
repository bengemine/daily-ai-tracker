/**
 * Journal generator for Daily AI Tracker.
 *
 * Produces a markdown document with:
 *   1. A chronological summary table (all sessions, all agents)
 *   2. Detailed session entries with anchor links from the table
 *
 * Each session entry has a title (from the summarizer) and a body paragraph.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const EMPTY_SESSION_BODY = '[Empty session — no content to summarize]';
const NO_ACTIVITY_BODY = 'No activity recorded.';

/**
 * Get a timestamp as epoch ms, regardless of input type.
 */
function toEpoch(ts) {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  return new Date(ts).getTime();
}

/**
 * Format a timestamp as a short time string (e.g. "11:39 AM").
 */
function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * Shorten a project path for table display.
 *   E:\projects\example.com  -> example.com
 *   C:\Users\dev             -> dev
 *   (codex)                    -> (codex)
 */
function shortProject(projectPath) {
  if (!projectPath || projectPath.startsWith('(')) return projectPath;
  const segments = projectPath.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] || projectPath;
}

/**
 * Escape and sanitize text for use inside a Markdown table cell.
 * - Collapses all whitespace (newlines, tabs, etc.) to single spaces
 * - Strips leading Markdown block prefixes (#, -, *, >) from the visible text
 * - Escapes pipe characters as \|
 * - Trims leading/trailing whitespace
 * - Truncates to 120 chars with an ellipsis if longer
 * - Falls back to "(untitled)" if the result is empty
 */
function escapeCell(text) {
  let s = (text || '')
    .replace(/[\r\n\t]+/g, ' ')   // collapse all whitespace runs incl newlines
    .replace(/\s+/g, ' ')          // collapse repeated spaces
    .replace(/^(?:#{1,6}\s+|[-*]\s+|>\s*)+/, '') // strip leading Markdown block prefixes (requires space after #/-/*, preserves inline **bold**)
    .replace(/\|/g, '\\|')         // escape pipes
    .trim();

  if (s.length > 120) s = s.slice(0, 120) + '\u2026';
  return s || '(untitled)';
}

/**
 * Extract the first meaningful line of prose from a possibly multi-line,
 * Markdown-laden string (e.g. a fallback summary blob).
 *
 * Rules:
 * - Skip blank lines, lines that are purely `#` headings, and `>` blockquote lines
 * - Return the first remaining prose line, truncated to 100 chars + … if longer
 * - Fall back to "(untitled)" if nothing usable is found
 */
function flattenTitle(raw) {
  if (!raw || typeof raw !== 'string') return '(untitled)';

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;                       // skip blank lines
    if (/^#+\s/.test(trimmed)) continue;          // skip # heading lines
    if (/^>/.test(trimmed)) continue;             // skip blockquote lines
    // Found a prose line — truncate if needed
    if (trimmed.length > 100) return trimmed.slice(0, 100) + '\u2026';
    return trimmed;
  }
  return '(untitled)';
}

/**
 * Check if a summary represents an empty/skipped session.
 * Handles both old string format and new { title, body } format.
 */
function isEmptySession(summary) {
  if (!summary) return true;
  if (typeof summary === 'string') return summary === EMPTY_SESSION_BODY;
  if (typeof summary === 'object') return summary.body === EMPTY_SESSION_BODY && !summary.title;
  return false;
}

/**
 * Extract title and body from a summary.
 * Handles both old string format (no title) and new { title, body } format.
 */
function extractSummary(summary) {
  if (typeof summary === 'string') {
    return { title: '', body: summary };
  }
  if (typeof summary === 'object' && summary !== null) {
    return {
      title: summary.title || '',
      body: summary.body || '',
      incomplete: summary.incomplete === true,
      summarySource: summary.summarySource || '',
    };
  }
  return { title: '', body: '' };
}

function buildNoActivityJournal(dateStr) {
  return [
    `# Daily AI Tracker — ${dateStr}`,
    '',
    '## Overview',
    '',
    NO_ACTIVITY_BODY,
    '',
    '---',
    '',
    '## Session Details',
    '',
    NO_ACTIVITY_BODY,
    '',
  ].join('\n');
}

function buildDetailedJournal(dateStr, entries, journalDir) {
  const deduped = new Map();
  for (const entry of entries) {
    const sessionKey = entry.session.sessionKey || entry.session.id;
    deduped.set(sessionKey, entry);
  }

  const groupedEntries = mergeEntriesByTask(Array.from(deduped.values()));
  const numbered = groupedEntries.map((entry, i) => ({
    ...entry,
    num: i + 1,
    anchor: `s-${i + 1}`,
  }));

  const lines = [];
  lines.push(`# Daily AI Tracker — ${dateStr}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  const fallbackCount = Array.from(deduped.values()).filter(entry => entry.summary?.incomplete === true).length;
  if (fallbackCount > 0) {
    lines.push(`> ⚠ ${fallbackCount} conversation ${fallbackCount === 1 ? 'summary' : 'summaries'} could not be completed by AI. The affected entries use a limited fallback; their cleaned conversation links remain complete.`);
    lines.push('');
  }
  lines.push('| # | Time | Agent | Task | Project |');
  lines.push('|--:|------|-------|------|---------|');

  for (const entry of numbered) {
    const time = formatTaskTime(entry);
    const agent = escapeCell(entry.agentLabel);
    const project = escapeCell(shortProject(entry.project));
    const title = entry.title || 'Untitled session';
    const taskCell = `[${escapeCell(flattenTitle(title))}](#${entry.anchor})`;
    lines.push(`| ${entry.num} | ${time} | ${agent} | ${taskCell} | ${project} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Session Details');
  lines.push('');

  for (const entry of numbered) {
    const title = entry.title || 'Untitled session';

    lines.push(`### <a id="${entry.anchor}"></a>${entry.num}. ${title}`);
    lines.push('');
    lines.push(`> **${entry.agentLabel}** · ${entry.project} · ${formatTaskTime(entry)} · ${entry.chatLabel}`);
    lines.push('');
    if (entry.incomplete) {
      lines.push('> ⚠ **Summary incomplete:** AI summarization failed after retry, so this entry uses a limited deterministic fallback.');
      lines.push('');
    }
    lines.push(entry.body);
    lines.push('');
    const artifactLinks = entry.sessions
      .filter(session => session.artifactPath)
      .map(session => {
        const relative = path.relative(journalDir, session.artifactPath).split(path.sep).join('/');
        return `[${session.agent} cleaned dialogue](<${relative}>)`;
      });
    if (artifactLinks.length > 0) {
      lines.push(`Cleaned conversation: ${artifactLinks.join(', ')}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function normalizeTaskTitle(title) {
  return (title || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ');
}

const TASK_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'how', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their',
  'this', 'to', 'was', 'were', 'will', 'with', 'client', 'request', 'feature',
  'logic', 'scope', 'added', 'updated', 'fixed', 'clarified', 'implemented',
  'enhanced', 'improved', 'change', 'changes', 'task', 'tasks', 'records',
  'record', 'session', 'code', 'project', 'support', 'team'
]);

function isMetaProject(project) {
  return !project || project.startsWith('(');
}

function extractTaskKeywords(text) {
  return new Set(
    normalizeTaskTitle(text)
      .split(' ')
      .filter(token => token.length >= 4 && !TASK_STOP_WORDS.has(token))
  );
}

function keywordOverlapScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  return overlap;
}

function areProjectsCompatible(projectA, projectB) {
  return projectA === projectB || isMetaProject(projectA) || isMetaProject(projectB);
}

function choosePrimaryGroup(left, right) {
  if (isMetaProject(left.project) && !isMetaProject(right.project)) return right;
  if (isMetaProject(right.project) && !isMetaProject(left.project)) return left;
  return left;
}

function extractIntentText(group) {
  return (group.sourceEntries || [])
    .flatMap(entry => {
      const topic = entry.highlights?.topic || '';
      const messages = entry.highlights?.userMessages || [];
      return [topic, ...messages];
    })
    .join('\n');
}

function isResponseOrReviewTask(text) {
  return /help me (answer|respond)|draft .*reply|review and confirm|answer .*comment|reply .*comment|normal human-looking reply|simple plain english/i.test(text);
}

function buildRequestSubject(text) {
  const normalized = normalizeTaskTitle(text);
  if (normalized.includes('auto arch') && normalized.includes('expiry') && normalized.includes('duplicate')) {
    return 'auto-archive expiry-date request';
  }
  if (normalized.includes('auto arch') && normalized.includes('expiry')) {
    return 'auto-archive expiry-date question';
  }
  if (normalized.includes('expiry') && normalized.includes('duplicate')) {
    return 'duplicate-record expiry-date request';
  }
  return 'client request';
}

function chooseGroupTitle(group) {
  if (!group.sessions || group.sessions.length === 1) return group.title;
  const intentText = extractIntentText(group);
  if (isResponseOrReviewTask(intentText)) {
    return `Reviewed ${buildRequestSubject(intentText)}`;
  }
  return group.title;
}

function shouldMergeGroups(left, right) {
  if (!areProjectsCompatible(left.project, right.project)) return false;
  if (!isMetaProject(left.project) && !isMetaProject(right.project)) return false;

  const hoursApart = Math.abs(toEpoch(right.startTime) - toEpoch(left.endTime)) / (1000 * 60 * 60);
  if (hoursApart > 6) return false;

  const leftKeywords = extractTaskKeywords(`${left.title} ${left.bodyParts.join(' ')}`);
  const rightKeywords = extractTaskKeywords(`${right.title} ${right.bodyParts.join(' ')}`);
  const overlap = keywordOverlapScore(leftKeywords, rightKeywords);
  return overlap >= 3;
}

function combineGroups(left, right) {
  const primary = choosePrimaryGroup(left, right);
  const secondary = primary === left ? right : left;

  return {
    title: primary.title,
    bodyParts: [...primary.bodyParts, ...secondary.bodyParts.filter(part => !primary.bodyParts.includes(part))],
    sessions: [...left.sessions, ...right.sessions].sort((a, b) => toEpoch(a.startTime) - toEpoch(b.startTime)),
    sourceEntries: [...left.sourceEntries, ...right.sourceEntries],
    project: primary.project,
    startTime: toEpoch(left.startTime) <= toEpoch(right.startTime) ? left.startTime : right.startTime,
    endTime: toEpoch(left.endTime) >= toEpoch(right.endTime) ? left.endTime : right.endTime,
  };
}

function mergeAdjacentRelatedGroups(groups) {
  const merged = [];

  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous && shouldMergeGroups(previous, group)) {
      merged[merged.length - 1] = combineGroups(previous, group);
      continue;
    }
    merged.push(group);
  }

  return merged;
}

function formatTaskTime(entry) {
  if (!entry.sessions || entry.sessions.length <= 1) {
    return formatTime(entry.startTime);
  }

  const first = formatTime(entry.startTime);
  const last = formatTime(entry.endTime);
  return first === last ? first : `${first}-${last}`;
}

function mergeEntriesByTask(entries) {
  const sorted = [...entries]
    .map(entry => ({ ...entry, ...extractSummary(entry.summary) }))
    .sort((a, b) => toEpoch(a.session.startTime) - toEpoch(b.session.startTime));

  const groups = [];
  const byKey = new Map();

  for (const entry of sorted) {
    const title = entry.title || 'Untitled session';
    const normalizedTitle = normalizeTaskTitle(title);
    const project = entry.session.project;
    const canMerge = normalizedTitle !== 'untitled session' && normalizedTitle !== '';
    const sessionKey = entry.session.sessionKey || entry.session.id;
    const groupKey = canMerge ? `${project}::${normalizedTitle}` : `${project}::${sessionKey}`;

    if (!byKey.has(groupKey)) {
      const group = {
        title,
        bodyParts: [entry.body],
        sessions: [entry.session],
        sourceEntries: [entry],
        project,
        startTime: entry.session.startTime,
        endTime: entry.session.startTime,
      };
      byKey.set(groupKey, group);
      groups.push(group);
      continue;
    }

    const group = byKey.get(groupKey);
    group.sessions.push(entry.session);
    group.sourceEntries.push(entry);
    group.endTime = entry.session.startTime;
    if (!group.bodyParts.includes(entry.body)) {
      group.bodyParts.push(entry.body);
    }
  }

  const mergedGroups = mergeAdjacentRelatedGroups(groups);

  return mergedGroups.map(group => {
    const agents = [...new Set(group.sessions.map(session => (
      session.client ? `${session.agent} via ${session.client}` : session.agent
    )))];
    const chatIds = group.sessions
      .map(session => `\`${session.sessionKey || session.id}\``)
      .join(', ');
    const body = group.sessions.length === 1
      ? group.bodyParts[0]
      : [
          'Combined across related chats:',
          '',
          ...group.bodyParts.map(part => `- ${part}`),
          '',
          `Related chats: ${chatIds}`,
        ].join('\n');

    return {
      title: chooseGroupTitle(group),
      body,
      project: group.project,
      sessions: group.sessions,
      startTime: group.startTime,
      endTime: group.endTime,
      agentLabel: agents.join(', '),
      chatLabel: group.sessions.length === 1 ? `Chat: ${chatIds}` : `Chats: ${chatIds}`,
      incomplete: group.sourceEntries.some(entry => entry.incomplete === true),
    };
  });
}

/**
 * Generate and write a markdown journal for a given date.
 *
 * @param {string} dateStr - YYYY-MM-DD date string
 * @param {{ session: object, highlights: object, summary: string|{title:string,body:string} }[]} entries
 * @param {string} [outputDir] - Override destination for isolated/test runs
 * @returns {string} Path written
 */
function generateJournal(dateStr, entries, outputDir = config.output.directory) {
  const valid = entries.filter(e => !isEmptySession(e.summary));
  const [year, month, day] = dateStr.split('-');
  const filePath = path.join(outputDir, year, month, `${day}.md`);
  const dirPath = path.dirname(filePath);
  const markdown = valid.length === 0
    ? buildNoActivityJournal(dateStr)
    : buildDetailedJournal(dateStr, valid, dirPath);

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, markdown, 'utf-8');

  console.log(`[journal] Wrote ${filePath}`);
  return filePath;
}

module.exports = {
  generateJournal,
  EMPTY_SESSION_BODY,
  NO_ACTIVITY_BODY,
  shortProject,
  formatTime,
  mergeEntriesByTask,
  isEmptySession,
  extractSummary,
  escapeCell,
  flattenTitle,
};
