/**
 * Shared utilities for the trimTranscript module.
 *
 * All helpers here are pure (no I/O side-effects) except assertReadOnly,
 * which performs a stat + hash fingerprint of a file path as a safety check.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

// ── assertReadOnly ─────────────────────────────────────────────────────────────

/**
 * Fingerprints a file (mtime + sha256) so adapters can optionally verify that
 * a source file was not modified during a trim call.
 *
 * Call BEFORE the trim, capture the result, call AFTER, then compare.
 * Throws if the file does not exist (protects against path typos).
 *
 * @param {string} filePath - Absolute path to the source file to fingerprint.
 * @returns {{ mtime: number, sha256: string }} Fingerprint object.
 */
function assertReadOnly(filePath) {
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return { mtime: stat.mtimeMs, sha256 };
}

// ── safeJsonParse ──────────────────────────────────────────────────────────────

/**
 * Tolerant JSON.parse that returns null (instead of throwing) on invalid input.
 *
 * Use this when iterating JSONL lines — malformed lines are skipped rather than
 * crashing the whole parse run.
 *
 * @param {string} line - A single JSONL text line.
 * @returns {unknown | null} Parsed value, or null if the line is not valid JSON.
 */
function safeJsonParse(line) {
  if (typeof line !== 'string' || line.trim() === '') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ── countTokensApprox ──────────────────────────────────────────────────────────

/**
 * Rough token-count estimate using the chars/4 rule of thumb.
 * Good enough for progress reporting and stats — not a billable count.
 *
 * @param {string} text - Any string.
 * @returns {number} Estimated token count (always an integer, minimum 0).
 */
function countTokensApprox(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

module.exports = { assertReadOnly, safeJsonParse, countTokensApprox };
