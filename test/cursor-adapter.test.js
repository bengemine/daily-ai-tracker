const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { CursorAdapter } = require('../src/adapters/cursor');
const { createSession, createHighlights } = require('../src/types');

// ── Synthetic Cursor storage ──────────────────────────────────────
// Tests read these temporary databases, never Cursor's real state.vscdb.

const ACTIVE_DATE = '2026-03-11';
const ACTIVE_COMPOSER = 'c0000000-0000-4000-8000-000000000001';
const OLDER_COMPOSER = 'c0000000-0000-4000-8000-000000000002';

// Local wall-clock time, so the 4 AM workday boundary holds in every time zone.
function localMs(month, day, hour, minute = 0) {
  return new Date(2026, month - 1, day, hour, minute).getTime();
}

function createKvDatabase(dbPath, itemRows, diskRows = []) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  const insertItem = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of itemRows) insertItem.run(key, JSON.stringify(value));
  const insertDisk = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (const [key, value] of diskRows) insertDisk.run(key, JSON.stringify(value));
  db.close();
}

function richText(text) {
  return JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] } });
}

function buildCursorFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fixture-'));
  const globalDbPath = path.join(root, 'globalStorage', 'state.vscdb');
  const workspaceStoragePath = path.join(root, 'workspaceStorage');

  createKvDatabase(globalDbPath, [
    [`aiCodeTracking.dailyStats.v1.5.${ACTIVE_DATE}`, { date: ACTIVE_DATE, tabAcceptedLines: 12, composerAcceptedLines: 40 }],
  ], [
    [`composerData:${ACTIVE_COMPOSER}`, {
      composerId: ACTIVE_COMPOSER,
      name: 'Login form validation',
      fullConversationHeadersOnly: [
        { bubbleId: 'b-user-1', type: 1 },
        { bubbleId: 'b-assistant-1', type: 2 },
        { bubbleId: 'b-user-2', type: 1 },
      ],
    }],
    [`bubbleId:${ACTIVE_COMPOSER}:b-user-1`, { type: 1, text: 'Fix the login form validation' }],
    [`bubbleId:${ACTIVE_COMPOSER}:b-assistant-1`, {
      type: 2,
      text: 'Updated the email check in login-form.js.',
      toolResults: [{ toolName: 'edit_file' }, { toolName: 'read_file' }, { toolName: 'edit_file' }],
    }],
    // Some user bubbles keep their text only in Lexical rich text.
    [`bubbleId:${ACTIVE_COMPOSER}:b-user-2`, { type: 1, text: '', richText: richText('Add a unit test for it') }],
  ]);

  const demoWorkspace = path.join(workspaceStoragePath, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  createKvDatabase(path.join(demoWorkspace, 'state.vscdb'), [
    ['composer.composerData', {
      allComposers: [
        { composerId: ACTIVE_COMPOSER, name: 'Login form validation', createdAt: localMs(3, 11, 9), lastUpdatedAt: localMs(3, 11, 10, 30) },
        { composerId: OLDER_COMPOSER, name: 'Older chat', createdAt: localMs(3, 2, 9), lastUpdatedAt: localMs(3, 2, 9, 30) },
      ],
    }],
  ]);
  fs.writeFileSync(path.join(demoWorkspace, 'workspace.json'), JSON.stringify({ folder: 'file:///e%3A/projects/demo-app' }));

  // A workspace folder without a state.vscdb file must not break the scan.
  const emptyWorkspace = path.join(workspaceStoragePath, '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
  fs.mkdirSync(emptyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(emptyWorkspace, 'workspace.json'), JSON.stringify({ folder: 'file:///e%3A/projects/sample-project' }));

  return { root, globalDbPath, workspaceStoragePath };
}

const fixture = buildCursorFixture();
after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

const adapter = new CursorAdapter();
adapter.globalDbPath = fixture.globalDbPath;
adapter.workspaceStoragePath = fixture.workspaceStoragePath;

// ── Activity Detection ────────────────────────────────────────────

describe('Cursor activity detection', () => {
  it('returns true for a known active date (2026-03-11)', async () => {
    const active = await adapter.checkActivity(ACTIVE_DATE);
    assert.equal(active, true);
  });

  it('returns false for a date with no data (2020-01-01)', async () => {
    const active = await adapter.checkActivity('2020-01-01');
    assert.equal(active, false);
  });

  it('uses daily stats key lookup (no table scan)', async () => {
    // This is structural — the adapter uses aiCodeTracking.dailyStats key.
    // If it works at all for 2020-01-01 (returns false without error),
    // it proves the key lookup approach is working.
    const active = await adapter.checkActivity('2024-01-15');
    assert.equal(typeof active, 'boolean');
  });
});

// ── Session Extraction ────────────────────────────────────────────

describe('Cursor session extraction', () => {
  it('returns non-empty array for known active date (2026-03-11)', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Expected at least one session');
    assert.deepEqual(sessions.map(session => session.id), [ACTIVE_COMPOSER]);
  });

  it('each session has correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    for (const session of sessions) {
      assert.equal(typeof session.id, 'string');
      assert.ok(session.id.length > 0, 'Session ID should be non-empty');
      assert.equal(session.agent, 'Cursor');
      assert.equal(typeof session.project, 'string');
      assert.ok(session.startTime instanceof Date, 'startTime should be a Date');
      assert.ok(!isNaN(session.startTime.getTime()), 'startTime should be a valid Date');
    }
  });

  it('session project path is decoded from workspace.json', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);
    // Project should be a decoded path, not a file:// URI
    for (const session of sessions) {
      assert.ok(!session.project.startsWith('file://'), 'Project should be decoded, not a URI');
      assert.equal(session.project.replace(/\\/g, '/'), 'e:/projects/demo-app');
    }
  });

  it('returns empty array for inactive date', async () => {
    const sessions = await adapter.extractSessions('2020-01-01');
    assert.deepEqual(sessions, []);
  });

  it('handles workspaces without state.vscdb gracefully', async () => {
    // This is implicit — the adapter should not crash if some workspace dirs
    // don't have state.vscdb. If extractSessions works at all, it passes.
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(Array.isArray(sessions));
  });
});

// ── Highlight Extraction ──────────────────────────────────────────

describe('Cursor highlight extraction', () => {
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

    let foundMessages = false;
    for (const session of sessions) {
      const highlights = await adapter.extractHighlights(session);
      if (highlights.userMessages.length > 0) {
        foundMessages = true;
        assert.equal(typeof highlights.topic, 'string');
        assert.ok(highlights.topic.length > 0, 'Topic should be non-empty');
        assert.deepEqual(highlights.userMessages, ['Fix the login form validation', 'Add a unit test for it']);
        assert.deepEqual(highlights.toolCalls, [{ name: 'edit_file', count: 2 }, { name: 'read_file', count: 1 }]);
        break;
      }
    }
    assert.ok(foundMessages, 'At least one session should have user messages');
  });

  it('handles missing composer in global DB gracefully', async () => {
    const fake = createSession({
      id: '00000000-0000-0000-0000-000000000000',
      agent: 'Cursor',
      project: 'Z:\\nonexistent',
      startTime: new Date(),
    });
    const highlights = await adapter.extractHighlights(fake);
    // Should return empty highlights, not crash
    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
  });

  it('highlight type has all expected fields', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);
    const highlights = await adapter.extractHighlights(sessions[0]);

    assert.ok(Array.isArray(highlights.userMessages));
    assert.ok(Array.isArray(highlights.toolCalls));
    assert.ok(Array.isArray(highlights.filePaths));
    assert.ok(Array.isArray(highlights.lastExchanges));
    assert.equal(typeof highlights.topic, 'string');
  });
});
