'use strict';

/**
 * Trimmer adapter for Factory JSONL session files.
 *
 * Factory stores sessions as JSONL files under ~/.factory/sessions/.
 * The wire format differs from Claude Code in one key way:
 *
 *   Factory: { "type": "message", "message": { "role": "user|assistant", "content": [...] } }
 *   Claude Code: { "type": "user|assistant", "message": { "role": "...", "content": [...] } }
 *
 * Factory-specific entry types (dropped silently):
 *   session_start, todo_state, openaiEncryptedContent fields (not separate entries)
 *
 * The content block schema IS identical to Claude Code's Anthropic-Messages format:
 * arrays of { type: 'text'|'thinking'|'tool_use'|'tool_result', ... }
 *
 * READ-ONLY INVARIANT: This module MUST NEVER write, modify, delete, rename,
 * or lock any file. JSONL reads use fs.createReadStream only.
 *
 * @module trimmer/adapters/factory
 */

const fs       = require('fs');
const readline = require('readline');

const { safeJsonParse }                               = require('../util');
const { flattenContentBlocks, normalizeWhitespace }   = require('../index');

// Block types whose counts we tally as dropped
const DROPPED_BLOCK_TYPES = new Set(['thinking', 'tool_use', 'tool_result']);

// Top-level Factory entry types that carry no natural-language content
const DROPPED_ENTRY_TYPES = new Set([
  'session_start', 'todo_state', 'system', 'attachment',
  'permission-mode', 'progress', 'last-prompt',
]);

// ── File reading ──────────────────────────────────────────────────────────────

/**
 * Read a JSONL file line-by-line via createReadStream (read-only, no write access).
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
function _readLines(filePath) {
  return new Promise((resolve, reject) => {
    const lines  = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line',  line => lines.push(line));
    rl.on('close', ()   => resolve(lines));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

// ── Content extraction ────────────────────────────────────────────────────────

/**
 * Extract plain text from Factory message content. Tallies dropped block types.
 * Accepts: string (plain text), or Array of Anthropic-style content blocks.
 *
 * @param {string | Array | undefined} content
 * @param {Record<string,number>} droppedCounts — mutated in-place
 * @returns {string}
 */
function _extractText(content, droppedCounts) {
  if (content == null) return '';

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const t = block.type;
      if (t && t !== 'text' && DROPPED_BLOCK_TYPES.has(t)) {
        droppedCounts[t] = (droppedCounts[t] || 0) + 1;
      }
    }
    return flattenContentBlocks(content);
  }

  return '';
}

// ── Line processing ───────────────────────────────────────────────────────────

/**
 * Process an array of raw JSONL line strings into CleanTurns.
 *
 * Factory JSONL schema per line:
 *   - session_start: { type: 'session_start', id, title, ... }  → skip
 *   - message:       { type: 'message', id, timestamp, message: { role, content } } → parse
 *   - todo_state:    { type: 'todo_state', ... }  → skip
 *   - anything else: skip
 *
 * @param {string[]} lines
 * @param {import('../types').TrimOptions} options
 * @param {string[]} warnings
 * @param {Record<string,number>} droppedCounts
 * @returns {{ turns: import('../types').CleanTurn[], badLines: number }}
 */
function _processLines(lines, options, warnings, droppedCounts) {
  const turns  = [];
  let badLines = 0;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    const obj = safeJsonParse(raw);
    if (obj === null) {
      badLines++;
      continue;
    }

    const entryType = obj.type;

    // Drop known non-conversation entry types
    if (DROPPED_ENTRY_TYPES.has(entryType)) {
      droppedCounts[entryType] = (droppedCounts[entryType] || 0) + 1;
      continue;
    }

    // Factory message entries use type='message', role is inside obj.message
    if (entryType === 'message') {
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') continue;

      const role = msg.role;
      if (role !== 'user' && role !== 'assistant') continue;

      // Use content from obj.message.content — identical Anthropic-Messages schema
      const content = msg.content;
      const rawText = _extractText(content, droppedCounts);
      const cleaned = normalizeWhitespace(rawText);
      if (!cleaned) continue;

      const turn = { role, content: cleaned };

      if (options.includeTimestamps !== false && obj.timestamp != null) {
        turn.timestamp = obj.timestamp;
      }

      // keepToolNotes: surface a note for dropped tool_use blocks
      if (options.keepToolNotes && Array.isArray(content)) {
        const toolNames = content
          .filter(b => b && b.type === 'tool_use' && b.name)
          .map(b => b.name);
        if (toolNames.length > 0) {
          turn.actionNote = toolNames.map(n => `[Tool: ${n}]`).join(' ');
        }
      }

      turns.push(turn);
      continue;
    }

    // Unknown entry type — silently drop (don't add noise to warnings)
  }

  return { turns, badLines };
}

// ── parse (public entry point) ────────────────────────────────────────────────

/**
 * Parse a Factory session source into CleanTurns.
 *
 * @param {string} source
 *   A path to a Factory .jsonl session file, OR a raw JSONL string (multi-line).
 * @param {import('../types').TrimOptions} [options={}]
 * @returns {Promise<{
 *   messages: import('../types').CleanTurn[],
 *   stats: Partial<import('../types').TrimStats>,
 *   warnings: string[]
 * }>}
 */
async function parse(source, options = {}) {
  const warnings      = [];
  const droppedCounts = {};
  let allLines        = [];
  let originalBytes   = 0;

  if (typeof source !== 'string') {
    warnings.push('factory adapter: source must be a string (file path or raw JSONL)');
    return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
  }

  // Determine source type: raw JSONL string vs file path
  const isRawString = source.includes('\n') ||
    (source.trim().startsWith('{') && !source.endsWith('.jsonl'));

  if (isRawString) {
    originalBytes = Buffer.byteLength(source, 'utf8');
    allLines      = source.split('\n');
  } else {
    let stat;
    try { stat = fs.statSync(source); } catch {
      warnings.push(`factory adapter: source path not found: ${source}`);
      return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
    }

    if (stat.isDirectory()) {
      warnings.push('factory adapter: directory source not supported; provide a single .jsonl file path');
      return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
    }

    try {
      originalBytes = stat.size;
      allLines      = await _readLines(source);
    } catch (err) {
      warnings.push(`factory adapter: failed to read ${source}: ${err.message}`);
      return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
    }
  }

  const originalLines             = allLines.length;
  const { turns, badLines }       = _processLines(allLines, options, warnings, droppedCounts);

  if (badLines > 0) {
    warnings.push(`factory adapter: ${badLines} line(s) failed JSON parsing and were skipped`);
    droppedCounts['_bad_json'] = badLines;
  }

  return {
    messages: turns,
    stats: { originalBytes, originalLines, droppedCounts },
    warnings,
  };
}

module.exports = { parse };
