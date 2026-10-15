'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalizeWhitespace } = require('../index');
const { safeJsonParse } = require('../util');
const { getDateRange, isWithinDate } = require('../../utils/date');

function readJsonl(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      const parsed = safeJsonParse(line);
      rows.push(parsed === null ? { __badJson: true } : parsed);
    });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

function extractText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  if (Array.isArray(content)) {
    text = content
      .filter(block => block && ['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    text = content.text;
  }
  return normalizeWhitespace(text)
    .replace(/^<user_query>\s*/i, '')
    .replace(/\s*<\/user_query>$/i, '')
    .trim();
}

function getPrimaryTurnTimes(events, targetDate) {
  const range = targetDate ? getDateRange(targetDate) : null;
  const turns = new Map();
  for (const event of events) {
    if (!event || event.__badJson || event.type !== 'turn_started') continue;
    if (event.session_relationship && event.session_relationship !== 'primary') continue;
    if (!Number.isInteger(event.turn_number) || !event.ts) continue;
    if (range && !isWithinDate(event.ts, range)) continue;
    turns.set(event.turn_number, event.ts);
  }
  return turns;
}

function parseRows(events, history, options = {}) {
  const droppedCounts = {};
  const warnings = [];
  const turnTimes = getPrimaryTurnTimes(events, options.targetDate);
  const messages = [];

  const badEvents = events.filter(row => row?.__badJson).length;
  const badHistory = history.filter(row => row?.__badJson).length;
  if (badEvents + badHistory > 0) {
    droppedCounts._bad_json = badEvents + badHistory;
    warnings.push(`grok adapter: ${badEvents + badHistory} malformed JSON line(s) skipped`);
  }

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || entry.__badJson || entry.type !== 'user' || !Number.isInteger(entry.prompt_index)) continue;

    const timestamp = turnTimes.get(entry.prompt_index);
    if (!timestamp) continue;
    if (entry.synthetic_reason) {
      // Grok can use hidden notification/task-completion prompts to resume a
      // turn. The prompt is noise, but the assistant text that follows is
      // still visible to the user and must remain in the clean transcript.
      droppedCounts.synthetic_user = (droppedCounts.synthetic_user || 0) + 1;
    } else {
      const userText = extractText(entry.content);
      if (!userText) {
        droppedCounts.empty_user = (droppedCounts.empty_user || 0) + 1;
      } else {
        const userTurn = { role: 'user', content: userText };
        if (options.includeTimestamps !== false) userTurn.timestamp = timestamp;
        messages.push(userTurn);
      }
    }

    for (let j = i + 1; j < history.length; j++) {
      const reply = history[j];
      if (!reply || reply.__badJson) continue;
      if (reply.type === 'user' && Number.isInteger(reply.prompt_index)) break;

      if (reply.type !== 'assistant') {
        if (reply.type) droppedCounts[reply.type] = (droppedCounts[reply.type] || 0) + 1;
        continue;
      }

      const assistantText = extractText(reply.content);
      if (!assistantText) {
        if (Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) {
          droppedCounts.tool_calls = (droppedCounts.tool_calls || 0) + reply.tool_calls.length;
        }
        continue;
      }

      const assistantTurn = { role: 'assistant', content: assistantText };
      if (options.includeTimestamps !== false) assistantTurn.timestamp = timestamp;
      messages.push(assistantTurn);
    }
  }

  return { messages, droppedCounts, warnings };
}

async function parse(source, options = {}) {
  let events;
  let history;
  let originalBytes = 0;

  if (source && typeof source === 'object' && Array.isArray(source.events) && Array.isArray(source.chatHistory)) {
    events = source.events;
    history = source.chatHistory;
  } else if (typeof source === 'string') {
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      return { messages: [], stats: { originalBytes: 0, droppedCounts: {} }, warnings: [`grok adapter: source not found: ${source}`] };
    }

    const sessionDir = stat.isDirectory() ? source : path.dirname(source);
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const historyPath = path.join(sessionDir, 'chat_history.jsonl');
    try {
      originalBytes = fs.statSync(eventsPath).size + fs.statSync(historyPath).size;
      [events, history] = await Promise.all([readJsonl(eventsPath), readJsonl(historyPath)]);
    } catch (err) {
      return { messages: [], stats: { originalBytes, droppedCounts: {} }, warnings: [`grok adapter: failed to read session: ${err.message}`] };
    }
  } else {
    return { messages: [], stats: { originalBytes: 0, droppedCounts: {} }, warnings: ['grok adapter: source must be a session directory or fixture object'] };
  }

  const result = parseRows(events, history, options);
  return {
    messages: result.messages,
    stats: {
      originalBytes,
      originalLines: events.length + history.length,
      droppedCounts: result.droppedCounts,
    },
    warnings: result.warnings,
  };
}

module.exports = { parse, parseRows, extractText, getPrimaryTurnTimes };
