const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CodexAdapter } = require('../src/adapters/codex');
const { createSession, createHighlights } = require('../src/types');

// ── Synthetic Codex storage ────────────────────────────────────────────────
// Tests read this temporary folder, never the real ~/.codex folder.

const ACTIVE_DATE = '2026-03-13';
const TOOL_DATE = '2026-03-16';
const DEMO_PROJECT = 'E:\\projects\\demo-app';
const TRACKER_PROJECT = 'E:\\projects\\daily-ai-tracker';
const DEMO_SESSION = '019a0000-0000-7000-8000-000000000001';
const TRACKER_SESSION = '019a0000-0000-7000-8000-000000000002';

// Local wall-clock time, so the 4 AM workday boundary holds in every time zone.
function localIso(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

function codexAdapterFor(storagePath) {
  return new CodexAdapter({ name: 'Codex', storagePath, historyFile: 'history.jsonl' });
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

function userInput(timestamp, text) {
  return { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}

function functionCall(timestamp, name, args) {
  return { timestamp, type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: `call-${name}` } };
}

function buildCodexFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fixture-'));
  const toSeconds = iso => Math.floor(Date.parse(iso) / 1000);

  writeJsonl(path.join(root, 'history.jsonl'), [
    { session_id: DEMO_SESSION, ts: toSeconds(localIso(2026, 3, 12, 16)), text: 'Plan the release notes' },
    { session_id: DEMO_SESSION, ts: toSeconds(localIso(2026, 3, 13, 9, 1)), text: 'Fix the login form validation' },
    { session_id: DEMO_SESSION, ts: toSeconds(localIso(2026, 3, 13, 9, 30)), text: 'Run the tests again' },
    { session_id: TRACKER_SESSION, ts: toSeconds(localIso(2026, 3, 16, 14)), text: 'Add a CSV export to the tracker' },
  ]);

  writeJsonl(path.join(root, 'sessions', '2026', '03', '13', `rollout-2026-03-13T09-00-00-${DEMO_SESSION}.jsonl`), [
    { timestamp: localIso(2026, 3, 13, 9), type: 'session_meta', payload: { id: DEMO_SESSION, cwd: DEMO_PROJECT, source: 'cli' } },
    { timestamp: localIso(2026, 3, 13, 9), type: 'turn_context', payload: { cwd: DEMO_PROJECT } },
    userInput(localIso(2026, 3, 13, 9, 0, 1), `<environment_context>\n  <cwd>${DEMO_PROJECT}</cwd>\n</environment_context>`),
    userInput(localIso(2026, 3, 13, 9, 1), 'Fix the login form validation'),
    { timestamp: localIso(2026, 3, 13, 9, 1), type: 'event_msg', payload: { type: 'user_message', message: 'Fix the login form validation' } },
    { timestamp: localIso(2026, 3, 13, 9, 5), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the email check.' }] } },
    userInput(localIso(2026, 3, 13, 9, 30), 'Run the tests again'),
  ]);

  writeJsonl(path.join(root, 'sessions', '2026', '03', '16', `rollout-2026-03-16T14-00-00-${TRACKER_SESSION}.jsonl`), [
    { timestamp: localIso(2026, 3, 16, 14), type: 'session_meta', payload: { id: TRACKER_SESSION, cwd: TRACKER_PROJECT, source: 'cli' } },
    userInput(localIso(2026, 3, 16, 14, 0, 1), 'Add a CSV export to the tracker'),
    functionCall(localIso(2026, 3, 16, 14, 1), 'shell', { command: ['npm', 'test'], workdir: TRACKER_PROJECT }),
    functionCall(localIso(2026, 3, 16, 14, 2), 'shell', { command: ['git', 'status'], workdir: TRACKER_PROJECT }),
    functionCall(localIso(2026, 3, 16, 14, 3), 'read_file', { path: `${TRACKER_PROJECT}\\src\\journal.js` }),
    { timestamp: localIso(2026, 3, 16, 14, 4), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added the export.' }] } },
  ]);

  return root;
}

const FIXTURE_ROOT = buildCodexFixture();
after(() => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

const adapter = codexAdapterFor(FIXTURE_ROOT);

describe('Codex timestamp handling', () => {
  it('converts seconds to milliseconds in _readHistory', () => {
    const entries = adapter._readHistory();
    assert.ok(entries.length > 0, 'Expected history entries');

    for (const entry of entries.slice(0, 5)) {
      assert.ok(typeof entry.tsMs === 'number', 'tsMs should be a number');
      assert.ok(entry.tsMs > 1_000_000_000_000, `tsMs should be milliseconds, got ${entry.tsMs}`);
      assert.ok(entry.ts < 100_000_000_000, `ts should be seconds, got ${entry.ts}`);
      assert.equal(entry.tsMs, entry.ts * 1000);
    }
  });

  it('filtering uses millisecond timestamps correctly', () => {
    const entries = adapter._readHistory();
    const filtered = adapter._filterHistory(entries, ACTIVE_DATE);
    assert.equal(filtered.length, 2, 'Expected the two fixture entries for 2026-03-13');

    for (const entry of filtered) {
      const date = new Date(entry.tsMs);
      assert.equal(date.getFullYear(), 2026);
      assert.equal(date.getMonth(), 2);
      assert.equal(date.getDate(), 13);
    }
  });
});

describe('Codex activity detection', () => {
  it('returns true for a known active date (2026-03-13)', async () => {
    const active = await adapter.checkActivity(ACTIVE_DATE);
    assert.equal(active, true);
  });

  it('returns false for a date with no data (2020-01-01)', async () => {
    const active = await adapter.checkActivity('2020-01-01');
    assert.equal(active, false);
  });

  it('treats EACCES/EPERM day-directory scans as missing roots', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-denied-'));
    try {
      const isolated = codexAdapterFor(tmpBase);

      const originalReaddirSync = fs.readdirSync;
      fs.readdirSync = function patchedReaddirSync(target, options) {
        if (String(target).includes(path.join('sessions', '2026', '03', '13'))) {
          const err = new Error('permission denied');
          err.code = fs.readdirSync.__testCode || 'EACCES';
          throw err;
        }
        return originalReaddirSync.call(fs, target, options);
      };

      try {
        for (const code of ['EACCES', 'EPERM']) {
          fs.readdirSync.__testCode = code;
          const files = isolated._getSessionFilesForDate('2026-03-13');
          assert.deepEqual(files, [], `Expected empty list for ${code}`);
        }
      } finally {
        delete fs.readdirSync.__testCode;
        fs.readdirSync = originalReaddirSync;
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('Codex session grouping', () => {
  it('finds a session on a later activity date even when its file is under the creation date', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cross-day-'));
    const creationDir = path.join(tmpBase, 'sessions', '2026', '07', '21');
    fs.mkdirSync(creationDir, { recursive: true });
    const filePath = path.join(creationDir, 'rollout-cross-day-session.jsonl');
    const lines = [
      {
        timestamp: localIso(2026, 7, 21, 10),
        type: 'session_meta',
        payload: { id: 'cross-day-session', cwd: '/projects/demo' },
      },
      {
        timestamp: localIso(2026, 7, 21, 10, 1),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First-day request' }] },
      },
      {
        timestamp: localIso(2026, 7, 22, 11),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continued request' }] },
      },
      {
        timestamp: localIso(2026, 7, 22, 11, 5),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continued reply' }] },
      },
    ];
    fs.writeFileSync(filePath, lines.map(JSON.stringify).join('\n') + '\n');

    try {
      const isolated = codexAdapterFor(tmpBase);
      const sessions = await isolated.extractSessions('2026-07-22');
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, 'cross-day-session');
      assert.equal(sessions[0].activityDate, '2026-07-22');
      assert.equal(sessions[0].startTime.toISOString(), localIso(2026, 7, 22, 11));
      assert.equal(sessions[0].filePath, filePath);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('extracts current Codex output_text assistant replies', async () => {
    const raw = [
      JSON.stringify({
        timestamp: localIso(2026, 7, 22, 10),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'User request' }] },
      }),
      JSON.stringify({
        timestamp: localIso(2026, 7, 22, 10, 1),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible assistant reply' }] },
      }),
    ].join('\n');
    const { trimTranscript } = require('../src/trimmer');
    const result = await trimTranscript(raw, 'codex');
    assert.deepEqual(result.messages.map(turn => turn.content), ['User request', 'Visible assistant reply']);
  });

  it('groups entries by session file/session id', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Expected at least one session');
    assert.deepEqual(sessions.map(s => s.id), [DEMO_SESSION]);

    const ids = sessions.map(s => s.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'Session IDs should be unique');
  });

  it('each session has correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    for (const session of sessions) {
      assert.equal(typeof session.id, 'string');
      assert.ok(session.id.length > 0);
      assert.equal(session.agent, 'Codex');
      assert.equal(typeof session.project, 'string');
      assert.ok(session.startTime instanceof Date);
      assert.ok(!isNaN(session.startTime.getTime()));
    }
  });

  it('preserves real working directory when available', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);
    assert.ok(
      sessions.some(session => session.project === DEMO_PROJECT),
      'Expected the session_meta cwd as the project path'
    );
  });

  it('returns empty array for inactive date', async () => {
    const sessions = await adapter.extractSessions('2020-01-01');
    assert.deepEqual(sessions, []);
  });
});

describe('Codex highlight extraction', () => {
  it('extracts highlights with correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);

    const highlights = await adapter.extractHighlights(sessions[0]);
    const expected = createHighlights();
    assert.deepEqual(Object.keys(highlights).sort(), Object.keys(expected).sort());
  });

  it('highlights have user messages from session logs', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);

    let foundMessages = false;
    for (const session of sessions) {
      const highlights = await adapter.extractHighlights(session);
      if (highlights.userMessages.length > 0) {
        foundMessages = true;
        assert.equal(typeof highlights.topic, 'string');
        assert.ok(highlights.topic.length > 0, 'Topic should be non-empty');
        // The <environment_context> block is skipped; duplicate event_msg copies collapse.
        assert.deepEqual(highlights.userMessages, ['Fix the login form validation', 'Run the tests again']);
        break;
      }
    }
    assert.ok(foundMessages, 'At least one session should have user messages');
  });

  it('extracts tool calls and file paths when present in session logs', async () => {
    const sessions = await adapter.extractSessions(TOOL_DATE);
    assert.ok(sessions.length > 0);

    const trackerSession = sessions.find(session => session.project === TRACKER_PROJECT);
    assert.ok(trackerSession, 'Expected a Codex session for daily-ai-tracker on 2026-03-16');

    const highlights = await adapter.extractHighlights(trackerSession);
    assert.ok(highlights.toolCalls.length > 0, 'Expected tool calls extracted from Codex session logs');
    assert.deepEqual(highlights.toolCalls, [{ name: 'shell', count: 2 }, { name: 'read_file', count: 1 }]);
    assert.ok(highlights.filePaths.some(fp => fp.includes(TRACKER_PROJECT)));
  });

  it('returns empty highlights for nonexistent session', async () => {
    const fake = createSession({
      id: 'nonexistent-session-id',
      agent: 'Codex',
      project: '(codex)',
      startTime: new Date(),
    });
    const highlights = await adapter.extractHighlights(fake);
    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
  });
});

// ── Sub-agent filtering ────────────────────────────────────────────────────

describe('Codex sub-agent filtering', () => {
  /**
   * Build a temporary session directory with JSONL files and return a
   * CodexAdapter whose storagePath points to it.
   */
  function buildTempAdapter(dateStr, sessionFiles) {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
    const [year, month, day] = dateStr.split('-');
    const dayDir = path.join(tmpBase, 'sessions', year, month, day);
    fs.mkdirSync(dayDir, { recursive: true });

    for (const { name, lines } of sessionFiles) {
      fs.writeFileSync(
        path.join(dayDir, name),
        lines.map(l => JSON.stringify(l)).join('\n') + '\n',
        'utf-8'
      );
    }

    // Point the adapter at the temp directory
    const tmpAdapter = codexAdapterFor(tmpBase);
    // historyFile must exist or _readHistory will warn; point it at /dev/null equivalent
    fs.writeFileSync(tmpAdapter.historyFile, '', 'utf-8');

    return { adapter: tmpAdapter, tmpBase };
  }

  function cleanup(tmpBase) {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  it('filters out a session with source.subagent (sub-agent)', async () => {
    const dateStr = '2026-04-20';
    const subAgentMeta = {
      timestamp: localIso(2026, 4, 20, 10),
      type: 'session_meta',
      payload: {
        id: 'sub-agent-session-id',
        cwd: 'E:\\test',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'parent-abc',
              depth: 1,
              agent_role: 'worker',
            },
          },
        },
      },
    };
    const userEntry = {
      timestamp: localIso(2026, 4, 20, 10, 0, 1),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'do some work' },
    };

    const { adapter, tmpBase } = buildTempAdapter(dateStr, [
      {
        name: 'rollout-2026-04-20T10-00-00-sub-agent.jsonl',
        lines: [subAgentMeta, userEntry],
      },
    ]);

    const sessions = await adapter.extractSessions(dateStr);
    assert.equal(sessions.length, 0, 'Sub-agent session should be filtered out');

    cleanup(tmpBase);
  });

  it('keeps a main session with source="exec"', async () => {
    const dateStr = '2026-04-20';
    const mainMeta = {
      timestamp: localIso(2026, 4, 20, 10),
      type: 'session_meta',
      payload: {
        id: 'main-exec-session-id',
        cwd: 'E:\\projects\\MyProject',
        source: 'exec',
      },
    };
    const userEntry = {
      timestamp: localIso(2026, 4, 20, 10, 0, 1),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'build the feature' },
    };

    const { adapter, tmpBase } = buildTempAdapter(dateStr, [
      {
        name: 'rollout-2026-04-20T10-00-00-main.jsonl',
        lines: [mainMeta, userEntry],
      },
    ]);

    const sessions = await adapter.extractSessions(dateStr);
    assert.equal(sessions.length, 1, 'Main session should be kept');
    assert.equal(sessions[0].id, 'main-exec-session-id');

    cleanup(tmpBase);
  });

  it('keeps a file with no session_meta (older format) to avoid false positives', async () => {
    const dateStr = '2026-04-20';
    const userEntry = {
      timestamp: localIso(2026, 4, 20, 10, 0, 1),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hello from old format' },
    };

    const { adapter, tmpBase } = buildTempAdapter(dateStr, [
      {
        name: 'rollout-2026-04-20T10-00-00-old.jsonl',
        lines: [userEntry],
      },
    ]);

    const sessions = await adapter.extractSessions(dateStr);
    assert.equal(sessions.length, 1, 'Old-format session without session_meta should be kept');

    cleanup(tmpBase);
  });

  it('filters sub-agents but keeps main sessions when both are present', async () => {
    const dateStr = '2026-04-21';
    const subMeta = {
      timestamp: localIso(2026, 4, 21, 9),
      type: 'session_meta',
      payload: {
        id: 'sub-111',
        cwd: 'E:\\test',
        source: { subagent: {} },
      },
    };
    const mainMeta = {
      timestamp: localIso(2026, 4, 21, 9, 1),
      type: 'session_meta',
      payload: {
        id: 'main-222',
        cwd: 'E:\\projects\\RealWork',
        source: 'tui',
      },
    };
    const mainUser = {
      timestamp: localIso(2026, 4, 21, 9, 1, 1),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'real main-session request' },
    };

    const { adapter, tmpBase } = buildTempAdapter(dateStr, [
      { name: 'rollout-sub.jsonl', lines: [subMeta] },
      { name: 'rollout-main.jsonl', lines: [mainMeta, mainUser] },
    ]);

    const sessions = await adapter.extractSessions(dateStr);
    assert.equal(sessions.length, 1, 'Only the main session should survive');
    assert.equal(sessions[0].id, 'main-222');

    cleanup(tmpBase);
  });
});
