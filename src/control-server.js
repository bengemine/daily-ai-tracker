'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { loadSettings, saveSettings } = require('./tracker-settings');
const { loadModelCatalog } = require('./model-catalog');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 64 * 1024;

function nativePath(value) {
  if (process.platform === 'win32') return value;
  const match = String(value).match(/^([A-Za-z]):[\\/](.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}` : value;
}

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function readErrors(outputDir) {
  const filePath = path.join(nativePath(outputDir), 'ai-summary-errors.jsonl');
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).slice(-100).reverse().map(line => {
      try { return JSON.parse(line); } catch { return { message: line, errorType: 'invalid-log-line' }; }
    });
  } catch { return []; }
}

function schedulerStatus() {
  if (process.platform !== 'win32') return { schedule: 'Daily at 11:30 AM', state: 'Configured on Windows' };
  try {
    const result = require('child_process').execFileSync('schtasks.exe', ['/Query', '/TN', 'DailyTrackerAI', '/FO', 'LIST', '/V'], { encoding: 'utf8' });
    const value = name => result.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
    return { schedule: value('Start Time') || '11:30:00', state: value('Status') || 'Unknown', nextRun: value('Next Run Time'), lastResult: value('Last Result') };
  } catch (error) {
    return { schedule: 'Daily at 11:30 AM', state: 'Unavailable', error: error.message };
  }
}

function startJob(script, args, outputDir, jobs) {
  fs.mkdirSync(outputDir, { recursive: true });
  const logPath = path.join(outputDir, 'control-room-run.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = { id, script, args, outputDir, logPath, status: 'running', startedAt: new Date().toISOString(), pid: child.pid };
  jobs.set(id, job);
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.on('close', code => {
    job.status = code === 0 ? 'complete' : 'failed';
    job.exitCode = code;
    job.completedAt = new Date().toISOString();
    stream.end();
  });
  child.on('error', error => {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    stream.end();
  });
  return job;
}

function createControlServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const outputDir = options.outputDir || config.output.directory;
  const settingsFile = options.settingsFile;
  const jobs = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        let html = fs.readFileSync(path.join(PUBLIC_DIR, 'control-panel.html'), 'utf8');
        html = html.replace('__TRACKER_TOKEN__', token);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        return json(res, 200, {
          settings: loadSettings({ filePath: settingsFile }),
          models: { claude: loadModelCatalog('claude'), codex: loadModelCatalog('codex') },
          scheduler: schedulerStatus(),
          errors: readErrors(outputDir),
          jobs: [...jobs.values()].slice(-20).reverse(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, { jobs: [...jobs.values()].slice(-20).reverse() });

      if (req.method === 'POST') {
        if (req.headers['x-tracker-token'] !== token) return json(res, 403, { error: 'Invalid control-room token' });
        const body = await readBody(req);
        if (url.pathname === '/api/settings') return json(res, 200, { settings: saveSettings(body, { filePath: settingsFile }) });
        if (url.pathname === '/api/compare') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) return json(res, 400, { error: 'Comparison date must use YYYY-MM-DD' });
          const resultDir = path.join(ROOT, 'validation-output', 'provider-comparisons', `${body.date}-${Date.now()}`);
          const job = startJob('compare-providers.js', ['--date', body.date, '--output', resultDir], resultDir, jobs);
          return json(res, 202, { job });
        }
        if (url.pathname === '/api/regenerate') {
          if (!/^\d{4}-\d{2}$/.test(body.month || '')) return json(res, 400, { error: 'Month must use YYYY-MM' });
          const resultDir = path.join(ROOT, 'validation-output', `regenerated-${body.month}-${Date.now()}`);
          const args = ['--month', body.month, '--output', resultDir, '--provider', body.provider || 'codex', '--model', body.model || 'gpt-5.6-luna', '--reasoning', body.reasoning || 'medium', '--resume'];
          const job = startJob('validate-month.js', args, resultDir, jobs);
          return json(res, 202, { job });
        }
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });

  return { server, token, host, jobs };
}

module.exports = { createControlServer, nativePath, readErrors, schedulerStatus };
