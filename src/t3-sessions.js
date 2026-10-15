'use strict';

/**
 * T3 Code detection — which Claude/Codex sessions were started from T3 Code.
 *
 * T3 Code drives Claude (Agent SDK) and Codex (app-server) itself. Their raw
 * transcripts still land in ~/.claude/projects and ~/.codex/sessions, so the
 * normal adapters read them. Two independent proofs mark a T3 session:
 *   1. T3's database links a T3 thread to the session ID (also gives the title).
 *   2. The transcript holds T3's runtime note in an app-controlled place.
 *
 * T3 keeps its state in a WAL-mode SQLite file. Reading it in place over the
 * \\wsl.localhost share is unreliable, so we copy the DB and WAL to a temp
 * folder and read the copy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Keys in resume_cursor_json that hold the provider's own session/thread ID.
// Claude uses `resume`; Codex uses its thread ID, which is also the rollout ID.
const CURSOR_ID_KEYS = ['resume', 'sessionId', 'threadId', 'conversationId', 'rolloutId'];

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function copyDatabase(dbPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-state-'));
  const copyPath = path.join(tempDir, 'state.sqlite');
  fs.copyFileSync(dbPath, copyPath);
  if (fs.existsSync(`${dbPath}-wal`)) fs.copyFileSync(`${dbPath}-wal`, `${copyPath}-wal`);
  return { tempDir, copyPath };
}

function readRows(db) {
  return db.prepare(`
    SELECT r.thread_id AS threadId,
           r.provider_name AS provider,
           r.resume_cursor_json AS cursorJson,
           s.provider_session_id AS providerSessionId,
           s.provider_thread_id AS providerThreadId,
           t.title AS title,
           p.title AS projectTitle,
           p.workspace_root AS workspaceRoot
      FROM provider_session_runtime r
      LEFT JOIN projection_thread_sessions s ON s.thread_id = r.thread_id
      LEFT JOIN projection_threads t ON t.thread_id = r.thread_id
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
  `).all();
}

/**
 * @param {{ stateDbPath?: string }} t3Config
 * @returns {Map<string, { threadId: string, title: string|null, provider: string|null, projectTitle: string|null, workspaceRoot: string|null }>}
 *   Keyed by lower-case provider session ID. Empty when T3 is absent or unreadable.
 */
function loadT3SessionMap(t3Config) {
  const map = new Map();
  const dbPath = t3Config?.stateDbPath;
  if (!dbPath || !fs.existsSync(dbPath)) return map;

  let copy;
  let db;
  try {
    copy = copyDatabase(dbPath);
    db = new DatabaseSync(copy.copyPath);
    for (const row of readRows(db)) {
      const cursor = parseJson(row.cursorJson) || {};
      const ids = [
        row.providerSessionId,
        row.providerThreadId,
        ...CURSOR_ID_KEYS.map(key => cursor[key]),
      ];
      const info = {
        threadId: row.threadId,
        title: row.title || null,
        provider: row.provider || null,
        projectTitle: row.projectTitle || null,
        workspaceRoot: row.workspaceRoot || null,
      };
      for (const id of ids) {
        // The cursor's threadId is T3's own thread ID for Claude; it never
        // matches a transcript, so mapping it is harmless.
        if (typeof id === 'string' && UUID_RE.test(id)) map.set(id.toLowerCase(), info);
      }
    }
  } catch (err) {
    console.warn(`[warn] T3 Code sessions not read from ${dbPath}: ${err.message}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    if (copy) fs.rmSync(copy.tempDir, { recursive: true, force: true });
  }
  return map;
}

// T3 Code adds this note to every chat it starts ("... running in T3 Code
// through the Claude Code harness", "... the Codex harness", ...).
const T3_RUNTIME_MARKER = 'you are running in T3 Code through the ';

function isT3RuntimeRow(parserName, row) {
  // Claude: T3 appends the note to the system prompt, which Claude saves in a
  // prompt_snapshot attachment. Typed chat text never lands there.
  if (parserName === 'claude-code') {
    return row.type === 'attachment' && row.attachment?.type === 'prompt_snapshot' &&
      JSON.stringify(row.attachment.systemPrompt ?? '').includes(T3_RUNTIME_MARKER);
  }
  // Codex: T3 sends turn/start.additionalContext.t3_code_runtime, which Codex
  // saves as a developer message. Only the launching app sends developer messages.
  if (parserName === 'codex') {
    const payload = row.type === 'response_item' ? row.payload : null;
    return payload?.type === 'message' && payload.role === 'developer' &&
      JSON.stringify(payload.content ?? '').includes(T3_RUNTIME_MARKER);
  }
  return false;
}

/**
 * True when a Claude/Codex transcript chunk carries T3 Code's runtime note in
 * the app-controlled place (system prompt or developer message).
 * @param {string} parserName
 * @param {string} text - raw JSONL
 */
function hasT3RuntimeMarker(parserName, text) {
  if (!String(text || '').includes(T3_RUNTIME_MARKER)) return false;
  for (const line of String(text).split('\n')) {
    if (!line.includes(T3_RUNTIME_MARKER)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (isT3RuntimeRow(parserName, row)) return true;
  }
  return false;
}

module.exports = { loadT3SessionMap, hasT3RuntimeMarker, T3_RUNTIME_MARKER };
