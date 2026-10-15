'use strict';

const { getClaudeCommandCandidates, runClaudeCommand } = require('../summarizer');

function parseClaudeResponse(raw) {
  let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const value = JSON.parse(text);
  let structured = value?.structured_output || value;
  if (!value?.structured_output && typeof value?.result === 'string') {
    try { structured = JSON.parse(value.result); } catch { /* keep outer value */ }
  }
  return structured;
}

async function invokeClaude(options) {
  const args = [
    '-p',
    '--safe-mode',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--disable-slash-commands',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--model', options.model,
    '--effort', options.reasoning,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(options.schema),
    '--system-prompt', options.systemPrompt,
  ];
  const attempts = [];
  let lastError;
  for (const candidate of getClaudeCommandCandidates(options.env)) {
    try {
      const raw = await runClaudeCommand(candidate, args, options.prompt, {
        timeoutMs: options.timeoutMs,
        cwd: options.workspace,
      });
      return { value: parseClaudeResponse(raw), raw };
    } catch (error) {
      lastError = error;
      attempts.push(`${candidate.command}: ${error.message}`);
      if (candidate.required) break;
    }
  }
  const error = lastError || new Error('No Claude CLI candidate was available');
  error.attempts = attempts;
  throw error;
}

module.exports = { invokeClaude, parseClaudeResponse };
