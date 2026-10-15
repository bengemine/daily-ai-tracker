'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseArgs } = require('../compare-providers');

describe('provider comparison CLI', () => {
  it('requires a date and isolated output folder', () => {
    assert.throws(() => parseArgs([]), /--date/);
    const parsed = parseArgs(['--date', '2026-07-03', '--output', 'validation-output/test-provider-compare']);
    assert.equal(parsed.date, '2026-07-03');
    assert.equal(parsed.outputDir, path.resolve('validation-output/test-provider-compare'));
  });
});
