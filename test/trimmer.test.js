'use strict';

/**
 * Unit tests for src/trimmer/index.js
 *
 * Covers:
 *  - trimTranscript with unknown adapter → empty result + warning
 *  - flattenContentBlocks keeps only text blocks and concatenates
 *  - flattenContentBlocks strips <thinking>, <system-reminder>, <tool_use>, <tool_result> tags
 *  - normalizeWhitespace collapses runs of whitespace
 *  - registerAdapter + trimTranscript dispatches to in-memory mock adapter
 *
 * NOTE: Per-adapter integration tests live in phases 3b-e and belong in
 *       separate test files. No real filesystem reads happen here.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  trimTranscript,
  registerAdapter,
  flattenContentBlocks,
  stripResidualTags,
  normalizeWhitespace,
} = require('../src/trimmer/index');

// ── trimTranscript — unknown adapter ──────────────────────────────────────────

describe('trimTranscript — unknown adapter', () => {
  it('returns empty messages array when adapter is not registered', async () => {
    const result = await trimTranscript('fake-source', 'no-such-adapter-xyz');
    assert.ok(Array.isArray(result.messages), 'messages should be an array');
    assert.equal(result.messages.length, 0, 'messages should be empty');
  });

  it('returns a non-empty warnings array when adapter is not registered', async () => {
    const result = await trimTranscript('fake-source', 'no-such-adapter-xyz');
    assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
    assert.ok(result.warnings.length > 0, 'should have at least one warning');
  });

  it('warning message mentions the adapter name', async () => {
    const result = await trimTranscript('fake-source', 'not-a-real-adapter');
    const combined = result.warnings.join(' ');
    assert.ok(
      combined.includes('not-a-real-adapter'),
      `Expected warning to mention adapter name, got: ${combined}`
    );
  });

  it('stats object is present with zero cleanedChars', async () => {
    const result = await trimTranscript('fake-source', 'no-such-adapter-xyz');
    assert.ok(result.stats, 'stats should exist');
    assert.equal(result.stats.cleanedChars, 0);
  });
});

// ── trimTranscript — adapter that throws ──────────────────────────────────────

describe('trimTranscript — adapter runtime error', () => {
  it('catches adapter throws and returns empty result with warning', async () => {
    registerAdapter('throws-on-parse', async () => {
      throw new Error('Simulated adapter failure');
    });

    const result = await trimTranscript('any-source', 'throws-on-parse');
    assert.equal(result.messages.length, 0);
    assert.ok(result.warnings.some(w => w.includes('Simulated adapter failure')));
  });
});

// ── flattenContentBlocks ──────────────────────────────────────────────────────

describe('flattenContentBlocks', () => {
  it('returns empty string for empty array', () => {
    assert.equal(flattenContentBlocks([]), '');
  });

  it('returns empty string for non-array input', () => {
    assert.equal(flattenContentBlocks(null), '');
    assert.equal(flattenContentBlocks(undefined), '');
    assert.equal(flattenContentBlocks('string'), '');
  });

  it('keeps only text blocks', () => {
    const blocks = [
      { type: 'thinking', thinking: 'internal reasoning here' },
      { type: 'text', text: 'Hello, world!' },
      { type: 'tool_use', name: 'Read', input: {} },
      { type: 'tool_result', content: 'file contents' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.equal(result, 'Hello, world!');
  });

  it('concatenates multiple text blocks with newline separator', () => {
    const blocks = [
      { type: 'text', text: 'First sentence.' },
      { type: 'tool_use', name: 'Edit', input: {} },
      { type: 'text', text: 'Second sentence.' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.ok(result.includes('First sentence.'), 'Should include first text');
    assert.ok(result.includes('Second sentence.'), 'Should include second text');
    // thinking / tool_use blocks do not appear in output
    assert.ok(!result.includes('Edit'), 'Should not include tool name');
  });

  it('drops thinking blocks entirely', () => {
    const blocks = [
      { type: 'thinking', thinking: 'SECRET INTERNAL THOUGHT' },
      { type: 'text', text: 'Public reply.' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.ok(!result.includes('SECRET INTERNAL THOUGHT'));
    assert.equal(result, 'Public reply.');
  });

  it('strips inline <thinking>...</thinking> tags from text blocks', () => {
    const blocks = [
      { type: 'text', text: 'Before<thinking>hidden stuff</thinking>After' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.ok(!result.includes('hidden stuff'), 'thinking tag content should be stripped');
    assert.ok(result.includes('Before'), 'text before tag should remain');
    assert.ok(result.includes('After'), 'text after tag should remain');
  });

  it('strips <system-reminder>...</system-reminder> tags from text blocks', () => {
    const blocks = [
      { type: 'text', text: 'Hello<system-reminder>injected context</system-reminder>World' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.ok(!result.includes('injected context'));
    assert.ok(result.includes('Hello'));
    assert.ok(result.includes('World'));
  });

  it('strips <tool_use>...</tool_use> tags from text blocks', () => {
    const blocks = [
      { type: 'text', text: 'Answer<tool_use>{"name":"Read"}</tool_use>done' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.ok(!result.includes('{"name":"Read"}'));
    assert.ok(result.includes('done'));
  });

  it('strips <tool_result>...</tool_result> tags from text blocks', () => {
    const blocks = [
      { type: 'text', text: 'Reply<tool_result>big file dump</tool_result>end' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.ok(!result.includes('big file dump'));
    assert.ok(result.includes('end'));
  });

  it('handles blocks with missing or empty text property gracefully', () => {
    const blocks = [
      { type: 'text' },           // no text property
      { type: 'text', text: '' }, // empty text
      { type: 'text', text: 'Real content.' },
    ];
    const result = flattenContentBlocks(blocks);
    assert.equal(result, 'Real content.');
  });
});

// ── normalizeWhitespace ───────────────────────────────────────────────────────

describe('normalizeWhitespace', () => {
  it('collapses multiple newlines into a single space', () => {
    const result = normalizeWhitespace('\n\n\n  foo   bar');
    assert.equal(result, 'foo bar');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalizeWhitespace('   hello   '), 'hello');
  });

  it('collapses mixed spaces and tabs', () => {
    assert.equal(normalizeWhitespace('a\t\t  b'), 'a b');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeWhitespace(''), '');
  });

  it('returns empty string for null/undefined input', () => {
    assert.equal(normalizeWhitespace(null), '');
    assert.equal(normalizeWhitespace(undefined), '');
  });

  it('leaves already-normalized text unchanged', () => {
    assert.equal(normalizeWhitespace('hello world'), 'hello world');
  });
});

// ── registerAdapter + dispatch ────────────────────────────────────────────────

describe('registerAdapter + trimTranscript dispatch', () => {
  it('dispatches trimTranscript to a mock adapter registered via registerAdapter', async () => {
    const mockMessages = [
      { role: 'user', content: 'Hello from mock', timestamp: '2026-04-21T00:00:00Z' },
      { role: 'assistant', content: 'Mock reply here', timestamp: '2026-04-21T00:00:01Z' },
    ];

    registerAdapter('mock-adapter-dispatch', async (_source, _options) => ({
      messages: mockMessages,
      stats: { originalBytes: 1234, originalLines: 2, droppedCounts: { tool_use: 3 } },
      warnings: [],
    }));

    const result = await trimTranscript('any-source-value', 'mock-adapter-dispatch');

    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Hello from mock');
    assert.equal(result.messages[1].role, 'assistant');
    assert.equal(result.messages[1].content, 'Mock reply here');
  });

  it('forwards options to the adapter', async () => {
    let capturedOptions;
    registerAdapter('mock-adapter-options', async (_source, options) => {
      capturedOptions = options;
      return { messages: [], stats: {}, warnings: [] };
    });

    await trimTranscript('src', 'mock-adapter-options', { keepToolNotes: true, maxTurns: 10 });
    assert.equal(capturedOptions.keepToolNotes, true);
    assert.equal(capturedOptions.maxTurns, 10);
  });

  it('enforces maxTurns cap by keeping LAST N turns', async () => {
    const manyMessages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Turn ${i}`,
    }));

    registerAdapter('mock-adapter-many', async () => ({
      messages: manyMessages,
      stats: {},
      warnings: [],
    }));

    const result = await trimTranscript('src', 'mock-adapter-many', { maxTurns: 3 });
    assert.equal(result.messages.length, 3);
    // Should be the LAST 3 turns (indices 7, 8, 9)
    assert.equal(result.messages[0].content, 'Turn 7');
    assert.equal(result.messages[2].content, 'Turn 9');
  });

  it('computes cleanedChars from actual message content', async () => {
    registerAdapter('mock-adapter-chars', async () => ({
      messages: [
        { role: 'user', content: 'abcde' },     // 5 chars
        { role: 'assistant', content: 'fghij' }, // 5 chars
      ],
      stats: { originalBytes: 500 },
      warnings: [],
    }));

    const result = await trimTranscript('src', 'mock-adapter-chars');
    assert.equal(result.stats.cleanedChars, 10);
  });

  it('throws a TypeError for invalid adapter name in registerAdapter', () => {
    assert.throws(() => registerAdapter('', () => {}), TypeError);
    assert.throws(() => registerAdapter(null, () => {}), TypeError);
  });

  it('throws a TypeError for non-function adapter fn in registerAdapter', () => {
    assert.throws(() => registerAdapter('valid-name', 'not-a-function'), TypeError);
  });
});

// ── stripResidualTags (direct) ────────────────────────────────────────────────

describe('stripResidualTags', () => {
  it('strips matched tag pairs including content', () => {
    const input = 'before<thinking>secret</thinking>after';
    assert.equal(stripResidualTags(input), 'beforeafter');
  });

  it('strips multiple different tags in one pass', () => {
    const input = '<system-reminder>noise</system-reminder>text<tool_use>data</tool_use>end';
    const result = stripResidualTags(input);
    assert.ok(!result.includes('noise'));
    assert.ok(!result.includes('data'));
    assert.ok(result.includes('text'));
    assert.ok(result.includes('end'));
  });

  it('returns empty string for empty input', () => {
    assert.equal(stripResidualTags(''), '');
  });

  it('leaves plain text unchanged', () => {
    assert.equal(stripResidualTags('hello world'), 'hello world');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3b — Adapter integration tests
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FIXTURES = path.join(__dirname, 'fixtures', 'trimmer');

// ── Inline JSONL fixtures (no file I/O for most tests) ────────────────────────

/** A typical 2-turn Claude Code session with thinking + tool_use blocks */
const CC_TYPICAL_JSONL = [
  JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' }),
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: 'u1',
    timestamp: '2026-04-21T10:00:00.000Z',
    message: { role: 'user', content: 'How do I reverse a string in JavaScript?' } }),
  JSON.stringify({ parentUuid: 'u1', isSidechain: false, type: 'assistant', uuid: 'a1',
    timestamp: '2026-04-21T10:00:05.000Z',
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Internal thought' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/src/utils.js' } },
      { type: 'text', text: 'You can use split-reverse-join: str.split(\'\').reverse().join(\'\')' },
    ] } }),
  JSON.stringify({ parentUuid: 'a1', isSidechain: false, type: 'user', uuid: 'u2',
    timestamp: '2026-04-21T10:00:10.000Z',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'xyz', content: 'big file dump' },
      { type: 'text', text: 'Thanks! Can you show a named function version?' },
    ] } }),
  JSON.stringify({ parentUuid: 'u2', isSidechain: false, type: 'assistant', uuid: 'a2',
    timestamp: '2026-04-21T10:00:15.000Z',
    message: { role: 'assistant', content: [
      { type: 'text', text: 'Sure! function reverseString(s) { return s.split(\'\').reverse().join(\'\'); }' },
    ] } }),
  JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1,
    timestamp: '2026-04-21T10:00:16.000Z', uuid: 'sys1' }),
].join('\n');

/** Claude Code session with ONLY tool/thinking blocks — no plain text at all */
const CC_TOOL_HEAVY_JSONL = [
  JSON.stringify({ type: 'user', isSidechain: false, uuid: 'u1', timestamp: '2026-04-21T11:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'output' }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: false, uuid: 'a1', timestamp: '2026-04-21T11:00:01.000Z',
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'more thoughts' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/x.js', old_string: 'a', new_string: 'b' } },
    ] } }),
].join('\n');

/** Claude Code session with malformed lines mixed in */
const CC_MALFORMED_JSONL = [
  JSON.stringify({ type: 'user', isSidechain: false, uuid: 'u1', timestamp: '2026-04-21T12:00:00.000Z',
    message: { role: 'user', content: 'First good message' } }),
  'NOT VALID JSON {{{',
  '{broken',
  JSON.stringify({ type: 'assistant', isSidechain: false, uuid: 'a1', timestamp: '2026-04-21T12:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'A valid reply' }] } }),
].join('\n');

/** Claude Code sidechain + meta entries — should be fully dropped */
const CC_SIDECHAIN_JSONL = [
  JSON.stringify({ type: 'user', isSidechain: true, uuid: 'sc1', timestamp: '2026-04-21T13:00:00.000Z',
    message: { role: 'user', content: 'This is a sidechain message' } }),
  JSON.stringify({ type: 'assistant', isMeta: true, uuid: 'mt1', timestamp: '2026-04-21T13:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'This is a meta entry' }] } }),
].join('\n');

/** Typical Codex session (event-stream format) */
const CODEX_TYPICAL_JSONL = [
  JSON.stringify({ timestamp: '2026-04-21T08:00:00.000Z', type: 'session_meta',
    payload: { id: 'codex-test-001', cwd: 'E:\\projects\\Test' } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:00.100Z', type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:00.200Z', type: 'response_item',
    payload: { type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions>\nSandbox active.\n</permissions instructions>' }] } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:00.300Z', type: 'response_item',
    payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>E:\\projects\\Test</cwd>\n</environment_context>' }] } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:00.400Z', type: 'event_msg',
    payload: { type: 'user_message', message: 'Fix the bug in the login form.', images: [] } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:02.000Z', type: 'response_item',
    payload: { type: 'function_call', name: 'container_exec', arguments: '{"cmd":["ls"]}' } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:02.500Z', type: 'response_item',
    payload: { type: 'function_call_output', output: 'src/login.js' } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:05.000Z', type: 'response_item',
    payload: { type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'I found the issue in login.js and fixed the validation.' }] } }),
  JSON.stringify({ timestamp: '2026-04-21T08:00:05.200Z', type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1' } }),
].join('\n');

/** Codex session with ONLY function_call/output lines — no natural language */
const CODEX_TOOL_HEAVY_JSONL = [
  JSON.stringify({ timestamp: '2026-04-21T09:00:00.000Z', type: 'response_item',
    payload: { type: 'function_call', name: 'container_exec', arguments: '{"cmd":["npm","test"]}' } }),
  JSON.stringify({ timestamp: '2026-04-21T09:00:01.000Z', type: 'response_item',
    payload: { type: 'function_call_output', output: 'All tests passed' } }),
  JSON.stringify({ timestamp: '2026-04-21T09:00:02.000Z', type: 'response_item',
    payload: { type: 'function_call', name: 'container_exec', arguments: '{"cmd":["git","commit","-m","fix"]}' } }),
].join('\n');

/** Codex session with malformed lines */
const CODEX_MALFORMED_JSONL = [
  JSON.stringify({ timestamp: '2026-04-21T09:30:00.000Z', type: 'event_msg',
    payload: { type: 'user_message', message: 'Good message here' } }),
  'NOT_JSON',
  '{{invalid}}',
  JSON.stringify({ timestamp: '2026-04-21T09:30:05.000Z', type: 'response_item',
    payload: { type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'I understand.' }] } }),
].join('\n');

/** Codex simple {role, content} fallback shape */
const CODEX_SIMPLE_SHAPE_JSONL = [
  JSON.stringify({ role: 'user',      content: 'What is 2+2?',       timestamp: '2026-04-21T09:45:00.000Z' }),
  JSON.stringify({ role: 'assistant', content: '4.',                  timestamp: '2026-04-21T09:45:01.000Z' }),
  JSON.stringify({ role: 'user',      content: 'What is 3 times 7?', timestamp: '2026-04-21T09:45:02.000Z' }),
].join('\n');

// ── Helper: fingerprint a file ────────────────────────────────────────────────

function fingerprint(filePath) {
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  return { mtime: stat.mtimeMs, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Claude Code adapter tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('claude-code trimmer adapter — via trimTranscript', () => {
  it('typical session: keeps user+assistant text, drops thinking/tool_use/tool_result', async () => {
    const result = await trimTranscript(CC_TYPICAL_JSONL, 'claude-code');
    assert.ok(result.messages.length >= 3, `Expected ≥3 messages, got ${result.messages.length}`);

    const roles = result.messages.map(m => m.role);
    assert.ok(roles.includes('user'), 'Should have user turns');
    assert.ok(roles.includes('assistant'), 'Should have assistant turns');

    // No raw thinking content should leak through
    const allContent = result.messages.map(m => m.content).join(' ');
    assert.ok(!allContent.includes('Internal thought'), 'Thinking block content must not appear');
    assert.ok(!allContent.includes('big file dump'), 'tool_result content must not appear');

    // Tool counts tracked
    assert.ok((result.stats.droppedCounts.thinking || 0) >= 1, 'thinking blocks counted');
    assert.ok((result.stats.droppedCounts.tool_use || 0) >= 1, 'tool_use blocks counted');
  });

  it('empty session: returns empty messages with no warnings', async () => {
    const result = await trimTranscript('', 'claude-code');
    assert.equal(result.messages.length, 0);
  });

  it('malformed JSON lines: skipped with warning emitted', async () => {
    const result = await trimTranscript(CC_MALFORMED_JSONL, 'claude-code');
    // Good lines should still parse
    assert.ok(result.messages.length >= 2, 'Valid lines still produce messages');
    // Warning about bad lines
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('failed JSON parsing') || warnText.includes('skipped'),
      `Expected parse-failure warning, got: ${warnText}`);
  });

  it('tool-heavy session: all entries stripped, zero messages returned', async () => {
    const result = await trimTranscript(CC_TOOL_HEAVY_JSONL, 'claude-code');
    assert.equal(result.messages.length, 0, 'Tool-only session should produce 0 messages');
    // Dropped counts should be non-empty
    const total = Object.values(result.stats.droppedCounts).reduce((a, b) => a + b, 0);
    assert.ok(total > 0, 'Should have counted dropped blocks');
  });

  it('sidechain + meta entries are fully dropped', async () => {
    const result = await trimTranscript(CC_SIDECHAIN_JSONL, 'claude-code');
    assert.equal(result.messages.length, 0, 'Sidechain/meta entries produce zero messages');
  });

  it('timestamps are included by default', async () => {
    const result = await trimTranscript(CC_TYPICAL_JSONL, 'claude-code');
    const withTs = result.messages.filter(m => m.timestamp);
    assert.ok(withTs.length > 0, 'At least some messages should carry a timestamp');
  });

  it('timestamps omitted when includeTimestamps=false', async () => {
    const result = await trimTranscript(CC_TYPICAL_JSONL, 'claude-code', { includeTimestamps: false });
    const withTs = result.messages.filter(m => m.timestamp);
    assert.equal(withTs.length, 0, 'No messages should have a timestamp when includeTimestamps=false');
  });

  it('keepToolNotes adds actionNote to assistant turns with tool_use blocks', async () => {
    const result = await trimTranscript(CC_TYPICAL_JSONL, 'claude-code', { keepToolNotes: true });
    const withNote = result.messages.filter(m => m.actionNote);
    assert.ok(withNote.length >= 1, 'At least one message should have an actionNote');
    assert.ok(withNote[0].actionNote.includes('[Tool:'), `Expected [Tool: ...] note, got: ${withNote[0].actionNote}`);
  });

  it('source fingerprint (mtime + sha256) is unchanged after parse()', async () => {
    const fixturePath = path.join(FIXTURES, 'claude-code-typical.jsonl');
    const before = fingerprint(fixturePath);
    await trimTranscript(fixturePath, 'claude-code');
    const after = fingerprint(fixturePath);
    assert.equal(before.mtime, after.mtime, 'mtime must not change');
    assert.equal(before.sha256, after.sha256, 'sha256 must not change');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Codex adapter tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('codex trimmer adapter — via trimTranscript', () => {
  it('drops current internal context and duplicate event copies of user messages', async () => {
    const raw = [
      JSON.stringify({
        timestamp: '2026-07-31T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do the visible work' }] },
      }),
      JSON.stringify({
        timestamp: '2026-07-31T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Do the visible work' },
      }),
      JSON.stringify({
        timestamp: '2026-07-31T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<codex_internal_context source="goal">hidden orchestration</codex_internal_context>' }] },
      }),
      JSON.stringify({
        timestamp: '2026-07-31T10:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I completed the visible work.' }] },
      }),
    ].join('\n');
    const result = await trimTranscript(raw, 'codex');
    assert.deepEqual(result.messages.map(turn => turn.content), [
      'Do the visible work',
      'I completed the visible work.',
    ]);
  });

  it('typical session: keeps user_message + assistant message, drops function_call/output/preamble', async () => {
    const result = await trimTranscript(CODEX_TYPICAL_JSONL, 'codex');
    assert.ok(result.messages.length >= 2, `Expected ≥2 messages, got ${result.messages.length}`);

    const userTurns = result.messages.filter(m => m.role === 'user');
    const asstTurns = result.messages.filter(m => m.role === 'assistant');
    assert.ok(userTurns.length >= 1, 'Should have at least one user turn');
    assert.ok(asstTurns.length >= 1, 'Should have at least one assistant turn');

    // System preamble must not leak
    const allContent = result.messages.map(m => m.content).join(' ');
    assert.ok(!allContent.includes('<permissions instructions>'), 'Permissions preamble must be stripped');
    assert.ok(!allContent.includes('<environment_context>'), 'Environment context must be stripped');

    // The real user message should be present
    assert.ok(allContent.includes('Fix the bug'), 'Real user message should survive');

    // function_call counted as dropped
    assert.ok((result.stats.droppedCounts.function_call || 0) >= 1, 'function_call blocks counted');
    assert.ok((result.stats.droppedCounts.function_call_output || 0) >= 1, 'function_call_output counted');
  });

  it('empty source: returns empty messages', async () => {
    const result = await trimTranscript('', 'codex');
    assert.equal(result.messages.length, 0);
  });

  it('malformed JSON lines: skipped with warning', async () => {
    const result = await trimTranscript(CODEX_MALFORMED_JSONL, 'codex');
    assert.ok(result.messages.length >= 2, 'Valid lines still parse');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('failed JSON parsing') || warnText.includes('skipped'),
      `Expected parse-failure warning, got: ${warnText}`);
  });

  it('tool-heavy session: zero natural-language messages', async () => {
    const result = await trimTranscript(CODEX_TOOL_HEAVY_JSONL, 'codex');
    assert.equal(result.messages.length, 0, 'Pure tool session should produce 0 messages');
    const total = Object.values(result.stats.droppedCounts).reduce((a, b) => a + b, 0);
    assert.ok(total > 0, 'Should have counted dropped items');
  });

  it('simple {role, content} fallback shape: parsed correctly', async () => {
    const result = await trimTranscript(CODEX_SIMPLE_SHAPE_JSONL, 'codex');
    assert.equal(result.messages.length, 3, 'All three simple-shape lines should parse');
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'What is 2+2?');
    assert.equal(result.messages[1].role, 'assistant');
    assert.equal(result.messages[2].role, 'user');
  });

  it('source fingerprint (mtime + sha256) is unchanged after parse()', async () => {
    const fixturePath = path.join(FIXTURES, 'codex-typical.jsonl');
    const before = fingerprint(fixturePath);
    await trimTranscript(fixturePath, 'codex');
    const after = fingerprint(fixturePath);
    assert.equal(before.mtime, after.mtime, 'mtime must not change');
    assert.equal(before.sha256, after.sha256, 'sha256 must not change');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cursor adapter tests  (Phase 3c)
//
// All SQLite interactions use in-memory DatabaseSync handles or a pre-built
// fixture file (test/fixtures/cursor-fixture.vscdb).
// No real user state.vscdb files are read.
// ═══════════════════════════════════════════════════════════════════════════════

describe('cursor trimmer adapter', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { parse: cursorParse } = require('../src/trimmer/adapters/cursor');

  // ── helpers ──────────────────────────────────────────────────────────────────

  function makeMemDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
    return db;
  }

  function insertComposer(db, composerId, headers, extra = {}) {
    const data = {
      composerId,
      createdAt:     extra.createdAt     || 1700000000000,
      lastUpdatedAt: extra.lastUpdatedAt || 1700000100000,
      name:          extra.name          || 'Test Composer',
      fullConversationHeadersOnly: headers,
    };
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `composerData:${composerId}`,
      JSON.stringify(data)
    );
  }

  function insertBubble(db, composerId, bubbleId, bubbleData) {
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:${bubbleId}`,
      JSON.stringify({ bubbleId, ...bubbleData })
    );
  }

  // ── Test 1: normal 3-bubble composer ─────────────────────────────────────────

  it('normal composer with 3 bubbles (user/assistant/user) produces 3 CleanTurns in order', async () => {
    const db  = makeMemDb();
    const cId = 'comp-normal';
    insertComposer(db, cId, [
      { bubbleId: 'b1', type: 1 },
      { bubbleId: 'b2', type: 2 },
      { bubbleId: 'b3', type: 1 },
    ]);
    insertBubble(db, cId, 'b1', { type: 1, text: 'User question one' });
    insertBubble(db, cId, 'b2', { type: 2, text: 'Assistant answer here' });
    insertBubble(db, cId, 'b3', { type: 1, text: 'User follow-up question' });

    const result = await cursorParse(db, {});

    assert.equal(result.messages.length, 3, 'should produce exactly 3 turns');
    assert.equal(result.messages[0].role,    'user');
    assert.equal(result.messages[0].content, 'User question one');
    assert.equal(result.messages[1].role,    'assistant');
    assert.equal(result.messages[1].content, 'Assistant answer here');
    assert.equal(result.messages[2].role,    'user');
    assert.equal(result.messages[2].content, 'User follow-up question');

    db.close();
  });

  // ── Test 2: thinking field stripped ──────────────────────────────────────────

  it('bubble with allThinkingBlocks: thinking content absent from output, drop count logged', async () => {
    const db  = makeMemDb();
    const cId = 'comp-think';
    insertComposer(db, cId, [{ bubbleId: 'bt', type: 2 }]);
    insertBubble(db, cId, 'bt', {
      type: 2,
      text: 'Visible assistant reply',
      allThinkingBlocks: [
        { type: 'thinking', content: 'SECRET INTERNAL REASONING must not appear' },
        { type: 'thinking', content: 'MORE INTERNAL STUFF' },
      ],
    });

    const result = await cursorParse(db, {});

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'Visible assistant reply');
    assert.ok(
      !result.messages[0].content.includes('SECRET INTERNAL REASONING'),
      'thinking content must not appear in output'
    );
    assert.ok(
      (result.stats.droppedCounts['allThinkingBlocks'] || 0) >= 2,
      `allThinkingBlocks drop count should be ≥2, got ${result.stats.droppedCounts['allThinkingBlocks']}`
    );

    db.close();
  });

  // ── Test 3: toolFormerData / toolResults dropped ───────────────────────────────

  it('bubble with toolResults: tool I/O absent from content, drop count logged', async () => {
    const db  = makeMemDb();
    const cId = 'comp-tool';
    insertComposer(db, cId, [{ bubbleId: 'btool', type: 2 }]);
    insertBubble(db, cId, 'btool', {
      type: 2,
      text: 'I ran the tool and got results',
      toolResults: [
        { toolName: 'Read',  output: 'SENSITIVE FILE CONTENTS' },
        { toolName: 'Edit',  output: 'SENSITIVE DIFF OUTPUT' },
      ],
    });

    const result = await cursorParse(db, {});

    assert.equal(result.messages.length, 1);
    assert.ok(
      (result.stats.droppedCounts['toolResults'] || 0) >= 2,
      `toolResults drop count should be ≥2, got ${result.stats.droppedCounts['toolResults']}`
    );
    assert.ok(!result.messages[0].content.includes('SENSITIVE FILE CONTENTS'), 'tool output must not leak');
    assert.ok(!result.messages[0].content.includes('SENSITIVE DIFF OUTPUT'),   'tool output must not leak');

    db.close();
  });

  // ── Test 4: codeBlocks dropped ───────────────────────────────────────────────

  it('bubble with codeBlocks: code absent from content, drop count logged', async () => {
    const db  = makeMemDb();
    const cId = 'comp-code';
    insertComposer(db, cId, [{ bubbleId: 'bcode', type: 2 }]);
    insertBubble(db, cId, 'bcode', {
      type: 2,
      text: 'Here is the updated function.',
      codeBlocks: [{ code: 'function secretFn() { return 42; }', language: 'js' }],
    });

    const result = await cursorParse(db, {});

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'Here is the updated function.');
    assert.ok(
      (result.stats.droppedCounts['codeBlocks'] || 0) >= 1,
      'codeBlocks should be counted as dropped'
    );
    assert.ok(!result.messages[0].content.includes('secretFn'), 'code must not appear in content');

    db.close();
  });

  // ── Test 5: richText Lexical tree extraction ──────────────────────────────────

  it('bubble with only richText (no text): extracts prose from Lexical tree, skips code nodes', async () => {
    const db  = makeMemDb();
    const cId = 'comp-rich';
    insertComposer(db, cId, [{ bubbleId: 'bright', type: 1 }]);

    const lexicalJson = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'Hello from',  detail: 0, format: 0, mode: 'normal', style: '', version: 1 },
              { type: 'text', text: ' richText',   detail: 0, format: 0, mode: 'normal', style: '', version: 1 },
            ],
          },
          {
            // standalone code block node — must be skipped
            type: 'code',
            children: [{ type: 'text', text: 'should be skipped code block text' }],
          },
        ],
      },
    });

    insertBubble(db, cId, 'bright', {
      type: 1,
      text: '',          // empty → forces richText fallback
      richText: lexicalJson,
    });

    const result = await cursorParse(db, {});

    assert.equal(result.messages.length, 1);
    assert.ok(result.messages[0].content.includes('Hello from'), 'first text node should be present');
    assert.ok(result.messages[0].content.includes('richText'),   'second text node should be present');
    assert.ok(
      !result.messages[0].content.includes('should be skipped code block text'),
      'code node content must be excluded'
    );

    db.close();
  });

  // ── Test 6: empty composer produces no turns and does not crash ───────────────

  it('empty composer (0 bubbles) produces no turns and no crash', async () => {
    const db  = makeMemDb();
    const cId = 'comp-empty';
    insertComposer(db, cId, []);

    const result = await cursorParse(db, {});

    assert.ok(Array.isArray(result.messages), 'messages should be an array');
    assert.equal(result.messages.length, 0,   'should have no turns for empty composer');
    assert.ok(Array.isArray(result.warnings),  'warnings should be an array');
    // droppedCounts should record the empty composer
    assert.ok(
      (result.stats.droppedCounts['_empty_composer'] || 0) >= 1,
      'empty composer should be counted in droppedCounts'
    );

    db.close();
  });

  // ── Test 7: fixture file immutability ─────────────────────────────────────────

  it('fixture state.vscdb mtime and sha256 are unchanged after parse()', async () => {
    const { assertReadOnly } = require('../src/trimmer/util');
    const fixturePath = path.join(__dirname, 'fixtures', 'cursor-fixture.vscdb');

    const before = assertReadOnly(fixturePath);
    const result = await cursorParse(fixturePath, {});
    const after  = assertReadOnly(fixturePath);

    assert.equal(after.mtime,  before.mtime,  'mtime must not change after parse()');
    assert.equal(after.sha256, before.sha256, 'sha256 must not change after parse()');

    // Sanity: the fixture has 3 bubbles and should produce 3 turns
    assert.ok(result.messages.length >= 1, 'fixture should produce at least 1 turn');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Factory adapter tests  (Phase 3d)
//
// Factory uses the identical Anthropic-Messages JSONL format as Claude Code,
// so the adapter simply re-exports claude-code.js. Tests verify the delegation
// and correct behaviour with Factory-specific data patterns (session_start line,
// system-reminder in user content, etc.).
// ═══════════════════════════════════════════════════════════════════════════════

describe('factory trimmer adapter', () => {
  // ── Inline fixtures ────────────────────────────────────────────────────────

  /**
   * Typical Factory session JSONL:
   *  - session_start entry (no message wrapper)
   *  - user message with <system-reminder> prefix (common in Factory)
   *  - assistant reply with thinking + tool_use + text blocks
   *  - user follow-up (plain text)
   *  - assistant reply (plain text only)
   */
  const FACTORY_TYPICAL_JSONL = [
    JSON.stringify({ type: 'session_start', id: 'fac-001', title: 'Fix login bug', owner: 'dev' }),
    JSON.stringify({
      type: 'message', id: 'fm1', timestamp: '2026-04-21T09:00:00.000Z',
      message: { role: 'user', content: [
        { type: 'text', text: '<system-reminder>\nSystem info here\n</system-reminder>' },
        { type: 'text', text: 'Why is the login form failing validation?' },
      ] },
    }),
    JSON.stringify({
      type: 'message', id: 'fm2', timestamp: '2026-04-21T09:00:05.000Z',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Internal reasoning about validation' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/src/login.js' } },
        { type: 'text', text: 'The issue is that the email regex is too strict.' },
      ] },
    }),
    JSON.stringify({
      type: 'message', id: 'fm3', timestamp: '2026-04-21T09:00:10.000Z',
      message: { role: 'user', content: 'Can you fix it?' },
    }),
    JSON.stringify({
      type: 'message', id: 'fm4', timestamp: '2026-04-21T09:00:15.000Z',
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Done! I updated the regex to accept plus signs in email addresses.' },
      ] },
    }),
  ].join('\n');

  /**
   * Tool-heavy Factory session: assistant only emits tool_use blocks, no text.
   */
  const FACTORY_TOOL_HEAVY_JSONL = [
    JSON.stringify({ type: 'session_start', id: 'fac-002', title: 'Batch rename' }),
    JSON.stringify({
      type: 'message', id: 'ft1', timestamp: '2026-04-21T10:00:00.000Z',
      message: { role: 'user', content: 'Rename all .txt files to .md' },
    }),
    JSON.stringify({
      type: 'message', id: 'ft2', timestamp: '2026-04-21T10:00:05.000Z',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'for f in *.txt; do mv "$f" "${f%.txt}.md"; done' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls *.md' } },
      ] },
    }),
    JSON.stringify({
      type: 'message', id: 'ft3', timestamp: '2026-04-21T10:00:08.000Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'bash1', content: 'file1.md file2.md' },
      ] },
    }),
  ].join('\n');

  /**
   * Malformed lines mixed into a Factory session.
   */
  const FACTORY_MALFORMED_JSONL = [
    JSON.stringify({ type: 'session_start', id: 'fac-003', title: 'Debug session' }),
    JSON.stringify({
      type: 'message', id: 'fm1', timestamp: '2026-04-21T11:00:00.000Z',
      message: { role: 'user', content: 'First good message' },
    }),
    '{ this is not valid JSON at all',
    'GARBAGE LINE',
    JSON.stringify({
      type: 'message', id: 'fm2', timestamp: '2026-04-21T11:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I understand the issue.' }] },
    }),
  ].join('\n');

  // ── Test 1: factory exports its own parse function ───────────────────────────

  it('module exports a parse function that is distinct from claude-code (Factory has type:message schema)', () => {
    const factoryMod = require('../src/trimmer/adapters/factory');
    assert.ok(typeof factoryMod.parse === 'function', 'factory adapter must export a parse function');
  });

  // ── Test 2: typical session ───────────────────────────────────────────────────

  it('typical session: keeps user+assistant text, drops session_start/thinking/tool_use', async () => {
    const result = await trimTranscript(FACTORY_TYPICAL_JSONL, 'factory');

    // session_start line has no message wrapper — should be dropped silently
    // user turns with system-reminder prefix still have the real text part
    const roles = result.messages.map(m => m.role);
    assert.ok(roles.includes('user'),      'should have user turns');
    assert.ok(roles.includes('assistant'), 'should have assistant turns');

    const allContent = result.messages.map(m => m.content).join(' ');
    assert.ok(!allContent.includes('Internal reasoning'), 'thinking content must be dropped');
    assert.ok(allContent.includes('email regex'),         'assistant natural text must survive');
    assert.ok(allContent.includes('Can you fix it'),      'plain user message must survive');

    assert.ok((result.stats.droppedCounts.thinking  || 0) >= 1, 'thinking blocks counted');
    assert.ok((result.stats.droppedCounts.tool_use  || 0) >= 1, 'tool_use blocks counted');
  });

  // ── Test 3: tool-heavy session ────────────────────────────────────────────────

  it('tool-heavy session: only the user message survives, tool_use/tool_result dropped', async () => {
    const result = await trimTranscript(FACTORY_TOOL_HEAVY_JSONL, 'factory');

    // The user message 'Rename all .txt…' should survive
    const userTurns = result.messages.filter(m => m.role === 'user');
    assert.ok(userTurns.length >= 1, 'user turn should survive');
    assert.ok(userTurns[0].content.includes('Rename all'), 'user text must be preserved');

    // No assistant turn because its content was entirely tool_use blocks
    const asstTurns = result.messages.filter(m => m.role === 'assistant');
    assert.equal(asstTurns.length, 0, 'pure-tool assistant turn should produce 0 assistant messages');

    // Dropped counts recorded
    assert.ok((result.stats.droppedCounts.tool_use    || 0) >= 2, 'tool_use blocks counted');
    assert.ok((result.stats.droppedCounts.tool_result || 0) >= 1, 'tool_result blocks counted');
  });

  // ── Test 4: malformed lines ───────────────────────────────────────────────────

  it('malformed lines: skipped with warning, valid messages still parse', async () => {
    const result = await trimTranscript(FACTORY_MALFORMED_JSONL, 'factory');

    // Should still produce the 2 valid message entries
    assert.ok(result.messages.length >= 2, `Expected ≥2 messages, got ${result.messages.length}`);

    // A warning should mention the bad JSON lines
    const warnText = result.warnings.join(' ');
    assert.ok(
      warnText.includes('failed JSON parsing') || warnText.includes('skipped'),
      `Expected parse-failure warning, got: ${warnText}`
    );
  });

  // ── Test 5: timestamps ────────────────────────────────────────────────────────

  it('timestamps carried through by default, omitted when includeTimestamps=false', async () => {
    const withTs = await trimTranscript(FACTORY_TYPICAL_JSONL, 'factory');
    assert.ok(withTs.messages.some(m => m.timestamp), 'timestamps expected by default');

    const noTs = await trimTranscript(FACTORY_TYPICAL_JSONL, 'factory', { includeTimestamps: false });
    assert.ok(noTs.messages.every(m => !m.timestamp), 'no timestamps when includeTimestamps=false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OpenCode adapter tests  (Phase 3d)
//
// All tests use in-memory { messages, parts } fixtures — no real storage paths.
// The in-memory path is activated when source is a plain object (not a string).
// ═══════════════════════════════════════════════════════════════════════════════

describe('opencode trimmer adapter', () => {
  const { parse: opencodeParse } = require('../src/trimmer/adapters/opencode');

  // ── Helpers ────────────────────────────────────────────────────────────────

  function makeFixture(messages, partsMap) {
    return {
      messages,
      parts: partsMap instanceof Map ? partsMap : new Map(Object.entries(partsMap)),
    };
  }

  // ── Test 1: typical sharded-JSON session (in-memory) ─────────────────────────

  it('typical sharded session: keeps user text + assistant text parts, drops tool/reasoning/step-*', async () => {
    const msgs = [
      { id: 'msg001', sessionID: 'ses_abc', role: 'user',      time: { created: 1000000000000 } },
      { id: 'msg002', sessionID: 'ses_abc', role: 'assistant', time: { created: 1000000001000 } },
      { id: 'msg003', sessionID: 'ses_abc', role: 'user',      time: { created: 1000000002000 } },
    ];

    const parts = new Map([
      ['msg001', [
        { id: 'prt001a', type: 'text', text: 'How do I parse JSON in Node.js?' },
      ]],
      ['msg002', [
        { id: 'prt002a', type: 'step-start', snapshot: 'abc' },
        { id: 'prt002b', type: 'reasoning', text: 'Internal reasoning about JSON.parse' },
        { id: 'prt002c', type: 'tool', tool: 'read_file', callID: 'c1', state: { status: 'completed', output: 'file' } },
        { id: 'prt002d', type: 'text', text: 'Use JSON.parse(). It throws on invalid input, so wrap in try/catch.' },
        { id: 'prt002e', type: 'step-finish', reason: 'stop' },
      ]],
      ['msg003', [
        { id: 'prt003a', type: 'text', text: 'What about JSON.stringify?' },
      ]],
    ]);

    const result = await opencodeParse(makeFixture(msgs, parts), {});

    assert.equal(result.messages.length, 3, 'should produce 3 CleanTurns');
    assert.equal(result.messages[0].role,    'user');
    assert.equal(result.messages[0].content, 'How do I parse JSON in Node.js?');
    assert.equal(result.messages[1].role,    'assistant');
    assert.ok(result.messages[1].content.includes('JSON.parse'), 'assistant text must survive');
    assert.equal(result.messages[2].role,    'user');
    assert.equal(result.messages[2].content, 'What about JSON.stringify?');

    // Dropped counts
    assert.ok((result.stats.droppedCounts['reasoning']   || 0) >= 1, 'reasoning parts counted');
    assert.ok((result.stats.droppedCounts['tool']        || 0) >= 1, 'tool parts counted');
    assert.ok((result.stats.droppedCounts['step-start']  || 0) >= 1, 'step-start parts counted');
    assert.ok((result.stats.droppedCounts['step-finish'] || 0) >= 1, 'step-finish parts counted');
  });

  // ── Test 2: assistant message with no text parts → dropped ───────────────────

  it('assistant message with only tool+reasoning parts produces no CleanTurn', async () => {
    const msgs = [
      { id: 'msg001', sessionID: 'ses_xyz', role: 'user',      time: { created: 2000000000000 } },
      { id: 'msg002', sessionID: 'ses_xyz', role: 'assistant', time: { created: 2000000001000 } },
    ];

    const parts = new Map([
      ['msg001', [
        { id: 'prt001a', type: 'text', text: 'Run the deploy script.' },
      ]],
      ['msg002', [
        { id: 'prt002a', type: 'step-start', snapshot: 'xyz' },
        { id: 'prt002b', type: 'tool', tool: 'bash_exec', callID: 'c2', state: { status: 'completed' } },
        { id: 'prt002c', type: 'step-finish', reason: 'tool-calls' },
      ]],
    ]);

    const result = await opencodeParse(makeFixture(msgs, parts), {});

    assert.equal(result.messages.length, 1, 'only the user turn should survive');
    assert.equal(result.messages[0].role, 'user');
    assert.ok((result.stats.droppedCounts['tool'] || 0) >= 1, 'tool parts should be counted');
  });

  // ── Test 3: messages sorted chronologically ──────────────────────────────────

  it('messages with out-of-order creation times are sorted chronologically', async () => {
    const msgs = [
      { id: 'msgC', sessionID: 'ses_sort', role: 'assistant', time: { created: 3000000002000 } },
      { id: 'msgA', sessionID: 'ses_sort', role: 'user',      time: { created: 3000000000000 } },
      { id: 'msgB', sessionID: 'ses_sort', role: 'assistant', time: { created: 3000000001000 } },
    ];

    const parts = new Map([
      ['msgA', [{ id: 'pA', type: 'text', text: 'First user message'    }]],
      ['msgB', [{ id: 'pB', type: 'text', text: 'First assistant reply' }]],
      ['msgC', [{ id: 'pC', type: 'text', text: 'Second assistant text' }]],
    ]);

    const result = await opencodeParse(makeFixture(msgs, parts), {});

    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].content, 'First user message',    'earliest message first');
    assert.equal(result.messages[1].content, 'First assistant reply', 'second message next');
    assert.equal(result.messages[2].content, 'Second assistant text', 'latest message last');
  });

  // ── Test 4: messages with empty / missing text parts ─────────────────────────

  it('messages with empty text parts produce no CleanTurn (not an error)', async () => {
    const msgs = [
      { id: 'msgBlank', sessionID: 'ses_blank', role: 'user', time: { created: 4000000000000 } },
      { id: 'msgGood',  sessionID: 'ses_blank', role: 'user', time: { created: 4000000001000 } },
    ];

    const parts = new Map([
      ['msgBlank', [{ id: 'pBlank', type: 'text', text: '   ' }]], // whitespace-only
      ['msgGood',  [{ id: 'pGood',  type: 'text', text: 'Real question here' }]],
    ]);

    const result = await opencodeParse(makeFixture(msgs, parts), {});

    assert.equal(result.messages.length, 1, 'only the non-empty message survives');
    assert.equal(result.messages[0].content, 'Real question here');
    assert.equal(result.warnings.length, 0, 'no warnings for empty parts — they are silently skipped');
  });

  // ── Test 5: timestamps ────────────────────────────────────────────────────────

  it('timestamps are ISO-8601 strings when includeTimestamps is not false', async () => {
    const msgs = [
      { id: 'msgTs', sessionID: 'ses_ts', role: 'user', time: { created: 1771223272967 } },
    ];
    const parts = new Map([['msgTs', [{ id: 'pTs', type: 'text', text: 'Hello' }]]]);

    const withTs = await opencodeParse(makeFixture(msgs, parts), {});
    assert.ok(withTs.messages[0].timestamp, 'timestamp should be present');
    assert.ok(/\d{4}-\d{2}-\d{2}T/.test(withTs.messages[0].timestamp), 'should be ISO-8601');

    const noTs = await opencodeParse(makeFixture(msgs, parts), { includeTimestamps: false });
    assert.ok(!noTs.messages[0].timestamp, 'no timestamp when includeTimestamps=false');
  });

  // ── Test 6: invalid source → warning, empty result ───────────────────────────

  it('non-string non-object source returns empty result with warning', async () => {
    const result = await opencodeParse(null, {});
    assert.equal(result.messages.length, 0);
    assert.ok(result.warnings.length > 0, 'should emit a warning for null source');
  });
});
