const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeConversationArtifact } = require('../src/conversation-artifacts');
const {
  parseArgs,
  datesInMonth,
  baselineSessions,
  compareMonth,
  fingerprintTree,
} = require('../validate-month');

describe('isolated month validation', () => {
  it('validates required CLI arguments and calendar days', () => {
    assert.equal(parseArgs(['--month', '2026-07']).error, '--output is required');
    assert.equal(parseArgs(['--month', 'July', '--output', 'result']).error, '--month must use YYYY-MM');
    const resumed = parseArgs(['--month', '2026-07', '--output', 'result', '--resume', '--local-summary']);
    assert.equal(resumed.error, null);
    assert.equal(resumed.resume, true);
    assert.equal(resumed.localSummary, true);
    const luna = parseArgs(['--month', '2026-07', '--output', 'result', '--provider', 'codex', '--model', 'gpt-5.6-luna', '--reasoning', 'medium']);
    assert.equal(luna.provider, 'codex');
    assert.equal(luna.model, 'gpt-5.6-luna');
    assert.equal(luna.reasoning, 'medium');
    assert.equal(datesInMonth('2026-07').length, 31);
    assert.equal(datesInMonth('2024-02').length, 29);
  });

  it('extracts session keys from old tracker details', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'month-baseline-'));
    const filePath = path.join(root, '2026', '07', '02.md');
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        '> **Claude Code (WSL)** · project · Chat: `Claude Code (WSL):claude-1`',
        'Related chats: `Codex (WSL):codex-1`, `Claude Code (WSL):claude-1`',
      ].join('\n'));
      assert.deepEqual([...baselineSessions(root, '2026-07-02')].sort(), [
        'Claude Code (WSL):claude-1',
        'Codex (WSL):codex-1',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies Grok additions separately from other differences', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'month-compare-'));
    const baseline = path.join(root, 'baseline');
    const generated = path.join(root, 'generated');
    const journal = path.join(baseline, '2026', '07', '02.md');
    try {
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, 'Chat: `Claude Code:shared-session`\nChat: `Codex:old-only`\n');
      writeConversationArtifact({
        id: 'shared-session', agent: 'Claude Code', project: '/demo',
        sessionKey: 'Claude Code:shared-session', startTime: new Date('2026-07-02T10:00:00Z'),
      }, '2026-07-02', [{ role: 'user', content: 'Shared work', timestamp: '2026-07-02T10:00:00Z' }], generated);
      writeConversationArtifact({
        id: 'grok-new', agent: 'Grok (WSL)', project: '/demo',
        sessionKey: 'Grok (WSL):grok-new', startTime: new Date('2026-07-02T11:00:00Z'),
      }, '2026-07-02', [{ role: 'user', content: 'Grok work', timestamp: '2026-07-02T11:00:00Z' }], generated);

      const report = compareMonth('2026-07', generated, baseline);
      const day = report.days.find(value => value.date === '2026-07-02');
      assert.equal(day.matched, 1);
      assert.deepEqual(day.expectedGrokAdditions, ['Grok (WSL):grok-new']);
      assert.deepEqual(day.missingFromGenerated, ['Codex:old-only']);
      assert.equal(report.totals.newNonGrok, 0);
      assert.equal(report.uniqueComparison.matched, 1);
      assert.deepEqual(report.uniqueComparison.expectedGrokAdditions, ['Grok (WSL):grok-new']);
      assert.deepEqual(report.uniqueComparison.missingFromGenerated, ['Codex:old-only']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies adjacent 4 a.m. boundary changes as date shifts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'month-date-shift-'));
    const baseline = path.join(root, 'baseline');
    const generated = path.join(root, 'generated');
    try {
      const oldJournal = path.join(baseline, '2026', '07', '04.md');
      fs.mkdirSync(path.dirname(oldJournal), { recursive: true });
      fs.writeFileSync(oldJournal, 'Chat: `Claude Code:shifted-session`\n');
      writeConversationArtifact({
        id: 'shifted-session', agent: 'Claude Code', project: '/demo',
        sessionKey: 'Claude Code:shifted-session', startTime: new Date('2026-07-03T23:00:00Z'),
      }, '2026-07-03', [{ role: 'user', content: 'Late work', timestamp: '2026-07-03T23:00:00Z' }], generated);

      const report = compareMonth('2026-07', generated, baseline);
      assert.equal(report.totals.adjacentDateShifts, 1);
      assert.equal(report.totals.newNonGrok, 0);
      assert.equal(report.totals.missingFromGenerated, 0);
      assert.equal(report.uniqueComparison.matched, 1);
      assert.equal(report.uniqueComparison.newNonGrok.length, 0);
      assert.equal(report.uniqueComparison.missingFromGenerated.length, 0);
      assert.deepEqual(report.days[2].adjacentDateShiftsIn, [{
        sessionKey: 'Claude Code:shifted-session', baselineDate: '2026-07-04',
      }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects any content change in a protected output tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'month-fingerprint-'));
    try {
      fs.writeFileSync(path.join(root, 'tracker.md'), 'before');
      const before = fingerprintTree(root);
      fs.writeFileSync(path.join(root, 'tracker.md'), 'after');
      const after = fingerprintTree(root);
      assert.notEqual(before.sha256, after.sha256);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
