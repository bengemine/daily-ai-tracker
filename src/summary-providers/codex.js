'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { atomicWrite } = require('../conversation-artifacts');

function toWslPath(value) {
  const match = String(value).match(/^([A-Za-z]):[\\/](.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}` : value;
}

function commandCandidates(env = process.env, platform = process.platform) {
  if (env.CODEX_CLI_PATH?.trim()) return [{ command: env.CODEX_CLI_PATH.trim(), required: true, source: 'CODEX_CLI_PATH' }];
  if (platform === 'win32') {
    const distro = env.AI_TRACKER_WSL_DISTRO || config.wsl.distro;
    return [{
      command: 'wsl.exe',
      source: `WSL ${distro}`,
      // --exec bypasses the WSL login shell, so '&' and spaces in args survive.
      prefixArgs: ['-d', distro, '--exec', 'bash', toWslPath(path.win32.resolve(__dirname, '..', 'run-codex-wsl.sh'))],
    }];
  }
  return [{ command: 'codex', source: 'PATH' }];
}

function argsForCandidate(candidate, args) {
  if (candidate.command.toLowerCase() !== 'wsl.exe') return args;
  const translated = [...args];
  for (let index = 0; index < translated.length - 1; index++) {
    if (['--cd', '--output-schema', '--output-last-message'].includes(translated[index])) {
      translated[index + 1] = toWslPath(translated[index + 1]);
    }
  }
  return translated;
}

function run(candidate, args, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, [...(candidate.prefixArgs || []), ...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Codex CLI timed out after ${options.timeoutMs / 1000}s`));
      if (code !== 0) return reject(new Error(`Codex CLI exited with code ${code}: ${stderr.trim() || 'no error output'}`));
      resolve({ stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function parseCodexResponse(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

async function invokeCodex(options) {
  const schemaPath = path.join(options.workspace, 'codex-output-schema.json');
  const outputPath = path.join(options.workspace, 'codex-last-message.json');
  atomicWrite(schemaPath, `${JSON.stringify(options.schema, null, 2)}\n`);
  const args = [
    'exec', '-',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', options.workspace,
    '--model', options.model,
    '--config', `model_reasoning_effort=${JSON.stringify(options.reasoning)}`,
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    '--json',
  ];
  let lastError;
  for (const candidate of commandCandidates(options.env)) {
    try {
      const result = await run(candidate, argsForCandidate(candidate, args), `${options.systemPrompt}\n\n${options.prompt}`, {
        cwd: options.workspace,
        timeoutMs: options.timeoutMs,
      });
      const raw = fs.readFileSync(outputPath, 'utf8');
      return { value: parseCodexResponse(raw), raw, events: result.stdout };
    } catch (error) {
      lastError = error;
      if (candidate.required) break;
    }
  }
  throw lastError || new Error('No Codex CLI candidate was available');
}

module.exports = { invokeCodex, parseCodexResponse, commandCandidates, argsForCandidate, toWslPath };
