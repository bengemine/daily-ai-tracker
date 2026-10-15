const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/config');

let originalDir;
let tmpDir;

function setupTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtracker-test-'));
  originalDir = config.output.directory;
  config.output.directory = tmpDir;
}

function teardownTmpDir() {
  config.output.directory = originalDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const { getLastRun, recordRun } = require('../src/run-tracker');

describe('run tracker', () => {
  beforeEach(() => setupTmpDir());
  afterEach(() => teardownTmpDir());

  it('returns null on first run (no marker file)', () => {
    const result = getLastRun();
    assert.equal(result, null);
  });

  it('records a run and reads it back', () => {
    recordRun('2026-03-13');
    const result = getLastRun();
    assert.ok(result);
    assert.equal(result.lastDate, '2026-03-13');
    assert.ok(result.timestamp, 'should have a timestamp');
  });

  it('overwrites with a new date', () => {
    recordRun('2026-03-12');
    recordRun('2026-03-13');
    const result = getLastRun();
    assert.equal(result.lastDate, '2026-03-13');
  });

  it('returns null for corrupt JSON gracefully', () => {
    const markerPath = path.join(tmpDir, '.last-run.json');
    fs.writeFileSync(markerPath, 'not valid json {{{', 'utf-8');
    const result = getLastRun();
    assert.equal(result, null);
  });

  it('returns null for JSON missing lastDate field', () => {
    const markerPath = path.join(tmpDir, '.last-run.json');
    fs.writeFileSync(markerPath, JSON.stringify({ wrong: 'field' }), 'utf-8');
    const result = getLastRun();
    assert.equal(result, null);
  });

  it('marker file is in the output directory', () => {
    recordRun('2026-03-13');
    const markerPath = path.join(tmpDir, '.last-run.json');
    assert.ok(fs.existsSync(markerPath), 'marker file should exist in output dir');
    const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    assert.equal(data.lastDate, '2026-03-13');
  });

  it('marker file contains valid JSON with expected fields', () => {
    recordRun('2026-03-13');
    const markerPath = path.join(tmpDir, '.last-run.json');
    const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    assert.equal(typeof data.lastDate, 'string');
    assert.equal(typeof data.timestamp, 'string');
    // Timestamp should be a valid ISO date
    assert.ok(!isNaN(new Date(data.timestamp).getTime()), 'timestamp should be valid ISO');
  });
});
