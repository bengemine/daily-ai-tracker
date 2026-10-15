/**
 * Trimmer adapter for Claude Code JSONL session files.
 *
 * READ-ONLY INVARIANT: This module MUST NEVER write, modify, delete, rename,
 * or lock any file. All access is strictly read-only via fs.createReadStream.
 *
 * Source may be:
 *   - A path to a single .jsonl file (session or history.jsonl)
 *   - A path to a directory  → walks all *.jsonl files within it
 *   - A raw JSONL string     → parsed directly without file I/O
 *
 * Claude Code JSONL schema (per-entry):
 *   {
 *     type: 'user' | 'assistant' | 'system' | 'attachment' | ...
 *     isSidechain?: boolean   // drop when true
 *     isMeta?: boolean        // drop when true
 *     message?: {
 *       role: 'user' | 'assistant'
 *       content: string | Array<{type, text?, ...}>
 *     }
 *     timestamp?: string      // ISO-8601
 *     // history.jsonl shape (simpler — no message wrapper):
 *     display?: string        // used as text when message is absent
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const { safeJsonParse }        = require('../util');
const { flattenContentBlocks, normalizeWhitespace } = require('../index');

// Block types that are counted as dropped (not kept)
const DROPPED_BLOCK_TYPES = new Set(['thinking', 'tool_use', 'tool_result']);

// Top-level entry types that carry no natural-language content
const DROPPED_ENTRY_TYPES = new Set([
  'system', 'attachment', 'permission-mode', 'file-history-snapshot',
  'queue-operation', 'progress', 'last-prompt',
]);

/**
 * Read a JSONL file line-by-line via createReadStream (read-only).
 * Returns an array of raw line strings.
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
 * Collect all .jsonl file paths inside a directory (non-recursive by default,
 * but we do one level of subdirectory so subagent files are found too).
 *
 * @param {string} dirPath
 * @returns {string[]}
 */
function _walkJsonlFiles(dirPath) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    } else if (entry.isDirectory()) {
      // One level deep — picks up subagent directories
      let subEntries;
      try { subEntries = fs.readdirSync(fullPath, { withFileTypes: true }); } catch { continue; }
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.jsonl')) {
          results.push(path.join(fullPath, sub.name));
        }
      }
    }
  }
  return results;
}

/**
 * Extract text from a Claude Code message's content field.
 * Returns { text, droppedCounts } where droppedCounts tallies non-text blocks.
 *
 * @param {string | Array | undefined} content
 * @param {Record<string,number>} droppedCounts  — mutated in place
 * @returns {string}
 */
function _extractText(content, droppedCounts) {
  if (content === undefined || content === null) return '';

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

/**
 * Process an array of raw JSONL line strings into CleanTurns.
 *
 * @param {string[]} lines
 * @param {import('../types').TrimOptions} options
 * @param {string[]} warnings
 * @param {Record<string,number>} droppedCounts
 * @param {number} badLines - running count of unparseable lines (returned by value)
 * @returns {{ turns: import('../types').CleanTurn[], badLines: number }}
 */
function _processLines(lines, options, warnings, droppedCounts) {
  const turns = [];
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

    // Drop sidechain and meta entries
    if (obj.isSidechain === true || obj.isMeta === true) {
      droppedCounts['sidechain_or_meta'] = (droppedCounts['sidechain_or_meta'] || 0) + 1;
      continue;
    }

    // history.jsonl uses a simpler shape: { display, timestamp, sessionId, project, ... }
    // There is no .message wrapper and no .type of 'user'/'assistant'.
    // We treat display lines as user turns.
    if (obj.display !== undefined && obj.message === undefined) {
      const text = typeof obj.display === 'string' ? obj.display : '';
      const cleaned = normalizeWhitespace(text);
      if (!cleaned) continue;
      const turn = { role: 'user', content: cleaned };
      if (options.includeTimestamps !== false && obj.timestamp != null) {
        // history.jsonl timestamps are epoch-ms numbers
        const ts = typeof obj.timestamp === 'number'
          ? new Date(obj.timestamp).toISOString()
          : obj.timestamp;
        turn.timestamp = ts;
      }
      turns.push(turn);
      continue;
    }

    // Standard session JSONL: type must be 'user' or 'assistant'
    if (entryType !== 'user' && entryType !== 'assistant') continue;

    const msgContent = obj.message?.content;
    const rawText = _extractText(msgContent, droppedCounts);
    const cleaned = normalizeWhitespace(rawText);
    if (!cleaned) continue;

    const turn = { role: entryType, content: cleaned };
    if (options.includeTimestamps !== false && obj.timestamp != null) {
      turn.timestamp = obj.timestamp;
    }

    // keepToolNotes: surface a note about tool calls that were dropped
    if (options.keepToolNotes && Array.isArray(msgContent)) {
      const toolNames = msgContent
        .filter(b => b && b.type === 'tool_use' && b.name)
        .map(b => b.name);
      if (toolNames.length > 0) {
        turn.actionNote = toolNames.map(n => `[Tool: ${n}]`).join(' ');
      }
    }

    turns.push(turn);
  }

  return { turns, badLines };
}

/**
 * Parse a Claude Code source into CleanTurns.
 *
 * @param {string} source         File path, directory path, or raw JSONL string.
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
    warnings.push('claude-code adapter: source must be a string (file path or raw JSONL)');
    return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
  }

  // Determine source type: raw JSONL string, directory, or file
  let isRawString = false;
  let filePaths = [];

  if (source.includes('\n') || (source.trim().startsWith('{') && !source.endsWith('.jsonl'))) {
    // Treat as raw JSONL string
    isRawString = true;
    originalBytes = Buffer.byteLength(source, 'utf8');
    allLines = source.split('\n');
  } else {
    let stat;
    try { stat = fs.statSync(source); } catch {
      warnings.push(`claude-code adapter: source path not found: ${source}`);
      return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
    }

    if (stat.isDirectory()) {
      filePaths = _walkJsonlFiles(source);
      if (filePaths.length === 0) {
        warnings.push(`claude-code adapter: no .jsonl files found in directory: ${source}`);
      }
    } else {
      filePaths = [source];
    }

    // Read all files
    for (const fp of filePaths) {
      try {
        const size = fs.statSync(fp).size;
        originalBytes += size;
        const lines = await _readLines(fp);
        allLines.push(...lines);
      } catch (err) {
        warnings.push(`claude-code adapter: failed to read ${fp}: ${err.message}`);
      }
    }
  }

  const originalLines = allLines.length;

  const { turns, badLines } = _processLines(allLines, options, warnings, droppedCounts);

  if (badLines > 0) {
    warnings.push(`claude-code adapter: ${badLines} line(s) failed JSON parsing and were skipped`);
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
