'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCodexModels, loadModelCatalog } = require('../src/model-catalog');

describe('model catalog', () => {
  it('loads Codex models and supported reasoning from the local cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    const filePath = path.join(root, 'models_cache.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify({ fetched_at: '2026-08-03T00:00:00Z', models: [{ slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', description: 'Affordable', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] }] }));
      const catalog = loadCodexModels({ candidates: [filePath] });
      assert.equal(catalog.models[0].id, 'gpt-5.6-luna');
      assert.deepEqual(catalog.models[0].reasoning, ['low', 'medium']);
      assert.equal(catalog.models[0].contextWindow, 272000);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a custom-model escape hatch for Claude aliases', () => {
    const catalog = loadModelCatalog('claude');
    assert.equal(catalog.customModelAllowed, true);
    assert.ok(catalog.models.some(model => model.id === 'sonnet'));
  });
});
