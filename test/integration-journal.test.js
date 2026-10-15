/**
 * Integration test: full pipeline with deterministic adapters -> mock
 * summarizer -> cleaned artifacts + journal file.
 *
 * Local agent history is intentionally not used here. Session files can be
 * rotated or deleted, which must not make the committed suite unstable.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/config');
const { runForDate } = require('../tracker');
const { writeConversationArtifact } = require('../src/conversation-artifacts');

let originalDir;
let tmpDir;

function setupTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-journal-'));
  originalDir = config.output.directory;
  config.output.directory = tmpDir;
  for (const record of getTestRecords()) {
    writeConversationArtifact(record.session, '2026-03-13', record.messages, tmpDir);
  }
}

function teardownTmpDir() {
  config.output.directory = originalDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function mockSummarize(highlights, session) {
  const shortId = session.id.slice(0, 8);
  return Promise.resolve({
    title: `Task for ${shortId}`,
    body: `Summary for ${session.id} [${session.agent}]: worked on ${session.project}`,
  });
}

function getTestRecords() {
  return [
    {
      session: { id: 'aaaaaaaa-1111-2222-3333-444444444444', agent: 'Claude Code', project: 'E:\\projects\\alpha', startTime: new Date('2026-03-13T09:00:00.000Z') },
      messages: [
        { role: 'user', content: 'Prepare the alpha report.', timestamp: '2026-03-13T09:00:00.000Z' },
        { role: 'assistant', content: 'I prepared and checked the alpha report.', timestamp: '2026-03-13T09:05:00.000Z' },
      ],
    },
    {
      session: { id: 'bbbbbbbb-1111-2222-3333-444444444444', agent: 'Codex', project: 'E:\\projects\\beta', startTime: new Date('2026-03-13T11:00:00.000Z') },
      messages: [
        { role: 'user', content: 'Fix the beta calculation.', timestamp: '2026-03-13T11:00:00.000Z' },
        { role: 'assistant', content: 'I fixed and tested the beta calculation.', timestamp: '2026-03-13T11:05:00.000Z' },
      ],
    },
  ];
}

function runTestDate(dateStr) {
  return runForDate(dateStr, {
    summarize: mockSummarize,
  });
}

describe('integration: full pipeline with mock summarizer', () => {
  beforeEach(() => setupTmpDir());
  afterEach(() => teardownTmpDir());

  it('produces a journal file at the correct path for 2026-03-13', async () => {
    const result = await runTestDate('2026-03-13');

    assert.ok(result, 'runForDate should return a path');
    assert.ok(fs.existsSync(result), 'journal file should exist on disk');

    const expected = path.join(tmpDir, '2026', '03', '13.md');
    assert.equal(result, expected, 'path should be YYYY/MM/DD.md under output dir');
  });

  it('keeps journal entries bounded after task-level merging', async () => {
    const result = await runTestDate('2026-03-13');
    const content = fs.readFileSync(result, 'utf-8');

    const anchors = content.match(/<a id="s-\d+"><\/a>/g) || [];
    assert.ok(anchors.length > 0, 'Expected at least one task entry');
    assert.ok(anchors.length <= 50, `Expected merged task count to stay at or below 50, got ${anchors.length}`);
  });

  it('contains all agent names in table and details', async () => {
    const result = await runTestDate('2026-03-13');
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('Claude Code'), 'Should have Claude Code entries');
    assert.ok(content.includes('Codex'), 'Should have Codex entries');
  });

  it('has overview table with linked task titles', async () => {
    const result = await runTestDate('2026-03-13');
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('## Overview'), 'Should have Overview section');
    assert.ok(content.includes('| # | Time | Agent | Task | Project |'), 'Should have table header');

    const linkPattern = /\[Task for [a-f0-9]+\]\(#s-\d+\)/;
    assert.ok(linkPattern.test(content), 'Table should have linked task titles');
  });

  it('has session details with anchors and blockquote metadata', async () => {
    const result = await runTestDate('2026-03-13');
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('## Session Details'), 'Should have Session Details section');
    assert.ok(content.includes('<a id="s-1"></a>'), 'Should have anchor for first session');

    const blockquotePattern = /> \*\*[^*]+\*\* .*Chat[s]?: `.+`/;
    assert.ok(blockquotePattern.test(content), 'Details should have metadata blockquote');
    assert.ok(content.includes('Summary for '), 'Should contain mock summary body text');
  });

  it('produces identical output on idempotent re-run', async () => {
    const path1 = await runTestDate('2026-03-13');
    const content1 = fs.readFileSync(path1, 'utf-8');

    const path2 = await runTestDate('2026-03-13');
    const content2 = fs.readFileSync(path2, 'utf-8');

    assert.equal(path1, path2, 'Same path on re-run');
    assert.equal(content1, content2, 'Same content on re-run (idempotent)');
  });

  it('writes a no-activity journal for a date with no activity', async () => {
    const result = await runTestDate('2099-12-31');
    assert.ok(result, 'Should return a journal path for no-activity date');
    const content = fs.readFileSync(result, 'utf-8');
    assert.ok(content.includes('No activity recorded.'));
  });

  it('entries are sorted chronologically across all agents', async () => {
    const result = await runTestDate('2026-03-13');
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.startsWith('# Daily AI Tracker — 2026-03-13'), 'Should start with date title');

    const tableRows = content.match(/^\| \d+ \|/gm) || [];
    assert.ok(tableRows.length > 0, 'Should have at least one table row');
    assert.ok(tableRows.length <= 50, `Merged task rows should stay at or below 50, got ${tableRows.length}`);

    const anchors = [...content.matchAll(/<a id="s-(\d+)"><\/a>/g)].map(m => Number(m[1]));
    for (let i = 1; i < anchors.length; i++) {
      assert.equal(anchors[i], anchors[i - 1] + 1, 'Anchors should be sequential');
    }
  });
});
