# AI Tracker Provider Control Room Design

## Goal

Let the daily tracker use either Claude Code or Codex as its headless summarizer without weakening completeness or changing the deterministic conversation-cleaning pipeline. Add a local control page where a user can choose the provider, model, reasoning level, and personal summary instructions. Historical regeneration and provider comparisons must always use isolated output folders unless the user explicitly chooses the live tracker.

## Verified Baseline

The existing production path is hard-coded to Claude in `src/summary-orchestrator.js`. Its summary cache is keyed by transcript fingerprint and prompt version, but not by provider, model, reasoning, or custom instructions. A direct provider switch would therefore risk reusing the wrong cached artifact.

Codex CLI 0.146.0 is installed. Its local catalog includes `gpt-5.6-luna`, supports medium reasoning, and describes Luna as fast and affordable. A read-only, ephemeral test passed the exact production schema for eight complete July 3 conversations in one call:

- 73,026 input tokens;
- 3,069 output tokens;
- 63 seconds;
- eight valid summaries with correct session keys and central identifiers.

The same Claude test took about 3 minutes 54 seconds. Luna preserved the main requests, decisions, results, blockers, and PR/case/ticket identifiers, but its summaries were roughly half as long. Luna is therefore suitable for a guarded production trial, but the comparison page should remain available because Claude currently retains more secondary detail.

## Architecture

The deterministic indexer and cleaned-conversation store remain unchanged. Only the AI summarization boundary is generalized.

`src/summary-providers/` exposes the same provider interface for Claude and Codex:

```text
invoke({ prompt, schema, model, reasoning, timeoutMs, workspace })
  -> structured daily summaries
```

Claude continues to run as a non-persistent schema-constrained CLI call with tools disabled. Codex runs with `exec`, `--ephemeral`, ignored user rules/configuration, a read-only sandbox, an output schema, and an isolated temporary working directory. Codex still uses the user's existing CLI authentication; no credentials are stored in tracker settings.

The orchestrator remains provider-neutral. It loads complete cleaned conversations, constructs one protected prompt, invokes the selected provider, validates every session result, writes provider-aware artifacts, and lets deterministic journal code assemble Markdown.

One call is used when the complete day fits the selected model. If a provider rejects or cannot fit the day, deterministic code may make multiple calls split only between complete conversations. It never truncates or splits an individual cleaned conversation. This protects completeness while avoiding sub-agents.

## Settings

Settings live in one validated JSON file in the project. Writes are atomic. Defaults preserve current behavior:

```json
{
  "provider": "claude",
  "model": "sonnet",
  "reasoning": "medium",
  "customInstructions": "",
  "timeoutMs": 10800000
}
```

Environment variables may override settings for one run. This allows isolated comparisons and regeneration without changing the scheduled provider.

The protected base prompt cannot be replaced from the UI. Personal instructions are appended in a clearly delimited section and cannot remove session isolation, completeness, visible-dialogue-only, schema, or no-truncation rules.

## Provider-Aware Cache

Every artifact records:

- provider;
- exact model;
- reasoning level;
- base prompt version;
- custom-instruction SHA-256;
- cleaned-conversation SHA-256.

All fields participate in cache validity. Changing any setting regenerates the affected summary rather than silently reusing Claude output as Luna output. Existing valid Claude artifacts can be recognized as the legacy Claude default; fallback journal prose is never treated as a valid AI artifact.

## Local Control Page

`control-panel.js` starts a server bound to `127.0.0.1` and opens a local browser page. It is not exposed to the network. A per-process token protects writes from unrelated browser pages.

The approved layout contains:

- Summarization: provider, model, reasoning, and custom instructions;
- Schedule: current Windows task state and next run time;
- Conversation sources: enabled adapters and last index status;
- Run history: recent summary runs, duration, provider, model, session count, and fallback count;
- Errors: parsed entries from the single `ai-summary-errors.jsonl` file;
- Comparison: run two configurations against the same isolated date and view side-by-side results;
- Regeneration: month and dedicated output folder, with an explicit live-output safeguard.

The page is a dependency-free local Node/HTML/CSS/JavaScript application. It uses an editorial, utilitarian control-room design with light and dark support, keyboard access, visible focus, and responsive layout.

## Model Discovery

Codex models are loaded from the CLI's local `models_cache.json`, including each model's supported reasoning levels. The page shows the cache timestamp and provides a reload action. Because this cache is an internal CLI artifact, the model field also accepts a custom ID if the catalog is missing or stale.

Claude Code does not expose a stable headless model-list command. The page provides known aliases supported by the installed CLI and always permits a custom model ID. It never claims that its Claude list is exhaustive or current.

## Comparison and Luna Decision

Provider comparison uses the same cleaned conversations, base prompt, custom instructions, and JSON schema. Results go under `validation-output/provider-comparisons/`; they never populate production caches or journals.

The report records:

- runtime and token usage when exposed by the CLI;
- schema and session coverage;
- summary word counts;
- identifier coverage;
- side-by-side titles and bodies;
- deterministic warnings such as missing output, fallback, or artificial truncation.

The initial measured judgment is that Luna is good enough for a production trial and materially faster, but not yet proven equivalent to Claude for secondary detail. The safe default remains Claude until a broader July comparison confirms acceptable completeness. Switching later is one settings change.

## July Regeneration

The reusable command regenerates July 2026 into a new dedicated folder with explicit provider/model/reasoning overrides. It never touches the live tracker's `2026/07` folder.

The command supports resume. Valid artifacts are reused after interruption. The final comparison identifies old fallback entries, newly recovered continued conversations, Grok additions, provider failures, and changed titles/details without treating expected Grok additions as regressions.

## Errors and Recovery

All AI errors remain append-only JSON Lines in one `ai-summary-errors.jsonl`. Records add provider, model, reasoning, run mode, and isolated/live output path. The journal is still written with marked deterministic fallbacks after one retry.

The control page does not need to remain running for scheduled work. The scheduler reads the saved settings file directly. A broken or missing settings file produces a logged validation warning and uses safe Claude defaults.

## Testing

Automated tests cover settings validation and atomic writes, provider command construction, structured-output parsing, model catalog discovery, provider-aware cache invalidation, protected custom prompt composition, context-safe whole-session batching, local-only server behavior, write-token enforcement, comparison isolation, regeneration isolation, fallback logging, existing journal rendering, and the 11:30 AM schedule.

Real verification uses representative July dates with Claude and Luna. The full Node test suite must pass, the scheduled task must remain Ready at 11:30 AM, and a filesystem fingerprint must prove the old July tracker was untouched.
