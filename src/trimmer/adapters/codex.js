/**
 * Trimmer adapter for Codex CLI JSONL session files.
 *
 * READ-ONLY INVARIANT: This module MUST NEVER write, modify, delete, rename,
 * or lock any file. All access is strictly read-only via fs.createReadStream.
 *
 * Codex session files live at:
 *   ~/.codex/sessions/<year>/<month>/<day>/rollout-<ISO>-<uuid>.jsonl
 *
 * Each line is one of:
 *   { type: 'session_meta',   payload: { id, cwd, ... } }
 *   { type: 'event_msg',      payload: { type: 'task_started'|'user_message'|'error'|... message? } }
 *   { type: 'response_item',  payload: { type: 'message'|'function_call'|'function_call_output'|...
 *                                         role?: 'user'|'assistant'|'developer', content?: [...] } }
 *   { type: 'turn_context',   payload: { ... } }
 *
 * Natural-language content lives in:
 *   - response_item where payload.type === 'message' AND payload.role IN ('user','assistant')
 *     payload.content is an array of { type: 'input_text'|'text', text: string }
 *   - event_msg where payload.type === 'user_message'
 *     payload.message is a plain string
 *
 * Everything else (function_call, function_call_output, developer messages,
 * task_started, turn_context, session_meta, error, etc.) is dropped.
 *
 * Fallback — simple {role, content} shape (history.jsonl or legacy sessions):
 *   If a line has a top-level `role` field ('user'|'assistant') and a `content`
 *   field (string or array), treat it directly as a conversation message.
 */

'use strict';

const fs       = require('fs');
const readline = require('readline');

const { safeJsonParse }        = require('../util');
const { normalizeWhitespace }  = require('../index');

// Codex response_item payload types that carry no natural-language text
const DROPPED_RESPONSE_TYPES = new Set([
  'function_call', 'function_call_output', 'computer_call',
  'computer_call_output', 'reasoning', 'web_search_call', 'code_interpreter_call',
]);

// Codex event_msg payload types that carry no natural-language text
const DROPPED_EVENT_TYPES = new Set([
  'task_started', 'task_complete', 'error', 'turn_started', 'turn_complete',
  'item_started', 'item_complete',
]);

/**
 * Read a JSONL file line-by-line via createReadStream (read-only).
 *
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
function _readLines(filePath) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', line => lines.push(line));
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * Extract plain text from a Codex content array.
 * Codex uses 'input_text' for user messages and 'output_text' for current
 * assistant messages. Older files may use the generic 'text' type.
 *
 * @param {Array | string | undefined} content
 * @returns {string}
 */
function _extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && ['input_text', 'output_text', 'text'].includes(b.type) && typeof b.text === 'string')
    .map(b => b.text.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Skip system/environment preamble lines that Codex injects as user messages.
 * These are not real user prompts.
 *
 * @param {string} text
 * @returns {boolean}
 */
function _isSystemPreamble(text) {
  if (!text) return true;
  return (
    text.startsWith('<environment_context>') ||
    text.startsWith('<codex_internal_context') ||
    text.startsWith('<permissions instructions>') ||
    text.startsWith('<collaboration_mode>') ||
    text.startsWith('# AGENTS.md instructions') ||
    text.startsWith('<skills_instructions>')
  );
}

/**
 * Process an array of raw JSONL line strings into CleanTurns.
 *
 * @param {string[]} lines
 * @param {import('../types').TrimOptions} options
 * @param {string[]} warnings        — mutated in place
 * @param {Record<string,number>} droppedCounts — mutated in place
 * @returns {{ turns: import('../types').CleanTurn[], badLines: number }}
 */
function _processLines(lines, options, warnings, droppedCounts) {
  const turns = [];
  let badLines = 0;
  const responseUserTexts = new Set();

  for (const raw of lines) {
    const obj = safeJsonParse(raw);
    if (obj?.type !== 'response_item' || obj.payload?.type !== 'message' || obj.payload.role !== 'user') continue;
    const cleaned = normalizeWhitespace(_extractContentText(obj.payload.content));
    if (cleaned && !_isSystemPreamble(cleaned)) responseUserTexts.add(cleaned);
  }

  for (const raw of lines) {
    if (!raw.trim()) continue;

    const obj = safeJsonParse(raw);
    if (obj === null) {
      badLines++;
      continue;
    }

    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

    // ── Fallback shape: top-level { role, content } ──────────────────────────
    if ((obj.role === 'user' || obj.role === 'assistant') && obj.content !== undefined && obj.type === undefined) {
      const text = _extractContentText(obj.content);
      const cleaned = normalizeWhitespace(text);
      if (!cleaned || _isSystemPreamble(cleaned)) {
        droppedCounts['system_preamble'] = (droppedCounts['system_preamble'] || 0) + 1;
        continue;
      }
      const turn = { role: obj.role, content: cleaned };
      if (options.includeTimestamps !== false && timestamp) turn.timestamp = timestamp;
      turns.push(turn);
      continue;
    }

    const entryType = obj.type;

    // ── session_meta / turn_context — drop ───────────────────────────────────
    if (entryType === 'session_meta' || entryType === 'turn_context') {
      droppedCounts[entryType] = (droppedCounts[entryType] || 0) + 1;
      continue;
    }

    // ── event_msg ─────────────────────────────────────────────────────────────
    if (entryType === 'event_msg') {
      const payload = obj.payload;
      if (!payload) continue;

      const ptype = payload.type;

      if (ptype === 'user_message') {
        const text = typeof payload.message === 'string' ? payload.message.trim() : '';
        const cleaned = normalizeWhitespace(text);
        if (!cleaned || _isSystemPreamble(cleaned)) {
          droppedCounts['system_preamble'] = (droppedCounts['system_preamble'] || 0) + 1;
          continue;
        }
        if (responseUserTexts.has(cleaned)) {
          droppedCounts['duplicate_user_event'] = (droppedCounts['duplicate_user_event'] || 0) + 1;
          continue;
        }
        const turn = { role: 'user', content: cleaned };
        if (options.includeTimestamps !== false && timestamp) turn.timestamp = timestamp;
        turns.push(turn);
      } else {
        // task_started, task_complete, error, etc.
        droppedCounts[ptype || 'event_unknown'] = (droppedCounts[ptype || 'event_unknown'] || 0) + 1;
      }
      continue;
    }

    // ── response_item ─────────────────────────────────────────────────────────
    if (entryType === 'response_item') {
      const payload = obj.payload;
      if (!payload) continue;

      const ptype = payload.type;
      const role  = payload.role;

      if (ptype === 'message') {
        // Drop developer messages (system prompts, permissions, skill listings)
        if (role === 'developer') {
          droppedCounts['developer_message'] = (droppedCounts['developer_message'] || 0) + 1;
          continue;
        }

        if (role === 'user' || role === 'assistant') {
          const text = _extractContentText(payload.content);
          const cleaned = normalizeWhitespace(text);
          if (!cleaned || _isSystemPreamble(cleaned)) {
            droppedCounts['system_preamble'] = (droppedCounts['system_preamble'] || 0) + 1;
            continue;
          }
          const turn = { role, content: cleaned };
          if (options.includeTimestamps !== false && timestamp) turn.timestamp = timestamp;

          if (options.keepToolNotes) {
            // Codex function calls show up as separate response_items, not inline.
            // No inline tools to note here.
          }

          turns.push(turn);
        }
      } else if (DROPPED_RESPONSE_TYPES.has(ptype)) {
        droppedCounts[ptype] = (droppedCounts[ptype] || 0) + 1;
      } else {
        // Unknown response type
        droppedCounts[`response_${ptype || 'unknown'}`] = (droppedCounts[`response_${ptype || 'unknown'}`] || 0) + 1;
      }
      continue;
    }

    // ── Anything else ─────────────────────────────────────────────────────────
    droppedCounts[entryType || 'unknown'] = (droppedCounts[entryType || 'unknown'] || 0) + 1;
  }

  return { turns, badLines };
}

/**
 * Parse a Codex source into CleanTurns.
 *
 * @param {string} source         File path or raw JSONL string.
 * @param {import('../types').TrimOptions} [options={}]
 * @returns {Promise<{
 *   messages: import('../types').CleanTurn[],
 *   stats: Partial<import('../types').TrimStats>,
 *   warnings: string[]
 * }>}
 */
async function parse(source, options = {}) {
  const warnings = [];
  const droppedCounts = {};
  let allLines = [];
  let originalBytes = 0;

  if (typeof source !== 'string') {
    warnings.push('codex adapter: source must be a string (file path or raw JSONL)');
    return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
  }

  // Raw JSONL string detection: contains newline, OR starts with '{' and isn't a file path
  const looksLikePath = !source.includes('\n') && fs.existsSync(source);
  if (!looksLikePath) {
    // Treat as raw JSONL string
    originalBytes = Buffer.byteLength(source, 'utf8');
    allLines = source.split('\n');
  } else {
    let stat;
    try { stat = fs.statSync(source); } catch {
      warnings.push(`codex adapter: source path not found: ${source}`);
      return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
    }

    if (stat.isDirectory()) {
      warnings.push(`codex adapter: directory source not supported; pass a single .jsonl file path`);
      return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
    }

    try {
      originalBytes = stat.size;
      allLines = await _readLines(source);
    } catch (err) {
      warnings.push(`codex adapter: failed to read ${source}: ${err.message}`);
      return { messages: [], stats: { originalBytes, droppedCounts }, warnings };
    }
  }

  const originalLines = allLines.length;
  const { turns, badLines } = _processLines(allLines, options, warnings, droppedCounts);

  if (badLines > 0) {
    warnings.push(`codex adapter: ${badLines} line(s) failed JSON parsing and were skipped`);
    droppedCounts['_bad_json'] = badLines;
  }

  return {
    messages: turns,
    stats: {
      originalBytes,
      originalLines,
      droppedCounts,
    },
    warnings,
  };
}

module.exports = { parse };
