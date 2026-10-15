const fs = require('fs');
const path = require('path');
const { AgentAdapter } = require('./base');
const { createSession, createHighlights } = require('../types');
const { getDateRange, isWithinDate } = require('../utils/date');
const config = require('../config');
const { detectSubAgent } = require('./sub-agent-filter');

/**
 * Claude Code adapter.
 * Phase 1: history.jsonl for activity detection + session grouping.
 * Phase 2: per-session JSONL parsing for highlight extraction.
 */
class ClaudeCodeAdapter extends AgentAdapter {
  constructor(agentConfig = config.agents.claudeCode) {
    super(agentConfig.name);
    this.agentConfig = agentConfig;
    this.storagePath = agentConfig.storagePath;
    this.historyFile = path.join(this.storagePath, agentConfig.historyFile);
    this.projectsDir = path.join(this.storagePath, agentConfig.projectsDir);
  }

  _isStorageAvailable() {
    return !!this.storagePath && fs.existsSync(this.storagePath);
  }

  // ── History parsing ─────────────────────────────────────────────

  /**
   * Read and parse history.jsonl. Returns all entries.
   */
  _readHistory() {
    if (!this._isStorageAvailable()) return [];
    try {
      const raw = fs.readFileSync(this.historyFile, 'utf-8');
      return raw.split('\n').filter(Boolean).map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          console.warn(`[warn] Malformed JSON at history.jsonl line ${i + 1}, skipping`);
          return null;
        }
      }).filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Filter history entries to a target date, excluding slash commands.
   */
  _filterHistory(entries, dateStr) {
    const range = getDateRange(dateStr);
    return entries.filter(entry => {
      if (!isWithinDate(entry.timestamp, range)) return false;
      return true;
    });
  }

  // ── Path encoding ───────────────────────────────────────────────

  /**
   * Encode a project filesystem path to the directory name Claude Code uses.
   * Algorithm: `:\` or `:/` at pos 1-2 → `--`, then `\` `/` `.` ` ` → `-`
   */
  static encodeProjectPath(projectPath) {
    let encoded = projectPath;
    // Replace drive separator (e.g. `C:\` or `C:/`) with `C--`
    encoded = encoded.replace(/^([A-Za-z]):[\\\/]/, '$1--');
    // Replace remaining separators and dots/spaces with `-`
    encoded = encoded.replace(/[\\\/. ]/g, '-');
    return encoded;
  }

  _getExactSessionFile(sessionId, projectPath) {
    const encodedProject = ClaudeCodeAdapter.encodeProjectPath(projectPath);
    const projectDir = path.join(this.projectsDir, encodedProject);
    return {
      filePath: path.join(projectDir, `${sessionId}.jsonl`),
      projectDir,
      encodedProject,
    };
  }

  _findSessionFilesById(sessionId) {
    const targetFile = `${sessionId}.jsonl`;
    const matches = [];

    if (!fs.existsSync(this.projectsDir)) return matches;

    const stack = [this.projectsDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        console.warn(`[warn] Could not scan Claude projects directory ${dir}: ${err.message}`);
        continue;
      }

      entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(entry => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'subagents') return; // skip sub-agent directories
            stack.push(fullPath);
          } else if (entry.isFile() && entry.name === targetFile) {
            matches.push(fullPath);
          }
        });
    }

    return matches.sort((a, b) => a.localeCompare(b));
  }

  _resolveSessionFile(sessionId, projectPath) {
    const exact = this._getExactSessionFile(sessionId, projectPath);
    if (fs.existsSync(exact.filePath)) {
      return { ...exact, usedFallback: false, matches: [exact.filePath] };
    }

    const matches = this._findSessionFilesById(sessionId);
    if (matches.length === 0) {
      return { ...exact, usedFallback: false, matches: [] };
    }

    const chosen = matches[0];
    const prefix = sessionId.slice(0, 8);
    if (matches.length === 1) {
      console.warn(
        `[warn] Session file path mismatch for session ${prefix}…: ` +
        `expected ${exact.filePath}; using fallback ${chosen}`
      );
    } else {
      console.warn(
        `[warn] Multiple Claude session files found for session ${prefix}…; ` +
        `expected ${exact.filePath}; using ${chosen}; candidates: ${matches.join(', ')}`
      );
    }

    return {
      filePath: chosen,
      projectDir: path.dirname(chosen),
      encodedProject: path.basename(path.dirname(chosen)),
      usedFallback: true,
      matches,
    };
  }

  // ── Activity detection ──────────────────────────────────────────

  async checkActivity(dateStr) {
    const entries = this._readHistory();
    const filtered = this._filterHistory(entries, dateStr);
    return filtered.length > 0;
  }

  // ── Session extraction ──────────────────────────────────────────

  async extractSessions(dateStr) {
    const entries = this._readHistory();
    const filtered = this._filterHistory(entries, dateStr);

    if (filtered.length === 0) return [];

    // Group by sessionId
    const sessionMap = new Map();
    for (const entry of filtered) {
      const sid = entry.sessionId;
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, { entries: [], project: entry.project, earliest: entry.timestamp });
      }
      const group = sessionMap.get(sid);
      group.entries.push(entry);
      if (entry.timestamp < group.earliest) group.earliest = entry.timestamp;
    }

    const sessions = [];
    for (const [sid, group] of sessionMap) {
      const resolved = this._resolveSessionFile(sid, group.project);
      if (resolved.matches.length === 0) {
        console.warn(`[warn] Session file not found: ${resolved.filePath} (session ${sid.slice(0, 8)}…)`);
      }

      sessions.push(createSession({
        id: sid,
        agent: this.name,
        project: group.project,
        startTime: new Date(group.earliest),
        activityDate: dateStr,
        activityEndTime: new Date(Math.max(...group.entries.map(entry => Number(entry.timestamp)).filter(Number.isFinite))),
        filePath: resolved.filePath,
        sessionKey: `${this.name}:${sid}`,
      }));
    }

    console.log(`[info] ${this.name}: ${sessions.length} session(s) found for ${dateStr}`);
    return sessions;
  }

  // ── Highlight extraction ────────────────────────────────────────

  /**
   * Parse a JSONL file into an array of entry objects.
   */
  _parseJsonlFile(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return raw.split('\n').filter(Boolean).map((line, i) => {
        const lineNo = i + 1;
        if (line.includes('\u0000')) {
          console.warn(`[warn] Null-containing JSONL line at ${filePath}:${lineNo}, skipping`);
          return null;
        }

        try {
          const parsed = JSON.parse(line);
          if (parsed === null) {
            console.warn(`[warn] Null JSONL entry at ${filePath}:${lineNo}, skipping`);
            return null;
          }
          return parsed;
        } catch {
          console.warn(`[warn] Malformed JSON at ${filePath}:${lineNo}, skipping`);
          return null;
        }
      }).filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return null; // caller handles
      throw err;
    }
  }

  /**
   * Extract text from user message content (handles string and array formats).
   * Returns empty string for arrays with no text blocks (e.g. pure tool_result entries).
   */
  static _extractUserText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text.trim())
        .filter(Boolean);
      return textParts.join('\n');
    }
    return '';
  }

  /**
   * Check whether a user message should be skipped (commands, system noise).
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
   * Detect user inputs that are technically conversational text but do not
   * represent a real task for journaling purposes.
   */
  static _isTrivialUserMessage(text) {
    if (!text) return true;

    const normalized = text.trim().toLowerCase();
    return (
      /^(hi|hello|hey|yo|sup|hiya|howdy)[!.?]*$/.test(normalized) ||
      /^(you|u)[!.?]*$/.test(normalized) ||
      /^you are generation \d+ of a vyrn relay chain [a-z0-9_-]+[.]?$/.test(normalized)
    );
  }

  /**
   * Extract tool_use data from assistant content blocks.
   * Returns { toolCounts: Map<name, count>, filePaths: Set<string> }
   */
  static _extractToolData(entries) {
    const toolCounts = new Map();
    const filePaths = new Set();

    for (const entry of entries) {
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;

      for (const block of entry.message.content) {
        if (block.type !== 'tool_use') continue;

        const name = block.name || 'unknown';
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);

        // Extract file paths from tool input
        const input = block.input || {};
        if (input.file_path) filePaths.add(input.file_path);
        if (input.path) filePaths.add(input.path);
        if (typeof input.command === 'string') {
          // Extract file paths from command strings — look for common patterns
          // but don't over-parse; just capture the command itself as context
        }
      }
    }

    return { toolCounts, filePaths };
  }

  /**
   * Scan for subagent JSONL files under a session directory.
   */
  _getSubagentFiles(sessionId, encodedProject) {
    const projectDir = path.isAbsolute(encodedProject)
      ? encodedProject
      : path.join(this.projectsDir, encodedProject);
    const subagentDir = path.join(projectDir, sessionId, 'subagents');
    try {
      const files = fs.readdirSync(subagentDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(subagentDir, f));
    } catch {
      // No subagent directory — normal case
      return [];
    }
  }

  async extractHighlights(session) {
    const resolved = session.filePath
      ? {
          filePath: session.filePath,
          projectDir: path.dirname(session.filePath),
          encodedProject: path.basename(path.dirname(session.filePath)),
        }
      : this._resolveSessionFile(session.id, session.project);

    // Parse main session file
    const entries = this._parseJsonlFile(resolved.filePath);
    if (!entries) {
      console.warn(`[warn] Session file not found: ${resolved.filePath} — returning empty highlights`);
      return createHighlights();
    }

    // Defense-in-depth: if the first entry marks this as a sidechain/sub-agent
    // file (e.g. isSidechain:true), bail out immediately with empty highlights.
    if (entries.length > 0) {
      const sideChainCheck = detectSubAgent('claude-code', entries[0]);
      if (sideChainCheck.isSubAgent) {
        console.warn(
          `[warn] Session ${session.id.slice(0, 8)}… is a sub-agent file (${sideChainCheck.reason}) — returning empty highlights`
        );
        return createHighlights();
      }
    }

    // Known non-conversation entry types to silently skip
    const SKIP_TYPES = new Set([
      'system', 'queue-operation', 'file-history-snapshot',
      'progress', 'last-prompt',
    ]);

    // Filter to relevant entry types
    const relevant = entries.filter(entry => {
      // Drop any sidechain entries that may have leaked into a mixed file
      if (entry.isSidechain === true) return false;
      const type = entry.type;
      if (SKIP_TYPES.has(type)) return false;
      // Keep user and assistant
      if (type === 'user' || type === 'assistant') return true;
      // Log truly unrecognized types (once per type per session)
      console.warn(`[warn] Unrecognized entry type: "${type}" in session ${session.id.slice(0, 8)}…`);
      return false;
    });

    // Extract user messages
    const userMessages = [];
    for (const entry of relevant) {
      if (entry.type !== 'user') continue;
      const text = ClaudeCodeAdapter._extractUserText(entry.message?.content);
      if (ClaudeCodeAdapter._shouldSkipUserMessage(text)) continue;
      if (ClaudeCodeAdapter._isTrivialUserMessage(text)) continue;
      userMessages.push(text);
    }

    // Topic = first real substantive user message
    const topic = userMessages[0] || '';

    // Last 3-5 exchanges for context
    const lastExchanges = userMessages.slice(-5);

    // Tool data from main session
    const { toolCounts, filePaths } = ClaudeCodeAdapter._extractToolData(relevant);

    // Include subagent data
    const subagentFiles = this._getSubagentFiles(session.id, resolved.projectDir);
    if (subagentFiles.length > 0) {
      console.log(`[info] Session ${session.id.slice(0, 8)}…: ${subagentFiles.length} subagent file(s)`);
    }
    for (const subFile of subagentFiles) {
      const subEntries = this._parseJsonlFile(subFile);
      if (!subEntries) continue;
      const subRelevant = subEntries.filter(e => e.type === 'user' || e.type === 'assistant');
      const { toolCounts: subTools, filePaths: subPaths } = ClaudeCodeAdapter._extractToolData(subRelevant);
      for (const [name, count] of subTools) {
        toolCounts.set(name, (toolCounts.get(name) || 0) + count);
      }
      for (const fp of subPaths) {
        filePaths.add(fp);
      }
    }

    // Format tool calls as sorted array
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

module.exports = { ClaudeCodeAdapter };
