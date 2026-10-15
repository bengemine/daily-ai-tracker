'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./conversation-artifacts');

const SETTINGS_VERSION = 1;
const SETTINGS_FILE = path.join(__dirname, '..', 'tracker-settings.json');
const PROVIDERS = new Set(['claude', 'codex']);
const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  provider: 'claude',
  model: 'sonnet',
  reasoning: 'medium',
  customInstructions: '',
  timeoutMs: 3 * 60 * 60 * 1000,
});

function settingsPath(env = process.env) {
  return env.AI_TRACKER_SETTINGS_PATH
    ? path.resolve(env.AI_TRACKER_SETTINGS_PATH)
    : SETTINGS_FILE;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSettings(value = {}, defaults = DEFAULT_SETTINGS) {
  const provider = String(value.provider || defaults.provider).trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported summary provider: ${provider}`);
  const model = String(value.model || defaults.model).trim();
  if (!model || model.length > 160) throw new Error('Summary model must be a non-empty model ID');
  const reasoning = String(value.reasoning || value.effort || defaults.reasoning).trim().toLowerCase();
  if (!REASONING_LEVELS.has(reasoning)) throw new Error(`Unsupported reasoning level: ${reasoning}`);
  const customInstructions = String(value.customInstructions || '').trim();
  if (customInstructions.length > 20000) throw new Error('Custom summary instructions cannot exceed 20,000 characters');
  return {
    version: SETTINGS_VERSION,
    provider,
    model,
    reasoning,
    customInstructions,
    timeoutMs: positiveInteger(value.timeoutMs, defaults.timeoutMs),
  };
}

function legacyDefaults(cfg = config) {
  return normalizeSettings({
    provider: cfg.summarizer?.provider || DEFAULT_SETTINGS.provider,
    model: cfg.summarizer?.model || DEFAULT_SETTINGS.model,
    reasoning: cfg.summarizer?.effort || DEFAULT_SETTINGS.reasoning,
    timeoutMs: cfg.summarizer?.claudeTimeoutMs || DEFAULT_SETTINGS.timeoutMs,
  });
}

function loadSettings(options = {}) {
  const env = options.env || process.env;
  const defaults = options.defaults || legacyDefaults(options.config || config);
  const filePath = options.filePath || settingsPath(env);
  let disk = {};
  if (options.loadDisk !== false) {
    try {
      disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && options.onWarning) options.onWarning(`Invalid tracker settings ignored: ${error.message}`);
    }
  }
  return normalizeSettings({
    ...disk,
    provider: env.AI_TRACKER_SUMMARY_PROVIDER || disk.provider,
    model: env.AI_TRACKER_SUMMARY_MODEL || disk.model,
    reasoning: env.AI_TRACKER_SUMMARY_REASONING || env.AI_TRACKER_SUMMARY_EFFORT || disk.reasoning,
    customInstructions: env.AI_TRACKER_CUSTOM_INSTRUCTIONS ?? disk.customInstructions,
    timeoutMs: env.AI_TRACKER_SUMMARIZER_TIMEOUT_MS || env.CLAUDE_SUMMARIZER_TIMEOUT_MS || disk.timeoutMs,
  }, defaults);
}

function saveSettings(value, options = {}) {
  const normalized = normalizeSettings(value, options.defaults || legacyDefaults(options.config || config));
  const filePath = options.filePath || settingsPath(options.env || process.env);
  atomicWrite(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function settingsFingerprint(settings) {
  const normalized = normalizeSettings(settings);
  return sha256(JSON.stringify({
    provider: normalized.provider,
    model: normalized.model,
    reasoning: normalized.reasoning,
    customInstructionsSha256: sha256(normalized.customInstructions),
  }));
}

module.exports = {
  SETTINGS_VERSION,
  SETTINGS_FILE,
  DEFAULT_SETTINGS,
  PROVIDERS,
  REASONING_LEVELS,
  settingsPath,
  normalizeSettings,
  loadSettings,
  saveSettings,
  settingsFingerprint,
  sha256,
};
