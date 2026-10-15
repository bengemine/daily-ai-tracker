const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, USAGE } = require('../index-conversations');

describe('conversation indexer CLI', () => {
  it('uses the fast automatic mode by default', () => {
    assert.deepEqual(parseArgs([]), { fullScan: false, help: false, error: null });
  });

  it('supports an explicit full reconciliation scan', () => {
    assert.deepEqual(parseArgs(['--full-scan']), { fullScan: true, help: false, error: null });
    assert.match(USAGE, /--full-scan/);
  });

  it('rejects unknown options instead of silently ignoring them', () => {
    assert.equal(parseArgs(['--unsafe']).error, 'Unknown option: --unsafe');
  });
});
