'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createControlServer } = require('../src/control-server');

function request(port, method, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(token ? { 'x-tracker-token': token } : {}) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('local control server', () => {
  it('binds locally, exposes model settings, and protects writes with a token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-server-'));
    const settingsFile = path.join(root, 'settings.json');
    // A synthetic Codex model cache, so the server never reads ~/.codex.
    const modelsCache = path.join(root, 'models_cache.json');
    fs.writeFileSync(modelsCache, JSON.stringify({ models: [{ slug: 'gpt-test-model', display_name: 'GPT Test Model', supported_reasoning_levels: [{ effort: 'low' }] }] }));
    const originalCache = process.env.CODEX_MODELS_CACHE;
    process.env.CODEX_MODELS_CACHE = modelsCache;
    const { server, token } = createControlServer({ token: 'test-token', settingsFile, outputDir: root });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const bootstrap = await request(port, 'GET', '/api/bootstrap');
      assert.equal(bootstrap.status, 200);
      assert.ok(bootstrap.value.models.claude.models.length > 0);
      assert.equal(bootstrap.value.models.codex.models[0].id, 'gpt-test-model');
      const denied = await request(port, 'POST', '/api/settings', null, { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium' });
      assert.equal(denied.status, 403);
      const saved = await request(port, 'POST', '/api/settings', token, { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium' });
      assert.equal(saved.status, 200);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).provider, 'codex');
    } finally {
      await new Promise(resolve => server.close(resolve));
      if (originalCache === undefined) delete process.env.CODEX_MODELS_CACHE;
      else process.env.CODEX_MODELS_CACHE = originalCache;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
