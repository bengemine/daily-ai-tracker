const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point every adapter at an empty folder before the config loads, so these
// tests never read the real agent folders in the user's home.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-registry-home-'));
process.env.USERPROFILE = EMPTY_HOME;
process.env.HOME = EMPTY_HOME;
process.env.APPDATA = path.join(EMPTY_HOME, 'AppData', 'Roaming');
process.env.AI_TRACKER_CONFIG_PATH = path.join(EMPTY_HOME, 'tracker-config.json');
process.env.AI_TRACKER_WSL_DISTRO = 'tracker-test-missing-distro';
process.env.AI_TRACKER_WSL_HOME = '/home/dev';
after(() => fs.rmSync(EMPTY_HOME, { recursive: true, force: true }));

const { getAllAdapters } = require('../src/adapters');
const { AgentAdapter } = require('../src/adapters/base');

// ── Registry shape ────────────────────────────────────────────────

describe('Adapter registry', () => {
  it('returns exactly 9 adapters', () => {
    const adapters = getAllAdapters();
    assert.equal(adapters.length, 9);
  });

  it('all adapters are instances of AgentAdapter', () => {
    const adapters = getAllAdapters();
    for (const adapter of adapters) {
      assert.ok(
        adapter instanceof AgentAdapter,
        `${adapter.name || 'unknown'} is not an AgentAdapter`
      );
    }
  });

  it('all adapter names are unique', () => {
    const adapters = getAllAdapters();
    const names = adapters.map(a => a.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Duplicate names: ${names.join(', ')}`);
  });

  it('returns fresh instances on each call', () => {
    const first = getAllAdapters();
    const second = getAllAdapters();
    for (let i = 0; i < first.length; i++) {
      assert.notEqual(first[i], second[i], `Adapter ${first[i].name} should be a new instance`);
    }
  });

  it('Claude Code is first in the list', () => {
    const adapters = getAllAdapters();
    assert.equal(adapters[0].name, 'Claude Code');
    assert.equal(adapters[1].name, 'Claude Code (WSL)');
  });
});

// ── Error resilience ──────────────────────────────────────────────

describe('Error resilience', () => {
  it('adapter-level error does not prevent other adapters from running', async () => {
    const adapters = getAllAdapters();
    const results = [];

    // Sabotage the second adapter's checkActivity to throw
    adapters[1].checkActivity = async () => {
      throw new Error('Intentional test explosion');
    };

    for (const adapter of adapters) {
      try {
        const active = await adapter.checkActivity('2000-01-01');
        results.push({ name: adapter.name, active, error: null });
      } catch (err) {
        results.push({ name: adapter.name, active: null, error: err.message });
      }
    }

    // The broken adapter should have an error
    const broken = results.find(r => r.error !== null);
    assert.ok(broken, 'Expected one adapter to have errored');
    assert.equal(broken.error, 'Intentional test explosion');

    // All other adapters should have completed (active: true or false)
    const healthy = results.filter(r => r.error === null);
    assert.equal(healthy.length, 8, 'Expected 8 healthy adapters');
  });

  it('session-level error does not skip remaining sessions', async () => {
    const adapters = getAllAdapters();
    const adapter = adapters[0]; // Claude Code

    // Create fake sessions
    const fakeSessions = [
      { id: 'sess-1', project: 'test-1', startTime: new Date(), rawMessages: [] },
      { id: 'sess-2', project: 'test-2', startTime: new Date(), rawMessages: [] },
      { id: 'sess-3', project: 'test-3', startTime: new Date(), rawMessages: [] },
    ];

    // Override extractSessions to return our fakes
    adapter.extractSessions = async () => fakeSessions;

    // Override extractHighlights: blow up on session 2, succeed on 1 and 3
    let successCount = 0;
    adapter.extractHighlights = async (session) => {
      if (session.id === 'sess-2') {
        throw new Error('Session 2 exploded');
      }
      successCount++;
      return { topic: 'test', toolCalls: [], filePaths: [], userMessages: [] };
    };

    const errors = [];
    const sessions = await adapter.extractSessions('2000-01-01');

    for (const session of sessions) {
      try {
        await adapter.extractHighlights(session);
      } catch (err) {
        errors.push({ session: session.id, error: err.message });
      }
    }

    assert.equal(successCount, 2, 'Should have processed sessions 1 and 3');
    assert.equal(errors.length, 1, 'Should have captured 1 session error');
    assert.equal(errors[0].session, 'sess-2');
  });
});
