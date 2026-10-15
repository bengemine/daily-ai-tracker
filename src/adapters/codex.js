const fs = require('fs');
const path = require('path');
const { AgentAdapter } = require('./base');
const { createSession, createHighlights } = require('../types');
const { getDateRange, isWithinDate } = require('../utils/date');
const config = require('../config');
const { detectSubAgent } = require('./sub-agent-filter');

function isMissingOrDenied(err) {
  return err && ['ENOENT', 'EACCES', 'EPERM'].includes(err.code);
}

/**
 * Codex adapter.
 *
 * Prefer the richer per-session JSONL files under ~/.codex/sessions/ because
 * they preserve cwd/project context and tool events. history.jsonl is still
 * used as a fallback signal for activity checks and backward compatibility.
 */
class CodexAdapter extends AgentAdapter {
  constructor(agentConfig = config.agents.codex) {
    super(agentConfig.name);
    this.agentConfig = agentConfig;
    this.storagePath = agentConfig.storagePath;
    this.historyFile = path.join(this.storagePath, agentConfig.historyFile);
    this.sessionsDir = path.join(this.storagePath, 'sessions');
    this._dailySessionCache = new Map();
  }

  _isStorageAvailable() {
    if (!this.storagePath) return false;
    try {
      return fs.existsSync(this.storagePath);
    } catch (err) {
      if (isMissingOrDenied(err)) return false;
      throw err;
    }
  }

  // -- History parsing -------------------------------------------------------

  _readHistory() {
    if (!this._isStorageAvailable()) return [];
    try {
      const raw = fs.readFileSync(this.historyFile, 'utf-8');
      return raw.split('\n').filter(Boolean).map((line, i) => {
        try {
          const entry = JSON.parse(line);
          if (typeof entry.ts === 'number') {
            entry.tsMs = entry.ts * 1000;
          }
          return entry;
        } catch {
          console.warn(`[warn] ${this.name}: Malformed JSON at history.jsonl line ${i + 1}, skipping`);
          return null;
        }
      }).filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  _filterHistory(entries, dateStr) {
    const range = getDateRange(dateStr);
    return entries.filter(entry => {
      if (!entry.tsMs) return false;
      return isWithinDate(entry.tsMs, range);
    });
  }

  // -- Session file helpers --------------------------------------------------

  _getSessionDirForDate(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return path.join(this.sessionsDir, year, month, day);
  }

  _getSessionFilesForDate(dateStr) {
    const dir = this._getSessionDirForDate(dateStr);
    try {
      return fs.readdirSync(dir)
        .filter(file => file.endsWith('.jsonl'))
        .map(file => path.join(dir, file));
    } catch (err) {
      if (isMissingOrDenied(err)) return [];
      throw err;
    }
  }

  _getAllSessionFiles() {
    const files = [];
    let years;
    try {
      years = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch (err) {
      if (isMissingOrDenied(err)) return files;
      throw err;
    }

    for (const year of years) {
      if (!year.isDirectory()) continue;
      const yearDir = path.join(this.sessionsDir, year.name);
      let months;
      try { months = fs.readdirSync(yearDir, { withFileTypes: true }); } catch { continue; }
      for (const month of months) {
        if (!month.isDirectory()) continue;
        const monthDir = path.join(yearDir, month.name);
        let days;
        try { days = fs.readdirSync(monthDir, { withFileTypes: true }); } catch { continue; }
        for (const day of days) {
          if (!day.isDirectory()) continue;
          const dayDir = path.join(monthDir, day.name);
          let entries;
          try { entries = fs.readdirSync(dayDir, { withFileTypes: true }); } catch { continue; }
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              files.push(path.join(dayDir, entry.name));
            }
          }
        }
      }
    }
    return files.sort();
  }

  _getCandidateSessionFiles(dateStr) {
    const range = getDateRange(dateStr);
    return this._getAllSessionFiles().filter(filePath => {
      try {
        const parts = path.relative(this.sessionsDir, filePath).split(path.sep);
        const creationDate = parts.length >= 3 ? `${parts[0]}-${parts[1]}-${parts[2]}` : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(creationDate) && creationDate > dateStr) return false;
        return fs.statSync(filePath).mtimeMs >= range.start.getTime();
      } catch {
        return false;
      }
    });
  }

  _getVisibleUserActivityTimestamps(entries, dateStr) {
    const range = getDateRange(dateStr);
    const timestamps = [];
    for (const entry of entries) {
      if (!entry?.timestamp || !isWithinDate(entry.timestamp, range)) continue;
      let text = '';
      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user') {
        text = CodexAdapter._extractInputText(entry.payload.content);
      } else if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        text = typeof entry.payload.message === 'string' ? entry.payload.message.trim() : '';
      }
      if (CodexAdapter._shouldSkipUserMessage(text)) continue;
      const timestamp = Date.parse(entry.timestamp);
      if (Number.isFinite(timestamp)) timestamps.push(timestamp);
    }
    return [...new Set(timestamps)].sort((a, b) => a - b);
  }

  _parseJsonlFile(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return raw.split('\n').filter(Boolean).map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          console.warn(`[warn] ${this.name}: Malformed JSON at ${path.basename(filePath)} line ${i + 1}, skipping`);
          return null;
        }
        }).filter(Boolean);
    } catch (err) {
      if (isMissingOrDenied(err)) return null;
      throw err;
    }
  }

  _getSessionMetadata(entries, filePath) {
    const meta = entries.find(entry => entry.type === 'session_meta' && entry.payload);
    const turnContext = entries.find(entry => entry.type === 'turn_context' && entry.payload);
    const firstTimestamp = entries
      .map(entry => Date.parse(entry.timestamp))
      .filter(ts => Number.isFinite(ts))
      .sort((a, b) => a - b)[0];

    return {
      id: meta?.payload?.id || path.basename(filePath, '.jsonl'),
      project: meta?.payload?.cwd || turnContext?.payload?.cwd || '(codex)',
      earliestTs: firstTimestamp || Date.now(),
    };
  }

  _findSessionFile(session) {
    if (session.filePath) return session.filePath;

    const candidates = [];
    if (session.startTime instanceof Date && !isNaN(session.startTime.getTime())) {
      const year = String(session.startTime.getFullYear());
      const month = String(session.startTime.getMonth() + 1).padStart(2, '0');
      const day = String(session.startTime.getDate()).padStart(2, '0');
      candidates.push(path.join(this.sessionsDir, year, month, day));
    }

    for (const dir of candidates) {
      try {
        const match = fs.readdirSync(dir).find(file => file.includes(session.id) && file.endsWith('.jsonl'));
        if (match) return path.join(dir, match);
      } catch {
        // Ignore missing directories and fall back to recursive search below.
      }
    }

    const dateDirs = [];
    try {
      for (const year of fs.readdirSync(this.sessionsDir)) {
        const yearDir = path.join(this.sessionsDir, year);
        if (!fs.statSync(yearDir).isDirectory()) continue;
        for (const month of fs.readdirSync(yearDir)) {
          const monthDir = path.join(yearDir, month);
          if (!fs.statSync(monthDir).isDirectory()) continue;
          for (const day of fs.readdirSync(monthDir)) {
            const dayDir = path.join(monthDir, day);
            if (fs.statSync(dayDir).isDirectory()) dateDirs.push(dayDir);
          }
        }
      }
    } catch (err) {
      if (isMissingOrDenied(err)) return null;
      return null;
    }

    for (const dir of dateDirs) {
      try {
        const match = fs.readdirSync(dir).find(file => file.includes(session.id) && file.endsWith('.jsonl'));
        if (match) return path.join(dir, match);
      } catch (err) {
        if (isMissingOrDenied(err)) continue;
        // Ignore unreadable directories.
      }
    }

    return null;
  }

  static _extractInputText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    return content
      .filter(block => ['input_text', 'output_text', 'text'].includes(block.type) && typeof block.text === 'string')
      .map(block => block.text.trim())
      .filter(Boolean)
      .join('\n');
  }

  static _shouldSkipUserMessage(text) {
    if (!text) return true;
    return (
      text.startsWith('<environment_context>') ||
      text.startsWith('<codex_internal_context') ||
      text.startsWith('# AGENTS.md instructions') ||
      text.startsWith('<permissions instructions>') ||
      text.startsWith('<collaboration_mode>')
    );
  }

  static _extractToolData(entries) {
    const toolCounts = new Map();
    const filePaths = new Set();

    for (const entry of entries) {
      if (entry.type !== 'response_item' || entry.payload?.type !== 'function_call') continue;

      const name = entry.payload.name || 'unknown';
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);

      let args = entry.payload.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = null;
        }
      }

      if (!args || typeof args !== 'object') continue;

      for (const key of ['workdir', 'path', 'file_path']) {
        if (typeof args[key] === 'string' && args[key].trim()) {
          filePaths.add(args[key]);
        }
      }

      if (typeof args.command === 'string') {
        const matches = args.command.match(/[A-Za-z]:\\\\[^"'`\r\n]+/g) || [];
        for (const match of matches) {
          filePaths.add(match);
        }
      }
    }

    return { toolCounts, filePaths };
  }

  static _extractUserMessages(entries) {
    const userMessages = [];

    for (const entry of entries) {
      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user') {
        const text = CodexAdapter._extractInputText(entry.payload.content);
        if (!CodexAdapter._shouldSkipUserMessage(text)) userMessages.push(text);
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const text = typeof entry.payload.message === 'string' ? entry.payload.message.trim() : '';
        if (!CodexAdapter._shouldSkipUserMessage(text)) userMessages.push(text);
      }
    }

    return [...new Set(userMessages)];
  }

  // -- Activity detection ----------------------------------------------------

  async checkActivity(dateStr) {
    return (await this.extractSessions(dateStr)).length > 0;
  }

  // -- Session extraction ----------------------------------------------------

  async extractSessions(dateStr) {
    if (this._dailySessionCache.has(dateStr)) {
      return this._dailySessionCache.get(dateStr).slice();
    }
    const sessionFiles = this._getCandidateSessionFiles(dateStr);
    if (sessionFiles.length === 0) {
      this._dailySessionCache.set(dateStr, []);
      return [];
    }

    const sessions = [];
    for (const filePath of sessionFiles) {
      const entries = this._parseJsonlFile(filePath);
      if (!entries || entries.length === 0) continue;

      const activityTimestamps = this._getVisibleUserActivityTimestamps(entries, dateStr);
      if (activityTimestamps.length === 0) continue;

      // Find the session_meta entry to check for sub-agent markers.
      // Only filter when a session_meta entry is present — older files that
      // lack it are kept to avoid false positives.
      const sessionMetaEntry = entries.find(
        entry => entry.type === 'session_meta' && entry.payload
      );

      if (sessionMetaEntry) {
        const filterResult = detectSubAgent('codex', sessionMetaEntry);
        if (filterResult.isSubAgent) {
          process.stderr.write(
            `[adapter:codex] skipped sub-agent session ${path.basename(filePath)} — ${filterResult.reason}\n`
          );
          continue;
        }
      }

      const meta = this._getSessionMetadata(entries, filePath);
      const session = createSession({
        id: meta.id,
        agent: this.name,
        project: meta.project,
        startTime: new Date(activityTimestamps[0]),
        activityDate: dateStr,
        activityEndTime: new Date(activityTimestamps[activityTimestamps.length - 1]),
        filePath,
        sessionKey: `${this.name}:${meta.id}`,
      });
      sessions.push(session);
    }

    console.log(`[info] ${this.name}: ${sessions.length} session(s) found for ${dateStr}`);
    this._dailySessionCache.set(dateStr, sessions);
    return sessions;
  }

  // -- Highlight extraction --------------------------------------------------

  async extractHighlights(session) {
    const sessionFile = session.filePath || this._findSessionFile(session);
    if (!sessionFile) {
      console.warn(`[warn] ${this.name}: No session file found for session ${session.id.slice(0, 8)}...`);
      return createHighlights();
    }

    const entries = this._parseJsonlFile(sessionFile);
    if (!entries || entries.length === 0) {
      console.warn(`[warn] ${this.name}: Empty session file for ${session.id.slice(0, 8)}...`);
      return createHighlights();
    }

    const userMessages = CodexAdapter._extractUserMessages(entries);
    const topic = userMessages[0] || '(no topic detected)';
    const lastExchanges = userMessages.slice(-5);
    const { toolCounts, filePaths } = CodexAdapter._extractToolData(entries);

    const toolCalls = [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return createHighlights({
      topic,
      userMessages,
      toolCalls,
      filePaths: [...filePaths].sort(),
      lastExchanges,
    });
  }
}

module.exports = { CodexAdapter };
