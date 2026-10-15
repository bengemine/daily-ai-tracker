const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runForDate } = require('../tracker');
const { writeConversationArtifact } = require('../src/conversation-artifacts');

describe('daily cleaned-dialogue pipeline', () => {
  it('saves and summarizes only the processed date from a continued session', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-pipeline-'));
    const captured = [];
    const session = {
      id: 'continued-session',
      agent: 'Test Agent',
      project: '/projects/demo',
      startTime: new Date('2026-07-22T10:00:00.000Z'),
      activityDate: '2026-07-22',
    };

    try {
      writeConversationArtifact(session, '2026-07-22', [
        { role: 'user', content: 'Continue today', timestamp: '2026-07-22T10:00:00.000Z' },
        { role: 'assistant', content: 'Today I completed it.', timestamp: '2026-07-22T10:01:00.000Z' },
      ], outputDir);
      const journalPath = await runForDate('2026-07-22', {
        outputDir,
        summarize: async (highlights, session) => {
          captured.push({ highlights, session });
          return { title: 'Completed continued work', body: 'Completed the requested work.' };
        },
      });

      assert.equal(captured.length, 1);
      assert.deepEqual(captured[0].highlights.userMessages, ['Continue today']);
      const artifactPath = path.join(
        outputDir,
        'conversations',
        'test-agent',
        'continued-session',
        '2026-07-22.md'
      );
      const artifact = fs.readFileSync(artifactPath, 'utf8');
      assert.ok(artifact.includes('Continue today'));
      assert.ok(artifact.includes('Today I completed it.'));
      assert.ok(!artifact.includes('Previous-day'));
      const journal = fs.readFileSync(journalPath, 'utf8');
      assert.ok(journal.includes('cleaned dialogue'));
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('skips a session when no dated visible user dialogue can be proven', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-pipeline-'));
    try {
      const journalPath = await runForDate('2026-07-22', { outputDir, loadIndexed: async () => [] });
      assert.ok(fs.readFileSync(journalPath, 'utf8').includes('No activity recorded.'));
      assert.equal(fs.existsSync(path.join(outputDir, 'conversations')), false);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
