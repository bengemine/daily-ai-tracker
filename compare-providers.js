#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { runForDate } = require('./tracker');
const { fingerprintTree } = require('./validate-month');

function parseArgs(argv = process.argv.slice(2)) {
  const result = { date: null, outputDir: null };
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === '--date') result.date = argv[index + 1];
    else if (argv[index] === '--output') result.outputDir = path.resolve(argv[index + 1]);
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date || '')) throw new Error('--date must use YYYY-MM-DD');
  if (!result.outputDir) throw new Error('--output is required');
  if (path.resolve(result.outputDir) === path.resolve(config.output.directory)) throw new Error('Comparison output cannot be the live tracker');
  return result;
}

function collectSummaries(root, date) {
  const result = [];
  const stack = [path.join(root, 'summaries')];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === `${date}.json`) {
        try { result.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* validation report shows missing item */ }
      }
    }
  }
  return result.sort((a, b) => String(a.sessionKey).localeCompare(String(b.sessionKey)));
}

function markdown(report) {
  const lines = [
    `# Claude vs Luna - ${report.date}`,
    '',
    `- Claude: ${report.claude.durationMs} ms, ${report.claude.summaries.length} summaries`,
    `- Luna: ${report.luna.durationMs} ms, ${report.luna.summaries.length} summaries`,
    `- Live tracker unchanged: ${report.liveUnchanged ? 'yes' : 'NO'}`,
    '',
    '| Conversation | Claude words | Luna words | Claude title | Luna title |',
    '|---|---:|---:|---|---|',
  ];
  const keys = new Set([...report.claude.summaries, ...report.luna.summaries].map(value => value.sessionKey));
  for (const key of [...keys].sort()) {
    const claude = report.claude.summaries.find(value => value.sessionKey === key);
    const luna = report.luna.summaries.find(value => value.sessionKey === key);
    lines.push(`| ${key} | ${claude?.wordCount ?? '-'} | ${luna?.wordCount ?? '-'} | ${claude?.title || 'missing'} | ${luna?.title || 'missing'} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.outputDir, { recursive: true });
  const liveBefore = fingerprintTree(config.output.directory);
  const configurations = [
    ['claude', { provider: 'claude', model: 'sonnet', reasoning: 'medium', customInstructions: '', timeoutMs: 10800000 }],
    ['luna', { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium', customInstructions: '', timeoutMs: 10800000 }],
  ];
  const report = { date: args.date, createdAt: new Date().toISOString() };
  for (const [name, summaryConfig] of configurations) {
    const outputDir = path.join(args.outputDir, name);
    const started = Date.now();
    await runForDate(args.date, { outputDir, conversationStoreDir: config.output.directory, summaryConfig });
    report[name] = { durationMs: Date.now() - started, outputDir, summaries: collectSummaries(outputDir, args.date) };
  }
  const liveAfter = fingerprintTree(config.output.directory);
  report.liveUnchanged = liveBefore.sha256 === liveAfter.sha256;
  fs.writeFileSync(path.join(args.outputDir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(args.outputDir, 'comparison.md'), markdown(report));
  if (!report.liveUnchanged) throw new Error('Live tracker changed during isolated provider comparison');
  console.log(`[comparison] ${path.join(args.outputDir, 'comparison.md')}`);
  return report;
}

module.exports = { parseArgs, collectSummaries, markdown, main };

if (require.main === module) main().catch(error => { console.error(`[comparison:fatal] ${error.message}`); process.exit(1); });
