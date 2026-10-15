const path = require('path');
const { resolveMachineSettings, wslUncPath } = require('./local-config');

/**
 * Agent storage paths and project-wide settings.
 * Uses USERPROFILE (not os.homedir()) per research findings — more reliable on Windows.
 * Machine-specific values (output folder, WSL distro, WSL home) come from
 * src/local-config.js: environment variables, then tracker-config.json, then defaults.
 */

const machine = resolveMachineSettings();
const userProfile = machine.userProfile;
const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
// Claude Code and Codex keep the \\wsl$ form so existing scan checkpoints stay valid.
const wslLegacyHome = wslUncPath('wsl$', machine.wslDistro, machine.wslHome);
// Node's file reads are much faster through wsl.localhost.
const wslLocalhostHome = wslUncPath('wsl.localhost', machine.wslDistro, machine.wslHome);
const claudeCodeWslStoragePath = `${wslLegacyHome}\\.claude`;
const codexWslStoragePath = `${wslLegacyHome}\\.codex`;
const grokWslStoragePath = `${wslLocalhostHome}\\.grok`;
const t3StateDbPath = `${wslLocalhostHome}\\.t3\\userdata\\state.sqlite`;

const config = {
  wsl: {
    distro: machine.wslDistro,
    home: machine.wslHome,
  },

  agents: {
    claudeCode: {
      name: 'Claude Code',
      storagePath: path.join(userProfile, '.claude'),
      historyFile: 'history.jsonl',
      projectsDir: 'projects',
    },
    claudeCodeWsl: {
      name: 'Claude Code (WSL)',
      storagePath: claudeCodeWslStoragePath,
      historyFile: 'history.jsonl',
      projectsDir: 'projects',
    },
    factory: {
      name: 'Factory',
      storagePath: path.join(userProfile, '.factory'),
      sessionsDir: 'sessions',
    },
    codex: {
      name: 'Codex',
      storagePath: path.join(userProfile, '.codex'),
      historyFile: 'history.jsonl',
    },
    codexWsl: {
      name: 'Codex (WSL)',
      storagePath: codexWslStoragePath,
      historyFile: 'history.jsonl',
    },
    grok: {
      name: 'Grok',
      storagePath: path.join(userProfile, '.grok'),
      sessionsDir: 'sessions',
    },
    grokWsl: {
      name: 'Grok (WSL)',
      storagePath: grokWslStoragePath,
      sessionsDir: 'sessions',
    },
    // Not a transcript source: T3 Code's Claude/Codex transcripts are read by
    // the WSL adapters above. This DB only tags which sessions came from T3.
    t3Code: {
      name: 'T3 Code',
      stateDbPath: t3StateDbPath,
    },
    openCode: {
      name: 'OpenCode',
      dbPath: path.join(userProfile, '.local', 'share', 'opencode', 'opencode.db'),
    },
    cursor: {
      name: 'Cursor',
      globalDbPath: path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      workspaceStoragePath: path.join(appData, 'Cursor', 'User', 'workspaceStorage'),
    },
  },

  output: {
    directory: machine.outputDir,
  },

  summarizer: {
    // tracker-settings.json may override these safe defaults.
    provider: 'claude',
    claudeTimeoutMs: 3 * 60 * 60 * 1000,
    model: 'sonnet',
    effort: 'medium',
  },
};

module.exports = config;
