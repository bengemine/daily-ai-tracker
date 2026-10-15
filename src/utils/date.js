/**
 * Date utilities for target-day filtering.
 * Handles both millisecond epoch (history.jsonl) and ISO 8601 string (session files) timestamps.
 */

/**
 * Tracker workdays start at 4 AM local time. This keeps after-midnight work
 * with the preceding evening while leaving ordinary calendar dates unchanged.
 * @param {string} dateStr - e.g. "2026-03-13"
 * @returns {{ start: Date, end: Date }}
 */
function getDateRange(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const start = new Date(year, month - 1, day, 4, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 4, 0, 0, 0);
  return { start, end };
}

/**
 * Check whether a timestamp falls within a date range.
 * @param {number|string} timestamp - Millisecond epoch or ISO 8601 string
 * @param {{ start: Date, end: Date }} dateRange
 * @returns {boolean}
 */
function isWithinDate(timestamp, dateRange) {
  const ts = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);
  return ts >= dateRange.start && ts < dateRange.end;
}

/**
 * Format a Date for display.
 * @param {Date} date
 * @returns {string} e.g. "2026-03-13"
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format a timestamp as its tracker workday. Local times before 4 AM belong
 * to the preceding calendar date.
 */
function formatWorkDate(date) {
  const shifted = new Date(date);
  shifted.setHours(shifted.getHours() - 4);
  return formatDate(shifted);
}

module.exports = { getDateRange, isWithinDate, formatDate, formatWorkDate };
