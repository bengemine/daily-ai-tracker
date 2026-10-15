const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FULL_SCAN_INTERVAL_MS,
  OVERLAP_MS,
  chooseScanMode,
  parseWslUnc,
  scanStatePath,
  sourceModifiedSince,
} = require('../src/conversation-scan');
const { indexAllConversations } = require('../src/conversation-indexer');

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function claudeTurn(type, timestamp, text) {
  return {
    type,
    timestamp,
    sessionId: 'scan-session',
    cwd: '/projects/scan-test',
    message: { role: type, content: [{ type: 'text', text }] },
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-scan-'));
  const claudeStorage = path.join(root, 'claude');
  const projectsDir = path.join(claudeStorage, 'projects', 'scan-project');
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(projectsDir, { recursive: true });
  const filePath = path.join(projectsDir, 'scan-session.jsonl');
  fs.writeFileSync(filePath, [
    claudeTurn('user', '2026-07-21T10:00:00.000Z', 'Start scan test'),
    claudeTurn('assistant', '2026-07-21T10:01:00.000Z', 'Scan test started'),
  ].map(line).join(''));

  const unavailable = name => ({ name, storagePath: '' });
  const cfg = {
    agents: {
      claudeCode: { name: 'Claude Code', storagePath: claudeStorage, projectsDir: 'projects' },
      claudeCodeWsl: unavailable('Claude Code WSL'),
      codex: unavailable('Codex'),
      codexWsl: unavailable('Codex WSL'),
      factory: { ...unavailable('Factory'), sessionsDir: 'sessions' },
      grok: { ...unavailable('Grok'), sessionsDir: 'sessions' },
      grokWsl: { ...unavailable('Grok WSL'), sessionsDir: 'sessions' },
      openCode: { name: 'OpenCode', dbPath: path.join(root, 'missing-opencode.db') },
      cursor: { name: 'Cursor', globalDbPath: path.join(root, 'missing-cursor.db') },
    },
    output: { directory: outputDir },
  };
  return { root, outputDir, filePath, cfg };
}

function conversationFiles(outputDir) {
  const root = path.join(outputDir, 'conversations');
  const result = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name !== '.source-state.json') {
        result[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  return result;
}

describe('conversation scan checkpoints', () => {
  it('forces a first scan and then chooses the five-minute-overlap fast path', async () => {
    const fixture = makeFixture();
    const start = new Date('2026-08-01T06:00:00.000Z');
    try {
      fs.utimesSync(fixture.filePath, new Date(start - 10 * 60_000), new Date(start - 10 * 60_000));
      const first = await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start });
      assert.equal(first.scanMode, 'full');
      assert.equal(first.scanReason, 'missing-or-invalid-checkpoint');

      const next = new Date(start.getTime() + 24 * 60 * 60_000);
      const second = await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: next });
      assert.equal(second.scanMode, 'fast');
      assert.equal(second.candidates, 1); // OpenCode's inexpensive database watermark check.
      assert.equal(second.unchanged, 2); // One prefiltered JSONL source plus missing OpenCode DB.

      const mode = chooseScanMode({ outputDir: fixture.outputDir, cfg: fixture.cfg, now: new Date(next.getTime() + 1000) });
      assert.equal(mode.fullScan, false);
      assert.equal(mode.cutoff.toISOString(), new Date(next.getTime() - OVERLAP_MS).toISOString());
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('selects an appended conversation and reconciles everything after seven days', async () => {
    const fixture = makeFixture();
    const start = new Date('2026-08-01T06:00:00.000Z');
    try {
      fs.utimesSync(fixture.filePath, new Date(start - 10 * 60_000), new Date(start - 10 * 60_000));
      await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start });

      const changedAt = new Date(start.getTime() + 24 * 60 * 60_000);
      fs.appendFileSync(fixture.filePath, [
        claudeTurn('user', '2026-07-22T10:00:00.000Z', 'Continue scan test'),
        claudeTurn('assistant', '2026-07-22T10:01:00.000Z', 'Scan test continued'),
      ].map(line).join(''));
      fs.utimesSync(fixture.filePath, changedAt, changedAt);
      const fast = await indexAllConversations({
        config: fixture.cfg,
        outputDir: fixture.outputDir,
        now: new Date(changedAt.getTime() + 60_000),
      });
      assert.equal(fast.scanMode, 'fast');
      assert.equal(fast.changed, 1);

      const weekly = await indexAllConversations({
        config: fixture.cfg,
        outputDir: fixture.outputDir,
        now: new Date(start.getTime() + FULL_SCAN_INTERVAL_MS + 1000),
      });
      assert.equal(weekly.scanMode, 'full');
      assert.equal(weekly.scanReason, 'weekly-reconciliation');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not advance the checkpoint when any selected source fails', async () => {
    const fixture = makeFixture();
    const start = new Date('2026-08-01T06:00:00.000Z');
    try {
      await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start });
      const checkpoint = fs.readFileSync(scanStatePath(fixture.outputDir), 'utf8');
      const next = new Date(start.getTime() + 60_000);
      await assert.rejects(
        indexAllConversations({
          config: fixture.cfg,
          outputDir: fixture.outputDir,
          now: next,
          selectChangedDescriptors: descriptors => descriptors,
          indexJsonlSource: async () => { throw new Error('simulated source failure'); },
        }),
        /conversation source\(s\) failed indexing/
      );
      assert.equal(fs.readFileSync(scanStatePath(fixture.outputDir), 'utf8'), checkpoint);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('falls back to a full scan when fast candidate discovery fails', async () => {
    const fixture = makeFixture();
    const start = new Date('2026-08-01T06:00:00.000Z');
    try {
      await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start });
      const result = await indexAllConversations({
        config: fixture.cfg,
        outputDir: fixture.outputDir,
        now: new Date(start.getTime() + 60_000),
        selectChangedDescriptors: () => { throw new Error('simulated discovery failure'); },
      });
      assert.equal(result.scanMode, 'full');
      assert.match(result.scanReason, /^candidate-discovery-failed:/);
      assert.equal(result.candidates, 2);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('produces identical conversation artifacts through fast and forced-full paths', async () => {
    const fixture = makeFixture();
    const fullOutput = path.join(fixture.root, 'full-output');
    const start = new Date('2026-08-01T06:00:00.000Z');
    try {
      await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start });
      const changedAt = new Date(start.getTime() + 24 * 60 * 60_000);
      fs.appendFileSync(fixture.filePath, [
        claudeTurn('user', '2026-07-22T10:00:00.000Z', 'Continue equivalence test'),
        claudeTurn('assistant', '2026-07-22T10:01:00.000Z', 'Equivalence preserved'),
      ].map(line).join(''));
      fs.utimesSync(fixture.filePath, changedAt, changedAt);

      await indexAllConversations({
        config: fixture.cfg,
        outputDir: fixture.outputDir,
        now: new Date(changedAt.getTime() + 60_000),
      });
      await indexAllConversations({
        config: fixture.cfg,
        outputDir: fullOutput,
        now: new Date(changedAt.getTime() + 60_000),
        fullScan: true,
      });
      assert.deepEqual(conversationFiles(fixture.outputDir), conversationFiles(fullOutput));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('recognizes both supported WSL UNC forms and matches only changed paths', () => {
    const legacy = parseWslUnc(String.raw`\\wsl$\Ubuntu\home\dev\.codex\sessions\a.jsonl`);
    const current = parseWslUnc(String.raw`\\wsl.localhost\Ubuntu\home\dev\.grok\sessions\p\s\events.jsonl`);
    assert.deepEqual(legacy, { distro: 'Ubuntu', linuxPath: '/home/dev/.codex/sessions/a.jsonl' });
    assert.deepEqual(current, { distro: 'Ubuntu', linuxPath: '/home/dev/.grok/sessions/p/s/events.jsonl' });

    const descriptor = {
      type: 'grok',
      eventsPath: String.raw`\\wsl.localhost\Ubuntu\home\dev\.grok\sessions\p\s\events.jsonl`,
      historyPath: String.raw`\\wsl.localhost\Ubuntu\home\dev\.grok\sessions\p\s\chat_history.jsonl`,
    };
    // Changed-path keys use the lowercase distro name.
    const changed = new Set([`ubuntu\0/home/dev/.grok/sessions/p/s/chat_history.jsonl`]);
    assert.equal(sourceModifiedSince(descriptor, new Date(0), changed), true);
  });

  it('forces reconciliation for future-dated or configuration-mismatched checkpoints', async () => {
    const fixture = makeFixture();
    const start = new Date('2026-08-01T06:00:00.000Z');
    try {
      await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start });
      const checkpointPath = scanStatePath(fixture.outputDir);
      const future = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      future.lastSuccessfulScanStartedAt = new Date(start.getTime() + 60 * 60_000).toISOString();
      fs.writeFileSync(checkpointPath, JSON.stringify(future));
      assert.equal(
        chooseScanMode({ outputDir: fixture.outputDir, cfg: fixture.cfg, now: start }).reason,
        'unsafe-checkpoint-time'
      );

      await indexAllConversations({ config: fixture.cfg, outputDir: fixture.outputDir, now: start, fullScan: true });
      const changedConfig = JSON.parse(JSON.stringify(fixture.cfg));
      changedConfig.agents.claudeCode.projectsDir = 'different-projects-root';
      assert.equal(
        chooseScanMode({ outputDir: fixture.outputDir, cfg: changedConfig, now: start }).reason,
        'configuration-changed'
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
