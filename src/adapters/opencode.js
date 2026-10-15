const { AgentAdapter } = require('./base');
const { createSession, createHighlights } = require('../types');
const { getDateRange } = require('../utils/date');
const { openDatabase } = require('../utils/sqlite');
const config = require('../config');
const { detectSubAgent } = require('./sub-agent-filter');
const { normalizeWhitespace } = require('../trimmer');

/**
 * OpenCode adapter.
 * SQLite-based — queries session/message/part/project tables in opencode.db.
 * All timestamps are millisecond epoch, compatible with getDateRange.
 */
class OpenCodeAdapter extends AgentAdapter {
  constructor() {
    super(config.agents.openCode.name);
    this.dbPath = config.agents.openCode.dbPath;
  }

  /**
   * Open the database. Returns null if missing.
   * Callers must close the returned db when done.
   */
  _openDb() {
    return openDatabase(this.dbPath);
  }

  _hasTable(db, tableName) {
    try {
      return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    } catch {
      return false;
    }
  }

  // ── Activity detection ──────────────────────────────────────────

  async checkActivity(dateStr) {
    const { start, end } = getDateRange(dateStr);
    const db = this._openDb();
    if (!db) return false;

    try {
      const row = this._hasTable(db, 'message')
        ? db.prepare('SELECT session_id AS id FROM message WHERE time_created >= ? AND time_created < ? LIMIT 1')
          .get(start.getTime(), end.getTime())
        : db.prepare('SELECT id FROM session WHERE time_updated >= ? AND time_updated < ? LIMIT 1')
          .get(start.getTime(), end.getTime());
      return !!row;
    } finally {
      db.close();
    }
  }

  // ── Schema introspection ────────────────────────────────────────

  /**
   * Check whether the session table has a parent_id or parentID column.
   * Returns the exact column name string if found, null otherwise.
   * Uses PRAGMA table_info which is safe on read-only connections.
   */
  _getParentIdColumn(db) {
    try {
      const cols = db.prepare('PRAGMA table_info(session)').all();
      for (const col of cols) {
        const name = col.name || '';
        if (name === 'parent_id' || name === 'parentID') return name;
      }
    } catch {
      // PRAGMA failed — assume no column
    }
    return null;
  }

  // ── Session extraction ──────────────────────────────────────────

  async extractSessions(dateStr) {
    const { start, end } = getDateRange(dateStr);
    const db = this._openDb();
    if (!db) return [];

    try {
      // Check once whether the session table carries a parent_id / parentID column.
      // If it does, use a WHERE clause to pre-filter sub-agent sessions (efficient),
      // then still run detectSubAgent() on each row as defense-in-depth.
      const parentCol = this._getParentIdColumn(db);

      const parentFilter = parentCol ? `AND s.${parentCol} IS NULL` : '';
      const hasMessages = this._hasTable(db, 'message');

      const rows = hasMessages
        ? db.prepare(`
            SELECT s.id, s.title, s.time_created, p.worktree,
                   MIN(m.time_created) AS _activity_start,
                   MAX(m.time_created) AS _activity_end
                   ${parentCol ? `, s.${parentCol} AS _parentID` : ''}
            FROM session s
            JOIN message m ON m.session_id = s.id
            LEFT JOIN project p ON s.project_id = p.id
            WHERE m.time_created >= ? AND m.time_created < ?
            ${parentFilter}
            GROUP BY s.id, s.title, s.time_created, p.worktree${parentCol ? `, s.${parentCol}` : ''}
            ORDER BY _activity_start ASC
          `).all(start.getTime(), end.getTime())
        : db.prepare(`
            SELECT s.id, s.title, s.time_created, p.worktree,
                   s.time_updated AS _activity_start,
                   s.time_updated AS _activity_end
                   ${parentCol ? `, s.${parentCol} AS _parentID` : ''}
            FROM session s
            LEFT JOIN project p ON s.project_id = p.id
            WHERE s.time_updated >= ? AND s.time_updated < ?
            ${parentFilter}
            ORDER BY s.time_created ASC
          `).all(start.getTime(), end.getTime());

      const sessions = [];
      for (const row of rows) {
        // Defense-in-depth: detectSubAgent on every returned row.
        // Build a minimal meta object that mirrors the parentID field name the
        // filter knows about, regardless of the actual column name in the DB.
        const rowMeta = { parentID: row._parentID ?? null };
        const filterResult = detectSubAgent('opencode', rowMeta);
        if (filterResult.isSubAgent) {
          process.stderr.write(
            `[adapter:opencode] skipped sub-agent session ${row.id} — ${filterResult.reason}\n`
          );
          continue;
        }

        sessions.push(createSession({
          id: row.id,
          agent: this.name,
          project: row.worktree || '(unknown)',
          startTime: new Date(row._activity_start || row.time_created),
          activityDate: dateStr,
          activityEndTime: new Date(row._activity_end || row._activity_start || row.time_created),
          sessionKey: `${this.name}:${row.id}`,
        }));
      }

      console.log(`[info] ${this.name}: ${sessions.length} session(s) found for ${dateStr}`);
      return sessions;
    } finally {
      db.close();
    }
  }

  async extractCleanTurns(session, dateStr = session.activityDate) {
    const db = this._openDb();
    if (!db) return { messages: [], warnings: ['OpenCode database unavailable'], stats: {} };
    const warnings = [];
    const messages = [];
    const droppedCounts = {};
    try {
      if (!this._hasTable(db, 'message') || !this._hasTable(db, 'part')) {
        warnings.push('OpenCode message-level tables unavailable; daily dialogue cannot be proven');
        return { messages, warnings, stats: { droppedCounts } };
      }
      const { start, end } = getDateRange(dateStr);
      const rows = db.prepare(
        'SELECT id, data, time_created FROM message WHERE session_id = ? AND time_created >= ? AND time_created < ? ORDER BY time_created ASC'
      ).all(session.id, start.getTime(), end.getTime());

      for (const row of rows) {
        let data;
        try { data = JSON.parse(row.data); } catch {
          droppedCounts._bad_json = (droppedCounts._bad_json || 0) + 1;
          continue;
        }
        if (data.role !== 'user' && data.role !== 'assistant') continue;
        const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC').all(row.id);
        const text = normalizeWhitespace(parts.map(part => {
          const parsed = this._safeParsePart(part.data);
          if (!parsed || parsed.type !== 'text' || typeof parsed.text !== 'string') {
            if (parsed?.type) droppedCounts[parsed.type] = (droppedCounts[parsed.type] || 0) + 1;
            return '';
          }
          return parsed.text;
        }).filter(Boolean).join('\n'));
        if (!text || (data.role === 'user' && this._shouldSkip(text))) continue;
        messages.push({
          role: data.role,
          content: text,
          timestamp: new Date(row.time_created).toISOString(),
        });
      }
      return { messages, warnings, stats: { droppedCounts } };
    } finally {
      db.close();
    }
  }

  // ── Highlight extraction ────────────────────────────────────────

  async extractHighlights(session) {
    const db = this._openDb();
    if (!db) return createHighlights();

    try {
      return this._extractHighlightsFromDb(db, session);
    } finally {
      db.close();
    }
  }

  _extractHighlightsFromDb(db, session) {
    // Get all messages for this session
    const messages = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC'
    ).all(session.id);

    const userMessages = [];
    const toolCounts = new Map();
    const filePaths = new Set();

    for (const msg of messages) {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        console.warn(`[warn] ${this.name}: Malformed message JSON for ${msg.id}`);
        continue;
      }

      // Get parts for this message
      const parts = db.prepare(
        'SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC'
      ).all(msg.id);

      if (data.role === 'user') {
        // Extract user text from text-type parts
        const texts = [];
        for (const part of parts) {
          const pd = this._safeParsePart(part.data);
          if (!pd) continue;
          if (pd.type === 'text' && pd.text) {
            texts.push(pd.text.trim());
          }
        }
        const combined = texts.join('\n').trim();
        if (combined && !this._shouldSkip(combined)) {
          userMessages.push(combined);
        }
      }

      if (data.role === 'assistant') {
        // Extract tool calls and file paths from assistant parts
        for (const part of parts) {
          const pd = this._safeParsePart(part.data);
          if (!pd) continue;

          if (pd.type === 'tool' && pd.tool) {
            toolCounts.set(pd.tool, (toolCounts.get(pd.tool) || 0) + 1);
            // Extract file paths from tool input
            const input = pd.state?.input;
            if (input) {
              if (input.filePath) filePaths.add(input.filePath);
              if (input.path) filePaths.add(input.path);
            }
          }

          if (pd.type === 'patch' && Array.isArray(pd.files)) {
            for (const fp of pd.files) {
              if (typeof fp === 'string') filePaths.add(fp);
            }
          }
        }
      }
    }

    const topic = userMessages[0] || '(no topic detected)';
    const lastExchanges = userMessages.slice(-5);
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

  _safeParsePart(dataStr) {
    try {
      return JSON.parse(dataStr);
    } catch {
      return null;
    }
  }

  _shouldSkip(text) {
    if (!text) return true;
    return (
      text.startsWith('/') ||
      text.startsWith('<command-') ||
      text.startsWith('<bash-')
    );
  }
}

module.exports = { OpenCodeAdapter };
