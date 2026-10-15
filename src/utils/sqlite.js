/**
 * SQLite utility — shared read-only database access via node:sqlite.
 * Wraps DatabaseSync with readOnly: true. Returns null for missing files.
 */

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

/**
 * Open a SQLite database in read-only mode.
 * @param {string} dbPath - Absolute path to the .db or .vscdb file
 * @returns {import('node:sqlite').DatabaseSync | null} Database instance or null if file missing
 */
function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.warn(`[warn] Database not found: ${dbPath}`);
    return null;
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    console.warn(`[warn] Failed to open database ${dbPath}: ${err.message}`);
    return null;
  }
}

module.exports = { openDatabase };
