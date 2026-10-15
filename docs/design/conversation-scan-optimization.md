# Conversation Scan Optimization Design

## Goal

Make normal Daily AI Tracker runs substantially faster without allowing the optimization to silently omit AI work. The cleaned conversation content, 4:00 AM workday boundary, daily journal inputs, agent parsers, and existing live tracker files remain unchanged.

The optimization changes only how the deterministic conversation indexer selects raw sources that might have changed. It does not change how a selected source is parsed.

## Safety Standard

Correctness has priority over speed. A run must use a full scan whenever the fast path cannot prove that its change checkpoint and candidate search are usable.

The system must never advance a checkpoint after a failed or partial indexing run. A later run must therefore reconsider everything that could have changed during the failed run.

No command used for discovery may write to Claude, Codex, Grok, Factory, OpenCode, Cursor, or any existing tracker output.

## Approaches Considered

### Agent history files only

Rejected. Local verification found recently modified, valid Claude conversation files that were not represented by new `history.jsonl` entries. Agent prompt histories may be used as supporting evidence but cannot be the authoritative candidate list.

### Reordered full scan

This would check raw source metadata before opening canonical and state artifacts. It is safe and removes some unnecessary reads, but it still asks Windows to inspect thousands of WSL files every day. It is retained as part of the full-scan implementation but is not sufficient as the normal path.

### Modified-time candidates with full-scan reconciliation

Selected. Normal runs use native filesystem modified-time filtering and then pass only candidate sources into the existing cursor-based parser. Automatic full scans provide a correctness backstop for unusual timestamp, storage-format, or checkpoint conditions.

## Checkpoint State

The conversation index directory contains one atomic global scan-state file with:

- schema version;
- start time of the last successful scan;
- time of the last successful full scan;
- configuration fingerprint covering enabled agents and source roots; and
- discovery implementation version.

At the beginning of a run, the indexer captures `scanStartedAt`. It writes the new checkpoint only after every selected source and configured database has completed successfully and all required artifacts are durable. The saved incremental watermark is `scanStartedAt`, not the later completion time, so changes made while the indexer was running are included on the following run.

The checkpoint is written through temporary-file replacement. A missing, malformed, unsupported, future-dated, or configuration-mismatched checkpoint forces a full scan.

## Candidate Discovery

### WSL sources

Claude, Codex, and Grok data stored inside WSL are selected with one native WSL modified-time scan. This avoids thousands of individual Windows-to-WSL metadata calls. The candidate cutoff begins five minutes before the saved successful-scan watermark. Existing source cursors and message deduplication make this overlap safe.

Discovery retains the current source rules:

- Claude primary session JSONL files are included and `subagents` directories are excluded;
- Codex rollout JSONL files are included;
- Grok sessions qualify when either `events.jsonl` or `chat_history.jsonl` changed, and both files are passed to the existing Grok parser.

If the native command is unavailable, times out, produces invalid output, or reports a non-zero exit status, the same run falls back to full discovery.

### Windows-local sources

Windows-local Claude, Codex, and Factory metadata scanning is already inexpensive on this computer. The indexer may scan their source metadata directly, but it must open state and canonical artifacts only after identifying a changed source. New roots or files are included automatically.

### Database sources

OpenCode retains its database size, modified-time, and message watermark logic. No undocumented Codex database schema becomes a required dependency. Cursor retains read-only database handling.

Agent prompt histories and private internal indexes are never the sole authority for activity detection.

## Full-Scan Conditions

A complete discovery and cursor check runs when any of these conditions applies:

- no valid checkpoint exists;
- seven days have elapsed since the last successful full scan;
- source roots or enabled-agent configuration changed;
- candidate discovery failed or returned invalid data;
- a caller explicitly requested `--full-scan`; or
- the indexer detects state that cannot be reconciled safely through the fast path.

The seven-day rule is enforced by the indexer itself, so the existing 11:30 AM scheduled task does not need a second weekly schedule.

A full scan uses source metadata first. It does not open every cleaned conversation when the source cursor already proves that the raw source is unchanged.

## Parsing and Output Invariants

After candidate selection, the existing deterministic pipeline remains authoritative:

1. Load the candidate's source cursor.
2. Read only appended raw JSONL bytes when the prefix is unchanged.
3. Rebuild the session if truncation or prefix replacement is detected.
4. Retain only visible user prompts and visible assistant replies.
5. Write canonical and dated clean artifacts atomically.
6. Build daily tracker input only from cleaned dated artifacts.

The optimization must not change session identifiers, agent names, project paths, message order, message timestamps, date assignment, sub-agent filtering, noise removal, or artifact formats.

## Failure Handling

- Candidate-discovery failure triggers a full scan, not an empty successful run.
- A source-processing failure prevents checkpoint advancement.
- A full-scan failure also prevents checkpoint advancement and is reported as a failed tracker run.
- Missing optional agent storage remains an unavailable agent, matching current behavior.
- An empty candidate set is accepted only after discovery itself succeeds.
- Existing live tracker files are never used as scratch output and are never changed by validation.

## Verification

### Automated tests

Tests use synthetic fixtures and must cover:

- first run forcing a full scan;
- a normal unchanged fast run;
- new sessions and appended turns;
- a conversation resumed after several days;
- activity spanning midnight and the 4:00 AM workday boundary;
- the five-minute overlap without duplicate turns;
- checkpoint atomicity and no advancement after failures;
- malformed, missing, future-dated, and configuration-mismatched checkpoints;
- native WSL discovery failure falling back to a full scan;
- the automatic seven-day reconciliation;
- explicit forced full scans;
- source truncation and replacement;
- Claude, Codex, Grok, Factory, OpenCode, and Cursor behavior; and
- proof that optimized and forced-full scans produce identical canonical and dated conversation artifacts from identical raw input.

The complete existing test suite must also pass.

### Local performance and equivalence test

Use real local agent data read-only. Generate optimized output and forced-full output into separate temporary directories. Compare stable structured data rather than AI-generated summary wording:

- session keys;
- active workdays;
- cleaned user and assistant turns;
- timestamps;
- per-day input fingerprints; and
- warnings and exclusions.

Any difference between optimized and forced-full structured output blocks release until explained and fixed.

## Isolated July 2026 Acceptance Run

After implementation and automated verification, fully generate the Daily AI Tracker for July 2026 in a new dedicated validation folder inside the project. The configured live output directory is read-only during this exercise. Existing July journals and conversation artifacts must not be overwritten, renamed, or deleted.

The validation folder contains:

- the newly generated July daily tracker files;
- their cleaned conversation artifacts;
- run logs and timing;
- a machine-readable comparison; and
- a concise human-readable comparison report.

Compare the isolated July output with the existing July tracker by date, agent, project, and session where the old format makes those fields available. Summary prose may vary because AI summaries are not deterministic; structural activity and cleaned inputs are the correctness comparison.

The old July tracker predates Grok support and is expected to contain no Grok conversations. Valid Grok entries in the isolated July output are therefore expected additions, not regressions. Grok correctness is checked against the cleaned Grok artifacts and timestamped raw source records instead of requiring an old-tracker match.

Every other difference is classified as one of:

- legitimate newly detected work that the old tracker missed;
- removal of an old false positive or noisy record;
- presentation-only or nondeterministic summary wording;
- unavailable historical source data; or
- a possible regression requiring investigation.

The optimization is accepted only when there are no unexplained structural differences, no missing expected non-Grok work, no live-output modifications, and the optimized scan shows a material normal-run speed improvement.

## Measured Results

These numbers come from the isolated July 2026 test run on the author's Windows machine with WSL. The raw data held 5,268 conversation source files. A full build read 2.72 GB and kept 44,642 visible turns.

| Run | Time | Sources inspected |
|---|---:|---:|
| First full build (no index yet) | 842.6 s (about 14 minutes) | 5,268 |
| Full reconciliation of an existing index | 17.6 s | 5,268 |
| Normal fast run | 5.8 s | 4 |

An earlier test of the same change measured a normal fast run at 6.3 s, with 2 of 5,261 sources inspected.

The normal fast run is about 145 times faster than a first full build and about 3 times faster than a full reconciliation. The first build is a one-time cost; the reconciliation is what the weekly safety scan costs.

The optimized scan and a forced full scan produced byte-identical July conversation artifacts. A SHA-256 fingerprint of the live tracker folder was the same before and after the test, so the test did not change the live output.

In daily use from August to mid-October 2026, the tracker log recorded 32 fast scans, 8 weekly full reconciliations and 1 full scan after a missing checkpoint.
