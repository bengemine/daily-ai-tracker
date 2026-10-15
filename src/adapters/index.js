/**
 * Adapter registry — returns instances of all agent adapters.
 *
 * Order: Claude Code roots first (Windows then WSL), then alphabetical.
 * Each adapter extends AgentAdapter from ./base.js.
 */

const { ClaudeCodeAdapter } = require('./claude-code');
const { CodexAdapter } = require('./codex');
const { CursorAdapter } = require('./cursor');
const { FactoryAdapter } = require('./factory');
const { GrokAdapter } = require('./grok');
const { OpenCodeAdapter } = require('./opencode');
const config = require('../config');

/**
 * Returns fresh instances of all active agent adapters.
 * @returns {import('./base').AgentAdapter[]}
 */
function getAllAdapters() {
  return [
    new ClaudeCodeAdapter(config.agents.claudeCode),
    new ClaudeCodeAdapter(config.agents.claudeCodeWsl),
    new CodexAdapter(config.agents.codex),
    new CodexAdapter(config.agents.codexWsl),
    new CursorAdapter(),
    new FactoryAdapter(),
    new GrokAdapter(),
    new GrokAdapter(config.agents.grokWsl),
    new OpenCodeAdapter(),
  ];
}

module.exports = { getAllAdapters };
