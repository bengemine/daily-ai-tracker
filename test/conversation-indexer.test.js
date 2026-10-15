const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  indexJsonlSource,
  indexGrokSource,
  indexOpenCodeDatabase,
  readAppendedLines,
  migrateConversationStore,
} = require('../src/conversation-indexer');
const { readConversationArtifactsForDate } = require('../src/conversation-artifacts');

// Local wall-clock time, so the 4 AM-to-4 AM workday holds in every time zone.
function localIso(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function claudeTurn(type, timestamp, text, extra = {}) {
  return {
    type,
    timestamp,
    sessionId: 'session-123',
    cwd: '/projects/demo',
    message: { role: type, content: [{ type: 'text', text }, ...(extra.blocks || [])] },
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-indexer-'));
  const sourceDir = path.join(root, 'raw');
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(sourceDir, { recursive: true });
  const filePath = path.join(sourceDir, 'session-123.jsonl');
  const initial = [
    claudeTurn('user', localIso(2026, 7, 21, 10, 0), 'Start the report'),
    claudeTurn('assistant', localIso(2026, 7, 21, 10, 1), 'I prepared the report', {
      blocks: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'tool_use', name: 'shell' }],
    }),
  ].map(line).join('');
  fs.writeFileSync(filePath, initial);
  return {
    root,
    outputDir,
    filePath,
    initial,
    descriptor: {
      type: 'jsonl',
      parserName: 'claude-code',
      agent: 'Claude Code',
      id: 'session-123',
      project: '/projects/demo',
      filePath,
    },
  };
}

describe('deterministic conversation indexer', () => {
  it('bootstraps a raw JSONL source into canonical and dated clean files', async () => {
    const fixture = makeFixture();
    try {
      const result = await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.equal(result.bytesRead, Buffer.byteLength(fixture.initial));
      const records = readConversationArtifactsForDate('2026-07-21', fixture.outputDir);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].messages.map(turn => [turn.role, turn.content]), [
        ['user', 'Start the report'],
        ['assistant', 'I prepared the report'],
      ]);
      const serialized = JSON.stringify(records[0]);
      assert.ok(!serialized.includes('hidden reasoning'));
      assert.ok(!serialized.includes('tool_use'));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('migrates existing canonical files without rereading raw sources', () => {
    const fixture = makeFixture();
    try {
      const sessionDir = path.join(fixture.outputDir, 'conversations', 'claude-code', 'session-123');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'canonical.json'), JSON.stringify({
        version: 1,
        session: { id: 'session-123', agent: 'Claude Code', project: '/projects/demo' },
        messages: [
          { role: 'user', content: 'Real request', timestamp: localIso(2026, 7, 21, 10, 0) },
          { role: 'user', content: '<task-notification>noise</task-notification>', timestamp: localIso(2026, 7, 21, 10, 0, 1) },
          { role: 'assistant', content: 'Real reply', timestamp: localIso(2026, 7, 21, 10, 1) },
        ],
      }));
      fs.writeFileSync(path.join(sessionDir, '.source-state.json'), '{}');

      const result = migrateConversationStore(fixture.outputDir);
      assert.equal(result.migrated, 1);
      assert.equal(result.removedTurns, 1);
      const stored = readConversationArtifactsForDate('2026-07-21', fixture.outputDir);
      assert.deepEqual(stored[0].messages.map(turn => turn.content), ['Real request', 'Real reply']);
      assert.equal(migrateConversationStore(fixture.outputDir).migrated, 0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reads only appended bytes and preserves earlier clean days', async () => {
    const fixture = makeFixture();
    try {
      await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      const appended = [
        claudeTurn('user', localIso(2026, 7, 22, 11, 0), 'Continue the report'),
        claudeTurn('assistant', localIso(2026, 7, 22, 11, 1), 'I finished the report'),
      ].map(line).join('');
      fs.appendFileSync(fixture.filePath, appended);

      const result = await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.equal(result.bytesRead, Buffer.byteLength(appended));
      assert.equal(readConversationArtifactsForDate('2026-07-21', fixture.outputDir).length, 1);
      const secondDay = readConversationArtifactsForDate('2026-07-22', fixture.outputDir);
      assert.deepEqual(secondDay[0].messages.map(turn => turn.content), [
        'Continue the report',
        'I finished the report',
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps continuous after-midnight work on the preceding workday until 4 AM', async () => {
    const fixture = makeFixture();
    try {
      const source = [
        claudeTurn('user', new Date(2026, 6, 22, 23, 50).toISOString(), 'Start late-night work'),
        claudeTurn('assistant', new Date(2026, 6, 23, 0, 10).toISOString(), 'I continued after midnight'),
        claudeTurn('user', new Date(2026, 6, 23, 4, 0).toISOString(), 'Start the new workday'),
        claudeTurn('assistant', new Date(2026, 6, 23, 4, 1).toISOString(), 'The new workday started'),
      ].map(line).join('');
      fs.writeFileSync(fixture.filePath, source);

      await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.deepEqual(
        readConversationArtifactsForDate('2026-07-22', fixture.outputDir)[0].messages.map(turn => turn.content),
        ['Start late-night work', 'I continued after midnight']
      );
      assert.deepEqual(
        readConversationArtifactsForDate('2026-07-23', fixture.outputDir)[0].messages.map(turn => turn.content),
        ['Start the new workday', 'The new workday started']
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not read message bytes again when a source is unchanged', async () => {
    const fixture = makeFixture();
    try {
      await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      const result = await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.equal(result.changed, false);
      assert.equal(result.bytesRead, 0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('excludes headless Claude queue sessions that were not visible interactive chats', async () => {
    const fixture = makeFixture();
    try {
      fs.writeFileSync(fixture.filePath, [
        { type: 'queue-operation', sessionId: 'session-123', operation: 'enqueue' },
        claudeTurn('user', localIso(2026, 7, 21, 10, 0), 'You are an internal routing model'),
        claudeTurn('assistant', localIso(2026, 7, 21, 10, 1), '{"route":"internal"}'),
      ].map(line).join(''));
      const result = await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.equal(result.excluded, true);
      assert.equal(readConversationArtifactsForDate('2026-07-21', fixture.outputDir).length, 0);
      const state = JSON.parse(fs.readFileSync(path.join(
        fixture.outputDir, 'conversations', 'claude-code', 'session-123', '.source-state.json'
      ), 'utf8'));
      assert.equal(state.exclusionReason, 'claude-headless-queue-operation');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reclassifies an unchanged Claude source written by an older indexer', async () => {
    const fixture = makeFixture();
    try {
      const headless = [
        { type: 'queue-operation', sessionId: 'session-123', operation: 'enqueue' },
        claudeTurn('user', localIso(2026, 7, 21, 10, 0), 'Internal scheduled prompt'),
        claudeTurn('assistant', localIso(2026, 7, 21, 10, 1), 'Internal scheduled result'),
      ].map(line).join('');
      fs.writeFileSync(fixture.filePath, headless);
      const oldCursor = readAppendedLines(fixture.filePath, {}).state;
      const sessionDir = path.join(fixture.outputDir, 'conversations', 'claude-code', 'session-123');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, '.source-state.json'), JSON.stringify({
        version: 1,
        format: 'claude-code',
        cursor: oldCursor,
      }));

      const result = await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.equal(result.excluded, true);
      assert.equal(result.bytesRead, Buffer.byteLength(headless));
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, '.source-state.json'), 'utf8'));
      assert.equal(state.classificationVersion, 2);
      assert.equal(state.excluded, true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rebuilds the session and removes stale days after source truncation', async () => {
    const fixture = makeFixture();
    try {
      await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      const replacement = [
        claudeTurn('user', localIso(2026, 7, 23, 9, 0), 'Replacement request'),
        claudeTurn('assistant', localIso(2026, 7, 23, 9, 1), 'Replacement reply'),
      ].map(line).join('');
      fs.writeFileSync(fixture.filePath, replacement);

      await indexJsonlSource(fixture.descriptor, fixture.outputDir);
      assert.equal(readConversationArtifactsForDate('2026-07-21', fixture.outputDir).length, 0);
      assert.equal(readConversationArtifactsForDate('2026-07-23', fixture.outputDir).length, 1);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('holds an incomplete trailing JSONL record until its newline arrives', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-tail-'));
    const filePath = path.join(root, 'source.jsonl');
    try {
      fs.writeFileSync(filePath, '{"type":"user"');
      const first = readAppendedLines(filePath, {});
      assert.equal(first.text, '');
      assert.equal(first.state.carry, '{"type":"user"');
      fs.appendFileSync(filePath, '}\n');
      const second = readAppendedLines(filePath, first.state);
      assert.equal(second.text, '{"type":"user"}\n');
      assert.equal(second.state.carry, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('incremental OpenCode indexing', () => {
  it('uses a message watermark and keeps only text parts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-indexer-'));
    const dbPath = path.join(root, 'opencode.db');
    const outputDir = path.join(root, 'output');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, project_id TEXT, parentID TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER);
    `);
    db.prepare('INSERT INTO project VALUES (?, ?)').run('p1', '/projects/demo');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('s1', 'Demo', Date.parse(localIso(2026, 7, 21, 10, 0)), 'p1', null);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 's1', JSON.stringify({ role: 'user' }), Date.parse(localIso(2026, 7, 21, 10, 0)));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p-user', 'm1', JSON.stringify({ type: 'text', text: 'Start OpenCode work' }), Date.parse(localIso(2026, 7, 21, 10, 0)));
    db.close();

    try {
      await indexOpenCodeDatabase({ name: 'OpenCode', dbPath }, outputDir);
      const updated = new DatabaseSync(dbPath);
      updated.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 's1', JSON.stringify({ role: 'assistant' }), Date.parse(localIso(2026, 7, 22, 10, 0)));
      updated.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p-tool', 'm2', JSON.stringify({ type: 'tool', tool: 'shell' }), Date.parse(localIso(2026, 7, 22, 10, 0)));
      updated.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p-assistant', 'm2', JSON.stringify({ type: 'text', text: 'I completed the OpenCode work.' }), Date.parse(localIso(2026, 7, 22, 10, 0, 1)));
      updated.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m3', 's1', JSON.stringify({ role: 'user' }), Date.parse(localIso(2026, 7, 22, 10, 1)));
      updated.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p-command', 'm3', JSON.stringify({ type: 'text', text: '/internal-command' }), Date.parse(localIso(2026, 7, 22, 10, 1)));
      updated.close();

      const result = await indexOpenCodeDatabase({ name: 'OpenCode', dbPath }, outputDir);
      assert.equal(result.turnsAdded, 1);
      const day = readConversationArtifactsForDate('2026-07-22', outputDir);
      // Assistant-only activity does not become a misleading daily work record.
      assert.equal(day.length, 0);
      const unchanged = await indexOpenCodeDatabase({ name: 'OpenCode', dbPath }, outputDir);
      assert.equal(unchanged.changed, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('incremental Grok indexing', () => {
  it('maps new events to new history without rereading the old session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-indexer-'));
    const sessionDir = path.join(root, 'raw', 'grok-session');
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(sessionDir, { recursive: true });
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const historyPath = path.join(sessionDir, 'chat_history.jsonl');
    const initialEvents = line({ type: 'turn_started', turn_number: 0, ts: localIso(2026, 7, 21, 10, 0), session_relationship: 'primary' });
    const initialHistory = [
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>Start work</user_query>' }] },
      { type: 'reasoning', content: 'hidden reasoning' },
      { type: 'assistant', content: 'I started the work.' },
    ].map(line).join('');
    fs.writeFileSync(eventsPath, initialEvents);
    fs.writeFileSync(historyPath, initialHistory);
    const descriptor = { type: 'grok', agent: 'Grok', id: 'grok-session', project: '/projects/demo', sessionDir, eventsPath, historyPath };

    try {
      await indexGrokSource(descriptor, outputDir);
      const appendedEvents = [
        { type: 'turn_started', turn_number: 1, ts: localIso(2026, 7, 22, 10, 0), session_relationship: 'primary' },
        { type: 'turn_started', turn_number: 2, ts: localIso(2026, 7, 22, 10, 5), session_relationship: 'primary' },
      ].map(line).join('');
      const appendedHistory = [
        { type: 'user', prompt_index: 1, content: [{ type: 'text', text: '<user_query>Continue work</user_query>' }] },
        { type: 'tool_result', content: 'secret command output' },
        { type: 'assistant', content: 'I continued the work.' },
        { type: 'user', prompt_index: 2, synthetic_reason: 'notification_drain', content: [{ type: 'text', text: 'hidden event' }] },
        { type: 'assistant', content: 'The background check finished.' },
      ].map(line).join('');
      fs.appendFileSync(eventsPath, appendedEvents);
      fs.appendFileSync(historyPath, appendedHistory);

      const result = await indexGrokSource(descriptor, outputDir);
      assert.equal(result.bytesRead, Buffer.byteLength(appendedEvents) + Buffer.byteLength(appendedHistory));
      const day = readConversationArtifactsForDate('2026-07-22', outputDir);
      assert.equal(day.length, 1);
      const serialized = JSON.stringify(day[0].messages);
      assert.ok(serialized.includes('Continue work'));
      assert.ok(serialized.includes('I continued the work.'));
      assert.ok(serialized.includes('The background check finished.'));
      assert.ok(!serialized.includes('hidden event'));
      assert.ok(!serialized.includes('secret command output'));
      const unchanged = await indexGrokSource(descriptor, outputDir);
      assert.equal(unchanged.changed, false);
      assert.equal(unchanged.bytesRead, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
