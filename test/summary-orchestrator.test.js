'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ERROR_LOG_NAME,
  getSummaryConfig,
  summarizeDay,
  summaryArtifactPath,
  parseDailyResponse,
} = require('../src/summary-orchestrator');

function makeRecord(root, id, content = 'User asked for PR #11957. Assistant reported it was reviewed.') {
  const artifactPath = path.join(root, 'source', `${id}.md`);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, content, 'utf8');
  return {
    session: {
      id,
      sessionKey: `Claude Code:${id}`,
      agent: 'Claude Code',
      project: 'E:\\projects\\demo',
      artifactPath,
      startTime: new Date('2026-07-01T10:00:00Z'),
    },
    highlights: {
      topic: content,
      userMessages: [content],
      lastExchanges: ['Assistant: Review completed.'],
    },
    messages: [],
  };
}

function writeResults(workspace, title = 'Reviewed PR #11957 authorization changes') {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'manifest.json'), 'utf8'));
  for (const job of manifest.jobs) {
    fs.writeFileSync(path.resolve(workspace, job.outputPath), JSON.stringify({
      title,
      body: 'The user requested a review of PR #11957. The agent reported the review was completed and described the result.',
      identifiers: { pullRequests: ['11957'] },
    }));
  }
  return manifest;
}

describe('daily summary orchestrator', () => {
  it('uses one daily agent with the configured model and timeout', () => {
    const settings = getSummaryConfig({}, { summarizer: { claudeTimeoutMs: 1234, model: 'sonnet' } });
    assert.equal(settings.timeoutMs, 1234);
    assert.equal(settings.model, 'sonnet');
  });

  it('does not treat generic prose about a branch name as an actual branch identifier', () => {
    const { extractIdentifiers } = require('../src/summary-orchestrator');
    const identifiers = extractIdentifiers('Provide a branch name. The branch: feature/real-work was reviewed.');
    assert.deepEqual(identifiers.branches, ['feature/real-work']);
  });

  it('parses Claude JSON output wrappers with schema-constrained summaries', () => {
    const summaries = parseDailyResponse(JSON.stringify({
      structured_output: {
        summaries: [{ sessionKey: 'Claude Code:test', title: 'Test title', body: 'Test body', identifiers: {} }],
      },
    }));
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].sessionKey, 'Claude Code:test');
  });

  it('stages the complete cleaned conversation for one daily AI call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-orchestrator-'));
    const longSource = `BEGIN\n${'A'.repeat(60000)}\nEND`;
    const records = [makeRecord(root, 'long', longSource)];
    try {
      let observed;
      const result = await summarizeDay('2026-07-01', records, {
        outputDir: root,
        summaryConfig: { timeoutMs: 60000, model: 'sonnet', effort: 'medium' },
        invokeClaude: async workspace => {
          observed = writeResults(workspace);
          const staged = fs.readFileSync(path.resolve(workspace, observed.jobs[0].inputPath), 'utf8');
          assert.equal(staged, longSource);
        },
      });
      assert.equal(observed.mode, 'single-agent-one-call');
      assert.equal(result.get('Claude Code:long').summarySource, 'claude-daily-agent');
      assert.equal(fs.existsSync(path.join(root, ERROR_LOG_NAME)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits oversized days only between complete conversations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-orchestrator-'));
    const records = [makeRecord(root, 'first', 'A'.repeat(80)), makeRecord(root, 'second', 'B'.repeat(80))];
    const observed = [];
    try {
      const result = await summarizeDay('2026-07-01', records, {
        outputDir: root,
        maxBatchChars: 100,
        summaryConfig: { timeoutMs: 60000, model: 'sonnet', effort: 'medium' },
        invokeProvider: async workspace => {
          const manifest = writeResults(workspace);
          observed.push(manifest.jobs.map(job => fs.readFileSync(path.resolve(workspace, job.inputPath), 'utf8')));
        },
      });
      assert.equal(observed.length, 2);
      assert.deepEqual(observed.flat(), ['A'.repeat(80), 'B'.repeat(80)]);
      assert.equal(result.size, 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('retries missing outputs once, appends errors, then succeeds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-orchestrator-'));
    const records = [makeRecord(root, 'retry')];
    let calls = 0;
    try {
      const result = await summarizeDay('2026-07-01', records, {
        outputDir: root,
        summaryConfig: { timeoutMs: 60000, model: 'sonnet', effort: 'medium' },
        invokeClaude: async workspace => {
          calls++;
          if (calls === 2) writeResults(workspace);
        },
      });
      assert.equal(calls, 2);
      assert.equal(result.get('Claude Code:retry').summarySource, 'claude-daily-agent');
      const errors = fs.readFileSync(path.join(root, ERROR_LOG_NAME), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].errorType, 'missing-output');
      assert.equal(errors[0].attempt, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses and marks a limited fallback after the retry also fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-orchestrator-'));
    const records = [makeRecord(root, 'fallback')];
    try {
      const result = await summarizeDay('2026-07-01', records, {
        outputDir: root,
        summaryConfig: { timeoutMs: 60000, model: 'sonnet', effort: 'medium' },
        invokeClaude: async () => {},
      });
      const summary = result.get('Claude Code:fallback');
      assert.equal(summary.summarySource, 'fallback');
      assert.equal(summary.incomplete, true);
      const errors = fs.readFileSync(path.join(root, ERROR_LOG_NAME), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(errors.length, 2);
      assert.equal(errors[1].fallbackUsed, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses a valid cached artifact without another Claude run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-orchestrator-'));
    const record = makeRecord(root, 'cached');
    let calls = 0;
    try {
      await summarizeDay('2026-07-01', [record], {
        outputDir: root,
        summaryConfig: { timeoutMs: 60000, model: 'sonnet', effort: 'medium' },
        invokeClaude: async workspace => { calls++; writeResults(workspace); },
      });
      assert.ok(fs.existsSync(summaryArtifactPath(root, '2026-07-01', record.session)));
      await summarizeDay('2026-07-01', [record], {
        outputDir: root,
        summaryConfig: { timeoutMs: 60000, model: 'sonnet', effort: 'medium' },
        invokeClaude: async () => { calls++; },
      });
      assert.equal(calls, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates cached summaries when provider, model, or custom instructions change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-orchestrator-'));
    const record = makeRecord(root, 'provider-aware');
    let calls = 0;
    const invoke = async workspace => { calls++; writeResults(workspace); };
    try {
      await summarizeDay('2026-07-01', [record], {
        outputDir: root,
        summaryConfig: { provider: 'claude', model: 'sonnet', reasoning: 'medium', customInstructions: '', timeoutMs: 60000 },
        invokeProvider: invoke,
      });
      await summarizeDay('2026-07-01', [record], {
        outputDir: root,
        summaryConfig: { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium', customInstructions: 'Preserve blockers.', timeoutMs: 60000 },
        invokeProvider: invoke,
      });
      assert.equal(calls, 2);
      const value = JSON.parse(fs.readFileSync(summaryArtifactPath(root, '2026-07-01', record.session), 'utf8'));
      assert.equal(value.provider, 'codex');
      assert.equal(value.model, 'gpt-5.6-luna');
      assert.equal(value.summarySource, 'codex-daily-agent');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
