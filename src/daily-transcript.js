const { createHighlights } = require('./types');
const { getDateRange, isWithinDate } = require('./utils/date');

function filterTurnsForDate(turns, dateStr) {
  if (!dateStr) return normalizeVisibleTurns(turns);
  const range = getDateRange(dateStr);
  return normalizeVisibleTurns((Array.isArray(turns) ? turns : []).filter(turn => {
    if (!turn || !turn.timestamp) return false;
    return isWithinDate(turn.timestamp, range);
  }));
}

function cleanVisibleContent(role, value) {
  let content = typeof value === 'string' ? value.trim() : '';
  if (!content) return '';

  if (role === 'user') {
    const commandName = content.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1]?.trim() || '';
    const commandArgs = content.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1]?.trim() || '';
    // Claude records these harness-generated events with role=user even though
    // the human did not type them. They are transport noise, not dialogue.
    if (/^<task-notification\b/i.test(content) ||
        /^<teammate-message\b/i.test(content) ||
        /^<local-command-(?:stdout|stderr)\b/i.test(content) ||
        /^<bash-(?:stdout|stderr)\b/i.test(content) ||
        /^Another Claude session sent a message:/i.test(content)) {
      return '';
    }

    // Older clean artifacts may have merged a real user turn and later
    // injected events into one string. Remove those embedded event blocks too.
    content = content
      .replace(/<task-notification\b[\s\S]*?<\/task-notification>/gi, ' ')
      .replace(/Another Claude session sent a message:\s*/gi, ' ')
      .replace(/<teammate-message\b[\s\S]*?<\/teammate-message>/gi, ' ')
      .replace(/This came from another Claude session[^\n]*(?=\n|$)/gi, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Slash commands may be prefixed as XML metadata before real user text.
    // Claude does not always emit the wrapper tags in the same order. The
    // command arguments contain the request, while name/message are metadata.
    content = content
      .replace(/^(?:\s*<(?:command-name|command-message)>[\s\S]*?<\/(?:command-name|command-message)>)+\s*/i, '')
      .replace(/^\s*<command-args>([\s\S]*?)<\/command-args>\s*/i, '$1\n')
      .replace(/^(?:\s*<(?:command-name|command-message)>[\s\S]*?<\/(?:command-name|command-message)>)+\s*/i, '')
      .trim();

    if (!content && commandName && !commandArgs && !/^\/(?:clear|model|help|config|status)$/i.test(commandName)) {
      content = commandName;
    }
  }

  return content.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeVisibleTurns(turns) {
  const normalized = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
    const content = cleanVisibleContent(turn.role, turn.content);
    if (!content) continue;
    const previous = normalized[normalized.length - 1];
    if (previous && previous.role === turn.role) {
      if (previous.content === content) continue;
      previous.content = `${previous.content}\n\n${content}`;
      continue;
    }
    normalized.push({ ...turn, content });
  }
  return normalized;
}

function hasVisibleUserTurn(turns) {
  return (Array.isArray(turns) ? turns : []).some(
    turn => turn?.role === 'user' && typeof turn.content === 'string' && turn.content.trim()
  );
}

function highlightsFromTurns(turns) {
  const cleanTurns = (Array.isArray(turns) ? turns : []).filter(
    turn => turn && (turn.role === 'user' || turn.role === 'assistant') &&
      typeof turn.content === 'string' && turn.content.trim()
  );
  const userMessages = cleanTurns
    .filter(turn => turn.role === 'user')
    .map(turn => turn.content.trim());
  const lastExchanges = cleanTurns.slice(-5).map(turn => `${turn.role}: ${turn.content.trim()}`);

  return createHighlights({
    topic: userMessages[0] || '',
    userMessages,
    toolCalls: [],
    filePaths: [],
    lastExchanges,
  });
}

module.exports = { cleanVisibleContent, filterTurnsForDate, normalizeVisibleTurns, hasVisibleUserTurn, highlightsFromTurns };
