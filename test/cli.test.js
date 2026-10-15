const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, validateDate, USAGE } = require('../tracker');

describe('parseArgs', () => {
  it('returns defaults when no args', () => {
    const result = parseArgs([]);
    assert.equal(result.dateStr, null);
    assert.equal(result.dryRun, false);
    assert.equal(result.help, false);
    assert.equal(result.error, null);
  });

  it('detects --help', () => {
    const result = parseArgs(['--help']);
    assert.equal(result.help, true);
    assert.equal(result.error, null);
  });

  it('detects --dry-run', () => {
    const result = parseArgs(['--dry-run']);
    assert.equal(result.dryRun, true);
    assert.equal(result.force, false);
    assert.equal(result.error, null);
  });

  it('detects --force and --overwrite', () => {
    assert.equal(parseArgs(['--force']).force, true);
    assert.equal(parseArgs(['--overwrite']).force, true);
  });

  it('parses valid --date', () => {
    const result = parseArgs(['--date', '2026-03-13']);
    assert.equal(result.dateStr, '2026-03-13');
    assert.equal(result.error, null);
  });

  it('combines --date and --dry-run', () => {
    const result = parseArgs(['--date', '2026-03-13', '--dry-run']);
    assert.equal(result.dateStr, '2026-03-13');
    assert.equal(result.dryRun, true);
    assert.equal(result.error, null);
  });

  it('combines --date and --force', () => {
    const result = parseArgs(['--date', '2026-03-13', '--force']);
    assert.equal(result.dateStr, '2026-03-13');
    assert.equal(result.force, true);
    assert.equal(result.error, null);
  });

  it('errors on --date without value', () => {
    const result = parseArgs(['--date']);
    assert.ok(result.error);
    assert.ok(result.error.includes('--date requires a value'));
  });

  it('errors on --date followed by another flag', () => {
    const result = parseArgs(['--date', '--dry-run']);
    assert.ok(result.error);
    assert.ok(result.error.includes('--date requires a value'));
  });

  it('errors on unknown flag', () => {
    const result = parseArgs(['--verbose']);
    assert.ok(result.error);
    assert.ok(result.error.includes('Unknown option'));
    assert.ok(result.error.includes('--verbose'));
  });

  it('errors on invalid date format', () => {
    const result = parseArgs(['--date', '13-03-2026']);
    assert.ok(result.error);
    assert.ok(result.error.includes('Invalid date format'));
  });

  it('errors on impossible date (Feb 30)', () => {
    const result = parseArgs(['--date', '2026-02-30']);
    assert.ok(result.error);
    assert.ok(result.error.includes('not a real calendar date'));
  });

  it('errors on future date', () => {
    // Use a date far in the future
    const result = parseArgs(['--date', '2099-01-01']);
    assert.ok(result.error);
    assert.ok(result.error.includes('future'));
  });
});

describe('validateDate', () => {
  it('accepts valid past date', () => {
    const result = validateDate('2026-03-13');
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it('rejects non-YYYY-MM-DD format', () => {
    assert.equal(validateDate('March 13').valid, false);
    assert.equal(validateDate('2026/03/13').valid, false);
    assert.equal(validateDate('20260313').valid, false);
    assert.equal(validateDate('2026-3-13').valid, false);
  });

  it('rejects impossible calendar dates', () => {
    assert.equal(validateDate('2026-02-29').valid, false); // not a leap year
    assert.equal(validateDate('2026-13-01').valid, false); // month 13
    assert.equal(validateDate('2026-00-15').valid, false); // month 0
    assert.equal(validateDate('2026-04-31').valid, false); // April has 30 days
  });

  it('accepts leap year Feb 29', () => {
    assert.equal(validateDate('2024-02-29').valid, true); // 2024 was a leap year
  });

  it('rejects today', () => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const result = validateDate(`${yyyy}-${mm}-${dd}`);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('future'));
  });

  it('rejects future date', () => {
    const result = validateDate('2099-06-15');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('future'));
  });
});

describe('USAGE', () => {
  it('contains all documented flags', () => {
    assert.ok(USAGE.includes('--date'));
    assert.ok(USAGE.includes('--dry-run'));
    assert.ok(USAGE.includes('--force'));
    assert.ok(USAGE.includes('--overwrite'));
    assert.ok(USAGE.includes('--help'));
    assert.ok(USAGE.includes('YYYY-MM-DD'));
  });

  it('contains examples', () => {
    assert.ok(USAGE.includes('Examples:'));
  });
});
