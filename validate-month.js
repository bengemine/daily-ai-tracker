#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { indexAllConversations } = require('./src/conversation-indexer');
const { readConversationArtifactsForDate } = require('./src/conversation-artifacts');
const { createRunSummarizer } = require('./src/summarizer');
const { runForDate } = require('./tracker');

const DATE_JSON_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

function parseArgs(argv = process.argv.slice(2)) {
  const result = { month: null, outputDir: null, baselineDir: config.output.directory, resume: false, localSummary: false, provider: null, model: null, reasoning: null, customInstructionsFile: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume') {
      result.resume = true;
      continue;
    }
    if (arg === '--local-summary') {
      result.localSummary = true;
      continue;
    }
    if (!['--month', '--output', '--baseline', '--provider', '--model', '--reasoning', '--custom-instructions-file'].includes(arg)) {
      result.error = `Unknown option: ${arg}`;
      return result;
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) {
      result.error = `${arg} requires a value`;
      return result;
    }
    if (arg === '--month') result.month = value;
    if (arg === '--output') result.outputDir = path.resolve(value);
    if (arg === '--baseline') result.baselineDir = path.resolve(value);
    if (arg === '--provider') result.provider = value;
    if (arg === '--model') result.model = value;
    if (arg === '--reasoning') result.reasoning = value;
    if (arg === '--custom-instructions-file') result.customInstructionsFile = path.resolve(value);
  }
  if (!/^\d{4}-\d{2}$/.test(result.month || '')) result.error = '--month must use YYYY-MM';
  if (!result.outputDir) result.error = '--output is required';
  if (result.provider && !['claude', 'codex'].includes(result.provider)) result.error = '--provider must be claude or codex';
  return result;
}

function datesInMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const count = new Date(year, monthNumber, 0).getDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

function fingerprintTree(root) {
  const digest = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const filePath of walkFiles(root)) {
    if (filePath.endsWith('.log')) continue;
    const content = fs.readFileSync(filePath);
    digest.update(path.relative(root, filePath).split(path.sep).join('/'));
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
    files++;
    bytes += content.length;
  }
  return { sha256: digest.digest('hex'), files, bytes };
}

function fingerprintMonthArtifacts(outputDir, month) {
  const root = path.join(outputDir, 'conversations');
  const prefix = `${month}-`;
  const digest = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const filePath of walkFiles(root)) {
    const name = path.basename(filePath);
    if (!name.startsWith(prefix) || !/\.(json|md)$/.test(name)) continue;
    const content = fs.readFileSync(filePath);
    digest.update(path.relative(root, filePath).split(path.sep).join('/'));
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
    files++;
    bytes += content.length;
  }
  return { sha256: digest.digest('hex'), files, bytes };
}

function baselineJournalPath(baselineDir, dateStr) {
  const [year, month, day] = dateStr.split('-');
  return path.join(baselineDir, year, month, `${day}.md`);
}

function baselineSessions(baselineDir, dateStr) {
  let text;
  try { text = fs.readFileSync(baselineJournalPath(baselineDir, dateStr), 'utf8'); } catch { return new Set(); }
  const agents = '(?:Claude Code|Codex|Factory|OpenCode|Cursor)(?: \\(WSL\\))?';
  const matcher = new RegExp('`(' + agents + ':[^`]+)`', 'g');
  const sessions = new Set();
  for (const match of text.matchAll(matcher)) sessions.add(match[1]);
  return sessions;
}

function currentSessions(outputDir, dateStr) {
  return new Set(readConversationArtifactsForDate(dateStr, outputDir)
    .map(record => record.session.sessionKey || `${record.session.agent}:${record.session.id}`));
}

function currentSessionsForMonth(outputDir, month) {
  const byDate = new Map(datesInMonth(month).map(date => [date, new Set()]));
  const root = path.join(outputDir, 'conversations');
  let agents;
  try { agents = fs.readdirSync(root, { withFileTypes: true }); } catch { return byDate; }
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const agentPath = path.join(root, agent.name);
    let sessions;
    try { sessions = fs.readdirSync(agentPath, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionPath = path.join(agentPath, session.name);
      let names;
      try { names = fs.readdirSync(sessionPath); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith(`${month}-`) || !DATE_JSON_RE.test(name)) continue;
        let record;
        try { record = JSON.parse(fs.readFileSync(path.join(sessionPath, name), 'utf8')); } catch { continue; }
        if (!record?.session || !byDate.has(record.date)) continue;
        byDate.get(record.date).add(record.session.sessionKey || `${record.session.agent}:${record.session.id}`);
      }
    }
  }
  return byDate;
}

function difference(left, right) {
  return [...left].filter(value => !right.has(value)).sort();
}

function indexSessionDates(days, field) {
  const datesBySession = new Map();
  for (const day of days) {
    for (const sessionKey of day[field]) {
      if (!datesBySession.has(sessionKey)) datesBySession.set(sessionKey, []);
      datesBySession.get(sessionKey).push(day.date);
    }
  }
  return datesBySession;
}

function adjacentDatePairs(baselineDates, generatedDates) {
  const pairs = [];
  const available = new Set(generatedDates);
  for (const baselineDate of baselineDates) {
    const baselineTime = new Date(`${baselineDate}T12:00:00Z`).getTime();
    const match = [...available]
      .map(date => ({ date, distance: Math.abs(new Date(`${date}T12:00:00Z`).getTime() - baselineTime) }))
      .filter(candidate => candidate.distance === 86400000)
      .sort((left, right) => left.date.localeCompare(right.date))[0];
    if (!match) continue;
    available.delete(match.date);
    pairs.push({ baselineDate, generatedDate: match.date });
  }
  return pairs;
}

function compareMonth(month, outputDir, baselineDir) {
  const generatedByDate = currentSessionsForMonth(outputDir, month);
  const days = datesInMonth(month).map(date => ({
    date,
    baselineSet: baselineSessions(baselineDir, date),
    generatedSet: generatedByDate.get(date) || new Set(),
  }));
  const baselineDates = indexSessionDates(days, 'baselineSet');
  const generatedDates = indexSessionDates(days, 'generatedSet');
  const shifts = new Map();
  for (const sessionKey of new Set([...baselineDates.keys(), ...generatedDates.keys()])) {
    const oldDates = baselineDates.get(sessionKey) || [];
    const newDates = generatedDates.get(sessionKey) || [];
    const oldOnly = oldDates.filter(date => !newDates.includes(date));
    const newOnly = newDates.filter(date => !oldDates.includes(date));
    for (const pair of adjacentDatePairs(oldOnly, newOnly)) {
      shifts.set(`${sessionKey}\0${pair.baselineDate}`, pair.generatedDate);
      shifts.set(`${sessionKey}\0${pair.generatedDate}`, pair.baselineDate);
    }
  }

  const totals = {
    baseline: 0,
    generated: 0,
    matched: 0,
    expectedGrokAdditions: 0,
    adjacentDateShifts: 0,
    newNonGrok: 0,
    missingFromGenerated: 0,
  };
  for (const day of days) {
    const { date, baselineSet: baseline, generatedSet: generated } = day;
    const added = difference(generated, baseline);
    const missing = difference(baseline, generated);
    const grok = added.filter(key => key.startsWith('Grok:') || key.startsWith('Grok (WSL):'));
    const shiftedIn = added
      .filter(key => shifts.has(`${key}\0${date}`))
      .map(key => ({ sessionKey: key, baselineDate: shifts.get(`${key}\0${date}`) }));
    const shiftedInKeys = new Set(shiftedIn.map(value => value.sessionKey));
    const shiftedOut = missing
      .filter(key => shifts.has(`${key}\0${date}`))
      .map(key => ({ sessionKey: key, generatedDate: shifts.get(`${key}\0${date}`) }));
    const shiftedOutKeys = new Set(shiftedOut.map(value => value.sessionKey));
    const addedNonGrok = added.filter(key => !grok.includes(key) && !shiftedInKeys.has(key));
    const trulyMissing = missing.filter(key => !shiftedOutKeys.has(key));
    const matched = [...generated].filter(key => baseline.has(key));
    totals.baseline += baseline.size;
    totals.generated += generated.size;
    totals.matched += matched.length;
    totals.expectedGrokAdditions += grok.length;
    totals.adjacentDateShifts += shiftedIn.length;
    totals.newNonGrok += addedNonGrok.length;
    totals.missingFromGenerated += trulyMissing.length;
    Object.assign(day, {
      baseline: baseline.size,
      generated: generated.size,
      matched: matched.length,
      expectedGrokAdditions: grok,
      adjacentDateShiftsIn: shiftedIn,
      adjacentDateShiftsOut: shiftedOut,
      newNonGrok: addedNonGrok,
      missingFromGenerated: trulyMissing,
    });
    delete day.baselineSet;
    delete day.generatedSet;
  }
  const baselineKeys = new Set(baselineDates.keys());
  const generatedKeys = new Set(generatedDates.keys());
  const uniqueAdded = difference(generatedKeys, baselineKeys);
  const uniqueExpectedGrokAdditions = uniqueAdded.filter(key => key.startsWith('Grok:') || key.startsWith('Grok (WSL):'));
  const uniqueExpectedGrokSet = new Set(uniqueExpectedGrokAdditions);
  const uniqueComparison = {
    baseline: baselineKeys.size,
    generated: generatedKeys.size,
    matched: [...generatedKeys].filter(key => baselineKeys.has(key)).length,
    expectedGrokAdditions: uniqueExpectedGrokAdditions,
    newNonGrok: uniqueAdded.filter(key => !uniqueExpectedGrokSet.has(key)),
    missingFromGenerated: difference(baselineKeys, generatedKeys),
  };
  return { month, totals, uniqueComparison, days };
}

function comparisonMarkdown(report, timings, liveBefore, liveAfter) {
  const lines = [
    `# ${report.month} Isolated Tracker Comparison`,
    '',
    '## Safety',
    '',
    `- Live tracker unchanged: ${liveBefore.sha256 === liveAfter.sha256 ? 'YES' : 'NO'}`,
    `- July artifacts unchanged by optimized rescan: ${report.equivalence.unchangedByFast ? 'YES' : 'NO'}`,
    `- July artifacts unchanged by forced reconciliation: ${report.equivalence.unchangedByFull ? 'YES' : 'NO'}`,
    `- Live files fingerprinted: ${liveBefore.files}`,
    `- Live content fingerprint before: \`${liveBefore.sha256}\``,
    `- Live content fingerprint after: \`${liveAfter.sha256}\``,
    '',
    '## Performance',
    '',
    `- Full reconciliation scan before generation: ${timings.fullIndexMs} ms`,
    `- Normal optimized scan: ${timings.fastIndexMs} ms`,
    `- Forced reconciliation scan: ${timings.reconciliationMs} ms`,
    `- Fast scan candidates: ${timings.fastCandidates} of ${timings.sources} sources`,
    '',
    '## Structural Comparison',
    '',
    'Unique sessions are the reliable comparison. The old journal can mention one chat on several dates as a related chat.',
    '',
    `- Unique sessions found by old tracker: ${report.uniqueComparison.baseline}`,
    `- Unique sessions found by new tracker: ${report.uniqueComparison.generated}`,
    `- Unique sessions found by both: ${report.uniqueComparison.matched}`,
    `- Unique expected Grok additions: ${report.uniqueComparison.expectedGrokAdditions.length}`,
    `- Unique new non-Grok sessions: ${report.uniqueComparison.newNonGrok.length}`,
    `- Unique old-only sessions: ${report.uniqueComparison.missingFromGenerated.length}`,
    '',
    'Date references are shown separately below. They are not missing-session evidence because the old tracker included related chats and used the midnight boundary.',
    '',
    `- Old tracker session references: ${report.totals.baseline}`,
    `- Newly generated clean sessions: ${report.totals.generated}`,
    `- Exact session/date matches: ${report.totals.matched}`,
    `- Expected Grok additions: ${report.totals.expectedGrokAdditions}`,
    `- Sessions moved to an adjacent date: ${report.totals.adjacentDateShifts}`,
    `- New non-Grok sessions requiring classification: ${report.totals.newNonGrok}`,
    `- Old sessions missing from generated output requiring classification: ${report.totals.missingFromGenerated}`,
    '',
    'Grok was not supported by the old July tracker. Grok-only additions are expected and are not regressions.',
    '',
    '## Daily Results',
    '',
    '| Date | Old | New | Matched | Grok added | Date shifts | Other added | Old-only |',
    '|------|----:|----:|--------:|-----------:|------------:|------------:|---------:|',
    ...report.days.map(day => `| ${day.date} | ${day.baseline} | ${day.generated} | ${day.matched} | ${day.expectedGrokAdditions.length} | ${day.adjacentDateShiftsIn.length + day.adjacentDateShiftsOut.length} | ${day.newNonGrok.length} | ${day.missingFromGenerated.length} |`),
    '',
  ];

  for (const day of report.days) {
    if (day.newNonGrok.length === 0 && day.missingFromGenerated.length === 0 && day.expectedGrokAdditions.length === 0 && day.adjacentDateShiftsIn.length === 0 && day.adjacentDateShiftsOut.length === 0) continue;
    lines.push(`### ${day.date}`, '');
    if (day.expectedGrokAdditions.length) lines.push(`- Expected Grok additions: ${day.expectedGrokAdditions.join(', ')}`);
    if (day.adjacentDateShiftsIn.length) lines.push(`- Shifted here from the next/previous date: ${day.adjacentDateShiftsIn.map(value => `${value.sessionKey} (old ${value.baselineDate})`).join(', ')}`);
    if (day.adjacentDateShiftsOut.length) lines.push(`- Shifted to the next/previous date: ${day.adjacentDateShiftsOut.map(value => `${value.sessionKey} (new ${value.generatedDate})`).join(', ')}`);
    if (day.newNonGrok.length) lines.push(`- Other additions: ${day.newNonGrok.join(', ')}`);
    if (day.missingFromGenerated.length) lines.push(`- Old-only sessions: ${day.missingFromGenerated.join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) throw new Error(args.error);
  if (path.resolve(args.outputDir) === path.resolve(args.baselineDir)) {
    throw new Error('Validation output must be different from the live baseline directory');
  }
  if (!args.resume && fs.existsSync(args.outputDir) && walkFiles(args.outputDir).length > 0) {
    throw new Error(`Validation output must be a new or empty directory: ${args.outputDir}`);
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  if (args.localSummary) process.env.AI_TRACKER_LOCAL_SUMMARY_ONLY = '1';
  const liveBefore = fingerprintTree(args.baselineDir);
  const timings = {};

  let started = Date.now();
  const full = await indexAllConversations({ outputDir: args.outputDir, fullScan: true });
  timings.fullIndexMs = Date.now() - started;
  timings.sources = full.sources;

  const summarize = args.localSummary ? createRunSummarizer() : undefined;
  const { loadSettings } = require('./src/tracker-settings');
  const summaryConfig = loadSettings({ env: {
    ...process.env,
    ...(args.provider ? { AI_TRACKER_SUMMARY_PROVIDER: args.provider } : {}),
    ...(args.model ? { AI_TRACKER_SUMMARY_MODEL: args.model } : {}),
    ...(args.reasoning ? { AI_TRACKER_SUMMARY_REASONING: args.reasoning } : {}),
    ...(args.customInstructionsFile ? { AI_TRACKER_CUSTOM_INSTRUCTIONS: fs.readFileSync(args.customInstructionsFile, 'utf8') } : {}),
  } });
  for (const dateStr of datesInMonth(args.month)) {
    await runForDate(dateStr, summarize
      ? { outputDir: args.outputDir, summarize }
      : { outputDir: args.outputDir, summaryConfig });
  }

  const julyBeforeFast = fingerprintMonthArtifacts(args.outputDir, args.month);
  started = Date.now();
  const fast = await indexAllConversations({ outputDir: args.outputDir });
  timings.fastIndexMs = Date.now() - started;
  timings.fastCandidates = fast.candidates;
  const julyAfterFast = fingerprintMonthArtifacts(args.outputDir, args.month);

  started = Date.now();
  await indexAllConversations({ outputDir: args.outputDir, fullScan: true });
  timings.reconciliationMs = Date.now() - started;
  const julyAfterFull = fingerprintMonthArtifacts(args.outputDir, args.month);

  const comparison = compareMonth(args.month, args.outputDir, args.baselineDir);
  comparison.equivalence = {
    beforeFast: julyBeforeFast,
    afterFast: julyAfterFast,
    afterFull: julyAfterFull,
    unchangedByFast: julyBeforeFast.sha256 === julyAfterFast.sha256,
    unchangedByFull: julyAfterFast.sha256 === julyAfterFull.sha256,
  };
  const liveAfter = fingerprintTree(args.baselineDir);
  comparison.liveOutput = { before: liveBefore, after: liveAfter, unchanged: liveBefore.sha256 === liveAfter.sha256 };
  comparison.timings = timings;

  fs.writeFileSync(path.join(args.outputDir, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  fs.writeFileSync(path.join(args.outputDir, 'comparison.md'), comparisonMarkdown(comparison, timings, liveBefore, liveAfter));
  fs.writeFileSync(path.join(args.outputDir, 'run.json'), `${JSON.stringify({ month: args.month, baselineDir: args.baselineDir, outputDir: args.outputDir, completedAt: new Date().toISOString(), index: full, timings }, null, 2)}\n`);

  if (!comparison.liveOutput.unchanged) throw new Error('Live tracker changed during isolated validation');
  if (!comparison.equivalence.unchangedByFast || !comparison.equivalence.unchangedByFull) {
    throw new Error('Optimized and full scans did not preserve identical conversation artifacts');
  }
  console.log(`[validation] Report: ${path.join(args.outputDir, 'comparison.md')}`);
}

module.exports = {
  parseArgs,
  datesInMonth,
  baselineSessions,
  currentSessionsForMonth,
  compareMonth,
  fingerprintTree,
  fingerprintMonthArtifacts,
  main,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`[validation:fatal] ${err.message}`);
    process.exit(1);
  });
}
