# Daily Agent Transcripts Design

## Goal

The Daily AI Tracker must treat every supported AI agent the same from the user's point of view while using a format-aware parser for each agent's local storage.

For every processed date, the tracker must:

- find new and continued conversations with real user activity on that date;
- retain only the user's prompts and the agent's visible natural-language replies from that date;
- exclude system prompts, project instructions, hidden reasoning, tool calls, command output, tool results, generated file dumps, and synthetic notifications;
- summarize only the cleaned daily slice; and
- save the cleaned daily slice as a readable local artifact.

The primary agents are Claude Code, Codex, and Grok. Factory, OpenCode, and Cursor remain supported with the same output contract. GSD and GSD/Pi support will be removed.

“Visible dialogue” is the strict content boundary. If the user saw or wrote the text as part of the conversation, it may be retained. A skill name or action is retained only when the agent mentioned it in visible prose. Internal skill-loading records, orchestration metadata, commands, and tool activity are never retained merely because they exist in the raw transcript.

## Equal-Agent Contract

Each detection adapter has the same responsibilities:

1. Discover its agent's local conversations without modifying the source files.
2. Determine whether a conversation contains real activity during the requested local calendar date.
3. Return a stable agent name, session ID, project path, source location, processed date, and first activity time for that date.
4. Exclude sub-agent or worker conversations when the source format identifies them.

Each transcript parser has the same responsibilities:

1. Read one detected conversation.
2. Select only turns that belong to the processed local calendar date.
3. Return chronological `user` and `assistant` text turns.
4. Remove agent-specific noise.
5. Report non-fatal parsing warnings and removal statistics.

The tracker and summarizer consume this common result. They do not need to know the source format.

## Agent-Specific Processing

### Claude Code

Use `history.jsonl` to detect user activity by date and session ID. Read the matching project session JSONL file for transcript content. Select timestamped user and assistant text from the requested date. Exclude command records, tool blocks, thinking blocks, system reminders, progress records, and side-chain content.

### Codex

Do not limit discovery to `sessions/YYYY/MM/DD`, because that folder represents session creation rather than every later activity date. Scan candidate session files and inspect their timestamped entries for the requested date. Keep user and assistant message records from that date. Exclude developer instructions, environment context, reasoning, function calls, function results, and lifecycle events.

Candidate discovery may use file modification time to avoid reading files that cannot contain the requested date, but activity must be confirmed from entry timestamps.

### Grok

Discover sessions under `~/.grok/sessions/<encoded-project>/<session-id>/`. Use `events.jsonl` `turn_started` records as the source of activity dates. Only primary user conversations qualify; sub-agent relationships do not.

Map each qualifying event's `turn_number` to the matching `prompt_index` in `chat_history.jsonl`. Include the real user prompt and visible assistant text belonging to that turn. Exclude synthetic user records, including project instructions, system reminders, task-completion notices, and notification drains. If such a hidden event triggers assistant prose that was visible to the user, retain that assistant prose. Also exclude system, reasoning, tool-result, and other internal records. Assistant tool-call metadata and command payloads are never saved; visible assistant prose may be kept when present.

### Factory

Continue discovering session JSONL files across project folders. Confirm activity using entry timestamps. Select only requested-date user and assistant messages, and preserve existing worker-session filtering.

### OpenCode

Use the SQLite message and part timestamps, rather than only the session's latest update time, to find activity on the requested date. Keep natural-language user and assistant text parts. Exclude reasoning, tool, file, patch, step, and child-session records.

### Cursor

Use read-only SQLite access. Detect the requested date from message-level timestamps where available instead of treating `lastUpdatedAt` as proof for only one day. Keep user and assistant text from that date and exclude code blocks, tool results, thinking blocks, and internal metadata.

If an older stored conversation genuinely lacks per-turn timestamps, the parser must not invent a daily assignment. It should emit a warning and skip the unassignable content.

## Daily Date Semantics

All comparisons use the tracker's local timezone with a 4:00 AM workday boundary. A workday uses the half-open interval from 4:00 AM on its calendar date through, but not including, 4:00 AM the next calendar date. Therefore, activity from midnight through 3:59:59 AM belongs to the preceding workday. This is a fixed boundary; the tracker does not guess sleep or inactivity periods.

A continued conversation is one stable session with activity on more than one date. It appears once in each applicable daily journal. The summary and saved transcript for a date contain only that date's work. Earlier or later turns are not sent to the summarizer for that journal entry.

The session's displayed time is its first qualifying activity time on the processed date, not the original session creation time.

## Cleaned Conversation Artifacts

Artifacts are stored below the configured tracker output directory:

```text
ai-tracker/
└── conversations/
    └── <agent-slug>/
        └── <session-id>/
            ├── index.md
            ├── 2026-07-21.md
            ├── 2026-07-22.md
            └── 2026-07-25.md
```

Agent slugs prevent session ID collisions between products. Session IDs and path components must be sanitized before they are used as filenames.

Each dated Markdown file contains:

- the processed date;
- agent name;
- session ID;
- project path;
- first and last activity times when available; and
- chronological `User` and `Assistant` sections containing only cleaned text.

`index.md` contains stable session metadata and a chronological list of links to every saved active date. It is rebuilt from the dated files so reruns cannot create duplicate links.

The daily journal links to the matching dated artifact. A conversation used for a week therefore has one session folder and one file for each active day. Days without user activity produce no artifact.

Reprocessing with force replaces only the requested date's artifact. Files are written through a temporary file in the destination directory and renamed into place to avoid leaving partial output. Source agent data remains strictly read-only.

## Pipeline

The system has two strict stages.

### 1. Deterministic conversation indexer

The indexer is the only stage that reads raw agent storage. It does not call an AI model. It discovers new or changed primary conversations, reads only newly appended records when possible, applies the format-aware parser, and writes timestamped visible turns to the clean conversation store.

The first run bootstraps each supported source completely. Later runs store a byte position, incomplete trailing line, and prefix fingerprint for each append-only file. If a source is truncated or its existing prefix changes, that session is rebuilt instead of receiving an unsafe append. SQLite sources use the last processed message timestamp with boundary deduplication.

The indexer writes its cursor only after the canonical clean record and affected daily files are durable.

### 2. Daily tracker

The tracker never reads agent storage. For each date it loads the dated JSON artifacts, skips records without a real user prompt, builds highlights, summarizes only those clean turns, and writes the journal with links to the matching Markdown artifacts.

The scheduled batch runs the indexer first. It stops if indexing fails and runs the tracker only after the clean store is current. Manual tracker runs do not fall back to raw sources.

The Markdown artifact, JSON artifact, and summary therefore use the same cleaned input and cannot disagree about which day was processed.

## Canonical Store and Index State

Each session folder also contains internal machine-readable data:

```text
<session-id>/
├── index.md
├── 2026-07-21.md
├── 2026-07-21.json
├── canonical.json
└── .source-state.json
```

`canonical.json` contains timestamped `user` and `assistant` turns plus stable session metadata. The dated JSON file contains the exact turns consumed by the daily tracker. `.source-state.json` contains only source cursors and fingerprints, never raw thinking or tool data. All are written through temporary-file replacement.

## Error Handling

- A missing agent storage directory means that agent is unavailable; it does not fail the full tracker run.
- Malformed lines are skipped and counted. Valid turns in the same conversation remain usable.
- A parser failure for one session is logged and does not stop other agents or sessions.
- A session with activity evidence but no usable daily user prompt is skipped and does not create a misleading journal entry.
- Artifact write failures are reported clearly. The tracker must not claim the day's run succeeded if its required cleaned artifacts were not saved.
- Existing artifacts outside the exact processed session/date target are never deleted or overwritten.

## GSD Removal

Remove GSD 2.0 and GSD/Pi from configuration, adapter registration, summarizer mappings, transcript adapters, tests, and user-facing counts or documentation. No migration is needed for old journal Markdown because it is historical output.

## Verification

Tests must cover:

- one new conversation for each supported parser;
- a conversation created on one day and continued on later days;
- strict daily slicing with no previous-day or next-day text leakage;
- Grok `turn_started` to `prompt_index` mapping;
- removal of Grok synthetic messages and internal records;
- removal of reasoning, tool calls, tool results, commands, and system content across formats;
- sub-agent filtering;
- artifact paths, filename sanitization, daily file replacement, and chronological index rebuilding;
- journal links to cleaned artifacts;
- read-only source invariants; and
- complete removal of GSD registration and mappings.

Use synthetic fixtures for committed tests so private conversation content is not added to the repository. After unit and integration tests pass, perform a read-only verification against the existing local Grok cross-day session and at least one local Claude or Codex session. Compare detected dates and turn counts without printing private message contents. Then run the complete test suite and a tracker dry run or isolated-output integration run that cannot overwrite existing journals.

## Verified Local Storage Facts

The design was checked against the formats present on this computer before implementation:

- Grok stores sessions below `~/.grok/sessions/<encoded-project>/<session-id>/` with separate `events.jsonl` and `chat_history.jsonl` files.
- Grok `events.jsonl` contains timestamped `turn_started` records with stable turn numbers and primary/sub-agent relationship metadata.
- Grok `chat_history.jsonl` contains matching `prompt_index` values, visible assistant text, synthetic-user reasons, reasoning records, and tool-result records.
- At least one local Grok session contains primary turns on two calendar dates, proving that continued-session detection must inspect event timestamps rather than folder dates.
- Codex stores a session below the date on which it was created. Later turns remain in that original file, so target-date directory scanning alone misses continued work.
- Claude Code history records are timestamped by user activity and already provide a reliable session/date index, while the richer project transcript supplies the visible replies.

These facts are local implementation evidence, not assumptions about every future agent version. Unknown record shapes must be skipped with warnings until covered by a parser and test.
