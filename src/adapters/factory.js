const fs = require('fs');
const path = require('path');
const { AgentAdapter } = require('./base');
const { createSession, createHighlights } = require('../types');
const { getDateRange, isWithinDate } = require('../utils/date');
const config = require('../config');
const { detectSubAgent } = require('./sub-agent-filter');

/**
 * Factory adapter.
 * Sessions stored as JSONL files under ~/.factory/sessions/<encoded-path>/<uuid>.jsonl
 * and also as loose sessions directly in sessions/ (older format without project dirs).
 * 
 * No reliable history index — uses filesystem mtime for fast activity detection,
 * then verifies with entry timestamps.
 */
class FactoryAdapter extends AgentAdapter {
  constructor() {
    super(config.agents.factory.name);
    const agentConfig = config.agents.factory;
    this.storagePath = agentConfig.storagePath;
    this.sessionsDir = path.join(this.storagePath, agentConfig.sessionsDir);
  }

  // ── Path encoding ───────────────────────────────────────────────

  /**
   * Encode a filesystem path to Factory's directory name format.
   * E:\projects\example.com → -E-projects-example.com
   * Prefix `-`, strip drive colon, backslashes → `-`, preserve dots and `&`.
   */
  static encodeProjectPath(projectPath) {
    let encoded = projectPath;
    // Remove drive colon: E:\ → E\
    encoded = encoded.replace(/^([A-Za-z]):/, '$1');
    // Replace backslashes and forward slashes with -
    encoded = encoded.replace(/[\\\/]/g, '-');
    // Prefix with -
    return '-' + encoded;
  }

  /**
   * Decode a Factory directory name back to a filesystem path (best-effort).
   * -E-projects-example.com → E:\projects\example.com
   * Note: ambiguous — dots/dashes in original path look the same. 
   * This produces the drive letter prefix; the rest stays hyphenated since
   * we can't distinguish original separators from original hyphens.
   */
  static decodeProjectPath(dirName) {
    if (!dirName.startsWith('-')) return dirName;
    // Strip leading dash, restore drive colon
    const stripped = dirName.slice(1);
    // First char is drive letter, next is a dash that was the backslash after colon
    if (stripped.length >= 2 && /^[A-Za-z]$/.test(stripped[0]) && stripped[1] === '-') {
      return stripped[0] + ':\\' + stripped.slice(2).replace(/-/g, '\\');
    }
    return stripped;
  }

  // ── JSONL parsing ───────────────────────────────────────────────

  /**
   * Parse a JSONL file into an array of entry objects.
   */
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
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // ── Session discovery ───────────────────────────────────────────

  /**
   * Scan the sessions directory for all JSONL session files.
   * Returns array of { filePath, projectDir } where projectDir is null for loose sessions.
   */
  _discoverSessionFiles() {
    const results = [];

    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('-')) {
          // Project directory — scan for JSONL files inside
          const projDir = path.join(this.sessionsDir, entry.name);
          try {
            const files = fs.readdirSync(projDir);
            for (const f of files) {
              if (f.endsWith('.jsonl')) {
                results.push({ filePath: path.join(projDir, f), projectDir: entry.name });
              }
            }
          } catch (err) {
            console.warn(`[warn] ${this.name}: Cannot read project dir ${entry.name}: ${err.message}`);
          }
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          // Loose session file
          results.push({ filePath: path.join(this.sessionsDir, entry.name), projectDir: null });
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`[warn] ${this.name}: Sessions directory not found: ${this.sessionsDir}`);
        return [];
      }
      throw err;
    }

    return results;
  }

  /**
   * Read the session_start entry from a JSONL file.
   * Returns null if the file doesn't start with a session_start entry.
   */
  _readSessionStart(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const firstNewline = raw.indexOf('\n');
      const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
      if (!firstLine.trim()) return null;

      const entry = JSON.parse(firstLine);
      if (entry.type === 'session_start') return entry;
      return null;
    } catch {
      return null;
    }
  }

  // ── Activity detection ──────────────────────────────────────────

  /**
   * Read just the first line's timestamp from a JSONL file (fast — no full parse).
   */
  _readFirstTimestamp(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(1024);
      const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);
      const chunk = buf.toString('utf-8', 0, bytesRead);
      const firstLine = chunk.split('\n')[0];
      if (!firstLine) return null;
      const entry = JSON.parse(firstLine);
      // session_start entries may not have a timestamp, check second line
      if (entry.type === 'session_start' && !entry.timestamp) {
        const secondLine = chunk.split('\n')[1];
        if (secondLine) {
          try {
            const e2 = JSON.parse(secondLine);
            return e2.timestamp ? new Date(e2.timestamp) : null;
          } catch { /* skip */ }
        }
        return null;
      }
      return entry.timestamp ? new Date(entry.timestamp) : null;
    } catch {
      return null;
    }
  }

  /**
   * Fast activity check: use mtime + first-entry timestamp to narrow candidates,
   * then verify with a full parse only for plausible files.
   */
  async checkActivity(dateStr) {
    const range = getDateRange(dateStr);
    const sessionFiles = this._discoverSessionFiles();

    for (const { filePath } of sessionFiles) {
      try {
        const stat = fs.statSync(filePath);
        // File must have been modified on or after target date start
        if (stat.mtimeMs < range.start.getTime()) continue;

        // Quick heuristic: check first entry timestamp. If the session started
        // well after the target date, skip it (session can't have entries on target date).
        const firstTs = this._readFirstTimestamp(filePath);
        if (firstTs && firstTs >= range.end) continue;

        // Plausible candidate — verify with full entry scan
        const entries = this._parseJsonlFile(filePath);
        if (!entries) continue;

        for (const entry of entries) {
          if (entry.timestamp && isWithinDate(entry.timestamp, range)) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  // ── Session extraction ──────────────────────────────────────────

  async extractSessions(dateStr) {
    const range = getDateRange(dateStr);
    const sessionFiles = this._discoverSessionFiles();
    const sessions = [];

    for (const { filePath, projectDir } of sessionFiles) {
      try {
        const stat = fs.statSync(filePath);
        // Skip files that were last modified before target date
        if (new Date(stat.mtimeMs) < range.start) continue;

        const entries = this._parseJsonlFile(filePath);
        if (!entries || entries.length === 0) continue;

        // Check if any entry falls within the target date
        const hasActivity = entries.some(e => e.timestamp && isWithinDate(e.timestamp, range));
        if (!hasActivity) continue;

        // Read session_start for metadata
        const sessionStart = entries[0]?.type === 'session_start' ? entries[0] : null;

        // Sub-agent filter: skip sessions spawned by the Task tool or Factory's
        // decomposition system. Only filter when a session_start is present —
        // older files without it are kept to avoid false positives.
        if (sessionStart) {
          const filterResult = detectSubAgent('factory', sessionStart);
          if (filterResult.isSubAgent) {
            process.stderr.write(
              `[adapter:factory] skipped sub-agent session ${path.basename(filePath)} — ${filterResult.reason}\n`
            );
            continue;
          }
        }

        const sessionId = sessionStart?.id || path.basename(filePath, '.jsonl');

        // Determine project path
        let project = '(unknown)';
        if (sessionStart?.cwd) {
          project = sessionStart.cwd;
        } else if (projectDir) {
          project = FactoryAdapter.decodeProjectPath(projectDir);
        }

        // Find earliest timestamp within the target date
        let earliest = null;
        let latest = null;
        for (const entry of entries) {
          if (entry.timestamp && isWithinDate(entry.timestamp, range)) {
            const ts = new Date(entry.timestamp);
            if (!earliest || ts < earliest) earliest = ts;
            if (!latest || ts > latest) latest = ts;
          }
        }

        sessions.push(createSession({
          id: sessionId,
          agent: this.name,
          project,
          startTime: earliest || new Date(stat.mtimeMs),
          activityDate: dateStr,
          activityEndTime: latest || earliest || new Date(stat.mtimeMs),
          filePath,
          sessionKey: `${this.name}:${sessionId}`,
        }));
      } catch (err) {
        console.warn(`[warn] ${this.name}: Error processing ${path.basename(filePath)}: ${err.message}`);
      }
    }

    console.log(`[info] ${this.name}: ${sessions.length} session(s) found for ${dateStr}`);
    return sessions;
  }

  // ── Highlight extraction ────────────────────────────────────────

  /**
   * Extract text from user message content, stripping <system-reminder> blocks.
   * Factory user messages often start with a large <system-reminder> text block
   * containing system info and directory listings — not real user input.
   */
  static _extractUserText(content) {
    if (typeof content === 'string') {
      return FactoryAdapter._stripSystemReminder(content);
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text.trim())
        .filter(text => !text.startsWith('<system-reminder>'))
        .filter(Boolean);
      return textParts.join('\n');
    }
    return '';
  }

  /**
   * Strip <system-reminder>...</system-reminder> prefix from text content.
   */
  static _stripSystemReminder(text) {
    if (!text) return '';
    // Remove entire <system-reminder>...</system-reminder> block
    const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
    return stripped;
  }

  /**
   * Check whether a user message should be skipped.
   */
  static _shouldSkipUserMessage(text) {
    if (!text) return true;
    return (
      text.startsWith('<command-') ||
      text.startsWith('<bash-') ||
      text.startsWith('<local-command-') ||
      text.startsWith('/')
    );
  }

  /**
   * Extract tool_use data from assistant content blocks.
   * Same structure as Claude Code — Factory uses identical tool_use blocks.
   */
  static _extractToolData(entries) {
    const toolCounts = new Map();
    const filePaths = new Set();

    for (const entry of entries) {
      if (entry.type !== 'message') continue;
      if (entry.message?.role !== 'assistant' || !Array.isArray(entry.message?.content)) continue;

      for (const block of entry.message.content) {
        if (block.type !== 'tool_use') continue;

        const name = block.name || 'unknown';
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);

        const input = block.input || {};
        if (input.file_path) filePaths.add(input.file_path);
        if (input.path) filePaths.add(input.path);
      }
    }

    return { toolCounts, filePaths };
  }

  async extractHighlights(session) {
    // Find the session file on disk
    let sessionFilePath = null;

    // Try project-dir path first
    if (session.project && session.project !== '(unknown)') {
      const encoded = FactoryAdapter.encodeProjectPath(session.project);
      const candidate = path.join(this.sessionsDir, encoded, `${session.id}.jsonl`);
      if (fs.existsSync(candidate)) {
        sessionFilePath = candidate;
      }
    }

    // Try loose session
    if (!sessionFilePath) {
      const candidate = path.join(this.sessionsDir, `${session.id}.jsonl`);
      if (fs.existsSync(candidate)) {
        sessionFilePath = candidate;
      }
    }

    // Search all project dirs as fallback
    if (!sessionFilePath) {
      const allFiles = this._discoverSessionFiles();
      const match = allFiles.find(f => path.basename(f.filePath, '.jsonl') === session.id);
      if (match) sessionFilePath = match.filePath;
    }

    if (!sessionFilePath) {
      console.warn(`[warn] ${this.name}: Session file not found for ${session.id.slice(0, 8)}… — returning empty highlights`);
      return createHighlights();
    }

    const entries = this._parseJsonlFile(sessionFilePath);
    if (!entries) {
      return createHighlights();
    }

    // Filter to message entries
    const messages = entries.filter(e => e.type === 'message');

    // Extract user messages (stripping system-reminder)
    const userMessages = [];
    for (const entry of messages) {
      if (entry.message?.role !== 'user') continue;
      const text = FactoryAdapter._extractUserText(entry.message.content);
      if (FactoryAdapter._shouldSkipUserMessage(text)) continue;
      userMessages.push(text);
    }

    const topic = userMessages[0] || '(no topic detected)';
    const lastExchanges = userMessages.slice(-5);

    // Tool data
    const { toolCounts, filePaths } = FactoryAdapter._extractToolData(messages);

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

module.exports = { FactoryAdapter };
