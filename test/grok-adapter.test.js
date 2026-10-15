const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { GrokAdapter } = require('../src/adapters/grok');
const { parse } = require('../src/trimmer/adapters/grok');

// Local wall-clock time, so the 4 AM-to-4 AM workday holds in every time zone.
function localIso(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-adapter-'));
  const sessionDir = path.join(root, 'sessions', encodeURIComponent('/projects/demo'), 'session-123');
  fs.mkdirSync(sessionDir, { recursive: true });

  const events = [
    { ts: localIso(2026, 7, 21, 10, 0), type: 'turn_started', turn_number: 0, session_relationship: 'primary' },
    { ts: localIso(2026, 7, 22, 10, 0), type: 'turn_started', turn_number: 1, session_relationship: 'primary' },
    { ts: localIso(2026, 7, 22, 11, 0), type: 'turn_started', turn_number: 2, session_relationship: 'primary' },
    { ts: localIso(2026, 7, 22, 12, 0), type: 'turn_started', turn_number: 3, session_relationship: 'subagent' },
  ];
  const chatHistory = [
    { type: 'system', content: 'internal system prompt' },
    { type: 'user', prompt_index: 0, content: [{ type: 'text', text: 'Start the report' }] },
    { type: 'reasoning', summary: 'private chain of thought' },
    { type: 'assistant', content: '', tool_calls: [{ name: 'shell' }] },
    { type: 'tool_result', content: 'large command output' },
    { type: 'assistant', content: 'I created the first report draft.' },
    { type: 'user', prompt_index: 1, content: [{ type: 'text', text: '<user_query> Continue and fix the totals </user_query>' }] },
    { type: 'assistant', content: 'I fixed the totals and verified the result.', tool_calls: [] },
    { type: 'user', prompt_index: 2, synthetic_reason: 'notification_drain', content: [{ type: 'text', text: 'internal notification' }] },
    { type: 'assistant', content: 'The background check finished.' },
    { type: 'user', prompt_index: 3, content: [{ type: 'text', text: 'Worker-only request' }] },
    { type: 'assistant', content: 'Worker-only response' },
  ];
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), chatHistory.map(JSON.stringify).join('\n') + '\n');
  return { root, sessionDir };
}

function fingerprint(filePath) {
  const stat = fs.statSync(filePath);
  return {
    mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
  };
}

describe('Grok daily visible dialogue parser', () => {
  it('returns only real user and visible assistant text for the requested day', async () => {
    const fixture = makeFixture();
    try {
      const result = await parse(fixture.sessionDir, { targetDate: '2026-07-22', includeTimestamps: true });
      assert.deepEqual(result.messages.map(turn => [turn.role, turn.content]), [
        ['user', 'Continue and fix the totals'],
        ['assistant', 'I fixed the totals and verified the result.'],
        ['assistant', 'The background check finished.'],
      ]);
      const serialized = JSON.stringify(result.messages);
      assert.ok(!serialized.includes('private chain'));
      assert.ok(!serialized.includes('command output'));
      assert.ok(!serialized.includes('internal notification'));
      assert.ok(!serialized.includes('Worker-only'));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('creates a separate slice for the earlier day of the same session', async () => {
    const fixture = makeFixture();
    try {
      const result = await parse(fixture.sessionDir, { targetDate: '2026-07-21', includeTimestamps: true });
      assert.deepEqual(result.messages.map(turn => turn.content), [
        'Start the report',
        'I created the first report draft.',
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not modify Grok source files', async () => {
    const fixture = makeFixture();
    const historyPath = path.join(fixture.sessionDir, 'chat_history.jsonl');
    const before = fingerprint(historyPath);
    try {
      await parse(fixture.sessionDir, { targetDate: '2026-07-22' });
      assert.deepEqual(fingerprint(historyPath), before);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('Grok adapter cross-day detection', () => {
  it('detects the same stable session on each day with real primary activity', async () => {
    const fixture = makeFixture();
    try {
      const adapter = new GrokAdapter({ name: 'Grok', storagePath: fixture.root, sessionsDir: 'sessions' });
      const firstDay = await adapter.extractSessions('2026-07-21');
      const secondDay = await adapter.extractSessions('2026-07-22');
      assert.equal(firstDay.length, 1);
      assert.equal(secondDay.length, 1);
      assert.equal(firstDay[0].id, secondDay[0].id);
      assert.equal(secondDay[0].project, '/projects/demo');
      assert.equal(secondDay[0].activityDate, '2026-07-22');
      assert.equal(secondDay[0].startTime.toISOString(), localIso(2026, 7, 22, 10, 0));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('ignores dates containing only synthetic or sub-agent turns', async () => {
    const fixture = makeFixture();
    try {
      const adapter = new GrokAdapter({ name: 'Grok', storagePath: fixture.root, sessionsDir: 'sessions' });
      assert.equal(await adapter.checkActivity('2026-07-23'), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
