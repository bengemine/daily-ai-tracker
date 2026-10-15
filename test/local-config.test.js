'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLocalConfig, resolveMachineSettings, wslUncPath } = require('../src/local-config');

describe('local machine config', () => {
  it('uses neutral defaults when no config file or variables exist', () => {
    const home = path.join(os.tmpdir(), 'tracker-home');
    const settings = resolveMachineSettings({ HOME: home }, {});
    assert.equal(settings.wslDistro, 'Ubuntu');
    assert.match(settings.wslHome, /^\/home\/[^/]+$/);
    assert.equal(settings.outputDir, path.join(home, 'ai-tracker'));
  });

  it('reads values from the config file', () => {
    const local = { outputDir: '/data/tracker', wslDistro: 'Debian', wslHome: '/home/sam/' };
    const settings = resolveMachineSettings({ HOME: '/home/other' }, local);
    assert.equal(settings.outputDir, '/data/tracker');
    assert.equal(settings.wslDistro, 'Debian');
    assert.equal(settings.wslHome, '/home/sam');
  });

  it('lets environment variables override the config file', () => {
    const env = { HOME: '/home/other', AI_TRACKER_OUTPUT_DIR: '/env/out', AI_TRACKER_WSL_DISTRO: 'Ubuntu-24.04', AI_TRACKER_WSL_HOME: '/home/env' };
    const settings = resolveMachineSettings(env, { outputDir: '/file/out', wslDistro: 'Debian', wslHome: '/home/file' });
    assert.deepEqual(
      { outputDir: settings.outputDir, wslDistro: settings.wslDistro, wslHome: settings.wslHome },
      { outputDir: '/env/out', wslDistro: 'Ubuntu-24.04', wslHome: '/home/env' },
    );
  });

  it('builds WSL UNC paths for both share names', () => {
    assert.equal(wslUncPath('wsl$', 'Ubuntu', '/home/dev'), '\\\\wsl$\\Ubuntu\\home\\dev');
    assert.equal(wslUncPath('wsl.localhost', 'Ubuntu', '/home/dev'), '\\\\wsl.localhost\\Ubuntu\\home\\dev');
  });

  it('reads the file named by AI_TRACKER_CONFIG_PATH and rejects broken JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-config-'));
    try {
      const good = path.join(dir, 'good.json');
      fs.writeFileSync(good, JSON.stringify({ wslDistro: 'Debian' }));
      assert.deepEqual(readLocalConfig({ AI_TRACKER_CONFIG_PATH: good }), { wslDistro: 'Debian' });
      assert.deepEqual(readLocalConfig({ AI_TRACKER_CONFIG_PATH: path.join(dir, 'missing.json') }), {});
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, '{ not json');
      assert.throws(() => readLocalConfig({ AI_TRACKER_CONFIG_PATH: bad }), /Invalid tracker config/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
