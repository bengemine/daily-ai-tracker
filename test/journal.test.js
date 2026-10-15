const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/config');
const { createSession } = require('../src/types');

// Save/restore config.output.directory so tests use a temp dir
let originalDir;
let tmpDir;

function setupTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
  originalDir = config.output.directory;
  config.output.directory = tmpDir;
}

function teardownTmpDir() {
  config.output.directory = originalDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const { generateJournal, EMPTY_SESSION_BODY, NO_ACTIVITY_BODY, mergeEntriesByTask, isEmptySession, escapeCell, flattenTitle } = require('../src/journal');

/**
 * Helper to create a journal entry. Supports both old (string) and new ({ title, body }) summary formats.
 */
function makeEntry(overrides = {}) {
  const session = createSession({
    id: overrides.id || 'sess-001',
    agent: overrides.agent || 'Claude Code',
    project: overrides.project || 'E:\\projects\\my-project',
    startTime: overrides.startTime || new Date('2026-03-13T10:00:00'),
    artifactPath: overrides.artifactPath,
  });
  return {
    session,
    highlights: overrides.highlights || {},
    summary: overrides.summary || {
      title: overrides.title || 'Built login page with JWT auth',
      body: overrides.body || 'Built the login page with JWT auth and rate limiting.',
    },
  };
}

describe('journal generator', () => {
  beforeEach(() => setupTmpDir());
  afterEach(() => teardownTmpDir());

  it('writes markdown with overview table and session details', () => {
    const entries = [
      makeEntry({ id: 'sess-001', startTime: new Date('2026-03-13T10:00:00') }),
      makeEntry({
        id: 'sess-002',
        startTime: new Date('2026-03-13T14:00:00'),
        title: 'Fixed auth bug in middleware',
        body: 'Fixed auth bug in middleware.',
      }),
    ];

    const result = generateJournal('2026-03-13', entries);
    assert.ok(result);
    assert.ok(result.endsWith('13.md'));

    const content = fs.readFileSync(result, 'utf-8');
    assert.ok(content.includes('# Daily AI Tracker — 2026-03-13'));
    assert.ok(content.includes('## Overview'), 'Should have overview section');
    assert.ok(content.includes('## Session Details'), 'Should have details section');
    assert.ok(content.includes('| # | Time | Agent | Task | Project |'), 'Should have table header');
    assert.ok(content.includes('`sess-001`'));
    assert.ok(content.includes('`sess-002`'));
    assert.ok(content.includes('Built the login page'));
    assert.ok(content.includes('Fixed auth bug'));
  });

  it('table rows link to detail anchors', () => {
    const entries = [
      makeEntry({ id: 's1', title: 'Setup project', body: 'Created new project.' }),
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    // Table should have a link to the anchor
    assert.ok(content.includes('[Setup project](#s-1)'), 'Table should link to anchor');
    // Detail section should have the anchor
    assert.ok(content.includes('<a id="s-1"></a>'), 'Detail should have anchor tag');
  });

  it('clearly marks only summaries that used the incomplete fallback', () => {
    const entries = [
      makeEntry({
        id: 'failed-summary',
        summary: {
          title: 'Limited fallback title',
          body: 'Only a limited fallback was available.',
          summarySource: 'fallback',
          incomplete: true,
        },
      }),
      makeEntry({ id: 'complete-summary', startTime: new Date('2026-03-13T11:00:00') }),
    ];
    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf8');
    assert.ok(content.includes('1 conversation summary could not be completed by AI'));
    assert.ok(content.includes('**Summary incomplete:**'));
  });

  it('links each journal detail to its cleaned conversation artifact', () => {
    const artifactPath = path.join(tmpDir, 'conversations', 'claude-code', 'sess-001', '2026-03-13.md');
    const entries = [makeEntry({ artifactPath })];
    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf8');
    assert.ok(content.includes('[Claude Code cleaned dialogue](<../../conversations/claude-code/sess-001/2026-03-13.md>)'));
  });

  it('shows agent names in both table and details', () => {
    const entries = [
      makeEntry({ id: 'cc-001', agent: 'Claude Code', title: 'Task A', body: 'Did A.' }),
      makeEntry({ id: 'grok-001', agent: 'Grok', startTime: new Date('2026-03-13T11:00:00'), title: 'Task B', body: 'Did B.' }),
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    // Both agents in table
    assert.ok(content.includes('| Claude Code |') || content.includes('Claude Code'), 'Table should show Claude Code');
    assert.ok(content.includes('Grok'), 'Table should show Grok');

    // Both agents in detail blockquotes
    assert.ok(content.includes('**Claude Code**'), 'Details should show Claude Code');
    assert.ok(content.includes('**Grok**'), 'Details should show Grok');
  });

  it('deduplicates entries by session ID (last wins)', () => {
    const entries = [
      makeEntry({ id: 'sess-dup', title: 'First', body: 'First version of summary.' }),
      makeEntry({ id: 'sess-dup', title: 'Updated', body: 'Updated summary after reprocessing.' }),
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    const chatLineMatches = content.match(/Chat: `sess-dup`|Chats: `sess-dup`/g) || [];
    assert.equal(chatLineMatches.length, 1, 'Session should appear only once in chat references');
    assert.ok(content.includes('Updated summary'), 'Last entry should win');
    assert.ok(!content.includes('First version'), 'First entry should be replaced');
  });

  it('merges related chats for the same task into one journal entry', () => {
    const entries = [
      makeEntry({
        id: 'sess-a',
        startTime: new Date('2026-03-13T10:00:00'),
        title: 'Fixed scheduler quoting',
        body: 'Updated the scheduler registration flow.',
      }),
      makeEntry({
        id: 'sess-b',
        startTime: new Date('2026-03-13T11:00:00'),
        title: 'Fixed scheduler quoting',
        body: 'Verified the scheduled task and added regression coverage.',
      }),
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    const anchors = content.match(/<a id="s-\d+"><\/a>/g) || [];
    assert.equal(anchors.length, 1, 'Should collapse into one task entry');
    assert.ok(content.includes('Related chats: `sess-a`, `sess-b`'));
    assert.ok(content.includes('Updated the scheduler registration flow.'));
    assert.ok(content.includes('Verified the scheduled task and added regression coverage.'));
  });

  it('does not merge same title across different projects', () => {
    const entries = [
      makeEntry({
        id: 'sess-a',
        project: 'E:\\projects\\app-a',
        title: 'Updated handoff prompt',
        body: 'Adjusted app A prompt.',
      }),
      makeEntry({
        id: 'sess-b',
        project: 'E:\\projects\\app-b',
        title: 'Updated handoff prompt',
        body: 'Adjusted app B prompt.',
      }),
    ];

    const grouped = mergeEntriesByTask(entries);
    assert.equal(grouped.length, 2);
  });

  it('merges related clarification and implementation chats for one task', () => {
    const entries = [
      makeEntry({
        id: 'clarify-chat',
        agent: 'Codex',
        project: '(codex)',
        startTime: new Date('2026-03-14T08:14:00'),
        title: 'Clarified auto-archive scope for duplicate record feature request',
        body: 'Investigated the duplicate record auto-archive request and clarified that it applies to the same-course duplicate path.',
        highlights: {
          topic: 'Customer auto-archive expiry request',
          userMessages: ['help me answer the reviewers last comment', 'review and confirm what the current logic does'],
        },
      }),
      makeEntry({
        id: 'implement-chat',
        agent: 'Grok',
        project: 'E:\\websites\\example.ca',
        startTime: new Date('2026-03-14T08:32:00'),
        title: 'Added expiry date logic to auto-archive duplicate records',
        body: 'Updated duplicate record auto-archive behavior so the furthest expiry date stays active.',
        highlights: {
          topic: 'Objective: Enhance the auto-archiving logic to optionally consider certificate expiry dates when determining which record should remain active.',
          userMessages: ['I want a normal human-looking reply and simple plain English.'],
        },
      }),
    ];

    const grouped = mergeEntriesByTask(entries);
    assert.equal(grouped.length, 1, 'Clarification and implementation should collapse into one task');
    assert.equal(grouped[0].project, 'E:\\websites\\example.ca');
    assert.ok(grouped[0].chatLabel.includes('clarify-chat'));
    assert.ok(grouped[0].chatLabel.includes('implement-chat'));
    assert.equal(grouped[0].title, 'Reviewed auto-archive expiry-date question');
  });

  it('filters out empty-session summaries (object format)', () => {
    const entries = [
      makeEntry({ id: 'sess-real', title: 'Real work', body: 'Did real work.' }),
      { ...makeEntry({ id: 'sess-empty' }), summary: { title: '', body: EMPTY_SESSION_BODY } },
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('`sess-real`'));
    assert.ok(!content.includes('sess-empty'));
    assert.ok(!content.includes(EMPTY_SESSION_BODY));
  });

  it('filters out empty-session summaries (legacy string format)', () => {
    const entries = [
      makeEntry({ id: 'sess-real', title: 'Real work', body: 'Did real work.' }),
      { ...makeEntry({ id: 'sess-empty' }), summary: EMPTY_SESSION_BODY },
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('`sess-real`'));
    assert.ok(!content.includes('sess-empty'));
  });

  it('writes a no-activity journal for empty day (no valid entries)', () => {
    const entries = [
      { ...makeEntry({ id: 's1' }), summary: { title: '', body: EMPTY_SESSION_BODY } },
      { ...makeEntry({ id: 's2' }), summary: { title: '', body: EMPTY_SESSION_BODY } },
    ];

    const result = generateJournal('2026-03-13', entries);
    assert.ok(result);
    const content = fs.readFileSync(result, 'utf-8');
    assert.ok(content.includes(NO_ACTIVITY_BODY));
  });

  it('writes a no-activity journal for empty entries array', () => {
    const result = generateJournal('2026-03-13', []);
    assert.ok(result);
    const content = fs.readFileSync(result, 'utf-8');
    assert.ok(content.includes(NO_ACTIVITY_BODY));
  });

  it('constructs correct YYYY/MM/DD.md file path', () => {
    const entries = [makeEntry()];
    const result = generateJournal('2026-03-13', entries);
    const expected = path.join(tmpDir, '2026', '03', '13.md');
    assert.equal(result, expected);
  });

  it('handles month boundaries in path (e.g. January)', () => {
    const entries = [makeEntry({ startTime: new Date('2026-01-05T09:00:00') })];
    const result = generateJournal('2026-01-05', entries);
    const expected = path.join(tmpDir, '2026', '01', '05.md');
    assert.equal(result, expected);
  });

  it('overwrites idempotently (same content on second write)', () => {
    const entries = [makeEntry()];
    const path1 = generateJournal('2026-03-13', entries);
    const content1 = fs.readFileSync(path1, 'utf-8');
    const path2 = generateJournal('2026-03-13', entries);
    const content2 = fs.readFileSync(path2, 'utf-8');
    assert.equal(path1, path2);
    assert.equal(content1, content2);
  });

  it('includes full project path in detail blockquote', () => {
    const entries = [makeEntry({
      project: 'E:\\projects\\cool-app',
      startTime: new Date('2026-03-13T15:30:00'),
    })];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('E:\\projects\\cool-app'), 'Detail should have full path');
  });

  it('shows short project name in table', () => {
    const entries = [makeEntry({
      project: 'E:\\projects\\cool-app',
    })];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    // Table should show short name
    const tableSection = content.split('## Session Details')[0];
    assert.ok(tableSection.includes('cool-app'), 'Table should show short project name');
  });

  it('sorts all entries chronologically in table and details', () => {
    const entries = [
      makeEntry({ id: 'late', agent: 'Codex', startTime: new Date('2026-03-13T18:00:00'), title: 'Late task', body: 'Late session.' }),
      makeEntry({ id: 'early', agent: 'Claude Code', startTime: new Date('2026-03-13T08:00:00'), title: 'Early task', body: 'Early session.' }),
      makeEntry({ id: 'mid', agent: 'Grok', startTime: new Date('2026-03-13T12:00:00'), title: 'Mid task', body: 'Mid session.' }),
    ];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    const earlyIdx = content.indexOf('Early session');
    const midIdx = content.indexOf('Mid session');
    const lateIdx = content.indexOf('Late session');
    assert.ok(earlyIdx < midIdx, 'Early should come before mid');
    assert.ok(midIdx < lateIdx, 'Mid should come before late');
  });

  it('handles legacy string summaries gracefully', () => {
    const entries = [{
      ...makeEntry({ id: 'legacy' }),
      summary: 'This is a plain string summary from an old run.',
    }];

    const result = generateJournal('2026-03-13', entries);
    const content = fs.readFileSync(result, 'utf-8');

    assert.ok(content.includes('This is a plain string summary'), 'Should include the body text');
    assert.ok(content.includes('Untitled session'), 'Should use fallback title for string summaries');
  });
});

describe('isEmptySession', () => {
  it('returns true for object with empty title and marker body', () => {
    assert.ok(isEmptySession({ title: '', body: EMPTY_SESSION_BODY }));
  });

  it('returns true for legacy string marker', () => {
    assert.ok(isEmptySession(EMPTY_SESSION_BODY));
  });

  it('returns true for null/undefined', () => {
    assert.ok(isEmptySession(null));
    assert.ok(isEmptySession(undefined));
  });

  it('returns false for real summaries', () => {
    assert.ok(!isEmptySession({ title: 'Did work', body: 'Wrote code.' }));
    assert.ok(!isEmptySession('Wrote code.'));
  });
});

describe('escapeCell', () => {
  it('collapses embedded newlines to single spaces', () => {
    const result = escapeCell('line one\nline two\nline three');
    assert.ok(!result.includes('\n'), 'result must not contain newlines');
    assert.ok(result.includes('line one line two line three'), 'lines should be joined with space');
  });

  it('collapses carriage returns and tabs as well', () => {
    const result = escapeCell('a\r\nb\tc');
    assert.ok(!result.includes('\r') && !result.includes('\n') && !result.includes('\t'));
    assert.equal(result, 'a b c');
  });

  it('strips leading # heading prefix', () => {
    const result = escapeCell('# Session Summary');
    assert.ok(!result.startsWith('#'), 'should not start with #');
    assert.equal(result, 'Session Summary');
  });

  it('strips leading - and * markdown list prefixes', () => {
    assert.equal(escapeCell('- list item'), 'list item');
    assert.equal(escapeCell('* bullet'), 'bullet');
  });

  it('strips leading > blockquote prefix', () => {
    assert.equal(escapeCell('> quoted text'), 'quoted text');
  });

  it('escapes pipe characters as \\|', () => {
    const result = escapeCell('foo | bar | baz');
    assert.equal(result, 'foo \\| bar \\| baz');
  });

  it('truncates to 120 chars with ellipsis', () => {
    const long = 'a'.repeat(150);
    const result = escapeCell(long);
    assert.equal(result.length, 121, 'should be 120 chars + 1 ellipsis char');
    assert.ok(result.endsWith('\u2026'), 'should end with ellipsis');
  });

  it('returns "(untitled)" for blank or whitespace-only input', () => {
    assert.equal(escapeCell(''), '(untitled)');
    assert.equal(escapeCell('   '), '(untitled)');
    assert.equal(escapeCell(null), '(untitled)');
    assert.equal(escapeCell(undefined), '(untitled)');
  });

  it('returns "(untitled)" when input is only markdown prefixes', () => {
    assert.equal(escapeCell('### '), '(untitled)');
  });
});

describe('flattenTitle', () => {
  it('returns the first prose line, skipping leading # heading lines', () => {
    const blob = '# Session Summary\n\n**Agent:** Factory\n**Project:** E:\\websites\\example-app';
    const result = flattenTitle(blob);
    assert.equal(result, '**Agent:** Factory');
  });

  it('skips blank lines before finding prose', () => {
    const blob = '\n\n\nActual title here';
    assert.equal(flattenTitle(blob), 'Actual title here');
  });

  it('skips blockquote lines starting with >', () => {
    const blob = '> blockquote\nProse line';
    assert.equal(flattenTitle(blob), 'Prose line');
  });

  it('truncates first prose line longer than 100 chars', () => {
    const longLine = 'b'.repeat(120);
    const result = flattenTitle(longLine);
    assert.equal(result.length, 101, 'should be 100 chars + ellipsis');
    assert.ok(result.endsWith('\u2026'));
  });

  it('returns "(untitled)" for empty string', () => {
    assert.equal(flattenTitle(''), '(untitled)');
  });

  it('returns "(untitled)" for null/undefined', () => {
    assert.equal(flattenTitle(null), '(untitled)');
    assert.equal(flattenTitle(undefined), '(untitled)');
  });

  it('returns "(untitled)" when all lines are headings or blank', () => {
    assert.equal(flattenTitle('# Heading\n## Another\n'), '(untitled)');
  });
});

describe('flattenTitle + escapeCell pipeline (Bug 2 regression)', () => {
  it('a fallback blob title produces a single-line table cell with no newlines', () => {
    // Simulates the multi-line blob that buildLocalFallbackSummary used to
    // surface as the title before the fix.
    const fallbackBlob = [
      '# Session Summary',
      '',
      '**Agent:** Factory',
      '**Project:** E:\\websites\\example-app',
      '**Session:** abc-123',
    ].join('\n');

    const cellText = escapeCell(flattenTitle(fallbackBlob));
    assert.ok(!cellText.includes('\n'), 'cell text must not contain newlines');
    assert.ok(!cellText.startsWith('#'), 'cell text must not start with #');
    assert.notEqual(cellText, '(untitled)', 'should extract the agent line as prose');
  });

  it('a generated Markdown table row with a fallback blob title is a single line', () => {
    const fallbackBlob = '# Session Summary\n\n**Agent:** Factory\n**Project:** E:\\websites\\example-app';
    const anchor = 's-2';
    const taskCell = `[${escapeCell(flattenTitle(fallbackBlob))}](#${anchor})`;
    const row = `| 2 | 2:02 AM | Factory | ${taskCell} | example.ca |`;

    assert.ok(!row.includes('\n'), 'the generated row must be a single line');
    assert.ok(row.includes('[**Agent:** Factory](#s-2)'), 'row should contain clean linked title');
  });
});
