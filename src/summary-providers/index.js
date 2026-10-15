'use strict';

const { invokeClaude } = require('./claude');
const { invokeCodex } = require('./codex');

const providers = { claude: invokeClaude, codex: invokeCodex };

function getProvider(name) {
  const provider = providers[String(name || '').toLowerCase()];
  if (!provider) throw new Error(`Unsupported summary provider: ${name}`);
  return provider;
}

module.exports = { getProvider, providers };
