const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadT3SessionMap, hasT3RuntimeMarker } = require('../src/t3-sessions');
const { indexJsonlSource } = require('../src/conversation-indexer');
const { readConversationArtifactsForDate } = require('../src/conversation-artifacts');

const CLAUDE_SESSION = '11111111-2222-4333-8444-555555555555';
const CODEX_SESSION = '01a00000-0000-7000-8000-000000000001';

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

// Transcript times are built from local wall-clock time so they stay on the
// 2026-10-12 workday (4 AM to 4 AM local) in every time zone.
const WORKDAY = '2026-10-12';
const USER_AT = new Date(2026, 9, 12, 10, 0).toISOString();
const ASSISTANT_AT = new Date(2026, 9, 12, 10, 1).toISOString();

function makeT3Database(root) {
  const dbPath = path.join(root, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT, provider_session_id TEXT, provider_thread_id TEXT);
    CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, title TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
    INSERT INTO projection_projects VALUES ('p1', 'app', '/srv/demo-app');
    INSERT INTO projection_threads VALUES ('t-claude', 'p1', 'Fix login bug'), ('t-codex', 'p1', 'Review PR');
    INSERT INTO provider_session_runtime VALUES
      ('t-claude', 'claudeAgent', '{"threadId":"t-claude","resume":"${CLAUDE_SESSION}"}'),
      ('t-codex', 'codex', '{"threadId":"${CODEX_SESSION.toUpperCase()}"}');
    INSERT INTO projection_thread_sessions VALUES ('t-claude', NULL, NULL), ('t-codex', NULL, NULL);
  `);
  db.close();
  return dbPath;
}

describe('T3 Code session map', () => {
  it('maps Claude resume IDs and Codex thread IDs to T3 threads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-map-'));
    try {
      const map = loadT3SessionMap({ stateDbPath: makeT3Database(root) });
      assert.equal(map.get(CLAUDE_SESSION).title, 'Fix login bug');
      assert.equal(map.get(CLAUDE_SESSION).threadId, 't-claude');
      assert.equal(map.get(CODEX_SESSION).provider, 'codex');
      assert.equal(map.get(CODEX_SESSION).projectTitle, 'app');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty map when T3 is not installed', () => {
    assert.equal(loadT3SessionMap({ stateDbPath: path.join(os.tmpdir(), 'missing-t3.sqlite') }).size, 0);
    assert.equal(loadT3SessionMap(undefined).size, 0);
  });
});

const RUNTIME_NOTE = "<runtime_info>In case you're asked: you are running in T3 Code through the Claude Code harness.</runtime_info>";
const CODEX_NOTE = "<t3_code_runtime><runtime_info>In case you're asked: you are running in T3 Code through the Codex harness.</runtime_info></t3_code_runtime>";

function promptSnapshot() {
  return { type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['You are Claude Code.', RUNTIME_NOTE] } };
}

describe('T3 Code runtime note in transcripts', () => {
  it('finds the note in a Claude system-prompt snapshot', () => {
    assert.equal(hasT3RuntimeMarker('claude-code', line(promptSnapshot())), true);
  });

  it('finds the note in a Codex developer message', () => {
    const row = { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: CODEX_NOTE }] } };
    assert.equal(hasT3RuntimeMarker('codex', line(row)), true);
  });

  it('ignores the same words typed or pasted by the user', () => {
    const claudeUser = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: RUNTIME_NOTE }] } };
    const codexUser = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: CODEX_NOTE }] } };
    assert.equal(hasT3RuntimeMarker('claude-code', line(claudeUser)), false);
    assert.equal(hasT3RuntimeMarker('codex', line(codexUser)), false);
  });
});

describe('indexing T3 Code sessions', () => {
  function writeSdkTranscript(filePath, extraRows = []) {
    // Agent SDK transcripts start with queue-operation rows, like headless runs.
    fs.writeFileSync(filePath, [
      { type: 'queue-operation', operation: 'enqueue', sessionId: CLAUDE_SESSION },
      ...extraRows,
      { type: 'user', timestamp: USER_AT, sessionId: CLAUDE_SESSION, cwd: '/srv/demo-app',
        entrypoint: 'sdk-ts', message: { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] } },
      { type: 'assistant', timestamp: ASSISTANT_AT, sessionId: CLAUDE_SESSION, cwd: '/srv/demo-app',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed the session check' }] } },
    ].map(line).join(''));
  }

  it('keeps a T3 Claude session and labels it with the client and thread title', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-index-'));
    try {
      const filePath = path.join(root, `${CLAUDE_SESSION}.jsonl`);
      const outputDir = path.join(root, 'out');
      writeSdkTranscript(filePath);
      const result = await indexJsonlSource({
        type: 'jsonl', parserName: 'claude-code', agent: 'Claude Code (WSL)', id: CLAUDE_SESSION,
        project: 'demo', filePath, t3: { threadId: 't-claude', title: 'Fix login bug' },
      }, outputDir);
      assert.notEqual(result.excluded, true);

      const [artifact] = readConversationArtifactsForDate(WORKDAY, outputDir);
      assert.equal(artifact.session.client, 'T3 Code');
      assert.equal(artifact.session.title, 'Fix login bug');
      const markdown = fs.readFileSync(artifact.session.artifactPath, 'utf8');
      assert.match(markdown, /- Client: T3 Code/);
      assert.match(markdown, /- Thread title: Fix login bug/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a T3 session from the transcript note alone when the database link is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-note-'));
    try {
      const filePath = path.join(root, `${CLAUDE_SESSION}.jsonl`);
      const outputDir = path.join(root, 'out');
      writeSdkTranscript(filePath, [promptSnapshot()]);
      const result = await indexJsonlSource({
        type: 'jsonl', parserName: 'claude-code', agent: 'Claude Code (WSL)', id: CLAUDE_SESSION,
        project: 'demo', filePath,
      }, outputDir);
      assert.notEqual(result.excluded, true);
      const [artifact] = readConversationArtifactsForDate(WORKDAY, outputDir);
      assert.equal(artifact.session.client, 'T3 Code');
      const state = JSON.parse(fs.readFileSync(path.join(path.dirname(artifact.filePath), '.source-state.json'), 'utf8'));
      assert.deepEqual(state.t3Evidence, ['transcript-runtime-note']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still drops a headless run that only mentions T3 in typed text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-typed-'));
    try {
      const filePath = path.join(root, `${CLAUDE_SESSION}.jsonl`);
      const outputDir = path.join(root, 'out');
      fs.writeFileSync(filePath, [
        { type: 'queue-operation', operation: 'enqueue', sessionId: CLAUDE_SESSION },
        { type: 'user', timestamp: USER_AT, sessionId: CLAUDE_SESSION,
          message: { role: 'user', content: [{ type: 'text', text: `Summarize: ${RUNTIME_NOTE}` }] } },
      ].map(line).join(''));
      const result = await indexJsonlSource({
        type: 'jsonl', parserName: 'claude-code', agent: 'Claude Code (WSL)', id: CLAUDE_SESSION,
        project: 'demo', filePath,
      }, outputDir);
      assert.equal(result.excluded, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a T3 session that an earlier run excluded as headless', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-recover-'));
    try {
      const filePath = path.join(root, `${CLAUDE_SESSION}.jsonl`);
      const outputDir = path.join(root, 'out');
      writeSdkTranscript(filePath);
      const descriptor = {
        type: 'jsonl', parserName: 'claude-code', agent: 'Claude Code (WSL)', id: CLAUDE_SESSION,
        project: 'demo', filePath,
      };
      const first = await indexJsonlSource(descriptor, outputDir);
      assert.equal(first.excluded, true);

      const second = await indexJsonlSource({ ...descriptor, t3: { threadId: 't-claude', title: 'Fix login bug' } }, outputDir);
      assert.notEqual(second.excluded, true);
      assert.equal(readConversationArtifactsForDate(WORKDAY, outputDir).length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
