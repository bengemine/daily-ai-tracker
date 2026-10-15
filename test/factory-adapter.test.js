const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FactoryAdapter } = require('../src/adapters/factory');
const { createSession, createHighlights } = require('../src/types');

// ── Synthetic Factory storage ─────────────────────────────────────
// Tests read this temporary folder, never the real ~/.factory folder.

const ACTIVE_DATE = '2026-03-11';
const DEMO_PROJECT = 'E:\\projects\\demo-app';
const PROJECT_SESSION = 'f0000000-0000-4000-8000-000000000001';
const LOOSE_SESSION = 'f0000000-0000-4000-8000-000000000002';
const OLDER_SESSION = 'f0000000-0000-4000-8000-000000000003';

// Local wall-clock time, so the 4 AM workday boundary holds in every time zone.
function localIso(month, day, hour, minute = 0) {
  return new Date(2026, month - 1, day, hour, minute).toISOString();
}

function factoryAdapterFor(sessionsDir) {
  const factoryAdapter = new FactoryAdapter();
  factoryAdapter.storagePath = path.dirname(sessionsDir);
  factoryAdapter.sessionsDir = sessionsDir;
  return factoryAdapter;
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

function buildFactoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fixture-'));
  const sessionsDir = path.join(root, 'sessions');
  const projectDir = path.join(sessionsDir, FactoryAdapter.encodeProjectPath(DEMO_PROJECT));

  writeJsonl(path.join(projectDir, `${PROJECT_SESSION}.jsonl`), [
    { type: 'session_start', id: PROJECT_SESSION, title: 'Login form validation', cwd: DEMO_PROJECT },
    { type: 'message', timestamp: localIso(3, 11, 9), message: { role: 'user', content: [
      { type: 'text', text: '<system-reminder>Working directory listing and system info</system-reminder>' },
      { type: 'text', text: 'Fix the login form validation' },
    ] } },
    { type: 'message', timestamp: localIso(3, 11, 9, 2), message: { role: 'assistant', content: [
      { type: 'text', text: 'Reading the form first.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'E:\\projects\\demo-app\\src\\login-form.js' } },
      { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: 'E:\\projects\\demo-app\\src\\login-form.js' } },
    ] } },
    { type: 'message', timestamp: localIso(3, 11, 9, 5), message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } },
  ]);

  // Older Factory versions wrote loose session files without a session_start line.
  writeJsonl(path.join(sessionsDir, `${LOOSE_SESSION}.jsonl`), [
    { type: 'message', timestamp: localIso(3, 11, 15), message: { role: 'user',
      content: '<system-reminder>Directory listing</system-reminder>\nUpdate the README install steps' } },
    { type: 'message', timestamp: localIso(3, 11, 15, 1), message: { role: 'assistant', content: [{ type: 'text', text: 'Updated the steps.' }] } },
  ]);

  writeJsonl(path.join(projectDir, `${OLDER_SESSION}.jsonl`), [
    { type: 'session_start', id: OLDER_SESSION, title: 'Older work', cwd: DEMO_PROJECT },
    { type: 'message', timestamp: localIso(3, 2, 10), message: { role: 'user', content: 'Plan the release notes' } },
  ]);

  return { root, sessionsDir };
}

const fixture = buildFactoryFixture();
after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

const adapter = factoryAdapterFor(fixture.sessionsDir);

// ── Path Encoding ─────────────────────────────────────────────────

describe('Factory path encoding', () => {
  it('encodes E:\\websites\\example.ca correctly', () => {
    assert.equal(
      FactoryAdapter.encodeProjectPath('E:\\websites\\example.ca'),
      '-E-websites-example.ca'
    );
  });

  it('preserves dots in path', () => {
    const encoded = FactoryAdapter.encodeProjectPath('E:\\my.project\\sub.dir');
    assert.ok(encoded.includes('.'), 'Dots should be preserved');
    assert.equal(encoded, '-E-my.project-sub.dir');
  });

  it('preserves ampersands', () => {
    assert.equal(
      FactoryAdapter.encodeProjectPath('E:\\projects\\Notes&Scripts'),
      '-E-projects-Notes&Scripts'
    );
  });

  it('handles C:\\WINDOWS\\system32', () => {
    assert.equal(
      FactoryAdapter.encodeProjectPath('C:\\WINDOWS\\system32'),
      '-C-WINDOWS-system32'
    );
  });

  it('handles paths with spaces', () => {
    assert.equal(
      FactoryAdapter.encodeProjectPath('E:\\My Project'),
      '-E-My Project'
    );
  });

  it('differs from Claude Code encoding', () => {
    // Claude Code: E--websites-example-ca (dots replaced)
    // Factory:     -E-websites-example.ca (dots preserved, - prefix)
    const factoryEncoded = FactoryAdapter.encodeProjectPath('E:\\websites\\example.ca');
    assert.notEqual(factoryEncoded, 'E--websites-example-ca');
  });
});

// ── Activity Detection ────────────────────────────────────────────

describe('Factory activity detection', () => {
  it('returns true for a known active date (2026-03-11)', async () => {
    const active = await adapter.checkActivity(ACTIVE_DATE);
    assert.equal(active, true);
  });

  it('returns false for a date with no data (2020-01-01)', async () => {
    const active = await adapter.checkActivity('2020-01-01');
    assert.equal(active, false);
  });
});

// ── Session Extraction ────────────────────────────────────────────

describe('Factory session extraction', () => {
  it('returns non-empty array for known active date', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Expected at least one session');
    assert.deepEqual(sessions.map(session => session.id).sort(), [PROJECT_SESSION, LOOSE_SESSION]);
    const projectSession = sessions.find(session => session.id === PROJECT_SESSION);
    assert.equal(projectSession.project, DEMO_PROJECT);
    assert.equal(projectSession.startTime.toISOString(), localIso(3, 11, 9));
  });

  it('each session has correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    for (const session of sessions) {
      assert.equal(typeof session.id, 'string');
      assert.ok(session.id.length > 0, 'Session ID should be non-empty');
      assert.equal(session.agent, 'Factory');
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

// ── System-Reminder Stripping ─────────────────────────────────────

describe('Factory system-reminder stripping', () => {
  it('strips <system-reminder> blocks from text', () => {
    const input = '<system-reminder>long system info here</system-reminder>\nActual user message';
    const result = FactoryAdapter._stripSystemReminder(input);
    assert.equal(result, 'Actual user message');
    assert.ok(!result.includes('<system-reminder>'));
  });

  it('returns text unchanged when no system-reminder', () => {
    assert.equal(FactoryAdapter._stripSystemReminder('hello world'), 'hello world');
  });

  it('_extractUserText filters system-reminder blocks from arrays', () => {
    const content = [
      { type: 'text', text: '<system-reminder>noise</system-reminder>' },
      { type: 'text', text: 'real user message' },
    ];
    const result = FactoryAdapter._extractUserText(content);
    assert.equal(result, 'real user message');
  });

  it('_extractUserText handles string content with system-reminder', () => {
    const text = '<system-reminder>info</system-reminder> actual question';
    const result = FactoryAdapter._extractUserText(text);
    assert.equal(result, 'actual question');
  });
});

// ── Highlight Extraction ──────────────────────────────────────────

describe('Factory highlight extraction', () => {
  it('extracts highlights with correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Need sessions for highlight test');

    const highlights = await adapter.extractHighlights(sessions[0]);
    const expected = createHighlights();
    const highlightKeys = Object.keys(highlights).sort();
    const expectedKeys = Object.keys(expected).sort();
    assert.deepEqual(highlightKeys, expectedKeys);
  });

  it('highlights topic does not contain system-reminder', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);

    for (const session of sessions) {
      const highlights = await adapter.extractHighlights(session);
      assert.ok(
        !highlights.topic.includes('<system-reminder>'),
        `Topic should not contain system-reminder: ${highlights.topic.slice(0, 50)}`
      );
    }
    const topics = await Promise.all(sessions.map(async session => (await adapter.extractHighlights(session)).topic));
    assert.deepEqual(topics.sort(), ['Fix the login form validation', 'Update the README install steps']);
  });

  it('returns empty highlights for nonexistent session', async () => {
    const fake = createSession({
      id: '00000000-0000-0000-0000-000000000000',
      agent: 'Factory',
      project: 'Z:\\nonexistent',
      startTime: new Date(),
    });
    const highlights = await adapter.extractHighlights(fake);
    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
  });

  it('highlights tool calls have correct shape', async () => {
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
        assert.deepEqual(highlights.toolCalls.map(tc => tc.name).sort(), ['Edit', 'Read']);
        assert.deepEqual(highlights.filePaths, ['E:\\projects\\demo-app\\src\\login-form.js']);
        break;
      }
    }
    assert.ok(foundToolCalls, 'At least one session should have tool calls');
  });
});

// ── Sub-agent Filtering ───────────────────────────────────────────

describe('Factory sub-agent filtering', () => {
  it('skips a session whose session_start has callingSessionId set', async () => {
    // Build a temporary sessions directory with two fixture files:
    //   1. sub-agent.jsonl  — session_start has callingSessionId (should be skipped)
    //   2. main.jsonl       — normal session_start (should be included)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-filter-'));
    try {
      const isolated = factoryAdapterFor(tmpDir);

      const ts = new Date('2026-04-21T10:00:00').toISOString();

      // Sub-agent session file
      const subAgentContent = [
        JSON.stringify({
          type: 'session_start',
          id: 'sub-session-001',
          cwd: 'E:\\projects\\worker',
          callingSessionId: 'parent-session-xyz',
          timestamp: ts,
        }),
        JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: 'worker task' } }),
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(tmpDir, 'sub-agent.jsonl'), subAgentContent, 'utf-8');

      // Normal main session file
      const mainContent = [
        JSON.stringify({
          type: 'session_start',
          id: 'main-session-001',
          cwd: 'E:\\projects\\main',
          timestamp: ts,
        }),
        JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: 'real task' } }),
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(tmpDir, 'main.jsonl'), mainContent, 'utf-8');

      const sessions = await isolated.extractSessions('2026-04-21');

      // Only the main session should survive
      assert.equal(sessions.length, 1, `Expected 1 session, got ${sessions.length}`);
      assert.equal(sessions[0].id, 'main-session-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips a session whose session_start has decompSessionType=worker', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-filter-decomp-'));
    try {
      const isolated = factoryAdapterFor(tmpDir);

      const ts = new Date('2026-04-21T11:00:00').toISOString();

      const workerContent = [
        JSON.stringify({
          type: 'session_start',
          id: 'decomp-worker-001',
          cwd: 'E:\\projects\\worker',
          decompSessionType: 'worker',
          timestamp: ts,
        }),
        JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: 'decomp worker task' } }),
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(tmpDir, 'worker.jsonl'), workerContent, 'utf-8');

      const sessions = await isolated.extractSessions('2026-04-21');

      assert.equal(sessions.length, 0, `Expected 0 sessions after filtering worker, got ${sessions.length}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT skip a session whose session_start has only parent set (user fork)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-filter-fork-'));
    try {
      const isolated = factoryAdapterFor(tmpDir);

      const ts = new Date('2026-04-21T12:00:00').toISOString();

      const forkContent = [
        JSON.stringify({
          type: 'session_start',
          id: 'fork-session-001',
          cwd: 'E:\\projects\\forked',
          parent: 'original-session-abc',
          timestamp: ts,
        }),
        JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: 'forked user task' } }),
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(tmpDir, 'fork.jsonl'), forkContent, 'utf-8');

      const sessions = await isolated.extractSessions('2026-04-21');

      assert.equal(sessions.length, 1, `Expected fork session to be kept, got ${sessions.length}`);
      assert.equal(sessions[0].id, 'fork-session-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
