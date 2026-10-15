'use strict';

/**
 * Centralized sub-agent detection filter.
 *
 * Prevents sub-agent session files from leaking into the Daily Tracker
 * overview table. Supports both explicit per-CLI rules (certain) and a
 * generic heuristic fallback (heuristic) for CLIs not yet enumerated here.
 */

// ── Observability counters ─────────────────────────────────────────────────

const subAgentDetectorStats = {
  certain: 0,
  heuristic: 0,
  byAdapter: {},
};

function _recordHit(adapterName, confidence) {
  if (confidence === 'certain') subAgentDetectorStats.certain++;
  else if (confidence === 'heuristic') subAgentDetectorStats.heuristic++;

  if (!subAgentDetectorStats.byAdapter[adapterName]) {
    subAgentDetectorStats.byAdapter[adapterName] = { certain: 0, heuristic: 0 };
  }
  const slot = subAgentDetectorStats.byAdapter[adapterName];
  if (confidence === 'certain') slot.certain++;
  else if (confidence === 'heuristic') slot.heuristic++;
}

// ── Generic heuristic ─────────────────────────────────────────────────────

/**
 * Keys that — when found anywhere in firstLineMeta (up to MAX_DEPTH levels
 * deep) — indicate the session is a sub-agent.
 */
const SUBAGENT_KEY_PATTERN =
  /^(sub_?agent|parent_thread_?id|parent_session_?id|parent_uuid|thread_spawn|spawned_by|spawn_parent|is_sidechain|side_?chain|agent_role|is_worker)$/i;

const MAX_DEPTH = 6;

/**
 * Recursively walk `obj` looking for any key matching SUBAGENT_KEY_PATTERN
 * or a numeric `depth` field with value > 0.
 *
 * Returns `{ matched: true, keyPath: string, value: * }` on first match,
 * or `{ matched: false }` if nothing found.
 *
 * Uses a `seen` WeakSet to handle cyclic references without crashing.
 *
 * @param {*} obj
 * @param {string} currentPath
 * @param {number} depth
 * @param {WeakSet} seen
 * @returns {{ matched: boolean, keyPath?: string, value?: * }}
 */
function _walkForSubagentKeys(obj, currentPath, depth, seen) {
  if (depth > MAX_DEPTH) return { matched: false };
  if (obj === null || typeof obj !== 'object') return { matched: false };

  // Guard against circular references
  if (seen.has(obj)) return { matched: false };
  seen.add(obj);

  for (const key of Object.keys(obj)) {
    const keyPath = currentPath ? `${currentPath}.${key}` : key;
    const value = obj[key];

    // Explicit key-name match
    if (SUBAGENT_KEY_PATTERN.test(key)) {
      return { matched: true, keyPath, value };
    }

    // Numeric depth > 0 check
    if (key === 'depth' && typeof value === 'number' && value > 0) {
      return { matched: true, keyPath, value };
    }

    // Recurse into nested objects / arrays
    if (value !== null && typeof value === 'object') {
      const nested = _walkForSubagentKeys(value, keyPath, depth + 1, seen);
      if (nested.matched) return nested;
    }
  }

  return { matched: false };
}

/**
 * Run the generic heuristic scan on firstLineMeta.
 *
 * @param {object} firstLineMeta
 * @returns {{ isSubAgent: boolean, reason: string | null, confidence: 'heuristic' | null }}
 */
function _genericHeuristic(firstLineMeta) {
  if (!firstLineMeta || typeof firstLineMeta !== 'object') {
    return { isSubAgent: false, reason: null, confidence: null };
  }

  const seen = new WeakSet();
  const result = _walkForSubagentKeys(firstLineMeta, '', 0, seen);

  if (result.matched) {
    return {
      isSubAgent: true,
      reason: `generic: key '${result.keyPath}'=${JSON.stringify(result.value)}`,
      confidence: 'heuristic',
    };
  }

  return { isSubAgent: false, reason: null, confidence: null };
}

// ── Per-CLI explicit rules ─────────────────────────────────────────────────

/**
 * Codex explicit rule.
 *
 * A session is a sub-agent if `payload.source` is an object AND any of:
 *   - has a `subagent` key
 *   - has a `thread_spawn` key
 *   - has an `agent_role` value in ['worker', 'helper', 'tool']
 */
function _detectCodex(firstLineMeta) {
  const source = firstLineMeta?.payload?.source;

  // source must be an object (not a string like "exec" or "tui")
  if (typeof source !== 'object' || source === null) {
    return { isSubAgent: false, reason: null, confidence: null };
  }

  const hasSubagentKey = 'subagent' in source;
  const hasThreadSpawn = 'thread_spawn' in source;

  // Check agent_role at top-level source or inside nested objects
  const WORKER_ROLES = new Set(['worker', 'helper', 'tool']);
  const agentRole = source.agent_role;
  const hasWorkerRole = typeof agentRole === 'string' && WORKER_ROLES.has(agentRole);

  // Also check inside source.subagent.thread_spawn if present
  const threadSpawn = source?.subagent?.thread_spawn || source?.thread_spawn;
  const spawnRole = threadSpawn?.agent_role;
  const hasSpawnRole = typeof spawnRole === 'string' && WORKER_ROLES.has(spawnRole);
  const parentId = threadSpawn?.parent_thread_id || null;
  const depth = threadSpawn?.depth != null ? threadSpawn.depth : null;

  if (hasSubagentKey || hasThreadSpawn || hasWorkerRole || hasSpawnRole) {
    let reason = 'codex.source.subagent';
    if (threadSpawn) {
      const parts = ['codex.source.subagent.thread_spawn'];
      if (parentId) parts.push(`parent=${parentId}`);
      if (depth != null) parts.push(`depth=${depth}`);
      reason = `${parts[0]} (${parts.slice(1).join(', ')})`;
    }
    return { isSubAgent: true, reason, confidence: 'certain' };
  }

  return { isSubAgent: false, reason: null, confidence: null };
}

/**
 * Claude Code explicit rule.
 *
 * A session is a sub-agent if:
 *   - `firstLineMeta.isSidechain === true`, OR
 *   - `firstLineMeta.isMeta === true` AND the file lives in a `subagents/` directory
 *     (the caller is responsible for verifying the path; we detect `isMeta` here
 *     and the codex adapter checks the path).
 */
function _detectClaudeCode(firstLineMeta) {
  if (firstLineMeta?.isSidechain === true) {
    return { isSubAgent: true, reason: 'claude-code.isSidechain=true', confidence: 'certain' };
  }

  // isMeta alone is not enough — caller must also confirm subagents/ directory.
  // We do NOT mark it certain here; return false and let the generic heuristic
  // or the adapter's path check handle it.
  return { isSubAgent: false, reason: null, confidence: null };
}

/**
 * Factory explicit rule.
 *
 * Two mechanisms identify a sub-agent session:
 *   1. callingSessionId — set by the Task tool when it spawns a worker session.
 *   2. decompSessionType === 'worker' — Factory's internal decomposition system.
 *
 * NOTE: `firstLineMeta?.parent` is deliberately NOT treated as a sub-agent
 * signal — it indicates a user-initiated fork, not a programmatic spawn.
 */
function _detectFactory(firstLineMeta) {
  // Mechanism 1: Task-tool-spawned worker session
  if (firstLineMeta?.callingSessionId) {
    return {
      isSubAgent: true,
      confidence: 'certain',
      reason: `factory.callingSessionId=${firstLineMeta.callingSessionId}`,
    };
  }
  // Mechanism 2: Factory's decomposition system
  if (firstLineMeta?.decompSessionType === 'worker') {
    return {
      isSubAgent: true,
      confidence: 'certain',
      reason: 'factory.decompSessionType=worker',
    };
  }
  return { isSubAgent: false, reason: null, confidence: null };
}

/**
 * OpenCode explicit rule.
 *
 * A session is a sub-agent if `parentID` is set on the session record.
 * This is written by OpenCode when one session spawns another as a tool call.
 */
function _detectOpenCode(firstLineMeta) {
  if (firstLineMeta?.parentID) {
    return {
      isSubAgent: true,
      confidence: 'certain',
      reason: `opencode.parentID=${firstLineMeta.parentID}`,
    };
  }
  return { isSubAgent: false, reason: null, confidence: null };
}

// Dispatch map: adapterName → explicit detection function
const EXPLICIT_RULES = {
  'codex': _detectCodex,
  'claude-code': _detectClaudeCode,
  'factory': _detectFactory,
  'opencode': _detectOpenCode,
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect whether a session file represents a sub-agent thread.
 *
 * @param {string} adapterName
 *   One of 'codex' | 'claude-code' | 'factory' | 'opencode' | 'cursor' | 'grok' | string
 * @param {object} firstLineMeta
 *   The parsed first-line object of a session file (or equivalent metadata).
 * @returns {{ isSubAgent: boolean, reason: string | null, confidence: 'certain' | 'heuristic' | null }}
 */
function detectSubAgent(adapterName, firstLineMeta) {
  // A. Explicit per-CLI rule
  const explicitFn = EXPLICIT_RULES[adapterName];
  if (explicitFn) {
    const explicit = explicitFn(firstLineMeta);
    if (explicit.isSubAgent) {
      _recordHit(adapterName, explicit.confidence);
      return explicit;
    }
  }

  // B. Generic heuristic fallback (runs for ALL adapters, including known ones
  //    that returned false from the explicit check)
  const heuristic = _genericHeuristic(firstLineMeta);
  if (heuristic.isSubAgent) {
    _recordHit(adapterName, heuristic.confidence);
    return heuristic;
  }

  return { isSubAgent: false, reason: null, confidence: null };
}

module.exports = { detectSubAgent, subAgentDetectorStats };
