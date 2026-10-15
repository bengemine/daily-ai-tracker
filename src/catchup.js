/**
 * Catch-up logic for Daily AI Tracker.
 *
 * Determines which dates need processing based on recorded runs and journal files.
 * Never includes today or future dates.
 */

const fs = require('fs');
const path = require('path');
const { getLastRun } = require('./run-tracker');
const { formatDate } = require('./utils/date');
const config = require('./config');

function parseDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function getJournalPath(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return path.join(config.output.directory, year, month, `${day}.md`);
}

function hasJournalForDate(dateStr) {
  return fs.existsSync(getJournalPath(dateStr));
}

function getLatestJournalDate() {
  if (!fs.existsSync(config.output.directory)) {
    return null;
  }

  const years = fs.readdirSync(config.output.directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map(entry => entry.name)
    .sort();

  let latest = null;
  for (const year of years) {
    const yearDir = path.join(config.output.directory, year);
    const months = fs.readdirSync(yearDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d{2}$/.test(entry.name))
      .map(entry => entry.name)
      .sort();

    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const days = fs.readdirSync(monthDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^\d{2}\.md$/.test(entry.name))
        .map(entry => entry.name.slice(0, 2))
        .sort();

      for (const day of days) {
        latest = `${year}-${month}-${day}`;
      }
    }
  }

  return latest;
}

const MAX_WINDOW_DAYS = 14;

/**
 * Get the array of date strings that need processing.
 * By default, existing journal files are skipped. Set includeExisting to true
 * for explicit regeneration/repair runs.
 *
 * A safety cap of 14 days is enforced unless forceWindow is true. When the
 * computed window exceeds 14 days the function logs a WARNING to stderr and
 * trims the list to the most-recent 14 days (anchored on yesterday).
 *
 * @param {{ includeExisting?: boolean, forceWindow?: boolean }} [options]
 * @returns {string[]} Array of YYYY-MM-DD strings, oldest first
 */
function getDatesToProcess(options = {}) {
  const includeExisting = Boolean(options.includeExisting);
  const forceWindow = Boolean(options.forceWindow);
  const lastRun = getLastRun();
  const latestJournalDate = getLatestJournalDate();

  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayStr = formatDate(yesterday);

  const knownDates = [lastRun?.lastDate, latestJournalDate].filter(Boolean);
  if (knownDates.length === 0) {
    console.log('[catchup] First run - processing yesterday only');
    return [yesterdayStr];
  }

  const oldestKnown = knownDates
    .map(parseDate)
    .sort((a, b) => a - b)[0];

  const startDate = new Date(oldestKnown);
  startDate.setDate(startDate.getDate() + 1);

  const dates = [];
  const current = new Date(startDate);
  while (current <= yesterday) {
    const dateStr = formatDate(current);
    if (includeExisting || !hasJournalForDate(dateStr)) {
      dates.push(dateStr);
    }
    current.setDate(current.getDate() + 1);
  }

  if (dates.length === 0) {
    return [];
  }

  // Safety cap: if the window exceeds MAX_WINDOW_DAYS, trim to the most-recent
  // MAX_WINDOW_DAYS entries unless the caller explicitly opts out with forceWindow.
  if (dates.length > MAX_WINDOW_DAYS) {
    if (forceWindow) {
      process.stderr.write(
        `[catchup] INFO: --force-window active — processing all ${dates.length} days without cap.\n`
      );
    } else {
      const capDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - MAX_WINDOW_DAYS);
      const capDateStr = formatDate(capDate);
      process.stderr.write(
        `[catchup] WARN: requested window is ${dates.length} days — capping at ${MAX_WINDOW_DAYS} unless --force-window is passed. Missed dates older than ${capDateStr} will be skipped.\n`
      );
      // Keep only the most-recent MAX_WINDOW_DAYS entries (array is oldest-first)
      dates.splice(0, dates.length - MAX_WINDOW_DAYS);
    }
  }

  console.log(`[catchup] ${dates.length} day(s) to catch up`);
  return dates;
}

module.exports = { getDatesToProcess, getLatestJournalDate, hasJournalForDate, getJournalPath };
