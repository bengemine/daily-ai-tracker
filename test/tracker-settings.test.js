'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSettings, normalizeSettings, saveSettings, settingsFingerprint } = require('../src/tracker-settings');

describe('tracker settings', () => {
  it('validates, writes atomically, and reloads provider settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-settings-'));
    const filePath = path.join(root, 'settings.json');
    try {
      const saved = saveSettings({ provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium', customInstructions: 'Keep blockers.', timeoutMs: 90000 }, { filePath });
      assert.equal(saved.provider, 'codex');
      assert.deepEqual(loadSettings({ filePath, env: {} }), saved);
      assert.equal(fs.existsSync(`${filePath}.tmp`), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('environment overrides do not rewrite the settings file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-settings-'));
    const filePath = path.join(root, 'settings.json');
    try {
      saveSettings({ provider: 'claude', model: 'sonnet', reasoning: 'medium' }, { filePath });
      const value = loadSettings({ filePath, env: { AI_TRACKER_SUMMARY_PROVIDER: 'codex', AI_TRACKER_SUMMARY_MODEL: 'gpt-5.6-luna' } });
      assert.equal(value.provider, 'codex');
      assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).provider, 'claude');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects unknown providers and fingerprints custom instructions', () => {
    assert.throws(() => normalizeSettings({ provider: 'other' }), /Unsupported summary provider/);
    const first = settingsFingerprint({ provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium', customInstructions: 'A' });
    const second = settingsFingerprint({ provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium', customInstructions: 'B' });
    assert.notEqual(first, second);
  });
});
