'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeResponse } = require('../src/summary-providers/claude');
const { parseCodexResponse, commandCandidates, argsForCandidate, toWslPath } = require('../src/summary-providers/codex');

describe('summary providers', () => {
  it('parses Claude structured output wrappers', () => {
    assert.deepEqual(parseClaudeResponse(JSON.stringify({ structured_output: { summaries: [] } })), { summaries: [] });
  });

  it('parses Codex schema output and builds a WSL candidate on Windows', () => {
    assert.deepEqual(parseCodexResponse('```json\n{"summaries":[]}\n```'), { summaries: [] });
    const candidates = commandCandidates({ AI_TRACKER_WSL_DISTRO: 'Ubuntu-24.04' }, 'win32');
    assert.equal(candidates[0].command, 'wsl.exe');
    assert.ok(candidates[0].prefixArgs.includes('Ubuntu-24.04'));
    assert.equal(toWslPath('E:\\projects\\Daily AI Tracker\\schema.json'), '/mnt/e/projects/Daily AI Tracker/schema.json');
    assert.deepEqual(argsForCandidate(candidates[0], ['--cd', 'E:\\projects\\Daily AI Tracker']), ['--cd', '/mnt/e/projects/Daily AI Tracker']);
  });
});
