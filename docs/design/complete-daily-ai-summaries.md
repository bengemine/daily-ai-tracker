# Complete Daily AI Summaries: Design

## Goal

Replace the short, ellipsis-filled fallback-style journal entries with complete AI-written summaries of each cleaned conversation. Preserve the existing daily tracker table, detailed entries, chat identifiers, and cleaned-conversation links.

The scheduled tracker continues to run daily at 11:30 AM. It summarizes the previous workday using the existing 4 a.m.-to-4 a.m. boundary.

## Source of Truth

The summarization stage reads only deterministic cleaned conversation artifacts. It never reads raw Claude, Codex, Grok, or other agent storage.

Each dated cleaned conversation is complete. The summarization path does not apply the old 40,000-character head/tail truncation and does not chunk conversations.

## One Daily AI Call

The tracker starts one non-persistent headless Claude Sonnet call for each date being processed. Deterministic Node code loads the complete cleaned conversations and places all independent jobs into one structured prompt.

There are no summary sub-agents and no AI file-tool turns. This removes startup and coordination overhead. The prompt:

- includes every complete cleaned conversation for the date;
- marks each job with an exact session key and clear boundary;
- instructs Claude to treat every job independently and never merge or leak details between jobs;
- requires exactly one structured result for every input job;
- uses Claude's JSON schema output so malformed or incomplete results can be detected deterministically.

Node validates the response and writes each per-session artifact atomically. The deterministic tracker, not the AI, assembles the final Markdown journal. This preserves stable formatting and prevents an AI formatting mistake from damaging the daily file.

## Summary Artifact

Each conversation produces one JSON artifact with this logical shape:

```json
{
  "version": 1,
  "promptVersion": 3,
  "date": "2026-07-23",
  "sessionKey": "Claude Code (WSL):example-id",
  "sourceSha256": "cleaned-conversation SHA-256",
  "title": "PR #482: Reviewed and corrected search index changes",
  "body": "Complete Markdown summary...",
  "identifiers": {
    "pullRequests": ["482"],
    "cases": [],
    "tickets": [],
    "commits": [],
    "branches": [],
    "urls": []
  },
  "summarySource": "claude-daily-agent",
  "wordCount": 184,
  "completedAt": "2026-08-01T00:00:00.000Z"
}
```

Artifacts are written atomically. Existing valid artifacts may be reused when their cleaned-conversation fingerprint and prompt version are unchanged. A prompt change invalidates the affected cached summary so summaries remain easy to improve later.

## Summary Requirements

The summary prompt is stored centrally and remains easy to edit. It instructs the daily agent to:

- Explain the full work that happened in the conversation without copying the transcript.
- Cover every distinct request, correction, decision, important discovery, completed action, reported result, failure, blocker, and unfinished item.
- Distinguish what the user requested from what the agent actually reported completing.
- Never infer hidden thinking, tools, commands, or results absent from the visible dialogue.
- Avoid generic headings and phrases such as “the user asked” or “the agent reported” as the whole summary structure.
- Use readable Markdown paragraphs and bullets when they improve clarity.
- Keep the body at or below approximately 1,000 words. This is a generous ceiling, not a target.
- Never shorten content with artificial ellipses.

When a pull request or PM case is the central task, its identifier leads the title. Examples:

- `PR #482: Reviewed and corrected search index changes`
- `Case #1093: Verified scheduler optimization without regression`
- `Case #2210 / PR #517: Reviewed authorization fixes`

The identifier extractor also records case, PR, ticket, commit, branch, and URL values in the structured artifact so the journal can preserve them reliably.

## Validation and Fallback

After the daily call exits, deterministic validation checks every expected artifact for:

- valid JSON and schema version;
- matching date and session key;
- non-empty title and body;
- matching cleaned-conversation fingerprint and prompt version;
- absence of the tracker’s truncation marker;
- a recorded word count so unusually long output remains visible; the 1,000-word guidance is soft because completeness takes priority.

A failed, missing, invalid, or timed-out summary is retried once. If it still fails, the tracker uses the existing deterministic fallback for that conversation, marks the entry as an incomplete fallback, and retains the cleaned-conversation link. The daily journal is still published.

If any fallback was necessary, the journal shows a short warning near the top with the number of incomplete AI summaries. A later forced regeneration can replace fallback artifacts with complete AI summaries.

## Timeout

The current 20-second Claude timeout is removed from the daily orchestration path. One complete date receives a maximum wall-clock runtime of three hours. There is no short per-conversation timeout. If the daily process reaches three hours, any missing summaries use fallback and the timeout is recorded as an error.

## Error Log

The existing combined `tracker.log` remains for normal operational output. In addition, the tracker maintains one append-only JSON Lines error log for all AI-summary failures:

`<tracker-output>/ai-summary-errors.jsonl`

The file is created only after the first error. Successful work does not add entries. Each error is one independent JSON record containing:

- timestamp and run ID;
- work date;
- stage;
- agent and session key when applicable;
- attempt number;
- error type and exact message;
- whether fallback was used.

JSON Lines is used because it permits safe appends without reading and rewriting an ever-growing JSON array. The log can still be parsed as structured JSON, one object per line.

## Journal Output

The existing journal layout remains:

- Daily title
- Overview table
- Anchored detailed entries
- Agent, project, time, and chat IDs
- Related-chat grouping
- Links to cleaned conversations

The overview title comes from the complete summary artifact. Detailed entries use the full summary body. Related conversations may still be grouped by the existing deterministic journal logic, but their independently generated summaries are preserved when combined.

## Scheduler and Recovery

The Windows scheduled task retains its 11:30 AM schedule and continues to run the deterministic indexer before the tracker.

For each pending date, the tracker:

1. Loads cleaned conversations.
2. Reuses valid cached summaries.
3. Makes one daily Claude call for missing or stale summaries.
4. Validates outputs and retries failures once.
5. Writes fallback artifacts and error records for remaining failures.
6. Atomically writes the final journal.
7. Advances the last-run marker after the journal is safely written.

An interrupted run can resume from already valid summary artifacts instead of repeating completed AI work.

## Safety Boundaries

The headless AI receives the cleaned conversations directly in its prompt and receives no file or shell tools. It does not receive raw agent storage, repository-editing authority, network tools, or access to the live journal file.

## Testing

Automated tests cover:

- full cleaned conversations are provided without the 40,000-character cap;
- one date uses one AI call with every complete cleaned conversation;
- all pending sessions must appear in the schema-constrained response;
- one conversation cannot leak into another session's summary;
- artifact schema, prompt-version, and source-fingerprint validation;
- central PR and case identifiers lead generated titles;
- successful artifact reuse and interrupted-run resume;
- one retry followed by marked fallback;
- the single error log is created only on error and receives valid JSONL records;
- the three-hour daily timeout path;
- warning display when a journal contains fallback summaries;
- journal table, details, IDs, grouping, and cleaned links remain intact;
- scheduled time remains 11:30 AM.

An isolated end-to-end validation regenerates July 2026 with AI summaries in a dedicated folder. It must not change the existing live tracker. The validation checks artifact coverage, error reporting, summary structure, fast/full conversation-scan equivalence, and representative PR/case title quality.
