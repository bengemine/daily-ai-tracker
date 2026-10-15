'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Machine-specific settings: where the tracker writes its output and which
 * WSL distro and home folder hold the WSL agents' session files.
 *
 * Each value is read in this order:
 *   1. an environment variable (AI_TRACKER_OUTPUT_DIR, AI_TRACKER_WSL_DISTRO,
 *      AI_TRACKER_WSL_HOME)
 *   2. tracker-config.json in the project root, or the file named by
 *      AI_TRACKER_CONFIG_PATH (see tracker-config.example.json)
 *   3. the defaults below.
 */

const CONFIG_FILE = path.join(__dirname, '..', 'tracker-config.json');
const DEFAULT_WSL_DISTRO = 'Ubuntu';

function configPath(env = process.env) {
  return env.AI_TRACKER_CONFIG_PATH ? path.resolve(env.AI_TRACKER_CONFIG_PATH) : CONFIG_FILE;
}

function readLocalConfig(env = process.env) {
  const filePath = configPath(env);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid tracker config ${filePath}: ${error.message}`);
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function currentUserName() {
  try {
    return os.userInfo().username || 'user';
  } catch {
    return 'user';
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn a WSL Linux home folder into a Windows UNC path, for example
 * ('wsl.localhost', 'Ubuntu', '/home/me') -> \\wsl.localhost\Ubuntu\home\me
 */
function wslUncPath(share, distro, linuxPath) {
  return `\\\\${share}\\${distro}${linuxPath.replace(/\//g, '\\')}`;
}

function resolveMachineSettings(env = process.env, local = readLocalConfig(env)) {
  const userProfile = env.USERPROFILE || env.HOME || os.homedir();
  const wslDistro = text(env.AI_TRACKER_WSL_DISTRO) || text(local.wslDistro) || DEFAULT_WSL_DISTRO;
  const wslHome = (text(env.AI_TRACKER_WSL_HOME) || text(local.wslHome) || `/home/${currentUserName().toLowerCase()}`)
    .replace(/\/+$/, '');
  const outputDir = text(env.AI_TRACKER_OUTPUT_DIR) || text(local.outputDir) || path.join(userProfile, 'ai-tracker');
  return { userProfile, wslDistro, wslHome, outputDir };
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_WSL_DISTRO,
  configPath,
  readLocalConfig,
  resolveMachineSettings,
  wslUncPath,
};
