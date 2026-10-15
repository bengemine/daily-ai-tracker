/**
 * AgentAdapter base class — the contract S02 adapters must implement.
 * Three methods: checkActivity, extractSessions, extractHighlights.
 */
class AgentAdapter {
  /**
   * @param {string} name - Human-readable agent name (e.g. "Claude Code")
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * Check whether this agent had any real activity on the given date.
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {Promise<boolean>}
   */
  async checkActivity(dateStr) {
    throw new Error(`${this.name}: checkActivity() not implemented`);
  }

  /**
   * Extract sessions for the given date.
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {Promise<import('../types').Session[]>}
   */
  async extractSessions(dateStr) {
    throw new Error(`${this.name}: extractSessions() not implemented`);
  }

  /**
   * Extract highlights from a single session.
   * @param {import('../types').Session} session
   * @returns {Promise<import('../types').Highlights>}
   */
  async extractHighlights(session) {
    throw new Error(`${this.name}: extractHighlights() not implemented`);
  }
}

module.exports = { AgentAdapter };
