/**
 * Type factories for Daily AI Tracker.
 * Plain object constructors — no classes, no validation overhead.
 */

/**
 * @param {Object} opts
 * @param {string} opts.id - Session UUID
 * @param {string} opts.agent - Agent name (e.g. "Claude Code")
 * @param {string} opts.project - Project filesystem path
 * @param {Date}   opts.startTime - Earliest timestamp in session
 * @param {string} [opts.activityDate] - Processed local date (YYYY-MM-DD)
 * @returns {{ id: string, agent: string, project: string, startTime: Date, name: string, activityDate?: string, filePath?: string, sessionKey?: string }}
 */
function createSession({ id, agent, project, startTime, name = '', ...rest }) {
  return { id, agent, project, startTime, name, ...rest };
}

/**
 * @param {Object} opts
 * @param {string}   opts.topic - First real user message (the "what")
 * @param {string[]} opts.userMessages - All filtered user messages
 * @param {{ name: string, count: number }[]} opts.toolCalls - Deduplicated tool usage
 * @param {string[]} opts.filePaths - Unique file paths touched
 * @param {string[]} opts.lastExchanges - Last 3-5 user messages for context
 * @returns {Object}
 */
function createHighlights({ topic = '', userMessages = [], toolCalls = [], filePaths = [], lastExchanges = [] } = {}) {
  return { topic, userMessages, toolCalls, filePaths, lastExchanges };
}

module.exports = { createSession, createHighlights };
