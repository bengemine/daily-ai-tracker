'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { atomicWrite, readJson } = require('./conversation-artifacts');

const SCAN_STATE_VERSION = 1;
const DISCOVERY_VERSION = 2;
const OVERLAP_MS = 5 * 60 * 1000;
const FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function scanStatePath(outputDir) {
  return path.join(outputDir, '.conversation-index', 'scan-state.json');
}

function sourceConfiguration(cfg) {
  const agents = cfg.agents || {};
  return [
    ['claudeCode', agents.claudeCode, agents.claudeCode?.projectsDir || 'projects'],
    ['claudeCodeWsl', agents.claudeCodeWsl, agents.claudeCodeWsl?.projectsDir || 'projects'],
    ['codex', agents.codex, 'sessions'],
    ['codexWsl', agents.codexWsl, 'sessions'],
    ['factory', agents.factory, agents.factory?.sessionsDir || 'sessions'],
    ['grok', agents.grok, agents.grok?.sessionsDir || 'sessions'],
    ['grokWsl', agents.grokWsl, agents.grokWsl?.sessionsDir || 'sessions'],
    ['openCode', agents.openCode, agents.openCode?.dbPath || ''],
    ['cursor', agents.cursor, agents.cursor?.globalDbPath || ''],
  ].map(([key, agent, child]) => ({
    key,
    name: agent?.name || '',
    storagePath: agent?.storagePath || '',
    child,
  }));
}

function configurationFingerprint(cfg) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ discoveryVersion: DISCOVERY_VERSION, sources: sourceConfiguration(cfg) }))
    .digest('hex');
}

function validDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function chooseScanMode({ outputDir, cfg, now = new Date(), forceFullScan = false }) {
  const fingerprint = configurationFingerprint(cfg);
  if (forceFullScan) return { fullScan: true, reason: 'forced', state: {}, fingerprint };

  const state = readJson(scanStatePath(outputDir), null);
  if (!state || state.version !== SCAN_STATE_VERSION) {
    return { fullScan: true, reason: 'missing-or-invalid-checkpoint', state: state || {}, fingerprint };
  }
  if (state.configurationFingerprint !== fingerprint || state.discoveryVersion !== DISCOVERY_VERSION) {
    return { fullScan: true, reason: 'configuration-changed', state, fingerprint };
  }

  const nowMs = now.getTime();
  const lastSuccess = validDate(state.lastSuccessfulScanStartedAt);
  const lastFull = validDate(state.lastFullScanAt);
  if (lastSuccess === null || lastFull === null || lastSuccess > nowMs + FUTURE_TOLERANCE_MS || lastFull > nowMs + FUTURE_TOLERANCE_MS) {
    return { fullScan: true, reason: 'unsafe-checkpoint-time', state, fingerprint };
  }
  if (nowMs - lastFull >= FULL_SCAN_INTERVAL_MS) {
    return { fullScan: true, reason: 'weekly-reconciliation', state, fingerprint };
  }

  return {
    fullScan: false,
    reason: 'modified-since-checkpoint',
    state,
    fingerprint,
    cutoff: new Date(lastSuccess - OVERLAP_MS),
  };
}

function writeSuccessfulScanState({ outputDir, mode, scanStartedAt }) {
  const fullScanAt = mode.fullScan
    ? scanStartedAt.toISOString()
    : mode.state.lastFullScanAt;
  atomicWrite(scanStatePath(outputDir), `${JSON.stringify({
    version: SCAN_STATE_VERSION,
    discoveryVersion: DISCOVERY_VERSION,
    configurationFingerprint: mode.fingerprint,
    lastSuccessfulScanStartedAt: scanStartedAt.toISOString(),
    lastFullScanAt: fullScanAt,
  }, null, 2)}\n`);
}

function parseWslUnc(filePath) {
  const match = String(filePath || '').match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i);
  if (!match) return null;
  return {
    distro: match[1],
    linuxPath: `/${match[2].replace(/\\/g, '/')}`,
  };
}

function wslKey(distro, linuxPath) {
  return `${String(distro).toLowerCase()}\0${linuxPath.replace(/\/+$/, '')}`;
}

function configuredWslRoots(cfg) {
  const agents = cfg.agents || {};
  const definitions = [
    [agents.claudeCodeWsl, agents.claudeCodeWsl?.projectsDir || 'projects'],
    [agents.codexWsl, 'sessions'],
    [agents.grokWsl, agents.grokWsl?.sessionsDir || 'sessions'],
  ];
  const roots = [];
  for (const [agent, child] of definitions) {
    if (!agent?.storagePath) continue;
    const windowsPath = path.join(agent.storagePath, child);
    const parsed = parseWslUnc(windowsPath);
    if (!parsed) continue;
    try {
      const stat = fs.statSync(windowsPath);
      if (!stat.isDirectory()) continue;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    roots.push({ ...parsed, windowsPath });
  }
  return roots;
}

function discoverModifiedWslPaths(cfg, cutoff, options = {}) {
  const run = options.execFileSync || execFileSync;
  const groups = new Map();
  for (const root of configuredWslRoots(cfg)) {
    const key = root.distro.toLowerCase();
    if (!groups.has(key)) groups.set(key, { distro: root.distro, roots: [] });
    groups.get(key).roots.push(root.linuxPath);
  }

  const changed = new Set();
  for (const { distro, roots } of groups.values()) {
    const output = run('wsl.exe', [
      '-d', distro, '--', 'find', ...roots,
      '-type', 'f', '-name', '*.jsonl', '-newermt', cutoff.toISOString(), '-print0',
    ], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    for (const linuxPath of Buffer.from(output || '').toString('utf8').split('\0')) {
      if (linuxPath) changed.add(wslKey(distro, linuxPath));
    }
  }
  return changed;
}

function descriptorPaths(descriptor) {
  if (descriptor.type === 'grok') return [descriptor.eventsPath, descriptor.historyPath];
  return descriptor.filePath ? [descriptor.filePath] : [];
}

function sourceModifiedSince(descriptor, cutoff, modifiedWslPaths) {
  for (const filePath of descriptorPaths(descriptor)) {
    const wsl = parseWslUnc(filePath);
    if (wsl) {
      if (modifiedWslPaths.has(wslKey(wsl.distro, wsl.linuxPath))) return true;
      continue;
    }
    try {
      if (fs.statSync(filePath).mtimeMs >= cutoff.getTime()) return true;
    } catch {
      // A source that disappeared after discovery must be processed so the run
      // fails safely instead of advancing its checkpoint.
      return true;
    }
  }
  return false;
}

function selectChangedDescriptors(descriptors, cfg, cutoff, options = {}) {
  const modifiedWslPaths = discoverModifiedWslPaths(cfg, cutoff, options);
  return descriptors.filter(descriptor => sourceModifiedSince(descriptor, cutoff, modifiedWslPaths));
}

module.exports = {
  SCAN_STATE_VERSION,
  DISCOVERY_VERSION,
  OVERLAP_MS,
  FULL_SCAN_INTERVAL_MS,
  scanStatePath,
  configurationFingerprint,
  chooseScanMode,
  writeSuccessfulScanState,
  parseWslUnc,
  discoverModifiedWslPaths,
  sourceModifiedSince,
  selectChangedDescriptors,
};
