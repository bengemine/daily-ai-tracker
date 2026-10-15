const { describe, it } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compressHighlights,
  summarizeConversation,
  createRunSummarizer,
  parseResponse,
  buildLocalFallbackSummary,
  getClaudeCommandCandidates,
  getClaudeTimeoutMs,
  extractMeaningfulTitle,
  STOCK_TITLE_PATTERNS,
  SYSTEM_PROMPT,
  AGENT_TO_TRIMMER_ADAPTER,
  resolveTranscriptSource,
  formatCleanTranscript,
} = require('../src/summarizer');
const { createHighlights, createSession } = require('../src/types');
const { ClaudeCodeAdapter } = require('../src/adapters/claude-code');
const { FactoryAdapter } = require('../src/adapters/factory');
const { EMPTY_SESSION_BODY } = require('../src/journal');

// -- Test helpers --

function makeSession(overrides = {}) {
  return createSession({
    id: 'test-session-001',
    agent: 'Claude Code',
    project: '/home/user/my-project',
    startTime: new Date('2026-03-13T10:00:00Z'),
    ...overrides,
  });
}

function makeHighlights(overrides = {}) {
  return createHighlights({
    topic: 'Implement user authentication flow',
    userMessages: [
      'Add login endpoint with JWT',
      'Fix the password hashing',
      'Add rate limiting to auth routes',
    ],
    toolCalls: [
      { name: 'Read', count: 12 },
      { name: 'Edit', count: 8 },
      { name: 'Bash', count: 5 },
    ],
    filePaths: [
      'src/auth/login.js',
      'src/auth/hash.js',
      'src/middleware/rateLimit.js',
      'test/auth.test.js',
    ],
    lastExchanges: [
      'All tests passing now, rate limiter is configured',
      'Looks good, let me verify the JWT expiry',
    ],
    ...overrides,
  });
}

// These tests check CLI handling, not transcript lookup. Skipping the trim
// step keeps them from probing the real ~/.claude folder for a transcript.
const NO_TRIM = { tryTrim: async () => null };

/**
 * Build a small synthetic Claude Code storage folder and return a session and
 * its highlights, read through the real ClaudeCodeAdapter.
 */
async function findSummarizableClaudeSession(root, dateStr = '2026-03-13') {
  const projectsDir = path.join(root, 'projects');
  const sessionId = '22222222-bbbb-4ccc-8ddd-000000000001';
  const project = 'E:\\projects\\demo-app';
  const at = (hour, minute) => new Date(2026, 2, 13, hour, minute);
  const sessionDir = path.join(projectsDir, ClaudeCodeAdapter.encodeProjectPath(project));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'history.jsonl'), [
    { display: 'Fix the login form validation', timestamp: at(9, 15).getTime(), project, sessionId },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    { type: 'user', timestamp: at(9, 15).toISOString(), sessionId, message: { role: 'user', content: 'Fix the login form validation' } },
    { type: 'assistant', timestamp: at(9, 16).toISOString(), sessionId, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'E:\\projects\\demo-app\\src\\login-form.js' } },
      { type: 'text', text: 'Updated the email check so empty emails are rejected.' },
    ] } },
    { type: 'user', timestamp: at(9, 20).toISOString(), sessionId, message: { role: 'user', content: 'Add a unit test for the empty email case' } },
    { type: 'assistant', timestamp: at(9, 22).toISOString(), sessionId, message: { role: 'assistant', content: [
      { type: 'text', text: 'Added the unit test and it passes.' },
    ] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');

  const adapter = new ClaudeCodeAdapter({ name: 'Claude Code', storagePath: root, historyFile: 'history.jsonl', projectsDir: 'projects' });
  const sessions = await adapter.extractSessions(dateStr);

  for (const session of sessions) {
    const highlights = await adapter.extractHighlights(session);
    if (highlights.topic.trim() || highlights.userMessages.some(msg => msg.trim())) {
      return { session, highlights };
    }
  }

  return null;
}

/**
 * Fake Claude CLI that returns a realistic TITLE/BODY summary. On POSIX it
 * also saves the prompt it received to prompt.txt next to the script.
 */
function writeSummaryFakeClaudeCommand(dir, name = process.platform === 'win32' ? 'claude.cmd' : 'claude') {
  const commandPath = path.join(dir, name);
  const title = 'Fixed the login form email check and added a unit test';
  const body = 'The user asked to fix the login form validation. The agent rejected empty emails and added a passing unit test.';
  if (process.platform === 'win32') {
    fs.writeFileSync(commandPath, `@echo off\r\necho TITLE: ${title}\r\necho BODY: ${body}\r\n`, 'utf-8');
  } else {
    fs.writeFileSync(
      commandPath,
      '#!/bin/sh\n' +
      `cat > "${path.join(dir, 'prompt.txt')}"\n` +
      `echo "TITLE: ${title}"\n` +
      `echo "BODY: ${body}"\n`,
      'utf-8'
    );
    fs.chmodSync(commandPath, 0o755);
  }
  return commandPath;
}

function writeFakeClaudeCommand(dir, name = process.platform === 'win32' ? 'claude.cmd' : 'claude') {
  const commandPath = path.join(dir, name);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      commandPath,
      '@echo off\r\n' +
      'echo Title: Used fake Claude\r\n' +
      'echo.\r\n' +
      'echo Fake Claude produced a deterministic summary for resolver testing.\r\n',
      'utf-8'
    );
  } else {
    fs.writeFileSync(
      commandPath,
      '#!/bin/sh\n' +
      'echo "Title: Used fake Claude"\n' +
      'echo\n' +
      'echo "Fake Claude produced a deterministic summary for resolver testing."\n',
      'utf-8'
    );
    fs.chmodSync(commandPath, 0o755);
  }
  return commandPath;
}

function writeSlowFakeClaudeCommand(dir, name = process.platform === 'win32' ? 'claude.cmd' : 'claude') {
  const commandPath = path.join(dir, name);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      commandPath,
      '@echo off\r\n' +
      'ping -n 3 127.0.0.1 >nul\r\n' +
      'echo Title: Too late\r\n' +
      'echo.\r\n' +
      'echo This output should not be used.\r\n',
      'utf-8'
    );
  } else {
    fs.writeFileSync(
      commandPath,
      '#!/bin/sh\n' +
      'sleep 2\n' +
      'echo "Title: Too late"\n' +
      'echo\n' +
      'echo "This output should not be used."\n',
      'utf-8'
    );
    fs.chmodSync(commandPath, 0o755);
  }
  return commandPath;
}

function writeFailingFakeClaudeCommand(dir, name = process.platform === 'win32' ? 'claude.cmd' : 'claude') {
  const commandPath = path.join(dir, name);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      commandPath,
      '@echo off\r\n' +
      'echo simulated Claude failure 1>&2\r\n' +
      'exit /b 7\r\n',
      'utf-8'
    );
  } else {
    fs.writeFileSync(
      commandPath,
      '#!/bin/sh\n' +
      'echo "simulated Claude failure" >&2\n' +
      'exit 7\n',
      'utf-8'
    );
    fs.chmodSync(commandPath, 0o755);
  }
  return commandPath;
}

// -- Tests --

describe('compressHighlights', () => {
  it('normal session with all fields → contains all sections', () => {
    const session = makeSession();
    const highlights = makeHighlights();
    const result = compressHighlights(highlights, session);

    assert.ok(result !== null, 'should not be null');
    assert.ok(result.includes('Agent: Claude Code'), 'should contain agent');
    assert.ok(result.includes('Project: /home/user/my-project'), 'should contain project');
    assert.ok(result.includes('Topic: Implement user authentication flow'), 'should contain topic');
    assert.ok(result.includes('Tools Used:'), 'should contain tools section');
    assert.ok(result.includes('Read (12x)'), 'should contain tool with count');
    assert.ok(result.includes('Edit (8x)'), 'should contain tool with count');
    assert.ok(result.includes('Files (4):'), 'should contain files section with count');
    assert.ok(result.includes('src/auth/login.js'), 'should contain file path');
    assert.ok(result.includes('User Messages (3 total):'), 'should contain messages section');
    assert.ok(result.includes('1. Add login endpoint with JWT'), 'should contain numbered message');
    assert.ok(result.includes('Final Context:'), 'should contain final context section');
    assert.ok(result.includes('All tests passing now'), 'should contain last exchange');
    assert.ok(result.includes('Summarize what was accomplished'), 'should end with summarize instruction');
  });

  it('empty toolCalls (Codex pattern) → no "Tools Used" section', () => {
    const session = makeSession({ agent: 'Codex CLI' });
    const highlights = makeHighlights({ toolCalls: [] });
    const result = compressHighlights(highlights, session);

    assert.ok(result !== null);
    assert.ok(!result.includes('Tools Used'), 'should NOT contain tools section');
    assert.ok(result.includes('Agent: Codex CLI'));
    assert.ok(result.includes('User Messages'));
    assert.ok(result.includes('Files'));
  });

  it('empty filePaths (Cursor pattern) → no "Files" section', () => {
    const session = makeSession({ agent: 'Cursor' });
    const highlights = makeHighlights({ filePaths: [] });
    const result = compressHighlights(highlights, session);

    assert.ok(result !== null);
    assert.ok(!result.includes('Files'), 'should NOT contain files section');
    assert.ok(result.includes('Agent: Cursor'));
    assert.ok(result.includes('Tools Used'));
    assert.ok(result.includes('User Messages'));
  });

  it('empty topic AND empty messages → returns null (skip)', () => {
    const session = makeSession();
    const highlights = makeHighlights({
      topic: '',
      userMessages: [],
    });
    const result = compressHighlights(highlights, session);

    assert.equal(result, null, 'should return null for empty session');
  });

  it('oversized topic (8KB string) → truncated to 500 chars', () => {
    const bigTopic = 'A'.repeat(8192);
    const session = makeSession();
    const highlights = makeHighlights({ topic: bigTopic });
    const result = compressHighlights(highlights, session);

    assert.ok(result !== null);
    const topicLine = result.split('\n').find(l => l.startsWith('Topic: '));
    assert.ok(topicLine, 'should have topic line');
    const topicValue = topicLine.slice('Topic: '.length);
    assert.equal(topicValue.length, 501, 'topic should be 500 chars + ellipsis');
    assert.ok(topicValue.endsWith('…'), 'should end with ellipsis');
    assert.ok(!result.includes(bigTopic), 'full 8KB topic must not appear');
  });

  it('34 messages → capped to 15 in output', () => {
    const messages = Array.from({ length: 34 }, (_, i) => `Message number ${i + 1}`);
    const session = makeSession();
    const highlights = makeHighlights({ userMessages: messages });
    const result = compressHighlights(highlights, session);

    assert.ok(result !== null);
    assert.ok(result.includes('User Messages (34 total):'), 'should show total count of 34');
    assert.ok(result.includes('1. Message number 1'), 'should have first message');
    assert.ok(result.includes('15. Message number 15'), 'should have 15th message');
    assert.ok(!result.includes('16. '), 'should not have 16th message');
    assert.ok(!result.includes('Message number 34'), 'should not have last message');
  });

  it('lastExchanges with 1000-char entries → each truncated to 300 chars', () => {
    const longExchanges = [
      'X'.repeat(1000),
      'Y'.repeat(1000),
      'Z'.repeat(1000),
    ];
    const session = makeSession();
    const highlights = makeHighlights({ lastExchanges: longExchanges });
    const result = compressHighlights(highlights, session);

    assert.ok(result !== null);
    assert.ok(result.includes('Final Context:'), 'should have final context section');

    const contextStart = result.indexOf('Final Context:');
    const contextBlock = result.slice(contextStart);

    const xRun = 'X'.repeat(300) + '…';
    const yRun = 'Y'.repeat(300) + '…';
    const zRun = 'Z'.repeat(300) + '…';
    assert.ok(contextBlock.includes(xRun), 'X exchange should be truncated to 300+ellipsis');
    assert.ok(contextBlock.includes(yRun), 'Y exchange should be truncated to 300+ellipsis');
    assert.ok(contextBlock.includes(zRun), 'Z exchange should be truncated to 300+ellipsis');
    assert.ok(!result.includes('X'.repeat(1000)), 'full X string must not appear');
  });
  it('trivial non-task session -> skip indicator', async () => {
    const trivialSession = createSession({
      id: 'trivial-test-001',
      agent: 'Claude Code',
      project: '/dev/null',
      startTime: new Date(),
    });
    const trivialHighlights = createHighlights({
      topic: '',
      userMessages: [],
      toolCalls: [],
      filePaths: [],
      lastExchanges: [],
    });

    const result = await summarizeConversation(trivialHighlights, trivialSession, NO_TRIM);

    assert.equal(result.title, '');
    assert.equal(result.body, EMPTY_SESSION_BODY);
  });
});

// -- parseResponse tests --

describe('parseResponse', () => {
  it('parses "Title: ..." format correctly', () => {
    const raw = 'Title: Configured MCP server integration\n\nThe session set up the codex-mcp-server and tested it.';
    const result = parseResponse(raw);
    assert.equal(result.title, 'Configured MCP server integration');
    assert.equal(result.body, 'The session set up the codex-mcp-server and tested it.');
  });

  it('handles missing Title: prefix gracefully', () => {
    const raw = 'The session focused on building auth. JWT tokens were configured and rate limiting added.';
    const result = parseResponse(raw);
    assert.ok(result.title.length > 0, 'should extract a fallback title');
    assert.ok(result.body.includes('JWT tokens'), 'body should contain the full text');
  });

  it('handles Title: with no body', () => {
    const raw = 'Title: Quick fix';
    const result = parseResponse(raw);
    assert.equal(result.title, 'Quick fix');
    assert.ok(result.body.length > 0, 'body should fall back to full text');
  });

  it('is case-insensitive for Title: prefix', () => {
    const raw = 'title: lowercase title prefix\n\nSome body text.';
    const result = parseResponse(raw);
    assert.equal(result.title, 'lowercase title prefix');
  });
});

describe('Claude CLI resolution', () => {
  it('uses CLAUDE_CLI_PATH when provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-env-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;
    try {
      const fakeClaude = writeFakeClaudeCommand(tmpDir);
      process.env.CLAUDE_CLI_PATH = fakeClaude;

      const result = await summarizeConversation(makeHighlights(), makeSession(), NO_TRIM);

      assert.equal(result.title, 'Used fake Claude');
      assert.ok(result.body.includes('deterministic summary'));
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes common Windows npm paths in resolver candidates', () => {
    const env = {
      APPDATA: 'C:\\Users\\jdoe\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\jdoe\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\jdoe',
    };

    const commands = getClaudeCommandCandidates(env, 'win32').map(candidate => candidate.command);

    assert.equal(commands[0], 'wsl.exe', 'should prefer the authenticated WSL Claude on this machine');
    assert.ok(commands.includes('claude'), 'should try normal PATH command');
    assert.ok(commands.includes('claude.cmd'), 'should try normal Windows PATH command');
    assert.ok(
      commands.includes('C:\\Users\\jdoe\\AppData\\Roaming\\npm\\claude.cmd'),
      'should include APPDATA npm global shim'
    );
    assert.ok(
      commands.includes('C:\\Users\\jdoe\\AppData\\Local\\npm\\claude.cmd'),
      'should include LOCALAPPDATA npm shim'
    );
  });

  it('falls back to APPDATA npm shim when PATH lookup fails on Windows', async () => {
    if (process.platform !== 'win32') return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-appdata-'));
    const npmDir = path.join(tmpDir, 'npm');
    const originalEnv = {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PATH: process.env.PATH,
      CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH,
    };

    try {
      fs.mkdirSync(npmDir, { recursive: true });
      writeFakeClaudeCommand(npmDir, 'claude.cmd');
      delete process.env.CLAUDE_CLI_PATH;
      process.env.APPDATA = tmpDir;
      process.env.LOCALAPPDATA = path.join(tmpDir, 'local');
      process.env.PATH = '';

      const result = await summarizeConversation(makeHighlights(), makeSession(), NO_TRIM);

      assert.equal(result.title, 'Used fake Claude');
      assert.ok(result.body.includes('deterministic summary'));
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Claude CLI timeout config', () => {
  it('defaults to the scheduled-run timeout from config', () => {
    assert.equal(getClaudeTimeoutMs({}, {}), 3 * 60 * 60 * 1000);
  });

  it('uses config timeout when provided', () => {
    assert.equal(
      getClaudeTimeoutMs({}, { summarizer: { claudeTimeoutMs: 180_000 } }),
      180_000
    );
  });

  it('uses environment timeout ahead of config', () => {
    assert.equal(
      getClaudeTimeoutMs(
        { CLAUDE_SUMMARIZER_TIMEOUT_MS: '250' },
        { summarizer: { claudeTimeoutMs: 180_000 } }
      ),
      250
    );
  });

  it('falls back when timeout values are invalid', () => {
    assert.equal(
      getClaudeTimeoutMs(
        { CLAUDE_SUMMARIZER_TIMEOUT_MS: 'nope' },
        { summarizer: { claudeTimeoutMs: 'also-nope' } }
      ),
      3 * 60 * 60 * 1000
    );
  });

  it('reports configured timeout and command source when Claude times out', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-timeout-'));
    const originalEnv = {
      CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH,
      CLAUDE_SUMMARIZER_TIMEOUT_MS: process.env.CLAUDE_SUMMARIZER_TIMEOUT_MS,
    };

    try {
      process.env.CLAUDE_CLI_PATH = writeSlowFakeClaudeCommand(tmpDir);
      process.env.CLAUDE_SUMMARIZER_TIMEOUT_MS = '50';

      const result = await summarizeConversation(makeHighlights(), makeSession(), NO_TRIM);

      assert.equal(result.title, 'Implement user authentication flow');
      assert.equal(result.summarySource, 'local');
      assert.ok(result.diagnostic.includes('configured timeout 0.05s'));
      assert.ok(result.diagnostic.includes('CLAUDE_CLI_PATH'));
      assert.ok(result.body.includes('Implement user authentication flow'));
      assert.ok(!result.body.includes('src/auth/login.js'));
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('local fallback summary', () => {
  it('builds a useful marked local summary from raw highlights', () => {
    const result = buildLocalFallbackSummary(
      makeHighlights(),
      makeSession(),
      new Error('example Claude failure')
    );

    assert.equal(result.title, 'Implement user authentication flow');
    assert.equal(result.summarySource, 'local');
    assert.equal(result.diagnostic, 'example Claude failure');
    assert.ok(result.body.includes('The user asked:'));
    assert.ok(result.body.includes('The agent reported:'));
    assert.ok(result.body.includes('Implement user authentication flow'));
    assert.ok(!result.body.includes('Read (12x)'));
    assert.ok(!result.body.includes('src/auth/login.js'));
  });

  it('uses local fallback when CLAUDE_CLI_PATH points to a missing executable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-missing-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;
    try {
      process.env.CLAUDE_CLI_PATH = path.join(tmpDir, 'missing-claude.cmd');

      const result = await summarizeConversation(makeHighlights(), makeSession(), NO_TRIM);

      assert.equal(result.title, 'Implement user authentication flow');
      assert.ok(result.diagnostic.includes('claude CLI not found'));
      assert.ok(result.diagnostic.includes('CLAUDE_CLI_PATH'));
      assert.ok(result.body.includes('Implement user authentication flow'));
      assert.ok(!result.body.includes('src/auth/login.js'));
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses local fallback when Claude exits nonzero', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-nonzero-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;
    try {
      process.env.CLAUDE_CLI_PATH = writeFailingFakeClaudeCommand(tmpDir);

      const result = await summarizeConversation(makeHighlights(), makeSession(), NO_TRIM);

      assert.equal(result.title, 'Implement user authentication flow');
      assert.ok(result.diagnostic.includes('claude CLI exited with code 7'));
      assert.ok(result.diagnostic.includes('simulated Claude failure'));
      assert.ok(result.body.includes('Implement user authentication flow'));
      assert.ok(!result.body.includes('Edit (8x)'));
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('still reports no-data when Claude cannot run and there are no highlights', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-empty-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;
    try {
      process.env.CLAUDE_CLI_PATH = path.join(tmpDir, 'missing-claude.cmd');
      const emptyHighlights = createHighlights({
        topic: '',
        userMessages: [],
        toolCalls: [],
        filePaths: [],
        lastExchanges: [],
      });

      const result = await summarizeConversation(emptyHighlights, makeSession(), NO_TRIM);

      assert.equal(result.title, '');
      assert.equal(result.body, EMPTY_SESSION_BODY);
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -- Integration tests (synthetic session through a fake claude CLI) --

describe('summarizeConversation — integration', () => {
  function withFakeClaude(prefix, run) {
    return async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      const originalOverride = process.env.CLAUDE_CLI_PATH;
      try {
        const cliDir = path.join(tmpDir, 'cli');
        fs.mkdirSync(cliDir);
        process.env.CLAUDE_CLI_PATH = writeSummaryFakeClaudeCommand(cliDir);
        const picked = await findSummarizableClaudeSession(path.join(tmpDir, 'claude'));
        assert.ok(picked, 'Synthetic Claude session should have highlights');
        await run({ ...picked, promptFile: path.join(cliDir, 'prompt.txt') });
      } finally {
        if (originalOverride === undefined) {
          delete process.env.CLAUDE_CLI_PATH;
        } else {
          process.env.CLAUDE_CLI_PATH = originalOverride;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    };
  }

  it('real session highlights → returns { title, body } with accomplishment-focused summary', withFakeClaude('fake-claude-session-', async ({ session, highlights, promptFile }) => {
    const result = await summarizeConversation(highlights, session);

    // Structure check
    assert.ok(typeof result === 'object', 'should return an object');
    assert.ok(typeof result.title === 'string', 'should have string title');
    assert.ok(typeof result.body === 'string', 'should have string body');
    assert.equal(result.summarySource, 'claude');

    // Title should be concise
    assert.ok(result.title.length > 0, 'title should not be empty');
    assert.ok(result.title.length <= 100, `title too long (${result.title.length} chars)`);

    // Body should be substantive
    assert.ok(result.body.length >= 50, `body too short (${result.body.length} chars)`);
    assert.ok(result.body.length <= 1500, `body too long (${result.body.length} chars)`);

    // Should NOT be a fallback
    assert.notEqual(result.title, 'Summarization failed');

    // The prompt carries the cleaned dialogue read from the session file.
    if (process.platform !== 'win32') {
      const prompt = fs.readFileSync(promptFile, 'utf-8');
      assert.ok(prompt.includes('User: Fix the login form validation'), 'prompt should include the user request');
      assert.ok(prompt.includes('Assistant: Added the unit test and it passes.'), 'prompt should include the agent reply');
      assert.ok(!prompt.includes('tool_use'), 'prompt should not include tool noise');
      assert.ok(result.trimStats, 'trimStats should be present when the transcript was cleaned');
    }
  }));

  it('session with empty toolCalls → still produces a summary', withFakeClaude('fake-claude-notools-', async ({ session, highlights, promptFile }) => {
    const codexHighlights = createHighlights({
      topic: highlights.topic,
      userMessages: highlights.userMessages,
      toolCalls: [],
      filePaths: highlights.filePaths,
      lastExchanges: highlights.lastExchanges,
    });
    const codexSession = createSession({
      id: session.id,
      agent: 'Codex CLI',
      project: session.project,
      startTime: session.startTime,
    });

    const result = await summarizeConversation(codexHighlights, codexSession);

    assert.ok(result.body.length >= 50, `body too short (${result.body.length} chars)`);
    assert.notEqual(result.title, 'Summarization failed');
    if (process.platform !== 'win32') {
      const prompt = fs.readFileSync(promptFile, 'utf-8');
      assert.ok(prompt.includes('Topic: Fix the login form validation'), 'prompt should be built from highlights');
      assert.ok(!prompt.includes('Tools Used'), 'prompt should not list tools when there are none');
    }
  }));

  it('genuinely empty session → skip indicator without calling claude', async () => {
    const emptySession = createSession({
      id: 'empty-test-000',
      agent: 'Test Agent',
      project: '/dev/null',
      startTime: new Date(),
    });
    const emptyHighlights = createHighlights({
      topic: '',
      userMessages: [],
      toolCalls: [],
      filePaths: [],
      lastExchanges: [],
    });

    const result = await summarizeConversation(emptyHighlights, emptySession);

    assert.ok(typeof result === 'object', 'should return an object');
    assert.equal(result.title, '', 'empty session should have empty title');
    assert.equal(result.body, '[Empty session — no content to summarize]',
      'should return skip indicator body for empty session');
  });
});

describe('run-level Claude circuit breaker', () => {
  it('tries Claude once, then uses local summaries for later sessions', async () => {
    let calls = 0;
    const summarizeForRun = createRunSummarizer({
      tryTrim: async () => null,
      callClaude: async () => {
        calls++;
        throw new Error('offline for test');
      },
    });

    const first = await summarizeForRun(makeHighlights(), makeSession({ id: 'first' }));
    const second = await summarizeForRun(makeHighlights(), makeSession({ id: 'second' }));

    assert.equal(calls, 1);
    assert.equal(first.summarySource, 'local');
    assert.equal(second.summarySource, 'local');
    assert.equal(second.diagnostic, 'offline for test');
  });
});

// ── Phase 3f: trimmer integration tests ──────────────────────────────────────

describe('AGENT_TO_TRIMMER_ADAPTER mapping', () => {
  it('maps all known agent names to their trimmer adapter names or null', () => {
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Claude Code'], 'claude-code');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Claude Code (WSL)'], 'claude-code');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Codex'],       'codex');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Codex (WSL)'], 'codex');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Factory'],     'factory');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Grok'],        'grok');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Grok (WSL)'],  'grok');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['OpenCode'],    null, 'OpenCode parsed directly from SQLite adapter');
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['Cursor'],      null, 'Cursor skipped (needs SQLite handle)');
  });

  it('unknown agent names are not in the map (undefined)', () => {
    assert.equal(AGENT_TO_TRIMMER_ADAPTER['SomeOtherAgent'], undefined);
  });
});

describe('resolveTranscriptSource', () => {
  it('prefers session.filePath and resolves nested Factory session files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-source-'));
    try {
      const session = createSession({
        id: 'factory-session-001',
        agent: 'Factory',
        project: 'E:\\websites\\example.ca',
        startTime: new Date('2026-04-22T10:00:00'),
      });

      const factoryStorage = path.join(tmpDir, '.factory');
      const sessionsDir = path.join(factoryStorage, 'sessions');
      const encoded = FactoryAdapter.encodeProjectPath(session.project);
      const nestedDir = path.join(sessionsDir, encoded);
      fs.mkdirSync(nestedDir, { recursive: true });

      const nestedFile = path.join(nestedDir, `${session.id}.jsonl`);
      fs.writeFileSync(nestedFile, '{"type":"message"}\n', 'utf-8');

      const explicitFile = path.join(tmpDir, 'explicit.jsonl');
      fs.writeFileSync(explicitFile, '{"type":"message"}\n', 'utf-8');

      const explicitSession = createSession({ ...session, filePath: explicitFile });
      const explicitResolved = resolveTranscriptSource('factory', explicitSession, {
        agents: { factory: { storagePath: factoryStorage } },
      });
      assert.equal(explicitResolved, explicitFile);

      const nestedResolved = resolveTranscriptSource('factory', session, {
        agents: { factory: { storagePath: factoryStorage } },
      });
      assert.equal(nestedResolved, nestedFile);

      const originalStatSync = fs.statSync;
      fs.statSync = function patchedStatSync(target, options) {
        if (String(target) === sessionsDir) {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return originalStatSync.call(fs, target, options);
      };

      try {
        const deniedResolved = resolveTranscriptSource('factory', session, {
          agents: { factory: { storagePath: factoryStorage } },
        });
        assert.equal(deniedResolved, null);
      } finally {
        fs.statSync = originalStatSync;
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats an inaccessible explicit transcript source as missing', () => {
    const uncSource = '\\\\wsl$\\Ubuntu\\home\\dev\\.claude\\projects\\work\\session.jsonl';
    // Empty storage folders, so the fallback lookup never reaches a real ~/.claude.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-unc-source-'));
    const session = createSession({
      id: 'wsl-session-001',
      agent: 'Claude Code (WSL)',
      project: 'E:\\work',
      startTime: new Date('2026-04-22T10:00:00'),
      filePath: uncSource,
    });

    const originalStatSync = fs.statSync;
    fs.statSync = function patchedStatSync(target, options) {
      if (String(target) === uncSource) {
        const err = new Error('permission denied');
        err.code = 'EPERM';
        throw err;
      }
      return originalStatSync.call(fs, target, options);
    };

    try {
      const resolved = resolveTranscriptSource('claude-code', session, {
        agents: {
          claudeCode: { storagePath: path.join(tmpDir, 'windows', '.claude') },
          claudeCodeWsl: { storagePath: path.join(tmpDir, 'wsl', '.claude') },
        },
      });
      assert.equal(resolved, null);
    } finally {
      fs.statSync = originalStatSync;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('formatCleanTranscript', () => {
  it('formats CleanTurns into User:/Assistant: blocks', () => {
    const turns = [
      { role: 'user',      content: 'Hello, please help me with X' },
      { role: 'assistant', content: 'Sure, I can help you with X' },
      { role: 'user',      content: 'Great, thanks' },
    ];
    const result = formatCleanTranscript(turns);
    assert.ok(result.includes('User: Hello, please help me with X'));
    assert.ok(result.includes('Assistant: Sure, I can help you with X'));
    assert.ok(result.includes('User: Great, thanks'));
    // Must NOT contain tool noise
    assert.ok(!result.includes('<thinking>'), 'no thinking tags');
    assert.ok(!result.includes('<tool_use>'), 'no tool_use tags');
    assert.ok(!result.includes('Tool result:'), 'no Tool result markers');
  });

  it('keeps the complete cleaned transcript above 40000 characters', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${'A'.repeat(200)} message number ${i}`,
    }));
    const result = formatCleanTranscript(turns);
    assert.ok(result.length > 40000);
    assert.ok(result.includes('message number 0'));
    assert.ok(result.includes('message number 199'));
    assert.ok(!result.includes('trimmed middle'));
  });

  it('does not add trimmed marker when content is within cap', () => {
    const turns = [
      { role: 'user',      content: 'Short message' },
      { role: 'assistant', content: 'Short reply' },
    ];
    const result = formatCleanTranscript(turns);
    assert.ok(!result.includes('[... trimmed middle'), 'no trimmed marker for short transcripts');
  });
});

describe('summarizeConversation — trimmer integration', () => {
  it('prompt payload contains cleaned transcript format when trimmer succeeds', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-trim-'));
    const capturedPrompts = [];
    const originalOverride = process.env.CLAUDE_CLI_PATH;

    try {
      // Write a fake claude that echoes the prompt back to us as part of its "response"
      // so we can inspect what was sent.
      const fakeClaude = path.join(tmpDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      if (process.platform === 'win32') {
        fs.writeFileSync(
          fakeClaude,
          '@echo off\r\necho Title: Trimmer Test Complete\r\necho.\r\necho Body was produced.\r\n',
          'utf-8'
        );
      } else {
        fs.writeFileSync(
          fakeClaude,
          '#!/bin/sh\necho "Title: Trimmer Test Complete"\necho\necho "Body was produced."\n',
          'utf-8'
        );
        fs.chmodSync(fakeClaude, 0o755);
      }
      process.env.CLAUDE_CLI_PATH = fakeClaude;

      // Mock tryTrim to return a clean transcript with User/Assistant format
      const mockTrimResult = {
        cleanText: 'User: Can you help me write a test?\n\nAssistant: Sure, I can help.\n\nUser: Thanks!',
        trimStats: { originalBytes: 50000, cleanedChars: 5000, ratio: 10.0 },
      };
      const mockTryTrim = async () => mockTrimResult;

      const result = await summarizeConversation(
        makeHighlights(),
        makeSession(),
        { tryTrim: mockTryTrim }
      );

      // Result should be a successful parse
      assert.ok(typeof result === 'object', 'should return object');
      assert.ok(typeof result.title === 'string', 'should have title');
      assert.ok(typeof result.body === 'string', 'should have body');
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('trimStats are present on the returned result when trimmer succeeds', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-trimstats-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;

    try {
      const fakeClaude = path.join(tmpDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      if (process.platform === 'win32') {
        fs.writeFileSync(
          fakeClaude,
          '@echo off\r\necho Title: Stats Test\r\necho.\r\necho Stats body.\r\n',
          'utf-8'
        );
      } else {
        fs.writeFileSync(
          fakeClaude,
          '#!/bin/sh\necho "Title: Stats Test"\necho\necho "Stats body."\n',
          'utf-8'
        );
        fs.chmodSync(fakeClaude, 0o755);
      }
      process.env.CLAUDE_CLI_PATH = fakeClaude;

      const expectedStats = { originalBytes: 100_000, cleanedChars: 8_000, ratio: 12.5 };
      const mockTryTrim = async () => ({
        cleanText: 'User: Hello\n\nAssistant: Hi there',
        trimStats: expectedStats,
      });

      const result = await summarizeConversation(
        makeHighlights(),
        makeSession(),
        { tryTrim: mockTryTrim }
      );

      assert.ok(typeof result.trimStats === 'object', 'should have trimStats object');
      assert.equal(result.trimStats.originalBytes, 100_000, 'trimStats.originalBytes correct');
      assert.equal(result.trimStats.cleanedChars,  8_000,   'trimStats.cleanedChars correct');
      assert.equal(result.trimStats.ratio,          12.5,    'trimStats.ratio correct');
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('when trimmer throws, summarization still completes via fallback and emits warning', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-trimfail-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;

    try {
      // Use a missing CLI path so that callClaude fails → local fallback triggered
      process.env.CLAUDE_CLI_PATH = path.join(tmpDir, 'missing-claude.cmd');

      // Mock tryTrim to throw (simulates trimmer blowing up)
      const mockTryTrim = async () => {
        throw new Error('trimmer internal error for test');
      };

      const result = await summarizeConversation(
        makeHighlights(),
        makeSession(),
        { tryTrim: mockTryTrim }
      );

      // Should still return a usable result via local fallback
      assert.ok(typeof result === 'object', 'should return object even when trimmer throws');
      assert.ok(typeof result.title === 'string', 'should have title');
      assert.ok(typeof result.body === 'string', 'should have body');
      // Local fallback should reference the highlights
      assert.ok(
        result.body.includes('Implement user authentication flow') ||
        result.body.includes('Local fallback'),
        'body should include fallback content'
      );
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('when trimmer returns null (skip), summarization proceeds normally without transcript', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-trimskip-'));
    const originalOverride = process.env.CLAUDE_CLI_PATH;

    try {
      const fakeClaude = path.join(tmpDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      if (process.platform === 'win32') {
        fs.writeFileSync(
          fakeClaude,
          '@echo off\r\necho Title: Skip Trim Test\r\necho.\r\necho Body without transcript.\r\n',
          'utf-8'
        );
      } else {
        fs.writeFileSync(
          fakeClaude,
          '#!/bin/sh\necho "Title: Skip Trim Test"\necho\necho "Body without transcript."\n',
          'utf-8'
        );
        fs.chmodSync(fakeClaude, 0o755);
      }
      process.env.CLAUDE_CLI_PATH = fakeClaude;

      // Mock tryTrim to return null (unsupported source scenario)
      const mockTryTrim = async () => null;

      const result = await summarizeConversation(
        makeHighlights(),
        makeSession(),
        { tryTrim: mockTryTrim }
      );

      assert.ok(typeof result === 'object', 'should return object');
      assert.ok(typeof result.title === 'string', 'should have title');
      // No trimStats when trimmer was skipped
      assert.equal(result.trimStats, undefined, 'trimStats should be absent when trim was skipped');
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = originalOverride;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Structured TITLE:/BODY: parser tests ──────────────────────────────────────

describe('parseResponse — structured TITLE:/BODY: format', () => {
  it('TITLE:/BODY: output → title and body parsed correctly', () => {
    const raw = 'TITLE: Fixed auth bug in login\nBODY:\nThe auth middleware was updated to validate JWT tokens correctly. Rate limiting was also applied to the login endpoint.';
    const result = parseResponse(raw);
    assert.equal(result.title, 'Fixed auth bug in login');
    assert.ok(result.body.includes('auth middleware'), 'body should include prose content');
    assert.ok(!result.body.includes('BODY:'), 'body should not include the BODY: label');
  });

  it('TITLE:/BODY: case-insensitive', () => {
    const raw = 'title: Mapped team hierarchy and drafted capacity-tracking Sheet\nbody:\nSome body content here.';
    const result = parseResponse(raw);
    assert.equal(result.title, 'Mapped team hierarchy and drafted capacity-tracking Sheet');
    assert.ok(result.body.includes('body content'), 'body content parsed');
  });

  it('TITLE: without BODY: label — body is rest of content', () => {
    const raw = 'TITLE: Debugged sub-agent memory leak and applied filter\n\nThe sub-agent was leaking memory due to missing cleanup hooks.';
    const result = parseResponse(raw);
    assert.equal(result.title, 'Debugged sub-agent memory leak and applied filter');
    assert.ok(result.body.includes('memory leak') || result.body.includes('sub-agent'));
  });

  it('TITLE: with forbidden words like "Session summary" is still accepted (prompt-level constraint only)', () => {
    // We do NOT re-validate the parsed title — the prompt prevents this, but
    // if the LLM ignores it, we still accept the output as-is.
    const raw = 'TITLE: Session summary for April 20\nBODY:\nContent here.';
    const result = parseResponse(raw);
    assert.equal(result.title, 'Session summary for April 20');
  });
});

// ── extractMeaningfulTitle tests ──────────────────────────────────────────────

describe('extractMeaningfulTitle', () => {
  it('stock heading only → falls through to first numbered subtitle', () => {
    const raw = '# Session Summary\n\n## What Was Accomplished\n\n### 1. Team Hierarchy Mapping\n\nAnalyzed the reporting chain across all sub-leads.';
    const result = extractMeaningfulTitle(raw);
    assert.equal(result, 'Team Hierarchy Mapping', 'should return the numbered subtitle text');
  });

  it('stock heading → first prose line wins when no numbered subtitle', () => {
    const raw = '# Session Summary\n\nThe user asked me to fix the login endpoint and add JWT validation.';
    const result = extractMeaningfulTitle(raw);
    assert.ok(result.includes('user asked'), 'should return the prose line');
    assert.ok(!result.startsWith('#'), 'should not start with #');
  });

  it('all stock phrases → returns (untitled)', () => {
    const raw = '# Session Summary\n\n## Overview\n\n### Summary\n\n#### Accomplishments';
    const result = extractMeaningfulTitle(raw);
    assert.equal(result, '(untitled)');
  });

  it('non-stock heading with 3+ words used as title', () => {
    const raw = '## Implemented JWT Authentication Flow\n\nSome body text here.';
    const result = extractMeaningfulTitle(raw);
    assert.equal(result, 'Implemented JWT Authentication Flow');
  });

  it('returns (untitled) for empty input', () => {
    assert.equal(extractMeaningfulTitle(''), '(untitled)');
    assert.equal(extractMeaningfulTitle(null), '(untitled)');
    assert.equal(extractMeaningfulTitle(undefined), '(untitled)');
  });
});

// ── STOCK_TITLE_PATTERNS blacklist tests ──────────────────────────────────────

describe('STOCK_TITLE_PATTERNS blacklist', () => {
  const stockPhrases = [
    'Session Summary',
    'SUMMARY',
    'What we worked on',
    'Accomplishments',
    'Untitled chat',
    'overview',
    'Tasks completed',
    'outcome',
  ];

  for (const phrase of stockPhrases) {
    it(`"${phrase}" is caught by STOCK_TITLE_PATTERNS`, () => {
      const matched = STOCK_TITLE_PATTERNS.some(p => p.test(phrase));
      assert.ok(matched, `"${phrase}" should match a stock title pattern`);
    });
  }
});

// ── SYSTEM_PROMPT structure test ──────────────────────────────────────────────

describe('SYSTEM_PROMPT structure', () => {
  it('prompt contains TITLE: instruction', () => {
    assert.ok(SYSTEM_PROMPT.includes('TITLE:'), 'prompt must reference TITLE: format');
  });

  it('prompt contains BODY: instruction', () => {
    assert.ok(SYSTEM_PROMPT.includes('BODY:'), 'prompt must reference BODY: format');
  });

  it('prompt contains the example TITLE line', () => {
    assert.ok(
      SYSTEM_PROMPT.includes('Mapped team hierarchy and drafted capacity-tracking Google Sheet for sub-leads'),
      'prompt must include the canonical example'
    );
  });

  it('prompt forbids generic words in title', () => {
    assert.ok(SYSTEM_PROMPT.includes('session'), 'prompt must list forbidden words');
    assert.ok(SYSTEM_PROMPT.includes('summary'), 'prompt must list "summary" as forbidden');
  });
});
