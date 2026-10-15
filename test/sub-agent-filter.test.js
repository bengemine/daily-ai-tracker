'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { detectSubAgent, subAgentDetectorStats } = require('../src/adapters/sub-agent-filter');

// ── Codex explicit rules ───────────────────────────────────────────────────

describe('detectSubAgent — codex explicit rules', () => {
  it('returns isSubAgent=false for source="exec"', () => {
    const result = detectSubAgent('codex', { payload: { source: 'exec' } });
    assert.equal(result.isSubAgent, false);
  });

  it('returns isSubAgent=false for source="tui"', () => {
    const result = detectSubAgent('codex', { payload: { source: 'tui' } });
    assert.equal(result.isSubAgent, false);
  });

  it('returns isSubAgent=false for source="cli"', () => {
    const result = detectSubAgent('codex', { payload: { source: 'cli' } });
    assert.equal(result.isSubAgent, false);
  });

  it('returns isSubAgent=true, confidence=certain for full thread_spawn structure', () => {
    const meta = {
      payload: {
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'abc',
              depth: 1,
              agent_role: 'worker',
            },
          },
        },
      },
    };
    const result = detectSubAgent('codex', meta);
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
    assert.ok(result.reason.includes('thread_spawn'), `Expected reason to mention thread_spawn, got: ${result.reason}`);
    assert.ok(result.reason.includes('abc'), `Expected reason to include parent_thread_id, got: ${result.reason}`);
  });

  it('returns isSubAgent=true for source={subagent:{}} (empty subagent key)', () => {
    const result = detectSubAgent('codex', { payload: { source: { subagent: {} } } });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
  });

  it('returns isSubAgent=true when source has thread_spawn key at top level', () => {
    const result = detectSubAgent('codex', {
      payload: {
        source: {
          thread_spawn: { parent_thread_id: 'xyz', depth: 2 },
        },
      },
    });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
  });

  it('returns isSubAgent=true when source has agent_role=worker at top level', () => {
    const result = detectSubAgent('codex', {
      payload: {
        source: { agent_role: 'worker' },
      },
    });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
  });

  it('returns isSubAgent=true when source has agent_role=helper', () => {
    const result = detectSubAgent('codex', {
      payload: { source: { agent_role: 'helper' } },
    });
    assert.equal(result.isSubAgent, true);
  });

  it('returns isSubAgent=true when source has agent_role=tool', () => {
    const result = detectSubAgent('codex', {
      payload: { source: { agent_role: 'tool' } },
    });
    assert.equal(result.isSubAgent, true);
  });
});

// ── Claude Code explicit rules ─────────────────────────────────────────────

describe('detectSubAgent — claude-code explicit rules', () => {
  it('returns isSubAgent=true, confidence=certain for isSidechain=true', () => {
    const result = detectSubAgent('claude-code', { isSidechain: true });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
    assert.ok(result.reason.includes('isSidechain'), `Expected reason to mention isSidechain, got: ${result.reason}`);
  });

  it('returns isSubAgent=false for a normal user entry', () => {
    const result = detectSubAgent('claude-code', { type: 'user' });
    assert.equal(result.isSubAgent, false);
  });

  it('returns isSubAgent=false for isSidechain=false', () => {
    const result = detectSubAgent('claude-code', { isSidechain: false });
    assert.equal(result.isSubAgent, false);
  });
});

// ── Factory explicit rules ─────────────────────────────────────────────────

describe('detectSubAgent — factory explicit rules', () => {
  it('returns isSubAgent=false for a main session with no markers', () => {
    const result = detectSubAgent('factory', { type: 'session_start', id: 'abc', cwd: 'E:\\projects\\foo' });
    assert.equal(result.isSubAgent, false);
    assert.equal(result.reason, null);
    assert.equal(result.confidence, null);
  });

  it('returns isSubAgent=true, confidence=certain for callingSessionId set', () => {
    const result = detectSubAgent('factory', { type: 'session_start', callingSessionId: 'parent-abc' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
    assert.ok(result.reason.includes('parent-abc'), `Expected reason to include callingSessionId value, got: ${result.reason}`);
  });

  it('returns isSubAgent=true for decompSessionType=worker', () => {
    const result = detectSubAgent('factory', { type: 'session_start', decompSessionType: 'worker' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
    assert.ok(result.reason.includes('decompSessionType=worker'), `Reason: ${result.reason}`);
  });

  it('returns isSubAgent=false for decompSessionType=orchestrator (not a worker)', () => {
    const result = detectSubAgent('factory', { type: 'session_start', decompSessionType: 'orchestrator' });
    assert.equal(result.isSubAgent, false);
  });

  it('returns isSubAgent=false for parent key alone (user fork, not sub-agent)', () => {
    const result = detectSubAgent('factory', { type: 'session_start', parent: 'xyz' });
    assert.equal(result.isSubAgent, false);
    assert.equal(result.reason, null);
  });

  it('returns isSubAgent=true when both parent and callingSessionId are set (callingSessionId fires)', () => {
    const result = detectSubAgent('factory', { type: 'session_start', parent: 'xyz', callingSessionId: 'abc' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
    assert.ok(result.reason.includes('abc'), `Expected callingSessionId to be in reason, got: ${result.reason}`);
  });
});

// ── OpenCode explicit rules ────────────────────────────────────────────────

describe('detectSubAgent — opencode explicit rules', () => {
  it('returns isSubAgent=false for a main session with no parentID', () => {
    const result = detectSubAgent('opencode', { id: 'ses_main', title: 'My task', parentID: null });
    assert.equal(result.isSubAgent, false);
  });

  it('returns isSubAgent=true, confidence=certain for parentID set', () => {
    const result = detectSubAgent('opencode', { id: 'ses_child', parentID: 'ses_abc' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'certain');
    assert.ok(result.reason.includes('ses_abc'), `Expected reason to include parentID value, got: ${result.reason}`);
  });
});

// ── Generic heuristic still fires for unknown markers on known adapters ────

describe('detectSubAgent — heuristic fallback fires for factory/opencode on unknown markers', () => {
  it('fires generic heuristic for opencode session with thread_spawn key (no parentID)', () => {
    // parentID is absent so the opencode explicit rule returns false;
    // the heuristic should catch thread_spawn.
    const result = detectSubAgent('opencode', { id: 'ses_x', thread_spawn: { id: 'parent' } });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires generic heuristic for factory session with spawned_by key (no callingSessionId)', () => {
    const result = detectSubAgent('factory', { type: 'session_start', spawned_by: 'parent-session' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });
});

// ── Generic heuristic — unknown adapter ───────────────────────────────────

describe('detectSubAgent — generic heuristic fallback', () => {
  it('fires on unknown adapter with parent_thread_id key nested in metadata', () => {
    const result = detectSubAgent('futurecli', { metadata: { parent_thread_id: 'x' } });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
    assert.ok(result.reason.startsWith('generic:'), `Expected generic reason, got: ${result.reason}`);
  });

  it('does NOT fire on unrelated parent_company key (regex specificity)', () => {
    const result = detectSubAgent('unknown', { metadata: { parent_company: 'X' } });
    assert.equal(result.isSubAgent, false);
  });

  it('fires for depth=2 (numeric depth > 0)', () => {
    const result = detectSubAgent('unknown', { depth: 2 });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('does NOT fire for depth=0', () => {
    const result = detectSubAgent('unknown', { depth: 0 });
    assert.equal(result.isSubAgent, false);
  });

  it('does NOT fire for depth_limit key (wrong key name)', () => {
    const result = detectSubAgent('unknown', { depth_limit: 5 });
    assert.equal(result.isSubAgent, false);
  });

  it('fires for sub_agent key (underscore variant)', () => {
    const result = detectSubAgent('unknown', { sub_agent: true });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires for parent_session_id key', () => {
    const result = detectSubAgent('unknown', { parent_session_id: 'sess-123' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires for parent_uuid key', () => {
    const result = detectSubAgent('unknown', { parent_uuid: 'uuid-abc' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires for thread_spawn key', () => {
    const result = detectSubAgent('unknown', { thread_spawn: { id: 'x' } });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires for spawned_by key', () => {
    const result = detectSubAgent('unknown', { spawned_by: 'parent-session' });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires for is_sidechain key (case insensitive)', () => {
    const result = detectSubAgent('unknown', { IS_SIDECHAIN: true });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('fires for is_worker key', () => {
    const result = detectSubAgent('unknown', { is_worker: true });
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
  });

  it('finds match deeply nested within 6 levels', () => {
    const deepMeta = {
      a: { b: { c: { d: { e: { parent_thread_id: 'deep-match' } } } } },
    };
    const result = detectSubAgent('unknown', deepMeta);
    assert.equal(result.isSubAgent, true);
    assert.equal(result.confidence, 'heuristic');
    assert.ok(result.reason.includes('parent_thread_id'), `reason: ${result.reason}`);
  });

  it('does NOT crash on cyclic objects — returns without error', () => {
    const obj = { a: 1 };
    obj.self = obj; // cyclic reference
    assert.doesNotThrow(() => {
      detectSubAgent('unknown', obj);
    });
  });

  it('cyclic object returns a valid result without hanging', () => {
    const obj = { normal_key: 'x' };
    obj.loop = obj;
    const result = detectSubAgent('unknown', obj);
    // Should be false (no subagent key) and should not throw
    assert.equal(typeof result.isSubAgent, 'boolean');
  });

  it('does NOT fire on an object nested 7 levels deep (exceeds MAX_DEPTH)', () => {
    // MAX_DEPTH is 6; a key at level 7 should not be found.
    const deepMeta = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { parent_thread_id: 'too-deep' } } } } } } },
    };
    const result = detectSubAgent('unknown', deepMeta);
    // l7 is at depth 7 from root (0-indexed: root=0, l1=1, ..., l7=7)
    // The walk stops at depth > MAX_DEPTH (6), so l7 at depth 7 is NOT reached.
    assert.equal(result.isSubAgent, false);
  });
});

// ── Observability stats ────────────────────────────────────────────────────

describe('subAgentDetectorStats', () => {
  it('exports a stats object with certain and heuristic counters', () => {
    // Stats are cumulative across the test run above, so they should be > 0
    assert.ok(typeof subAgentDetectorStats.certain === 'number');
    assert.ok(typeof subAgentDetectorStats.heuristic === 'number');
    assert.ok(typeof subAgentDetectorStats.byAdapter === 'object');
    assert.ok(subAgentDetectorStats.certain > 0, 'Expected at least one certain hit from earlier tests');
    assert.ok(subAgentDetectorStats.heuristic > 0, 'Expected at least one heuristic hit from earlier tests');
  });

  it('byAdapter tracks hits per adapter name', () => {
    assert.ok('codex' in subAgentDetectorStats.byAdapter);
    assert.ok(subAgentDetectorStats.byAdapter.codex.certain > 0);
  });
});
