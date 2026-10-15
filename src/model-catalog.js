'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const { wslUncPath } = require('./local-config');

const CLAUDE_MODELS = [
  { id: 'sonnet', name: 'Sonnet (latest alias)', description: 'Balanced Claude model alias', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opus', name: 'Opus (latest alias)', description: 'Highest-capability Claude model alias', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'fable', name: 'Fable (latest alias)', description: 'Fast Claude model alias exposed by the installed CLI', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

function codexCatalogCandidates(env = process.env, platform = process.platform) {
  const userProfile = env.USERPROFILE || env.HOME || os.homedir();
  const candidates = [];
  if (env.CODEX_MODELS_CACHE) candidates.push(env.CODEX_MODELS_CACHE);
  if (platform === 'win32') {
    candidates.push(
      path.win32.join(userProfile, '.codex', 'models_cache.json'),
      `${wslUncPath('wsl.localhost', config.wsl.distro, config.wsl.home)}\\.codex\\models_cache.json`,
      `${wslUncPath('wsl$', config.wsl.distro, config.wsl.home)}\\.codex\\models_cache.json`,
    );
  } else {
    candidates.push(path.join(userProfile, '.codex', 'models_cache.json'), path.posix.join(config.wsl.home, '.codex', 'models_cache.json'));
  }
  return [...new Set(candidates)];
}

function loadCodexModels(options = {}) {
  const candidates = options.candidates || codexCatalogCandidates(options.env, options.platform);
  let lastError = null;
  for (const filePath of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const models = Array.isArray(raw.models) ? raw.models.map(model => ({
        id: String(model.slug),
        name: String(model.display_name || model.slug),
        description: String(model.description || ''),
        reasoning: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map(level => String(level.effort)).filter(Boolean)
          : [],
        contextWindow: Number(model.context_window || model.max_context_window) || null,
      })).filter(model => model.id) : [];
      if (models.length === 0) throw new Error('model cache contains no models');
      const stat = fs.statSync(filePath);
      return { provider: 'codex', source: filePath, updatedAt: stat.mtime.toISOString(), fetchedAt: raw.fetched_at || null, models };
    } catch (error) {
      lastError = error;
    }
  }
  return { provider: 'codex', source: null, updatedAt: null, fetchedAt: null, models: [], error: lastError?.message || 'Codex model cache not found' };
}

function loadModelCatalog(provider, options = {}) {
  if (provider === 'codex') return loadCodexModels(options);
  if (provider === 'claude') return {
    provider: 'claude', source: 'installed CLI aliases', updatedAt: null, fetchedAt: null,
    models: CLAUDE_MODELS, customModelAllowed: true,
    note: 'Claude Code does not expose a stable headless model-list command. These aliases are not exhaustive.',
  };
  throw new Error(`Unsupported model provider: ${provider}`);
}

module.exports = { CLAUDE_MODELS, codexCatalogCandidates, loadCodexModels, loadModelCatalog };
