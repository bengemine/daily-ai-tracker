const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getDateRange, isWithinDate, formatWorkDate } = require('../src/utils/date');
const { ClaudeCodeAdapter } = require('../src/adapters/claude-code');
const { createHighlights, createSession } = require('../src/types');

// ── Synthetic Claude Code storage ─────────────────────────────────
// Tests read this temporary folder, never the real ~/.claude folder.

const ACTIVE_DATE = '2026-03-13';
const DEMO_PROJECT = 'E:\\projects\\demo-app';
const SAMPLE_PROJECT = 'E:\\projects\\sample-project';
const MAIN_SESSION = '11111111-aaaa-4bbb-8ccc-000000000001';
const SKILL_SESSION = '11111111-aaaa-4bbb-8ccc-000000000002';
const OTHER_DAY_SESSION = '11111111-aaaa-4bbb-8ccc-000000000003';
const COMMAND_ONLY_SESSION = '11111111-aaaa-4bbb-8ccc-000000000004';
const GREETING_ONLY_SESSION = '11111111-aaaa-4bbb-8ccc-000000000005';
const RELAY_CHAIN_SESSION = '11111111-aaaa-4bbb-8ccc-000000000006';

// Local wall-clock time, so the 4 AM workday boundary holds in every time zone.
function localTime(month, day, hour, minute = 0) {
  return new Date(2026, month - 1, day, hour, minute);
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

function fixtureAdapter(storagePath) {
  return new ClaudeCodeAdapter({
    name: 'Claude Code',
    storagePath,
    historyFile: 'history.jsonl',
    projectsDir: 'projects',
  });
}

function userRow(sessionId, time, content) {
  return { type: 'user', timestamp: time.toISOString(), sessionId, message: { role: 'user', content } };
}

function assistantRow(sessionId, time, content) {
  return { type: 'assistant', timestamp: time.toISOString(), sessionId, message: { role: 'assistant', content } };
}

function toolUse(name, input) {
  return { type: 'tool_use', id: `tool-${name}`, name, input };
}

function buildClaudeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fixture-'));
  const projectsDir = path.join(root, 'projects');
  const demoDir = path.join(projectsDir, ClaudeCodeAdapter.encodeProjectPath(DEMO_PROJECT));
  const sampleDir = path.join(projectsDir, ClaudeCodeAdapter.encodeProjectPath(SAMPLE_PROJECT));

  writeJsonl(path.join(root, 'history.jsonl'), [
    { display: 'Plan the release notes', timestamp: localTime(3, 12, 15).getTime(), project: DEMO_PROJECT, sessionId: OTHER_DAY_SESSION },
    { display: 'Fix the login form validation', timestamp: localTime(3, 13, 9, 15).getTime(), project: DEMO_PROJECT, sessionId: MAIN_SESSION },
    { display: 'Also add a unit test for the empty email case', timestamp: localTime(3, 13, 9, 40).getTime(), project: DEMO_PROJECT, sessionId: MAIN_SESSION },
    { display: '/my-skill check the docs', timestamp: localTime(3, 13, 23, 30).getTime(), project: SAMPLE_PROJECT, sessionId: SKILL_SESSION },
    // 1:30 AM still belongs to the 2026-03-13 workday; 4 AM starts the next one.
    { display: 'Update the README install steps', timestamp: localTime(3, 14, 1, 30).getTime(), project: SAMPLE_PROJECT, sessionId: SKILL_SESSION },
    { display: 'Start the next task', timestamp: localTime(3, 14, 4).getTime(), project: DEMO_PROJECT, sessionId: OTHER_DAY_SESSION },
  ]);

  writeJsonl(path.join(demoDir, `${MAIN_SESSION}.jsonl`), [
    { type: 'system', subtype: 'init', sessionId: MAIN_SESSION },
    userRow(MAIN_SESSION, localTime(3, 13, 9, 15), 'Fix the login form validation'),
    assistantRow(MAIN_SESSION, localTime(3, 13, 9, 16), [
      { type: 'text', text: 'I will read the form first.' },
      toolUse('Read', { file_path: 'E:\\projects\\demo-app\\src\\login-form.js' }),
    ]),
    userRow(MAIN_SESSION, localTime(3, 13, 9, 17), [{ type: 'tool_result', tool_use_id: 'tool-Read', content: 'file text' }]),
    assistantRow(MAIN_SESSION, localTime(3, 13, 9, 18), [
      toolUse('Edit', { file_path: 'E:\\projects\\demo-app\\src\\login-form.js' }),
    ]),
    userRow(MAIN_SESSION, localTime(3, 13, 9, 40), 'Also add a unit test for the empty email case'),
    assistantRow(MAIN_SESSION, localTime(3, 13, 9, 41), [
      toolUse('Write', { file_path: 'E:\\projects\\demo-app\\test\\login-form.test.js' }),
      { type: 'text', text: 'Added the validation and a unit test.' },
    ]),
  ]);
  writeJsonl(path.join(demoDir, MAIN_SESSION, 'subagents', 'agent-a1.jsonl'), [
    assistantRow(MAIN_SESSION, localTime(3, 13, 9, 19), [toolUse('Grep', { path: 'E:\\projects\\demo-app\\src' })]),
  ]);

  writeJsonl(path.join(sampleDir, `${SKILL_SESSION}.jsonl`), [
    userRow(SKILL_SESSION, localTime(3, 13, 23, 30), '/my-skill check the docs'),
    userRow(SKILL_SESSION, localTime(3, 14, 1, 30), 'Update the README install steps'),
    assistantRow(SKILL_SESSION, localTime(3, 14, 1, 31), [{ type: 'text', text: 'Updated the install steps.' }]),
  ]);

  writeJsonl(path.join(demoDir, `${COMMAND_ONLY_SESSION}.jsonl`), [
    userRow(COMMAND_ONLY_SESSION, localTime(3, 25, 12, 16), '<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
    userRow(COMMAND_ONLY_SESSION, localTime(3, 25, 12, 16), '<local-command-stdout></local-command-stdout>'),
  ]);
  writeJsonl(path.join(sampleDir, `${GREETING_ONLY_SESSION}.jsonl`), [
    userRow(GREETING_ONLY_SESSION, localTime(3, 25, 17, 24), 'hi'),
    assistantRow(GREETING_ONLY_SESSION, localTime(3, 25, 17, 24), [{ type: 'text', text: 'Hello! How can I help?' }]),
    userRow(GREETING_ONLY_SESSION, localTime(3, 25, 17, 25), 'Hello!'),
  ]);
  writeJsonl(path.join(sampleDir, `${RELAY_CHAIN_SESSION}.jsonl`), [
    userRow(RELAY_CHAIN_SESSION, localTime(3, 26, 11, 55), 'You are generation 2 of a Vyrn relay chain 8ada.'),
    assistantRow(RELAY_CHAIN_SESSION, localTime(3, 26, 11, 55), [{ type: 'text', text: 'Ready.' }]),
  ]);

  return root;
}

const FIXTURE_ROOT = buildClaudeFixture();
after(() => fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

// ── Date Utilities ────────────────────────────────────────────────

describe('Date utilities', () => {
  it('getDateRange produces the 4 AM-to-4 AM workday range', () => {
    const { start, end } = getDateRange('2026-03-13');
    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth(), 2); // 0-indexed
    assert.equal(start.getDate(), 13);
    assert.equal(start.getHours(), 4);
    assert.equal(start.getMinutes(), 0);
    assert.equal(start.getSeconds(), 0);

    assert.equal(end.getFullYear(), 2026);
    assert.equal(end.getMonth(), 2);
    assert.equal(end.getDate(), 14);
    assert.equal(end.getHours(), 4);
  });

  it('isWithinDate handles ms epoch timestamps', () => {
    const range = getDateRange('2026-03-13');
    // Midnight March 13 — inside
    const insideMs = new Date(2026, 2, 13, 12, 0, 0).getTime();
    assert.equal(isWithinDate(insideMs, range), true);

    // 4 AM March 14 — outside
    const outsideMs = new Date(2026, 2, 14, 4, 0, 0).getTime();
    assert.equal(isWithinDate(outsideMs, range), false);
  });

  it('isWithinDate handles ISO 8601 string timestamps', () => {
    const range = getDateRange('2026-03-13');
    // Build ISO strings from local dates to avoid timezone mismatch
    const insideDate = new Date(2026, 2, 13, 10, 30, 0);
    assert.equal(isWithinDate(insideDate.toISOString(), range), true);

    const outsideDate = new Date(2026, 2, 13, 3, 59, 59);
    assert.equal(isWithinDate(outsideDate.toISOString(), range), false);
  });

  it('start is inclusive, end is exclusive', () => {
    const range = getDateRange('2026-03-13');
    assert.equal(isWithinDate(range.start.getTime(), range), true);
    assert.equal(isWithinDate(range.end.getTime(), range), false);
  });

  it('assigns midnight through 3:59 AM to the previous workday', () => {
    assert.equal(formatWorkDate(new Date(2026, 2, 14, 0, 0, 0)), '2026-03-13');
    assert.equal(formatWorkDate(new Date(2026, 2, 14, 3, 59, 59)), '2026-03-13');
    assert.equal(formatWorkDate(new Date(2026, 2, 14, 4, 0, 0)), '2026-03-14');
  });
});

// ── Adapter instance (shared, read-only) ──────────────────────────

const adapter = fixtureAdapter(FIXTURE_ROOT);

async function findSessionsWithFiles(dateStr = ACTIVE_DATE) {
  const allSessions = await adapter.extractSessions(dateStr);
  return allSessions.filter(session => {
    const resolved = adapter._resolveSessionFile(session.id, session.project);
    return resolved.matches.length > 0 && fs.existsSync(resolved.filePath);
  });
}

// ── Activity Detection ────────────────────────────────────────────

describe('Activity detection', () => {
  it('returns true for a known active date (2026-03-13)', async () => {
    const active = await adapter.checkActivity(ACTIVE_DATE);
    assert.equal(active, true);
  });

  it('returns false for a date with no data (2020-01-01)', async () => {
    const active = await adapter.checkActivity('2020-01-01');
    assert.equal(active, false);
  });
});

// ── Slash Command Filtering ───────────────────────────────────────

describe('Slash command filtering', () => {
  it('does not exclude slash commands from session discovery', () => {
    // Slash commands should NOT be filtered at the history/session-discovery level.
    // They are only filtered later during highlight extraction (_shouldSkipUserMessage).
    // This ensures sessions that start with a skill invocation (e.g. /my-skill)
    // are still discovered and tracked.
    const entries = adapter._readHistory();
    const range = getDateRange(ACTIVE_DATE);
    const allInRange = entries.filter(e => isWithinDate(e.timestamp, range));
    const filtered = adapter._filterHistory(entries, ACTIVE_DATE);

    assert.ok(allInRange.length > 0, 'Expected entries in date range');
    assert.ok(allInRange.some(e => e.display.startsWith('/')), 'Fixture should have a slash command in range');
    assert.strictEqual(filtered.length, allInRange.length,
      'filterHistory should keep all entries including slash commands');
  });

  it('skips slash commands during highlight extraction', () => {
    assert.ok(ClaudeCodeAdapter._shouldSkipUserMessage('/help'));
    assert.ok(ClaudeCodeAdapter._shouldSkipUserMessage('/my-skill some text'));
    assert.ok(!ClaudeCodeAdapter._shouldSkipUserMessage('normal message'));
  });

  it('detects trivial non-task prompts', () => {
    assert.ok(ClaudeCodeAdapter._isTrivialUserMessage('hi'));
    assert.ok(ClaudeCodeAdapter._isTrivialUserMessage('Hello!'));
    assert.ok(ClaudeCodeAdapter._isTrivialUserMessage('You'));
    assert.ok(ClaudeCodeAdapter._isTrivialUserMessage('You are generation 2 of a Vyrn relay chain 8ada.'));
    assert.ok(!ClaudeCodeAdapter._isTrivialUserMessage('hi, can you debug this issue?'));
    assert.ok(!ClaudeCodeAdapter._isTrivialUserMessage('review this PR'));
  });
});

// ── Path Encoding ─────────────────────────────────────────────────

describe('Path encoding', () => {
  it('encodes C:\\Users\\jdoe correctly', () => {
    assert.equal(
      ClaudeCodeAdapter.encodeProjectPath('C:\\Users\\jdoe'),
      'C--Users-jdoe'
    );
  });

  it('encodes E:\\websites\\example.ca correctly', () => {
    assert.equal(
      ClaudeCodeAdapter.encodeProjectPath('E:\\websites\\example.ca'),
      'E--websites-example-ca'
    );
  });

  it('handles forward slashes', () => {
    assert.equal(
      ClaudeCodeAdapter.encodeProjectPath('C:/Users/jdoe'),
      'C--Users-jdoe'
    );
  });

  it('handles paths with spaces', () => {
    assert.equal(
      ClaudeCodeAdapter.encodeProjectPath('C:\\Program Files\\App'),
      'C--Program-Files-App'
    );
  });
});

// ── Session Extraction ────────────────────────────────────────────

describe('Session extraction', () => {
  it('returns non-empty array for known active date', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Expected at least one session');
    assert.deepEqual(sessions.map(s => s.id).sort(), [MAIN_SESSION, SKILL_SESSION]);
    assert.equal(sessions.find(s => s.id === MAIN_SESSION).project, DEMO_PROJECT);
  });

  it('each session has correct shape', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    for (const session of sessions) {
      // UUID format: 8-4-4-4-12 hex
      assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        `Session ID should be UUID format, got: ${session.id}`);
      assert.equal(session.agent, 'Claude Code');
      assert.equal(typeof session.project, 'string');
      assert.ok(session.project.length > 0, 'Project path should be non-empty');
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

describe('Highlight extraction', () => {
  let sessionsWithFiles = [];

  it('setup: find sessions with on-disk files', async () => {
    sessionsWithFiles = await findSessionsWithFiles();
    assert.equal(sessionsWithFiles.length, 2, 'Both fixture sessions should resolve to files');
  });

  it('extracts non-empty highlights from a session with a file', async () => {
    if (sessionsWithFiles.length === 0) sessionsWithFiles = await findSessionsWithFiles();
    const mainSession = sessionsWithFiles.find(session => session.id === MAIN_SESSION);
    const highlights = await adapter.extractHighlights(mainSession);

    assert.ok(highlights.topic.length > 0, 'Topic should be non-empty');
    assert.ok(highlights.userMessages.length > 0, 'Should have user messages');
    assert.equal(highlights.topic, 'Fix the login form validation');
    assert.deepEqual(highlights.userMessages, [
      'Fix the login form validation',
      'Also add a unit test for the empty email case',
    ]);
  });

  it('skips the slash command but keeps the real request in a skill session', async () => {
    if (sessionsWithFiles.length === 0) sessionsWithFiles = await findSessionsWithFiles();
    const skillSession = sessionsWithFiles.find(session => session.id === SKILL_SESSION);
    const highlights = await adapter.extractHighlights(skillSession);

    assert.equal(highlights.topic, 'Update the README install steps');
    assert.deepEqual(highlights.userMessages, ['Update the README install steps']);
    assert.deepEqual(highlights.toolCalls, []);
  });

  it('highlights contain tool call data', async () => {
    if (sessionsWithFiles.length === 0) sessionsWithFiles = await findSessionsWithFiles();

    // Check across all sessions with files — at least one should have tool calls
    let foundToolCalls = false;
    for (const session of sessionsWithFiles) {
      const highlights = await adapter.extractHighlights(session);
      if (highlights.toolCalls.length > 0) {
        foundToolCalls = true;
        // Verify shape of tool call entries
        for (const tc of highlights.toolCalls) {
          assert.equal(typeof tc.name, 'string');
          assert.equal(typeof tc.count, 'number');
          assert.ok(tc.count > 0);
        }
        break;
      }
    }
    assert.ok(foundToolCalls, 'At least one session should have tool calls');
  });

  it('highlights contain file paths array', async () => {
    if (sessionsWithFiles.length === 0) sessionsWithFiles = await findSessionsWithFiles();

    // At least one session should have file paths
    let foundPaths = false;
    for (const session of sessionsWithFiles) {
      const highlights = await adapter.extractHighlights(session);
      assert.ok(Array.isArray(highlights.filePaths), 'filePaths should be an array');
      if (highlights.filePaths.length > 0) {
        foundPaths = true;
        for (const fp of highlights.filePaths) {
          assert.equal(typeof fp, 'string');
        }
        break;
      }
    }
    assert.ok(foundPaths, 'At least one session should have file paths');
  });

  it('treats command-only Claude sessions as empty highlights', async () => {
    const session = createSession({
      id: COMMAND_ONLY_SESSION,
      agent: 'Claude Code',
      project: DEMO_PROJECT,
      startTime: localTime(3, 25, 12, 16),
    });
    assert.ok(fs.existsSync(adapter._getExactSessionFile(session.id, session.project).filePath));

    const highlights = await adapter.extractHighlights(session);

    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
  });

  it('treats greeting-only Claude sessions as empty highlights', async () => {
    const session = createSession({
      id: GREETING_ONLY_SESSION,
      agent: 'Claude Code',
      project: SAMPLE_PROJECT,
      startTime: localTime(3, 25, 17, 24),
    });
    assert.ok(fs.existsSync(adapter._getExactSessionFile(session.id, session.project).filePath));

    const highlights = await adapter.extractHighlights(session);

    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
  });

  it('treats relay-chain bootstrap sessions as empty highlights', async () => {
    const session = createSession({
      id: RELAY_CHAIN_SESSION,
      agent: 'Claude Code',
      project: SAMPLE_PROJECT,
      startTime: localTime(3, 26, 11, 55),
    });
    assert.ok(fs.existsSync(adapter._getExactSessionFile(session.id, session.project).filePath));

    const highlights = await adapter.extractHighlights(session);

    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
  });
});

// ── Missing Session Files ─────────────────────────────────────────

describe('Missing session file resilience', () => {
  it('returns empty highlights for a session with no on-disk file', async () => {
    const { createSession } = require('../src/types');
    // Fabricate a session pointing to a file that doesn't exist
    const fakeSession = createSession({
      id: '00000000-0000-0000-0000-000000000000',
      agent: 'Claude Code',
      project: 'C:\\nonexistent\\project',
      startTime: new Date(),
    });

    const highlights = await adapter.extractHighlights(fakeSession);

    // Should return empty highlights, not throw
    assert.equal(highlights.topic, '');
    assert.deepEqual(highlights.userMessages, []);
    assert.deepEqual(highlights.toolCalls, []);
    assert.deepEqual(highlights.filePaths, []);
    assert.deepEqual(highlights.lastExchanges, []);
  });

  it('finds a session file by ID when Claude uses a different encoded project folder', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fallback-'));
    try {
      const isolated = fixtureAdapter(tmpDir);

      const session = createSession({
        id: '11111111-2222-3333-4444-555555555555',
        agent: 'Claude Code',
        project: 'E:\\projects\\Notes&Scripts\\daily-ai-tracker',
        startTime: new Date('2026-04-15T10:00:00'),
      });

      const actualDir = path.join(isolated.projectsDir, 'E--projects-Notes-Scripts-daily-ai-tracker');
      fs.mkdirSync(actualDir, { recursive: true });
      fs.writeFileSync(
        path.join(actualDir, `${session.id}.jsonl`),
        JSON.stringify({
          type: 'user',
          message: { content: 'Repair Claude Code tracker data' },
        }) + '\n',
        'utf-8'
      );

      const highlights = await isolated.extractHighlights(session);

      assert.equal(highlights.topic, 'Repair Claude Code tracker data');
      assert.deepEqual(highlights.userMessages, ['Repair Claude Code tracker data']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips malformed, null, and NUL-containing JSONL lines', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-'));
    try {
      const isolated = fixtureAdapter(tmpDir);

      const session = createSession({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        agent: 'Claude Code',
        project: 'C:\\repo\\example',
        startTime: new Date('2026-04-01T10:00:00'),
      });

      const exact = isolated._getExactSessionFile(session.id, session.project);
      fs.mkdirSync(exact.projectDir, { recursive: true });
      fs.writeFileSync(
        exact.filePath,
        [
          JSON.stringify({ type: 'user', message: { content: 'First valid task' } }),
          '\u0000\u0000{"type":"user","message":{"content":"corrupt task"}}',
          '{"type":"user","message":',
          'null',
          JSON.stringify({ type: 'user', message: { content: 'Second valid task' } }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const highlights = await isolated.extractHighlights(session);

      assert.equal(highlights.topic, 'First valid task');
      assert.deepEqual(highlights.userMessages, ['First valid task', 'Second valid task']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Non-string Content Handling ───────────────────────────────────

describe('Non-string content handling', () => {
  it('_extractUserText handles string content', () => {
    assert.equal(ClaudeCodeAdapter._extractUserText('hello'), 'hello');
  });

  it('_extractUserText handles array content with text blocks', () => {
    const content = [
      { type: 'text', text: 'first part' },
      { type: 'tool_result', content: 'ignored' },
      { type: 'text', text: 'second part' },
    ];
    const result = ClaudeCodeAdapter._extractUserText(content);
    assert.equal(result, 'first part\nsecond part');
  });

  it('_extractUserText returns empty string for non-text arrays', () => {
    const content = [{ type: 'tool_result', content: 'data' }];
    assert.equal(ClaudeCodeAdapter._extractUserText(content), '');
  });

  it('_extractUserText returns empty string for null/undefined', () => {
    assert.equal(ClaudeCodeAdapter._extractUserText(null), '');
    assert.equal(ClaudeCodeAdapter._extractUserText(undefined), '');
  });
});

// ── Subagent Discovery ────────────────────────────────────────────

describe('Subagent discovery', () => {
  it('subagent scan does not throw for sessions without subagents', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0, 'Need at least one session');

    // This should not throw regardless of whether subagent data exists
    for (const session of sessions) {
      await assert.doesNotReject(
        () => adapter.extractHighlights(session),
        'extractHighlights should not throw even without subagent data'
      );
    }
  });

  it('adds tool calls and file paths from subagent files to the main session', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    const highlights = await adapter.extractHighlights(sessions.find(s => s.id === MAIN_SESSION));

    assert.deepEqual(
      highlights.toolCalls.map(tc => tc.name).sort(),
      ['Edit', 'Grep', 'Read', 'Write']
    );
    assert.ok(highlights.filePaths.includes('E:\\projects\\demo-app\\src'), 'Subagent Grep path should be included');
  });
});

// ── Highlights Type Shape ─────────────────────────────────────────

describe('Highlights type shape', () => {
  it('returned highlights have all expected fields', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    assert.ok(sessions.length > 0);

    const highlights = await adapter.extractHighlights(sessions[0]);
    const expected = createHighlights();

    // Same set of keys
    const highlightKeys = Object.keys(highlights).sort();
    const expectedKeys = Object.keys(expected).sort();
    assert.deepEqual(highlightKeys, expectedKeys,
      `Highlights keys should match type: got [${highlightKeys}], expected [${expectedKeys}]`);

    // Type checks
    assert.equal(typeof highlights.topic, 'string');
    assert.ok(Array.isArray(highlights.userMessages));
    assert.ok(Array.isArray(highlights.toolCalls));
    assert.ok(Array.isArray(highlights.filePaths));
    assert.ok(Array.isArray(highlights.lastExchanges));
  });

  it('createHighlights() with no args produces valid defaults', () => {
    const empty = createHighlights();
    assert.equal(empty.topic, '');
    assert.deepEqual(empty.userMessages, []);
    assert.deepEqual(empty.toolCalls, []);
    assert.deepEqual(empty.filePaths, []);
    assert.deepEqual(empty.lastExchanges, []);
  });

  it('no extra undocumented fields on highlights', async () => {
    const sessions = await adapter.extractSessions(ACTIVE_DATE);
    const highlights = await adapter.extractHighlights(sessions[0]);
    const allowedKeys = new Set(['topic', 'userMessages', 'toolCalls', 'filePaths', 'lastExchanges']);

    for (const key of Object.keys(highlights)) {
      assert.ok(allowedKeys.has(key), `Unexpected key "${key}" on highlights — boundary contract violation`);
    }
  });
});

// ── Sub-agent Defense-in-Depth ────────────────────────────────────

describe('Claude Code sub-agent defense-in-depth', () => {
  it('returns empty highlights when the first JSONL entry has isSidechain=true', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sidechain-'));
    try {
      const isolated = fixtureAdapter(tmpDir);

      const session = createSession({
        id: 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',
        agent: 'Claude Code',
        project: 'E:\\projects\\test',
        startTime: new Date('2026-04-21T10:00:00'),
      });

      const exact = isolated._getExactSessionFile(session.id, session.project);
      fs.mkdirSync(exact.projectDir, { recursive: true });

      // Write a JSONL file whose first entry has isSidechain=true — this is a
      // sub-agent sidechain file that should be rejected entirely.
      fs.writeFileSync(
        exact.filePath,
        [
          JSON.stringify({
            type: 'user',
            isSidechain: true,
            message: { content: 'sub-agent task not for journal' },
          }),
          JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            message: { content: [{ type: 'text', text: 'sub-agent reply' }] },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const highlights = await isolated.extractHighlights(session);

      // The sidechain guard should fire before any content is extracted
      assert.equal(highlights.topic, '', 'Topic should be empty for sidechain session');
      assert.deepEqual(highlights.userMessages, [], 'No user messages should be extracted from sidechain');
      assert.deepEqual(highlights.toolCalls, []);
      assert.deepEqual(highlights.filePaths, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('filters out isSidechain=true entries mixed into an otherwise normal session', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mixed-'));
    try {
      const isolated = fixtureAdapter(tmpDir);

      const session = createSession({
        id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        agent: 'Claude Code',
        project: 'E:\\projects\\mixed',
        startTime: new Date('2026-04-21T11:00:00'),
      });

      const exact = isolated._getExactSessionFile(session.id, session.project);
      fs.mkdirSync(exact.projectDir, { recursive: true });

      // Normal first entry (no isSidechain) followed by a sidechain entry
      // The sidechain entry should be stripped from relevant[] without the
      // top-level guard triggering (which only fires on entries[0]).
      fs.writeFileSync(
        exact.filePath,
        [
          JSON.stringify({
            type: 'user',
            message: { content: 'real user task' },
          }),
          JSON.stringify({
            type: 'user',
            isSidechain: true,
            message: { content: 'sidechain leak should not appear' },
          }),
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'assistant reply' }] },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const highlights = await isolated.extractHighlights(session);

      // Only the non-sidechain user message should appear
      assert.equal(highlights.topic, 'real user task');
      assert.deepEqual(highlights.userMessages, ['real user task'],
        'Sidechain leak entry must be filtered out');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('_findSessionFilesById does not descend into subagents/ directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagents-'));
    try {
      const isolated = fixtureAdapter(tmpDir);

      const sessionId = 'eeeeeeee-ffff-0000-1111-222222222222';

      // Normal project dir — should be found
      const normalDir = path.join(isolated.projectsDir, 'E--projects-main');
      fs.mkdirSync(normalDir, { recursive: true });
      fs.writeFileSync(path.join(normalDir, `${sessionId}.jsonl`), '{}', 'utf-8');

      // subagents/ dir — the same file name inside it should NOT be found
      const subagentsDir = path.join(isolated.projectsDir, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, `${sessionId}.jsonl`), '{}', 'utf-8');

      const matches = isolated._findSessionFilesById(sessionId);

      // Only the one in normalDir should be returned
      assert.equal(matches.length, 1, `Expected 1 match, got ${matches.length}: ${JSON.stringify(matches)}`);
      assert.ok(matches[0].includes('E--projects-main'), `Expected match to be in normal dir, got: ${matches[0]}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
