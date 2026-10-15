const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { OpenCodeAdapter } = require('../src/adapters/opencode');
const { createSession, createHighlights } = require('../src/types');

// ── Synthetic OpenCode database ───────────────────────────────────
// Tests read this temporary database, never the real opencode.db.

const ACTIVE_DATE = '2026-02-19';
const DEMO_FILE = 'E:\\projects\\demo-app\\src\\login-form.js';

// Local wall-clock time, so the 4 AM workday boundary holds in every time zone.
function localMs(month, day, hour, minute = 0) {
  return new Date(2026, month - 1, day, hour, minute).getTime();
}

function buildOpenCodeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fixture-'));
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER, project_id TEXT, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO project VALUES (?, ?)').run('proj-demo', 'E:\\projects\\demo-app');

  const insertSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)');
  insertSession.run('ses_demo', 'Login form validation', localMs(2, 19, 9), localMs(2, 19, 10), 'proj-demo', null);
  insertSession.run('ses_child', 'Sub-agent search', localMs(2, 19, 9, 10), localMs(2, 19, 9, 20), 'proj-demo', 'ses_demo');
  insertSession.run('ses_older', 'Older work', localMs(2, 10, 9), localMs(2, 10, 10), 'proj-demo', null);

  const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)');
  const addMessage = (id, sessionId, role, time, parts) => {
    insertMessage.run(id, sessionId, time, JSON.stringify({ role }));
    parts.forEach((part, index) => insertPart.run(`${id}-part-${index}`, id, time + index, JSON.stringify(part)));
  };

  addMessage('m1', 'ses_demo', 'user', localMs(2, 19, 9), [{ type: 'text', text: 'Fix the login form validation' }]);
  addMessage('m2', 'ses_demo', 'assistant', localMs(2, 19, 9, 2), [
    { type: 'tool', tool: 'read', state: { input: { filePath: DEMO_FILE } } },
    { type: 'tool', tool: 'edit', state: { input: { filePath: DEMO_FILE } } },
    { type: 'patch', files: [DEMO_FILE] },
    { type: 'text', text: 'Updated the email check.' },
  ]);
  addMessage('m3', 'ses_demo', 'user', localMs(2, 19, 9, 30), [{ type: 'text', text: '/compact' }]);
  addMessage('m4', 'ses_demo', 'user', localMs(2, 19, 9, 40), [{ type: 'text', text: 'Add a unit test for it' }]);
  addMessage('m5', 'ses_child', 'user', localMs(2, 19, 9, 10), [{ type: 'text', text: 'Search the src folder' }]);
  addMessage('m6', 'ses_older', 'user', localMs(2, 10, 9), [{ type: 'text', text: 'Plan the release notes' }]);
  db.close();
  return { root, dbPath };
}

const fixture = buildOpenCodeFixture();
after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

const adapter = new OpenCodeAdapter();
adapter.dbPath = fixture.dbPath;

// ── Activity Detection ────────────────────────────────────────────

describe('OpenCode activity detection', () => {
  it('returns true for a known active date', async () => {
    const active = await adapter.checkActivity(ACTIVE_DATE);
    assert.equal(active, true);
  });

  it('returns false for a date with no data', async () => {
    const active = await adapter.checkActivity('2020-01-01');
    assert.equal(active, false);
  });
});

// ── Session Extraction ────────────────────────────────────────────

describe('OpenCode session extraction', () => {
  it('returns non-empty array for known active date', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Expected at least one session');
    // The sub-agent session (parent_id set) and the older session are left out.
    assert.deepEqual(sessions.map(session => session.id), ['ses_demo']);
    assert.equal(sessions[0].project, 'E:\\projects\\demo-app');
    assert.equal(sessions[0].startTime.getTime(), localMs(2, 19, 9));
  });

  it('each session has correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    for (const session of sessions) {
      assert.equal(typeof session.id, 'string');
      assert.ok(session.id.length > 0, 'Session ID should be non-empty');
      assert.equal(session.agent, 'OpenCode');
      assert.equal(typeof session.project, 'string');
      assert.ok(session.startTime instanceof Date, 'startTime should be a Date');
      assert.ok(!isNaN(session.startTime.getTime()), 'startTime should be a valid Date');
    }
  });

  it('returns empty array for inactive date', async () => {
    const sessions = await adapter.extractSessions('2020-01-01');
    assert.deepEqual(sessions, []);
  });
});

// ── Highlight Extraction ──────────────────────────────────────────

describe('OpenCode highlight extraction', () => {
  it('extracts highlights with correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Need sessions for highlight test');

    const highlights = await adapter.extractHighlights(sessions[0]);
    const expected = createHighlights();
    const highlightKeys = Object.keys(highlights).sort();
    const expectedKeys = Object.keys(expected).sort();
    assert.deepEqual(highlightKeys, expectedKeys);
  });

  it('highlights contain user messages', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);

    // At least one session should have user messages
    let foundMessages = false;
    for (const session of sessions) {
      const highlights = await adapter.extractHighlights(session);
      if (highlights.userMessages.length > 0) {
        foundMessages = true;
        assert.equal(typeof highlights.topic, 'string');
        assert.ok(highlights.topic.length > 0, 'Topic should be non-empty');
        assert.deepEqual(highlights.userMessages, ['Fix the login form validation', 'Add a unit test for it']);
        break;
      }
    }
    assert.ok(foundMessages, 'At least one session should have user messages');
  });

  it('highlights extract tool calls with correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    let foundToolCalls = false;
    for (const session of sessions) {
      const highlights = await adapter.extractHighlights(session);
      if (highlights.toolCalls.length > 0) {
        foundToolCalls = true;
        for (const tc of highlights.toolCalls) {
          assert.equal(typeof tc.name, 'string');
          assert.equal(typeof tc.count, 'number');
          assert.ok(tc.count > 0);
        }
        assert.deepEqual(highlights.toolCalls.map(tc => tc.name).sort(), ['edit', 'read']);
        break;
      }
    }
    assert.ok(foundToolCalls, 'At least one session should have tool calls');
  });

  it('highlights extract file paths', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    let foundPaths = false;
    for (const session of sessions) {
      const highlights = await adapter.extractHighlights(session);
      if (highlights.filePaths.length > 0) {
        foundPaths = true;
        for (const fp of highlights.filePaths) {
          assert.equal(typeof fp, 'string');
          assert.ok(fp.length > 0);
        }
        assert.deepEqual(highlights.filePaths, [DEMO_FILE]);
        break;
      }
    }
    assert.ok(foundPaths, 'At least one session should have file paths');
  });

  it('returns empty highlights for nonexistent session', async () => {
    const fake = createSession({
      id: 'nonexistent-session-id',
      agent: 'OpenCode',
      project: 'Z:\\nonexistent',
      startTime: new Date(),
    });
    const highlights = await adapter.extractHighlights(fake);
    // No messages for nonexistent session — should return empty highlights
    assert.equal(highlights.userMessages.length, 0);
  });
});

// ── Sub-agent Filtering ───────────────────────────────────────────

describe('OpenCode sub-agent filtering', () => {
  // A fixed local noon keeps the sessions inside one 4 AM-to-4 AM workday.
  const SUBAGENT_DATE = '2026-04-21';
  const SUBAGENT_NOW = localMs(4, 21, 12);

  /**
   * Build a minimal in-memory SQLite DB with a session table that has a
   * parentID column.  Two sessions are inserted:
   *   - ses_child: parentID = 'ses_parent' → should be skipped
   *   - ses_main:  parentID = NULL          → should be kept
   */
  function buildTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        project_id TEXT,
        parentID TEXT
      );
    `);

    const now = SUBAGENT_NOW;
    const start = now - 3600_000; // 1 hour earlier

    db.prepare('INSERT INTO project VALUES (?, ?)').run('proj1', 'E:\\projects\\test');

    db.prepare(
      'INSERT INTO session (id, title, time_created, time_updated, project_id, parentID) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ses_child', 'Worker task', start, now, 'proj1', 'ses_parent');

    db.prepare(
      'INSERT INTO session (id, title, time_created, time_updated, project_id, parentID) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ses_main', 'Main task', start, now, 'proj1', null);

    return db;
  }

  it('skips a session with parentID set and keeps the main session', async () => {
    const isolated = new OpenCodeAdapter();

    // Inject our in-memory DB instead of reading from disk
    isolated._openDb = () => buildTestDb();

    const dateStr = SUBAGENT_DATE;

    const sessions = await isolated.extractSessions(dateStr);

    assert.equal(sessions.length, 1, `Expected only main session, got ${sessions.length}`);
    assert.equal(sessions[0].id, 'ses_main');
  });

  it('keeps all sessions when none have parentID set', async () => {
    const isolated = new OpenCodeAdapter();

    isolated._openDb = () => {
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          title TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          project_id TEXT
        );
      `);
      const now = SUBAGENT_NOW;
      const start = now - 3600_000;
      db.prepare('INSERT INTO project VALUES (?, ?)').run('proj1', 'E:\\projects\\test');
      db.prepare(
        'INSERT INTO session (id, title, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?)'
      ).run('ses_a', 'Task A', start, now, 'proj1');
      db.prepare(
        'INSERT INTO session (id, title, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?)'
      ).run('ses_b', 'Task B', start, now, 'proj1');
      return db;
    };

    const dateStr = SUBAGENT_DATE;

    const sessions = await isolated.extractSessions(dateStr);

    assert.equal(sessions.length, 2, `Expected both sessions, got ${sessions.length}`);
  });
});
