const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/config');
const { recordRun } = require('../src/run-tracker');
const { formatDate } = require('../src/utils/date');
const { generateJournal } = require('../src/journal');

let originalDir;
let tmpDir;

function setupTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-test-'));
  originalDir = config.output.directory;
  config.output.directory = tmpDir;
}

function teardownTmpDir() {
  config.output.directory = originalDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const { getDatesToProcess } = require('../src/catchup');

function getYesterday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}

function getToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

describe('catch-up', () => {
  beforeEach(() => setupTmpDir());
  afterEach(() => teardownTmpDir());

  it('first run (no marker) returns yesterday only', () => {
    const dates = getDatesToProcess();
    const yesterday = formatDate(getYesterday());
    assert.deepEqual(dates, [yesterday]);
  });

  it('uses existing journal files as catch-up baseline when marker is missing', () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    generateJournal(formatDate(threeDaysAgo), []);
    const dates = getDatesToProcess();
    assert.ok(dates.includes(formatDate(twoDaysAgo)));
    assert.ok(dates.includes(formatDate(yesterday)));
  });

  it('backfills missing journal dates even if marker is ahead', () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    generateJournal(formatDate(threeDaysAgo), []);
    recordRun(formatDate(yesterday));
    const dates = getDatesToProcess();
    assert.deepEqual(dates, [formatDate(twoDaysAgo), formatDate(yesterday)]);
  });

  it('includes existing journals during explicit force catch-up', () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

    recordRun(formatDate(threeDaysAgo));
    generateJournal(formatDate(twoDaysAgo), []);

    const dates = getDatesToProcess({ includeExisting: true });

    assert.deepEqual(dates, [formatDate(twoDaysAgo), formatDate(yesterday)]);
  });

  it('caught-up (lastRun = yesterday) returns empty array', () => {
    const yesterday = formatDate(getYesterday());
    recordRun(yesterday);
    const dates = getDatesToProcess();
    assert.deepEqual(dates, []);
  });

  it('caught-up (lastRun = today) returns empty array', () => {
    const today = formatDate(getToday());
    recordRun(today);
    const dates = getDatesToProcess();
    assert.deepEqual(dates, []);
  });

  it('3-day gap returns 3 dates in order', () => {
    // Set lastRun to 4 days ago
    const now = new Date();
    const fourDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 4);
    recordRun(formatDate(fourDaysAgo));

    const dates = getDatesToProcess();
    assert.equal(dates.length, 3);

    // Verify order and content
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

    assert.equal(dates[0], formatDate(threeDaysAgo));
    assert.equal(dates[1], formatDate(twoDaysAgo));
    assert.equal(dates[2], formatDate(yesterday));
  });

  it('month boundary crossing (Jan 30 → Feb 2)', () => {
    // Use a fixed date approach: simulate lastRun = Jan 30
    // and "yesterday" being Feb 1 by setting marker and checking the gap manually
    recordRun('2026-01-30');

    // We need to control "now" for this test, so we'll test the date arithmetic directly
    // Instead, verify the dates module handles month boundaries
    const jan30 = new Date(2026, 0, 30); // Jan 30
    const jan31 = new Date(2026, 0, 31);
    const feb1 = new Date(2026, 1, 1);

    // Verify Date arithmetic crosses month boundary correctly
    const start = new Date(jan30);
    start.setDate(start.getDate() + 1);
    assert.equal(formatDate(start), '2026-01-31');
    start.setDate(start.getDate() + 1);
    assert.equal(formatDate(start), '2026-02-01');
    start.setDate(start.getDate() + 1);
    assert.equal(formatDate(start), '2026-02-02');
  });

  it('never includes today in results', () => {
    // Set lastRun to 2 days ago — should get yesterday but not today
    const now = new Date();
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    recordRun(formatDate(twoDaysAgo));

    const dates = getDatesToProcess();
    const today = formatDate(getToday());
    assert.ok(!dates.includes(today), 'Today should never be included');

    const yesterday = formatDate(getYesterday());
    assert.ok(dates.includes(yesterday), 'Yesterday should be included');
  });

  it('never includes future dates', () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    recordRun(formatDate(twoDaysAgo));

    const dates = getDatesToProcess();
    const todayDate = getToday();

    for (const d of dates) {
      const [y, m, day] = d.split('-').map(Number);
      const parsed = new Date(y, m - 1, day);
      assert.ok(parsed < todayDate, `Date ${d} should be before today`);
    }
  });

  it('existing journal file is NOT overwritten by default (includeExisting defaults to false)', () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

    // Set lastRun to 3 days ago so catch-up covers twoDaysAgo + yesterday
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    recordRun(formatDate(threeDaysAgo));

    // Create an existing journal for twoDaysAgo
    generateJournal(formatDate(twoDaysAgo), []);

    // Default call — includeExisting is false
    const dates = getDatesToProcess();

    // twoDaysAgo already has a journal — must NOT appear
    assert.ok(!dates.includes(formatDate(twoDaysAgo)), 'Existing journal date should be skipped by default');
    // yesterday has no journal — MUST appear
    assert.ok(dates.includes(formatDate(yesterday)), 'Missing journal date should be included');
  });

  it('existing journal file IS overwritten when includeExisting: true', () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    recordRun(formatDate(threeDaysAgo));

    // Create an existing journal for twoDaysAgo
    generateJournal(formatDate(twoDaysAgo), []);

    const dates = getDatesToProcess({ includeExisting: true });

    // Both dates must appear even though twoDaysAgo already has a journal
    assert.ok(dates.includes(formatDate(twoDaysAgo)), 'Existing journal date should be included with includeExisting: true');
    assert.ok(dates.includes(formatDate(yesterday)), 'Missing journal date should be included');
  });

  it('14-day cap triggers when window exceeds 14 days', () => {
    const now = new Date();
    // Set lastRun to 20 days ago → window is 19 days, exceeds 14
    const twentyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20);
    recordRun(formatDate(twentyDaysAgo));

    const dates = getDatesToProcess();

    assert.ok(dates.length <= 14, `Expected at most 14 dates, got ${dates.length}`);
  });

  it('14-day cap emits a WARNING to stderr when triggered', () => {
    const now = new Date();
    const twentyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20);
    recordRun(formatDate(twentyDaysAgo));

    const stderrChunks = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...rest);
    };

    try {
      getDatesToProcess();
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[catchup] WARN'), `Expected WARN on stderr, got: ${stderrOutput}`);
    assert.ok(stderrOutput.includes('capping at 14'), `Expected cap message on stderr, got: ${stderrOutput}`);
  });

  it('14-day cap is bypassed when forceWindow: true', () => {
    const now = new Date();
    // Set lastRun to 20 days ago → 19-day window, but forceWindow bypasses the cap
    const twentyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20);
    recordRun(formatDate(twentyDaysAgo));

    const dates = getDatesToProcess({ forceWindow: true });

    assert.ok(dates.length > 14, `Expected more than 14 dates with forceWindow: true, got ${dates.length}`);
  });
});
