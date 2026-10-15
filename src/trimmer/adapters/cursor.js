/**
 * Trimmer adapter for Cursor AI conversation data stored in state.vscdb SQLite files.
 *
 * READ-ONLY INVARIANT: This module MUST NEVER write, modify, delete, rename,
 * or lock any file. All SQLite connections use { readOnly: true }.
 * No UPDATE / INSERT / DELETE / CREATE / DROP SQL is issued anywhere in this file.
 *
 * Data layout (Cursor's SQLite schema):
 *   Table: cursorDiskKV  (columns: key TEXT, value TEXT)
 *
 *   Key "composerData:<composerId>" → JSON with:
 *     { fullConversationHeadersOnly: [{bubbleId, type}], createdAt, lastUpdatedAt, name, ... }
 *     type 1 = user bubble, type 2 = assistant bubble
 *
 *   Key "bubbleId:<composerId>:<bubbleId>" → JSON with:
 *     { text?, richText?, allThinkingBlocks?, toolResults?, codeBlocks?,
 *       suggestedCodeBlocks?, images?, ... }
 *
 * Source may be:
 *   - A path to a state.vscdb file
 *   - A path to a directory containing a state.vscdb file (found by walking one level)
 *   - A node:sqlite DatabaseSync handle (already opened by the caller, read-only)
 *
 * The global state.vscdb (%APPDATA%/Cursor/User/globalStorage/state.vscdb) holds
 * composer and bubble data for all workspaces.
 * Workspace state.vscdb files hold ItemTable rows but not the bubble payloads.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { normalizeWhitespace } = require('../index');
const { safeJsonParse }       = require('../util');

// ── Database helper (uses built-in node:sqlite, no extra dependency) ───────────

/**
 * Open a state.vscdb file in strict read-only mode.
 * Throws if the file does not exist — callers must guard.
 *
 * @param {string} dbPath - Absolute path to a .vscdb or .db file.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function _openDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

// ── Lexical richText walker ────────────────────────────────────────────────────

/**
 * Recursively walk a Lexical JSON tree (Cursor's richText format) and
 * concatenate all leaf text nodes.
 *
 * Skips nodes with type 'code' or 'codeblock' (standalone code blocks that
 * appear as their own paragraph node rather than inline formatting).
 *
 * @param {object} node - A Lexical node (root, paragraph, text, code, etc.)
 * @param {string[]} parts - Accumulator array (mutated in place).
 * @returns {void}
 */
function _walkLexical(node, parts) {
  if (!node || typeof node !== 'object') return;

  const t = node.type;

  // Skip standalone code block nodes — they are file/command dumps, not prose.
  if (t === 'code' || t === 'codeblock') return;

  // Leaf text node — capture its text.
  if (t === 'text' && typeof node.text === 'string') {
    const trimmed = node.text; // preserve internal formatting; normalizeWhitespace handles it later
    if (trimmed) parts.push(trimmed);
    return;
  }

  // Recurse into children for container nodes (root, paragraph, list, etc.)
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      _walkLexical(child, parts);
    }
  }
}

/**
 * Extract plain text from a Cursor richText JSON string (Lexical format).
 *
 * @param {string | undefined} richTextStr - Serialised Lexical JSON string.
 * @returns {string} Plain text, or empty string if not parseable.
 */
function _extractRichText(richTextStr) {
  if (!richTextStr || typeof richTextStr !== 'string') return '';
  const parsed = safeJsonParse(richTextStr);
  if (!parsed) return '';
  const parts = [];
  // Lexical JSON top-level shape: { root: { children: [...] } }
  _walkLexical(parsed.root || parsed, parts);
  return parts.join(' ');
}

// ── Source resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the source argument to an open DatabaseSync handle.
 * Returns { db, shouldClose } — callers must call db.close() if shouldClose is true.
 *
 * @param {string | object} source
 * @returns {{ db: import('node:sqlite').DatabaseSync, shouldClose: boolean }}
 * @throws {Error} If the source cannot be resolved to a state.vscdb file.
 */
function _resolveDb(source) {
  // Duck-type check: is source an already-open DB handle?
  if (source !== null && typeof source === 'object' && typeof source.prepare === 'function') {
    return { db: source, shouldClose: false };
  }

  if (typeof source !== 'string') {
    throw new Error('cursor adapter: source must be a file path, directory path, or open DatabaseSync handle');
  }

  // Check if path exists
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new Error(`cursor adapter: source path not found: ${source}`);
  }

  let dbPath;

  if (stat.isDirectory()) {
    // Walk one level to find state.vscdb
    const candidate = path.join(source, 'state.vscdb');
    if (fs.existsSync(candidate)) {
      dbPath = candidate;
    } else {
      // Try one level deeper (e.g. workspaceStorage/<hash>/state.vscdb)
      let entries;
      try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nested = path.join(source, entry.name, 'state.vscdb');
          if (fs.existsSync(nested)) { dbPath = nested; break; }
        }
      }
    }
    if (!dbPath) {
      throw new Error(`cursor adapter: no state.vscdb found in directory: ${source}`);
    }
  } else {
    // Assume it is a .vscdb file (or any SQLite file with cursorDiskKV)
    dbPath = source;
  }

  const db = _openDb(dbPath);
  return { db, shouldClose: true };
}

// ── Core parsing ───────────────────────────────────────────────────────────────

/**
 * Fields on a bubble JSON object that we explicitly drop (count as droppedCounts).
 * We don't need to delete them from the object — we just never read them into output.
 * The list is here for documentation and for building droppedCounts stats.
 */
const DROPPED_BUBBLE_FIELDS = [
  'allThinkingBlocks',  // Internal reasoning steps — never expose
  'toolResults',        // Tool call I/O metadata
  'suggestedCodeBlocks', // File diff / code suggestions
  'codeBlocks',         // File content dumps
  'images',             // Inline image attachments
  'attachedCodeChunks', // Code context chunks
  'codebaseContextChunks', // Semantic search results
  'gitDiffs',           // Git diff data
  'interpreterResults', // Terminal output
  'assistantSuggestedDiffs', // Diff suggestions
];

/**
 * Parse all composers from an open cursorDiskKV database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../types').TrimOptions} options
 * @param {string[]} warnings
 * @param {Record<string, number>} droppedCounts
 * @returns {import('../types').CleanTurn[]}
 */
function _parseFromDb(db, options, warnings, droppedCounts) {
  // ── Step 1: enumerate all composer records ──────────────────────────────────
  let composerRows;
  try {
    composerRows = db.prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
    ).all();
  } catch (err) {
    warnings.push(`cursor adapter: failed to query composerData rows: ${err.message}`);
    return [];
  }

  if (!composerRows || composerRows.length === 0) {
    warnings.push('cursor adapter: no composerData rows found in cursorDiskKV');
    return [];
  }

  // ── Step 2: parse and sort composers by createdAt ──────────────────────────
  const composers = [];
  for (const row of composerRows) {
    const data = safeJsonParse(row.value);
    if (!data) {
      warnings.push(`cursor adapter: malformed JSON for key ${row.key} — skipped`);
      droppedCounts['_bad_json'] = (droppedCounts['_bad_json'] || 0) + 1;
      continue;
    }

    const composerId = row.key.slice('composerData:'.length);
    composers.push({
      composerId,
      createdAt: data.createdAt || data.lastUpdatedAt || 0,
      lastUpdatedAt: data.lastUpdatedAt || 0,
      name: data.name || '',
      headers: Array.isArray(data.fullConversationHeadersOnly)
        ? data.fullConversationHeadersOnly
        : [],
    });
  }

  // Sort chronologically by createdAt so multi-composer output is ordered
  composers.sort((a, b) => a.createdAt - b.createdAt);

  // ── Step 3: for each composer, fetch bubbles in header order ───────────────
  const allTurns = [];

  // Prepare one reusable statement for bubble lookups
  let bubbleStmt;
  try {
    bubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
  } catch (err) {
    warnings.push(`cursor adapter: failed to prepare bubble statement: ${err.message}`);
    return [];
  }

  for (const composer of composers) {
    if (composer.headers.length === 0) {
      // Empty composer — skip silently (no warning; this is normal for drafts)
      droppedCounts['_empty_composer'] = (droppedCounts['_empty_composer'] || 0) + 1;
      continue;
    }

    for (const header of composer.headers) {
      const bubbleId  = header.bubbleId;
      const bubbleType = header.type; // 1 = user, 2 = assistant

      if (!bubbleId || (bubbleType !== 1 && bubbleType !== 2)) {
        droppedCounts['_unknown_bubble_type'] = (droppedCounts['_unknown_bubble_type'] || 0) + 1;
        continue;
      }

      const bubbleKey = `bubbleId:${composer.composerId}:${bubbleId}`;
      let bubbleRow;
      try {
        bubbleRow = bubbleStmt.get(bubbleKey);
      } catch (err) {
        warnings.push(`cursor adapter: error fetching bubble ${bubbleKey}: ${err.message}`);
        continue;
      }

      if (!bubbleRow) {
        // Bubble not in this DB — may be in a different state.vscdb; skip silently
        droppedCounts['_bubble_not_found'] = (droppedCounts['_bubble_not_found'] || 0) + 1;
        continue;
      }

      const bubble = safeJsonParse(bubbleRow.value);
      if (!bubble) {
        droppedCounts['_bad_json'] = (droppedCounts['_bad_json'] || 0) + 1;
        continue;
      }

      // Count explicitly dropped fields for stats
      for (const field of DROPPED_BUBBLE_FIELDS) {
        if (bubble[field] !== undefined) {
          const val = bubble[field];
          const count = Array.isArray(val) ? val.length : 1;
          if (count > 0) {
            droppedCounts[field] = (droppedCounts[field] || 0) + count;
          }
        }
      }

      // ── Extract text ────────────────────────────────────────────────────────
      let text = '';

      if (typeof bubble.text === 'string' && bubble.text.trim()) {
        // Preferred path: plain text field
        text = bubble.text.trim();
      } else if (typeof bubble.richText === 'string' && bubble.richText.trim()) {
        // Fallback: Lexical richText JSON tree
        text = _extractRichText(bubble.richText);
      }

      if (!text) {
        // No extractable text — skip this bubble entirely
        droppedCounts['_empty_bubble'] = (droppedCounts['_empty_bubble'] || 0) + 1;
        continue;
      }

      const content = normalizeWhitespace(text);
      if (!content) {
        droppedCounts['_empty_bubble'] = (droppedCounts['_empty_bubble'] || 0) + 1;
        continue;
      }

      // ── Build CleanTurn ─────────────────────────────────────────────────────
      const role = bubbleType === 1 ? 'user' : 'assistant';

      /** @type {import('../types').CleanTurn} */
      const turn = { role, content };

      // Timestamps come from the composer, not the bubble (bubbles have no ts field)
      if (options.includeTimestamps !== false && composer.createdAt) {
        turn.timestamp = new Date(composer.createdAt).toISOString();
      }

      // keepToolNotes: note that tool results were present but stripped
      if (options.keepToolNotes) {
        const toolResults = Array.isArray(bubble.toolResults) ? bubble.toolResults : [];
        if (toolResults.length > 0) {
          const names = toolResults
            .map(tr => tr.toolName || tr.name || 'unknown_tool')
            .filter(Boolean);
          if (names.length > 0) {
            turn.actionNote = names.map(n => `[Tool: ${n}]`).join(' ');
          }
        }
      }

      allTurns.push(turn);
    }
  }

  return allTurns;
}

// ── Public parse function ─────────────────────────────────────────────────────

/**
 * Parse Cursor AI conversation data from a state.vscdb SQLite source.
 *
 * READ-ONLY: All database handles are opened with { readOnly: true }.
 * No SQL writes (UPDATE/INSERT/DELETE/CREATE/DROP) are performed.
 *
 * @param {string | import('node:sqlite').DatabaseSync} source
 *   - Path to a state.vscdb file
 *   - Path to a directory containing state.vscdb
 *   - An already-open node:sqlite DatabaseSync handle
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

  // Measure original byte size when source is a file path
  let originalBytes = 0;
  if (typeof source === 'string') {
    try {
      const stat = fs.statSync(source);
      originalBytes = stat.isFile() ? stat.size : 0;
    } catch {
      // Not fatal — we'll catch the real error in _resolveDb
    }
  }

  let db;
  let shouldClose = false;

  try {
    const resolved = _resolveDb(source);
    db         = resolved.db;
    shouldClose = resolved.shouldClose;
  } catch (err) {
    warnings.push(err.message);
    return {
      messages: [],
      stats: { originalBytes, droppedCounts },
      warnings,
    };
  }

  let messages = [];
  try {
    messages = _parseFromDb(db, options, warnings, droppedCounts);
  } finally {
    if (shouldClose && db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  return {
    messages,
    stats: { originalBytes, droppedCounts },
    warnings,
  };
}

module.exports = { parse };
