/**
 * Run tracker for Daily AI Tracker.
 *
 * Manages a .last-run.json marker file in the output directory.
 * Only records after successful journal generation — never on partial/failed runs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const MARKER_FILE = '.last-run.json';

/**
 * Get the path to the marker file.
 * @returns {string}
 */
function getMarkerPath() {
  return path.join(config.output.directory, MARKER_FILE);
}

/**
 * Read the last successful run date.
 * @returns {{ lastDate: string, timestamp: string }|null} Last run info, or null if missing/corrupt
 */
function getLastRun() {
  const markerPath = getMarkerPath();
  try {
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data.lastDate === 'string') {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record a successful run date. Writes atomically via temp file + rename.
 * @param {string} dateStr - YYYY-MM-DD date that was successfully processed
 */
function recordRun(dateStr) {
  const markerPath = getMarkerPath();
  const dir = path.dirname(markerPath);

  fs.mkdirSync(dir, { recursive: true });

  const data = {
    lastDate: dateStr,
    timestamp: new Date().toISOString(),
  };
  const content = JSON.stringify(data, null, 2) + '\n';

  // Atomic write: temp file in same directory, then rename over
  const tmpPath = path.join(dir, `.last-run-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, markerPath);
  } catch (err) {
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

module.exports = { getLastRun, recordRun };
