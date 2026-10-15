#!/usr/bin/env node

'use strict';

const { indexAllConversations } = require('./src/conversation-indexer');

function parseArgs(argv = process.argv.slice(2)) {
  const known = new Set(['--full-scan', '--help']);
  const unknown = argv.find(arg => !known.has(arg));
  return {
    fullScan: argv.includes('--full-scan'),
    help: argv.includes('--help'),
    error: unknown ? `Unknown option: ${unknown}` : null,
  };
}

const USAGE = `Deterministic Conversation Indexer

Usage:
  node index-conversations.js
  node index-conversations.js --full-scan

Options:
  --full-scan   Reconcile every discovered conversation source
  --help        Show this help message`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.error) throw new Error(args.error);

  console.log('\n═══ Deterministic Conversation Indexer ═══\n');
  const stats = await indexAllConversations({ fullScan: args.fullScan });
  console.log(`[indexer] Scan: ${stats.scanMode} (${stats.scanReason}); candidates: ${stats.candidates}`);
  console.log(`[indexer] Sources: ${stats.sources}`);
  console.log(`[indexer] Changed: ${stats.changed}; unchanged: ${stats.unchanged}; excluded: ${stats.excluded}`);
  if (stats.t3Sessions > 0) console.log(`[indexer] T3 Code sessions tagged: ${stats.t3Sessions}`);
  console.log(`[indexer] New raw bytes read: ${stats.bytesRead}; visible turns added: ${stats.turnsAdded}`);
  if (stats.migrated > 0) {
    console.log(`[indexer] Clean-store migration: ${stats.migrated} session(s) rewritten; ${stats.removedNoiseTurns} noise turn(s) removed`);
  }
  console.log('[indexer] Cursor skipped: local Cursor records do not provide reliable per-message dates.');
  console.log('\n═══ Indexing Complete ═══\n');
}

module.exports = { main, parseArgs, USAGE };

if (require.main === module) {
  main().catch(err => {
    console.error(`[indexer:fatal] ${err.message}`);
    if (err.stats?.errors) {
      for (const failure of err.stats.errors) {
        console.error(`[indexer:error] ${failure.agent} ${failure.id}: ${failure.error}`);
      }
    }
    process.exit(1);
  });
}
