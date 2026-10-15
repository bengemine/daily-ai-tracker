const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeConversationArtifact,
  sanitizePathComponent,
  readConversationArtifactsForDate,
  dateIndexPath,
} = require('../src/conversation-artifacts');

function session() {
  return {
    id: 'stable-session-123',
    agent: 'Claude Code',
    project: '/projects/demo',
    startTime: new Date('2026-07-21T10:00:00.000Z'),
    activityEndTime: new Date('2026-07-21T10:30:00.000Z'),
  };
}

describe('cleaned conversation artifacts', () => {
  it('stores one file per active day in one stable session folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-artifacts-'));
    try {
      const first = writeConversationArtifact(session(), '2026-07-21', [
        { role: 'user', content: 'Start the work' },
        { role: 'assistant', content: 'I completed the first part.' },
      ], root);
      const second = writeConversationArtifact(session(), '2026-07-22', [
        { role: 'user', content: 'Continue the same work' },
        { role: 'assistant', content: 'I completed the second part.' },
      ], root);

      assert.equal(path.dirname(first.filePath), path.dirname(second.filePath));
      assert.ok(fs.existsSync(first.filePath));
      assert.ok(fs.existsSync(second.filePath));
      assert.ok(fs.existsSync(first.filePath.replace(/\.md$/, '.json')));
      const indexed = readConversationArtifactsForDate('2026-07-22', root);
      assert.equal(indexed.length, 1);
      assert.equal(indexed[0].messages[0].content, 'Continue the same work');
      const dateIndex = JSON.parse(fs.readFileSync(dateIndexPath(root, '2026-07-22'), 'utf8'));
      assert.equal(dateIndex.artifacts.length, 1);
      assert.ok(dateIndex.artifacts[0].endsWith('/2026-07-22.json'));

      const index = fs.readFileSync(path.join(path.dirname(first.filePath), 'index.md'), 'utf8');
      assert.ok(index.includes('[2026-07-21](./2026-07-21.md)'));
      assert.ok(index.includes('[2026-07-22](./2026-07-22.md)'));
      assert.ok(index.indexOf('2026-07-21') < index.indexOf('2026-07-22'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reprocessing replaces only that date and does not duplicate index links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-artifacts-'));
    try {
      const first = writeConversationArtifact(session(), '2026-07-21', [
        { role: 'user', content: 'Original request' },
        { role: 'assistant', content: 'Original reply' },
      ], root);
      const other = writeConversationArtifact(session(), '2026-07-22', [
        { role: 'user', content: 'Second-day request' },
        { role: 'assistant', content: 'Second-day reply' },
      ], root);
      writeConversationArtifact(session(), '2026-07-21', [
        { role: 'user', content: 'Corrected request' },
        { role: 'assistant', content: 'Corrected reply' },
      ], root);

      assert.ok(fs.readFileSync(first.filePath, 'utf8').includes('Corrected request'));
      assert.ok(fs.readFileSync(other.filePath, 'utf8').includes('Second-day request'));
      const index = fs.readFileSync(path.join(path.dirname(first.filePath), 'index.md'), 'utf8');
      assert.equal((index.match(/2026-07-21\.md/g) || []).length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips artifacts without a real user turn', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-artifacts-'));
    try {
      const result = writeConversationArtifact(session(), '2026-07-21', [
        { role: 'assistant', content: 'Unprompted internal text' },
      ], root);
      assert.equal(result, null);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sanitizes path traversal and reserved filename characters', () => {
    assert.equal(sanitizePathComponent('../../bad:session*id'), 'bad-session-id');
  });
});
