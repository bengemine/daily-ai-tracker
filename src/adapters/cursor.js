const fs = require('fs');
const path = require('path');
const { AgentAdapter } = require('./base');
const { createSession, createHighlights } = require('../types');
const { getDateRange } = require('../utils/date');
const { openDatabase } = require('../utils/sqlite');
const config = require('../config');

/**
 * Cursor adapter.
 * Most complex adapter — multi-layer key lookups across a 4.6 GB state.vscdb.
 * 
 * Activity check: single ItemTable key lookup (dailyStats).
 * Session extraction: scan workspace directories for composerData, filter by date.
 * Highlight extraction: targeted cursorDiskKV lookups — composerData:<id> for headers,
 *   then bubbleId:<composerId>:<bubbleId> for individual messages.
 * 
 * Critical constraint: never scan the 152K-row cursorDiskKV table.
 */
class CursorAdapter extends AgentAdapter {
  constructor() {
    super(config.agents.cursor.name);
    const agentConfig = config.agents.cursor;
    this.globalDbPath = agentConfig.globalDbPath;
    this.workspaceStoragePath = agentConfig.workspaceStoragePath;
  }

  // ── Activity detection ──────────────────────────────────────────

  /**
   * Single key lookup on ItemTable — cheapest possible check.
   * Key format: aiCodeTracking.dailyStats.v1.5.YYYY-MM-DD
   */
  async checkActivity(dateStr) {
    const db = openDatabase(this.globalDbPath);
    if (!db) return false;

    try {
      const key = `aiCodeTracking.dailyStats.v1.5.${dateStr}`;
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
      return !!row;
    } finally {
      db.close();
    }
  }

  // ── Session extraction ──────────────────────────────────────────

  /**
   * Scan all workspace directories for composer sessions active on the target date.
   * Each workspace has its own state.vscdb with composer.composerData in ItemTable.
   */
  async extractSessions(dateStr) {
    const { start, end } = getDateRange(dateStr);
    const startMs = start.getTime();
    const endMs = end.getTime();

    let workspaceDirs;
    try {
      workspaceDirs = fs.readdirSync(this.workspaceStoragePath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`[warn] ${this.name}: Workspace storage not found: ${this.workspaceStoragePath}`);
        return [];
      }
      throw err;
    }

    const sessions = [];

    for (const wsHash of workspaceDirs) {
      const wsDbPath = path.join(this.workspaceStoragePath, wsHash, 'state.vscdb');
      const db = openDatabase(wsDbPath);
      if (!db) continue;

      try {
        const composerRow = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
        ).get();
        if (!composerRow) continue;

        let composerData;
        try {
          composerData = JSON.parse(composerRow.value);
        } catch {
          console.warn(`[warn] ${this.name}: Malformed composerData JSON in workspace ${wsHash}`);
          continue;
        }

        const allComposers = composerData.allComposers || [];
        if (allComposers.length === 0) continue;

        // Get project path from workspace.json
        const project = this._getProjectPath(wsHash);

        // Filter composers by date range — use lastUpdatedAt or fall back to createdAt
        for (const composer of allComposers) {
          const ts = composer.lastUpdatedAt || composer.createdAt;
          if (typeof ts !== 'number' || ts <= 0) continue;
          if (ts < startMs || ts >= endMs) continue;

          sessions.push(createSession({
            id: composer.composerId,
            agent: this.name,
            project,
            startTime: new Date(composer.createdAt || ts),
            activityDate: dateStr,
            name: composer.name || '',
          }));
        }
      } catch (err) {
        console.warn(`[warn] ${this.name}: Error reading workspace ${wsHash}: ${err.message}`);
      } finally {
        db.close();
      }
    }

    console.log(`[info] ${this.name}: ${sessions.length} session(s) found for ${dateStr}`);
    return sessions;
  }

  /**
   * Read project path from workspace.json in a workspace directory.
   * workspace.json has either { folder: "file:///..." } or { workspace: "file:///..." }.
   */
  _getProjectPath(wsHash) {
    const wsJsonPath = path.join(this.workspaceStoragePath, wsHash, 'workspace.json');
    try {
      const data = JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8'));
      const uri = data.folder || data.workspace || '';
      return this._decodeFileUri(uri);
    } catch {
      return `(workspace:${wsHash.slice(0, 8)})`;
    }
  }

  /**
   * Decode a file:// URI to a filesystem path.
   * e.g. "file:///e%3A/projects/demo-app" → "E:\projects\demo-app"
   */
  _decodeFileUri(uri) {
    if (!uri) return '(unknown)';
    // Strip file:/// prefix
    let decoded = uri.replace(/^file:\/\/\//, '');
    // URL-decode
    decoded = decodeURIComponent(decoded);
    // Convert forward slashes to backslashes on Windows
    if (process.platform === 'win32') {
      decoded = decoded.replace(/\//g, '\\');
    }
    // Strip .code-workspace suffix if present
    decoded = decoded.replace(/\.code-workspace$/, '');
    return decoded || '(unknown)';
  }

  // ── Highlight extraction ────────────────────────────────────────

  /**
   * Extract highlights from a Cursor composer session.
   * Two-layer lookup in global state.vscdb:
   * 1. composerData:<composerId> → fullConversationHeadersOnly (bubble IDs + types)
   * 2. bubbleId:<composerId>:<bubbleId> → individual messages
   */
  async extractHighlights(session) {
    const db = openDatabase(this.globalDbPath);
    if (!db) return createHighlights();

    try {
      return this._extractHighlightsFromDb(db, session);
    } finally {
      db.close();
    }
  }

  /**
   * Extract text content from a Lexical richText JSON string.
   * Returns empty string if no text nodes found or parsing fails.
   */
  static _extractRichText(richTextStr) {
    if (!richTextStr || typeof richTextStr !== 'string') return '';
    try {
      const rt = JSON.parse(richTextStr);
      const texts = [];
      const walk = (node) => {
        if (node.type === 'text' && typeof node.text === 'string' && node.text.trim()) {
          texts.push(node.text.trim());
        }
        if (Array.isArray(node.children)) {
          for (const child of node.children) walk(child);
        }
      };
      walk(rt.root || rt);
      return texts.join(' ');
    } catch {
      return '';
    }
  }

  _extractHighlightsFromDb(db, session) {
    const composerId = session.id;

    // Layer 1: get conversation headers
    const cdRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${composerId}`);

    if (!cdRow) {
      // Composer might not have bubbles in global DB yet — use session name as fallback
      if (session.name) {
        return createHighlights({ topic: session.name });
      }
      return createHighlights();
    }

    let cdData;
    let headers;
    try {
      cdData = JSON.parse(cdRow.value);
      headers = cdData.fullConversationHeadersOnly || [];
    } catch {
      console.warn(`[warn] ${this.name}: Malformed composerData JSON for ${composerId.slice(0, 8)}…`);
      return createHighlights();
    }

    // Layer 2: fetch individual bubbles by targeted key lookups
    const userMessages = [];
    const conversation = []; // interleaved user + assistant for full context
    const toolCounts = new Map();

    for (const header of headers) {
      const bubbleKey = `bubbleId:${composerId}:${header.bubbleId}`;
      const bbRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(bubbleKey);
      if (!bbRow) continue;

      let bubble;
      try {
        bubble = JSON.parse(bbRow.value);
      } catch {
        continue;
      }

      if (header.type === 1) {
        // User bubble — try text first, fall back to richText
        let text = (bubble.text || '').trim();
        if (!text) {
          text = CursorAdapter._extractRichText(bubble.richText);
        }
        if (text) {
          userMessages.push(text);
          conversation.push(`User: ${text}`);
        }
      } else if (header.type === 2) {
        // Assistant bubble — extract response text and tool results
        const text = (bubble.text || '').trim();
        if (text) {
          conversation.push(`Assistant: ${text}`);
        }
        const toolResults = bubble.toolResults || [];
        for (const tr of toolResults) {
          const toolName = tr.toolName || tr.name || 'unknown_tool';
          toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
        }
      }
    }

    // Fallback topic: composer name from cursorDiskKV, then session name from workspace DB
    const composerName = cdData.name || session.name || '';
    const topic = userMessages[0] || composerName;

    // Use the full conversation (user + assistant) as lastExchanges so the
    // summarizer sees what was actually discussed and accomplished.
    const lastExchanges = conversation.slice(-10);
    const toolCalls = [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return createHighlights({
      topic,
      userMessages,
      toolCalls,
      filePaths: [],
      lastExchanges,
    });
  }
}

module.exports = { CursorAdapter };
