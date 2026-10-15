#!/usr/bin/env node

/**
 * Daily AI Tracker — CLI entry point.
 *
 * Pipeline: load deterministic clean store → summarize → journal write.
 *
 * Usage:
 *   node tracker.js --date YYYY-MM-DD   Process a specific date
 *   node tracker.js --date YYYY-MM-DD --force
 *   node tracker.js --dry-run           Show which dates would be processed
 *   node tracker.js                     Catch-up mode (fills gaps since last run)
 */

const { createRunSummarizer, formatCleanTranscript } = require('./src/summarizer');
const { generateJournal } = require('./src/journal');
const { summarizeDay } = require('./src/summary-orchestrator');
const { highlightsFromTurns, hasVisibleUserTurn } = require('./src/daily-transcript');
const { readConversationArtifactsForDate } = require('./src/conversation-artifacts');
const { getDatesToProcess, hasJournalForDate, getJournalPath } = require('./src/catchup');
const { recordRun } = require('./src/run-tracker');

// ── Usage ─────────────────────────────────────────────────────────

const USAGE = `
Daily AI Tracker — Automated AI conversation journal generator.

Usage:
  node tracker.js                     Catch-up mode (fills gaps since last run)
  node tracker.js --date YYYY-MM-DD   Process a specific date
  node tracker.js --date YYYY-MM-DD --force
  node tracker.js --dry-run           Show which dates would be processed
  node tracker.js --help              Show this help message

Options:
  --date YYYY-MM-DD   Generate a journal for a specific past date
  --dry-run           Preview which dates would be processed without running
  --force             Overwrite existing journal files AND bypass the 14-day window cap
  --overwrite         Alias for --force
  --force-window      Bypass only the 14-day window cap (existing files still skipped)
  --help              Show this help message and exit

Examples:
  node tracker.js --date 2026-03-13        Journal for March 13, 2026
  node tracker.js --date 2026-04-15 --force
  node tracker.js --dry-run                See pending catch-up dates
  node tracker.js --force --dry-run        See catch-up dates including existing journals
  node tracker.js --force-window           Catch-up beyond 14 days without overwriting files
  node tracker.js                          Run catch-up (default)
`.trim();

// ── Parse arguments ───────────────────────────────────────────────

/**
 * Validate a date string is YYYY-MM-DD format and represents a real, non-future date.
 * @param {string} str
 * @returns {{ valid: boolean, error?: string }}
 */
function validateDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return { valid: false, error: `Invalid date format: "${str}". Expected YYYY-MM-DD.` };
  }

  const [year, month, day] = str.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);

  // Check the date components round-trip (catches Feb 30, month 13, etc.)
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return { valid: false, error: `Invalid date: "${str}" is not a real calendar date.` };
  }

  // Reject future dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (parsed >= today) {
    return { valid: false, error: `Date "${str}" is today or in the future. Only past dates are allowed.` };
  }

  return { valid: true };
}

function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const result = { dateStr: null, dryRun: false, force: false, forceWindow: false, help: false, error: null };

  // Check for unknown flags
  const knownFlags = ['--date', '--dry-run', '--force', '--overwrite', '--force-window', '--help'];
  for (const arg of args) {
    if (arg.startsWith('--') && !knownFlags.includes(arg)) {
      result.error = `Unknown option: "${arg}". Use --help for usage.`;
      return result;
    }
  }

  result.help = args.includes('--help');
  result.dryRun = args.includes('--dry-run');
  result.force = args.includes('--force') || args.includes('--overwrite');
  // --force-window bypasses the 14-day cap; --force implies it as well
  result.forceWindow = result.force || args.includes('--force-window');

  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1) {
    const dateVal = args[dateIdx + 1];
    if (!dateVal || dateVal.startsWith('--')) {
      result.error = '--date requires a value in YYYY-MM-DD format. Use --help for usage.';
      return result;
    }

    const validation = validateDate(dateVal);
    if (!validation.valid) {
      result.error = validation.error;
      return result;
    }

    result.dateStr = dateVal;
  }

  return result;
}

// ── Single-date pipeline ──────────────────────────────────────────

/**
 * Run the full pipeline for a single date:
 * clean-store load → dedup → summarize → journal write.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {object} [deps] - Injectable dependencies for testing
 * @param {Function} [deps.summarize] - legacy per-session summarizer replacement
 * @param {Function} [deps.summarizeDay] - daily orchestrator replacement
 * @param {Function} [deps.loadIndexed] - clean-store reader replacement
 * @returns {Promise<string|null>} Path to written journal, or null if no activity
 */
async function runForDate(dateStr, deps = {}) {
  const summarize = deps.summarize;
  const summarizeAll = deps.summarizeDay || summarizeDay;
  const loadIndexed = deps.loadIndexed || readConversationArtifactsForDate;
  const writeJournal = deps.generateJournal || generateJournal;
  const outputDir = deps.outputDir;
  const conversationStoreDir = deps.conversationStoreDir || outputDir;

  console.log(`[tracker] Processing date: ${dateStr}`);

  // Production tracking starts strictly from the deterministic clean store.
  // Raw agent adapters are intentionally not imported or available here.
  const indexed = await loadIndexed(dateStr, conversationStoreDir);
  const sessionMap = new Map();
  for (const record of indexed) {
    const session = { ...record.session, activityDate: dateStr };
    const messages = Array.isArray(record.messages) ? record.messages : [];
    if (!hasVisibleUserTurn(messages)) continue;
    session.cleanedTranscript = {
      messages,
      cleanText: formatCleanTranscript(messages),
      trimStats: record.trimStats || {},
      warnings: record.warnings || [],
    };
    const highlights = highlightsFromTurns(messages);
    sessionMap.set(session.sessionKey || `${session.agent}:${session.id}`, { session, highlights, messages });
  }

  const uniqueCount = sessionMap.size;
  console.log(`[tracker] ${uniqueCount} indexed clean session(s)`);

  const records = [...sessionMap.values()];
  const entries = [];
  if (summarize) {
    let idx = 0;
    for (const [sessionId, { session, highlights }] of sessionMap) {
      idx++;
      const prefix = sessionId.length > 12 ? sessionId.slice(0, 12) + '...' : sessionId;
      console.log(`[tracker] Summarizing session ${idx} of ${uniqueCount}: ${prefix}`);
      const summary = await summarize(highlights, session);
      entries.push({ session, highlights, summary });
    }
  } else if (records.length > 0) {
    console.log(`[tracker] Starting one daily summary orchestrator for ${uniqueCount} session(s)`);
    const summaries = await summarizeAll(dateStr, records, { outputDir, summaryConfig: deps.summaryConfig, env: deps.env });
    for (const record of records) {
      const key = record.session.sessionKey || `${record.session.agent}:${record.session.id}`;
      entries.push({ ...record, summary: summaries.get(key) });
    }
  }

  // Write a journal even for no-activity days so catch-up state is visible on disk.
  const writtenPath = writeJournal(dateStr, entries, outputDir);

  if (uniqueCount === 0) {
    console.log(`[tracker] No activity for ${dateStr}`);
  } else {
    console.log(`[tracker] Journal written: ${writtenPath}`);
  }

  return writtenPath;
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const { dateStr, dryRun, force, forceWindow, help, error } = parseArgs();

  if (help) {
    console.log(USAGE);
    return;
  }

  if (error) {
    console.error(`[cli] ${error}`);
    process.exit(1);
  }

  console.log(`\n═══ Daily AI Tracker ═══\n`);

  if (dateStr) {
    // --date mode: process a single specific date
    if (dryRun) {
      const action = force ? 'force process' : 'process';
      console.log(`[dry-run] Would ${action}: ${dateStr}`);
      return;
    }
    if (hasJournalForDate(dateStr) && !force) {
      console.log(`[tracker] Journal already exists for ${dateStr}: ${getJournalPath(dateStr)}`);
      console.log('[tracker] Use --force to overwrite it.');
      return;
    }
    await runForDate(dateStr);
  } else {
    // Catch-up mode: process all dates since last run
    const dates = getDatesToProcess({ includeExisting: force, forceWindow });

    if (dates.length === 0) {
      console.log('[tracker] Already caught up — nothing to process');
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] Would process ${dates.length} date(s):`);
      for (const d of dates) {
        console.log(`[dry-run]   ${d}`);
      }
      return;
    }

    // Process each date. Only recordRun after ALL dates succeed.
    for (const d of dates) {
      await runForDate(d);
    }

    // Record last processed date
    const lastDate = dates[dates.length - 1];
    recordRun(lastDate);
    console.log(`[tracker] Run recorded: last processed date = ${lastDate}`);
  }

  console.log(`\n═══ Done ═══\n`);
}

module.exports = { runForDate, parseArgs, validateDate, USAGE };

// Run when invoked directly
if (require.main === module) {
  main().catch(err => {
    console.error(`[fatal] ${err.message}`);
    process.exit(1);
  });
}
