/**
 * Shared JSDoc type definitions for the trimTranscript module.
 *
 * No runtime code lives here — import this file only for JSDoc @type references.
 * All shapes are plain objects (no classes, no validation overhead).
 */

/**
 * A single cleaned conversation turn containing only natural-language text.
 *
 * @typedef {Object} CleanTurn
 * @property {'user' | 'assistant'} role        - Who spoke this turn.
 * @property {string}               content     - Plain-text content (tool calls, thinking, etc. stripped).
 * @property {string}               [timestamp] - ISO-8601 timestamp if available in source data.
 * @property {string}               [actionNote] - Optional human-readable note when a tool action
 *                                                 is summarised rather than dropped (only present
 *                                                 when TrimOptions.keepToolNotes is true).
 */

/**
 * Options that control how aggressively the trimmer strips content.
 *
 * @typedef {Object} TrimOptions
 * @property {boolean} [keepToolNotes=false]      - When true, replace dropped tool blocks with a
 *                                                  one-line "[Tool: <name>]" note in actionNote
 *                                                  instead of silently removing them.
 * @property {number}  [maxTurns]                 - Hard cap on the number of CleanTurns returned.
 *                                                  When set, keeps the LAST maxTurns turns so the
 *                                                  most recent context is preserved.
 * @property {boolean} [includeTimestamps=true]   - Copy source timestamps into CleanTurn.timestamp.
 *                                                  Set to false to omit them (saves chars in output).
 * @property {string}  [targetDate]               - Keep only turns assigned to this local YYYY-MM-DD date.
 */

/**
 * The return value from trimTranscript and every per-adapter parse() function.
 *
 * @typedef {Object} TrimResult
 * @property {CleanTurn[]} messages  - Cleaned conversation turns, chronological order.
 * @property {TrimStats}   stats     - Before/after size metrics.
 * @property {string[]}    warnings  - Non-fatal issues discovered during parsing.
 */

/**
 * Size and drop metrics produced by a trim operation.
 *
 * @typedef {Object} TrimStats
 * @property {number}              originalBytes  - Byte size of the raw source (file size, or
 *                                                  Buffer.byteLength of the raw string).
 * @property {number}              [originalLines] - Number of lines in a JSONL source.
 *                                                   Omitted for SQLite or non-line-based sources.
 * @property {number}              cleanedChars   - Total character count of all CleanTurn.content
 *                                                  strings in messages[].
 * @property {Record<string,number>} droppedCounts - How many items of each category were dropped.
 *                                                   Keys are block/event types (e.g. "tool_use",
 *                                                   "thinking", "system", "summary").
 */

/**
 * The canonical string identifier for each supported agent adapter.
 *
 * @typedef {'claude-code' | 'codex' | 'cursor' | 'factory' | 'grok' | 'opencode'} AdapterName
 */
