const fs = require('fs');
const path = require('path');
const { AgentAdapter } = require('./base');
const { createSession } = require('../types');
const { getDateRange, isWithinDate } = require('../utils/date');
const { parse: parseGrokTranscript } = require('../trimmer/adapters/grok');
const { highlightsFromTurns, hasVisibleUserTurn } = require('../daily-transcript');
const config = require('../config');

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(err.code)) return [];
    throw err;
  }
}

class GrokAdapter extends AgentAdapter {
  constructor(agentConfig = config.agents.grok) {
    super(agentConfig.name);
    this.storagePath = agentConfig.storagePath;
    this.sessionsDir = path.join(this.storagePath, agentConfig.sessionsDir || 'sessions');
    this._dailySessionCache = new Map();
  }

  _discoverSessions() {
    const sessions = [];
    let projects;
    try {
      projects = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch (err) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(err.code)) return sessions;
      throw err;
    }

    for (const projectEntry of projects) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = path.join(this.sessionsDir, projectEntry.name);
      let sessionEntries;
      try {
        sessionEntries = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory()) continue;
        const sessionDir = path.join(projectDir, sessionEntry.name);
        if (!fs.existsSync(path.join(sessionDir, 'events.jsonl')) ||
            !fs.existsSync(path.join(sessionDir, 'chat_history.jsonl'))) continue;
        let project = projectEntry.name;
        try { project = decodeURIComponent(projectEntry.name); } catch { /* keep encoded path */ }
        let summary = {};
        try { summary = JSON.parse(fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf8')); } catch { /* optional */ }
        sessions.push({
          id: sessionEntry.name,
          project,
          sessionDir,
          createdAt: summary.created_at,
          updatedAt: summary.last_active_at || summary.updated_at,
        });
      }
    }
    return sessions;
  }

  _dailyVisibleActivity(candidate, dateStr) {
    const range = getDateRange(dateStr);
    const createdAt = candidate.createdAt ? Date.parse(candidate.createdAt) : NaN;
    const updatedAt = candidate.updatedAt ? Date.parse(candidate.updatedAt) : NaN;
    if (Number.isFinite(createdAt) && createdAt >= range.end.getTime()) return [];
    if (Number.isFinite(updatedAt) && updatedAt < range.start.getTime()) return [];
    const events = readJsonLines(path.join(candidate.sessionDir, 'events.jsonl'));
    const history = readJsonLines(path.join(candidate.sessionDir, 'chat_history.jsonl'));
    const realPromptIndexes = new Set(history
      .filter(row => row.type === 'user' && Number.isInteger(row.prompt_index) && !row.synthetic_reason)
      .map(row => row.prompt_index));

    return events
      .filter(event => event.type === 'turn_started' &&
        (!event.session_relationship || event.session_relationship === 'primary') &&
        realPromptIndexes.has(event.turn_number) &&
        event.ts && isWithinDate(event.ts, range))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }

  async checkActivity(dateStr) {
    return (await this.extractSessions(dateStr)).length > 0;
  }

  async extractSessions(dateStr) {
    if (this._dailySessionCache.has(dateStr)) return this._dailySessionCache.get(dateStr).slice();
    const sessions = [];
    for (const candidate of this._discoverSessions()) {
      const activity = this._dailyVisibleActivity(candidate, dateStr);
      if (activity.length === 0) continue;
      sessions.push(createSession({
        id: candidate.id,
        agent: this.name,
        project: candidate.project,
        startTime: new Date(activity[0].ts),
        activityDate: dateStr,
        activityEndTime: new Date(activity[activity.length - 1].ts),
        filePath: candidate.sessionDir,
        sessionKey: `${this.name}:${candidate.id}`,
      }));
    }
    console.log(`[info] ${this.name}: ${sessions.length} session(s) found for ${dateStr}`);
    this._dailySessionCache.set(dateStr, sessions);
    return sessions;
  }

  async extractHighlights(session) {
    const result = await parseGrokTranscript(session.filePath, {
      targetDate: session.activityDate,
      includeTimestamps: true,
    });
    if (!hasVisibleUserTurn(result.messages)) return highlightsFromTurns([]);
    return highlightsFromTurns(result.messages);
  }
}

module.exports = { GrokAdapter, readJsonLines };
