/**
 * trimTranscript — entry point for the transcript preprocessing layer.
 *
 * Takes a raw agent conversation source (JSONL file path, raw JSONL string, or
 * SQLite DB handle), dispatches to the matching per-adapter parser, and returns
 * a TrimResult containing only natural-language user/assistant turns.
 *
 * READ-ONLY INVARIANT: This module (and every adapter it loads) MUST NEVER
 * write, modify, delete, rename, or lock any file under ~/.claude/, ~/.codex/,
 * Cursor's state.vscdb, ~/.factory/, or ~/.local/share/opencode/.
 * All access to those paths is strictly read-only.
 */

'use strict';

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Map of registered adapter names → parse functions.
 * Pre-populated via lazy dynamic require; extensible via registerAdapter().
 *
 * @type {Map<string, import('./types').AdapterParseFn>}
 */
const _registry = new Map();

/**
 * Register a custom adapter parse function under a given name.
 *
 * Useful for testing (inject a mock adapter without touching the filesystem)
 * or for adding a new adapter without modifying this file.
 *
 * @param {string}   name - Adapter identifier (e.g. 'claude-code').
 * @param {Function} fn   - async function(source, options) → TrimResult-partial.
 *                          Must return { messages, stats (partial), warnings }.
 * @returns {void}
 */
function registerAdapter(name, fn) {
  if (typeof name !== 'string' || !name) throw new TypeError('Adapter name must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError('Adapter fn must be a function');
  _registry.set(name, fn);
}

// ── Helpers exported for direct use and testing ────────────────────────────────

/**
 * Tag patterns to strip from concatenated text as a final safety net.
 * Covers both block-level XML-style tags that sometimes leak into text content.
 */
const RESIDUAL_TAG_RE =
  /<(system-reminder|thinking|tool_use|tool_result|antml:function_calls|function_calls)[^>]*>[\s\S]*?<\/\1>/gi;

/** Matches any remaining opening/closing tags of the above types (unmatched halves). */
const RESIDUAL_LONE_TAG_RE =
  /<\/?(system-reminder|thinking|tool_use|tool_result|antml:function_calls|function_calls)[^>]*>/gi;

/**
 * Strip XML-style noise tags and their contents from a string.
 *
 * Handles: <thinking>, <system-reminder>, <tool_use>, <tool_result>,
 *          <function_calls>, <function_calls> (and their closing tags).
 * After removing block content, also removes any orphaned lone tags.
 *
 * @param {string} text - Input text that may contain residual XML tags.
 * @returns {string} Text with all matched tags and their contents removed.
 */
function stripResidualTags(text) {
  if (!text || typeof text !== 'string') return '';
  // First pass: remove tag blocks including their content.
  let result = text.replace(RESIDUAL_TAG_RE, '');
  // Second pass: remove any remaining unpaired opening/closing tags.
  result = result.replace(RESIDUAL_LONE_TAG_RE, '');
  return result;
}

/**
 * Collapse runs of whitespace (spaces, tabs, newlines) into a single space
 * and trim leading/trailing whitespace.
 *
 * @param {string} text - Any string.
 * @returns {string} Normalised string.
 */
function normalizeWhitespace(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Flatten an array of Anthropic-style content blocks into a single plain-text string.
 *
 * Keeps only blocks where type === 'text'. Drops: 'thinking', 'tool_use',
 * 'tool_result', and any unknown block type. The concatenated text is then
 * passed through stripResidualTags as a final safety net for inline tags.
 *
 * @param {Array<{type: string, text?: string, [key: string]: unknown}>} blocks
 *   Array of content blocks (Anthropic / Claude Code message format).
 * @returns {string} Concatenated plain text from all text blocks, tags stripped.
 */
function flattenContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const textParts = blocks
    .filter(b => b && typeof b === 'object' && b.type === 'text')
    .map(b => (typeof b.text === 'string' ? b.text : ''));
  const joined = textParts.join('\n').trim();
  return stripResidualTags(joined);
}

// ── Empty result factory ───────────────────────────────────────────────────────

/**
 * Build an empty TrimResult with sensible zero values.
 *
 * @param {number} [originalBytes=0]
 * @returns {import('./types').TrimResult}
 */
function _emptyResult(originalBytes = 0) {
  return {
    messages: [],
    stats: {
      originalBytes,
      cleanedChars: 0,
      droppedCounts: {},
    },
    warnings: [],
  };
}

// ── trimTranscript ─────────────────────────────────────────────────────────────

/**
 * Trim a raw agent conversation down to natural-language turns only.
 *
 * @param {string | object} source
 *   - A filesystem path (string ending in .jsonl or a database path).
 *   - A raw JSONL string (multi-line, no newline-terminated file).
 *   - A better-sqlite3 Database handle (for SQLite-backed adapters like Cursor).
 * @param {import('./types').AdapterName} adapterName
 *   Which adapter parser to use. Must match a key in the registry or a module
 *   at ./adapters/<adapterName>.js.
 * @param {import('./types').TrimOptions} [options={}]
 *   Trim behaviour options (keepToolNotes, maxTurns, includeTimestamps).
 * @returns {Promise<import('./types').TrimResult>}
 */
async function trimTranscript(source, adapterName, options = {}) {
  // Resolve adapter — registry first, then lazy require.
  let parseFn = _registry.get(adapterName);

  if (!parseFn) {
    try {
      const mod = require(`./adapters/${adapterName}.js`);
      parseFn = mod.parse || mod.default;
      if (typeof parseFn !== 'function') throw new Error('No parse export');
      // Cache for subsequent calls.
      _registry.set(adapterName, parseFn);
    } catch (loadErr) {
      const result = _emptyResult(0);
      result.warnings.push(
        `Unknown or unloadable adapter "${adapterName}": ${loadErr.message}`
      );
      return result;
    }
  }

  // Determine original byte size for stats.
  let originalBytes = 0;
  if (typeof source === 'string') {
    // Could be a file path or raw JSONL — measure either way.
    originalBytes = Buffer.byteLength(source, 'utf8');
  }

  // Invoke adapter.
  let adapterResult;
  try {
    adapterResult = await parseFn(source, options);
  } catch (runErr) {
    const result = _emptyResult(originalBytes);
    result.warnings.push(`Adapter "${adapterName}" threw during parse: ${runErr.message}`);
    return result;
  }

  // Merge into canonical TrimResult shape.
  const messages = Array.isArray(adapterResult.messages) ? adapterResult.messages : [];

  // Apply maxTurns cap (keep last N turns).
  const maxTurns = options.maxTurns;
  const capped = (maxTurns && maxTurns > 0 && messages.length > maxTurns)
    ? messages.slice(messages.length - maxTurns)
    : messages;

  // Compute cleanedChars from actual messages.
  const cleanedChars = capped.reduce((acc, t) => acc + (t.content ? t.content.length : 0), 0);

  const stats = {
    originalBytes: adapterResult.stats?.originalBytes ?? originalBytes,
    cleanedChars,
    droppedCounts: adapterResult.stats?.droppedCounts ?? {},
    ...(adapterResult.stats?.originalLines != null
      ? { originalLines: adapterResult.stats.originalLines }
      : {}),
  };

  return {
    messages: capped,
    stats,
    warnings: Array.isArray(adapterResult.warnings) ? adapterResult.warnings : [],
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  trimTranscript,
  registerAdapter,
  flattenContentBlocks,
  stripResidualTags,
  normalizeWhitespace,
};
