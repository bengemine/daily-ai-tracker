'use strict';

/**
 * Trimmer adapter for OpenCode sharded-JSON storage.
 *
 * OpenCode stores conversations under ~/.local/share/opencode/storage/ with
 * three relevant subdirectories:
 *
 *   session/<projectID>/<sessionID>.json       — session metadata
 *   message/<sessionID>/msg_*.json             — one file per message
 *   part/<messageID>/prt_*.json                — one file per content part
 *
 * Only parts with type === 'text' are kept as natural-language content.
 * Parts of type 'reasoning', 'tool', 'step-start', 'step-finish', and any
 * other types are dropped and counted.
 *
 * The `source` parameter accepted by parse() is:
 *   - The storage root directory path (the directory containing message/, part/,
 *     session/ subdirs), AND
 *   - a sessionID string OR undefined (when undefined, all sessions are parsed)
 *   OR
 *   - An in-memory object with shape { messages, parts } for testing — where
 *       messages: Array<{ id, sessionID, role, time: { created } }>
 *       parts:    Map<messageID, Array<{ id, type, text? }>>
 *
 * READ-ONLY INVARIANT: This module MUST NEVER write, modify, delete, or rename
 * any file. All reads use fs.createReadStream or fs.readFileSync with read-only
 * intent. No SQLite is opened by this module.
 *
 * @module trimmer/adapters/opencode
 */

const fs   = require('fs');
const path = require('path');

const { safeJsonParse }        = require('../util');
const { normalizeWhitespace }  = require('../index');

// Part types that carry natural language we want to keep
const KEPT_PART_TYPES = new Set(['text']);

// Part types that are intentionally dropped (tallied in droppedCounts)
const KNOWN_DROPPED_TYPES = new Set([
  'reasoning', 'tool', 'step-start', 'step-finish', 'file', 'patch',
]);

// ── File helpers ──────────────────────────────────────────────────────────────

/**
 * Read and JSON-parse a file. Returns null on any error.
 * @param {string} filePath
 * @returns {unknown | null}
 */
function _readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

/**
 * List all *.json files directly inside a directory. Returns [] on error.
 * @param {string} dirPath
 * @returns {string[]}
 */
function _listJsonFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}

/**
 * List all immediate subdirectory names inside a directory. Returns [] on error.
 * @param {string} dirPath
 * @returns {string[]}
 */
function _listSubdirs(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

// ── Core parsing helpers ──────────────────────────────────────────────────────

/**
 * Given an array of part objects for a message, extract text content.
 * Returns { text, droppedCounts } where droppedCounts tallies non-text types.
 *
 * @param {Array<{ type: string, text?: string }>} parts
 * @param {Record<string,number>} droppedCounts — mutated in-place
 * @returns {string}
 */
function _partsToText(parts, droppedCounts) {
  const textPieces = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const type = part.type;
    if (!type) continue;

    if (KEPT_PART_TYPES.has(type)) {
      if (typeof part.text === 'string' && part.text.trim()) {
        textPieces.push(part.text.trim());
      }
    } else {
      // Tally as dropped
      droppedCounts[type] = (droppedCounts[type] || 0) + 1;
    }
  }
  return textPieces.join('\n');
}

// ── In-memory path (for tests) ────────────────────────────────────────────────

/**
 * Parse from an in-memory { messages, parts } fixture.
 * This path is used by unit tests to avoid filesystem I/O.
 *
 * @param {{ messages: Array, parts: Map<string, Array> }} fixture
 * @param {import('../types').TrimOptions} options
 * @returns {{ messages: import('../types').CleanTurn[], stats: object, warnings: string[] }}
 */
function _parseFromFixture(fixture, options) {
  const droppedCounts = {};
  const warnings = [];
  const turns = [];

  const { messages, parts } = fixture;

  if (!Array.isArray(messages)) {
    warnings.push('opencode adapter: fixture.messages must be an array');
    return { messages: [], stats: { originalBytes: 0, droppedCounts }, warnings };
  }

  // Sort messages by creation time
  const sorted = [...messages].sort((a, b) => {
    const ta = a.time?.created ?? 0;
    const tb = b.time?.created ?? 0;
    return ta - tb;
  });

  for (const msg of sorted) {
    const role = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const msgParts = (parts instanceof Map ? parts.get(msg.id) : (parts?.[msg.id])) ?? [];
    const raw = _partsToText(msgParts, droppedCounts);
    const cleaned = normalizeWhitespace(raw);
    if (!cleaned) continue;

    const turn = { role, content: cleaned };
    if (options.includeTimestamps !== false && msg.time?.created != null) {
      turn.timestamp = new Date(msg.time.created).toISOString();
    }
    turns.push(turn);
  }

  return {
    messages: turns,
    stats: { originalBytes: 0, droppedCounts },
    warnings,
  };
}

// ── Filesystem path ───────────────────────────────────────────────────────────

/**
 * Parse from the OpenCode storage root directory.
 *
 * Walks message/<sessionID>/msg_*.json → part/<messageID>/prt_*.json
 *
 * @param {string} storageRoot   Path to the opencode/storage directory.
 * @param {string | undefined}   sessionID  When provided, only that session is parsed.
 * @param {import('../types').TrimOptions} options
 * @returns {Promise<{ messages: import('../types').CleanTurn[], stats: object, warnings: string[] }>}
 */
async function _parseFromDisk(storageRoot, sessionID, options) {
  const droppedCounts = {};
  const warnings = [];
  const turns = [];
  let originalBytes = 0;

  const messageRoot = path.join(storageRoot, 'message');
  const partRoot    = path.join(storageRoot, 'part');

  // Determine which session directories to process
  let sessionDirs;
  if (sessionID) {
    sessionDirs = [sessionID];
  } else {
    sessionDirs = _listSubdirs(messageRoot);
  }

  if (sessionDirs.length === 0) {
    warnings.push(`opencode adapter: no session directories found under ${messageRoot}`);
    return { messages: turns, stats: { originalBytes, droppedCounts }, warnings };
  }

  for (const sesDir of sessionDirs) {
    const sesMessageDir = path.join(messageRoot, sesDir);
    const msgFiles = _listJsonFiles(sesMessageDir);

    // Load all messages for this session
    const messages = [];
    for (const mf of msgFiles) {
      try {
        originalBytes += fs.statSync(mf).size;
      } catch { /* size not critical */ }
      const msg = _readJson(mf);
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      messages.push(msg);
    }

    // Sort by creation time
    messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

    for (const msg of messages) {
      const msgPartDir = path.join(partRoot, msg.id);
      const partFiles  = _listJsonFiles(msgPartDir);

      // Sort part files by filename (they sort chronologically by their timestamp prefix)
      partFiles.sort();

      const parts = [];
      for (const pf of partFiles) {
        try {
          originalBytes += fs.statSync(pf).size;
        } catch { /* size not critical */ }
        const part = _readJson(pf);
        if (part && typeof part === 'object') {
          parts.push(part);
        }
      }

      const rawText = _partsToText(parts, droppedCounts);
      const cleaned = normalizeWhitespace(rawText);
      if (!cleaned) continue;

      const turn = { role: msg.role, content: cleaned };
      if (options.includeTimestamps !== false && msg.time?.created != null) {
        turn.timestamp = new Date(msg.time.created).toISOString();
      }
      turns.push(turn);
    }
  }

  return {
    messages: turns,
    stats: { originalBytes, droppedCounts },
    warnings,
  };
}

// ── parse (public entry point) ────────────────────────────────────────────────

/**
 * Parse an OpenCode conversation source into CleanTurns.
 *
 * @param {string | { messages: Array, parts: Map|object }} source
 *   - A storage root path (string) — walks message/ and part/ subdirs.
 *   - An in-memory fixture object { messages, parts } — used by tests.
 *   When source is a string, an optional sessionID can be appended after a
 *   pipe character: "/path/to/storage|ses_abc123" to restrict to one session.
 * @param {import('../types').TrimOptions} [options={}]
 * @returns {Promise<{
 *   messages: import('../types').CleanTurn[],
 *   stats: Partial<import('../types').TrimStats>,
 *   warnings: string[]
 * }>}
 */
async function parse(source, options = {}) {
  // In-memory fixture path (tests)
  if (source !== null && typeof source === 'object') {
    return _parseFromFixture(source, options);
  }

  if (typeof source !== 'string' || !source) {
    return {
      messages: [],
      stats: { originalBytes: 0, droppedCounts: {} },
      warnings: ['opencode adapter: source must be a storage root path or fixture object'],
    };
  }

  // Allow "storagePath|sessionID" to restrict to a single session
  let storageRoot = source;
  let sessionID;
  if (source.includes('|')) {
    const idx = source.indexOf('|');
    storageRoot = source.slice(0, idx);
    sessionID   = source.slice(idx + 1) || undefined;
  }

  return _parseFromDisk(storageRoot, sessionID, options);
}

module.exports = { parse };
