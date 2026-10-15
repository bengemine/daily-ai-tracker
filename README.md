# Daily AI Tracker

Daily AI Tracker writes a daily journal of the work you did with AI coding agents. It reads the session files that Claude Code, Codex and other agents already save on your computer. Each day it writes one Markdown file with a table of the day's conversations and a summary of each one.

The repo also contains **Echo** (in [`echo/`](echo/)), a small local web app that searches the tracker's archive and reopens an old conversation from a description.

## What it does

- Finds every conversation you had with a supported agent on a given day, including old conversations you continued that day.
- Keeps only what you typed and what the agent visibly replied. It drops system prompts, hidden reasoning, tool calls and command output.
- Saves that cleaned dialogue as a Markdown file and a JSON file per conversation per day.
- Asks Claude or Codex, once per day, to summarize every cleaned conversation of that day.
- Writes the day's journal: an overview table, one section per conversation with its summary and session ID, and a link to the cleaned dialogue.
- Catches up on missed days when it runs (up to 14 days back by default).

A day runs from 4:00 AM to 4:00 AM local time, so late-night work counts toward the day it started.

Example journal entry (made-up data):

```markdown
## Overview

| # | Time | Agent | Task | Project |
|--:|------|-------|------|---------|
| 1 | 3:30 PM | Claude Code | [Explained how to reverse a string in JavaScript](#s-1) | demo-app |

### 1. Explained how to reverse a string in JavaScript

> **Claude Code** · /home/dev/demo-app · 3:30 PM · Chat: `Claude Code:11111111-2222-3333-4444-555555555555`

The user asked how to reverse a string. The agent suggested split, reverse and join.

Cleaned conversation: [Claude Code cleaned dialogue](<../../conversations/claude-code/11111111-2222-3333-4444-555555555555/2026-10-14.md>)
```

## Why I built it

I work with many AI coding agents every day, often several at once. At the end of a week I had no record of what had been done, in which conversation, or where to find it again. This tool now keeps that record for me, one file per day.

## How it works

The work is split into two steps. Only the second step uses AI.

**Step 1: deterministic indexer (`index-conversations.js`), no AI.** It reads each agent's local session files and never writes to them. A parser for each agent keeps only the visible dialogue, sorts it into 4 AM-to-4 AM days, and writes it to the output folder under `conversations/`. It remembers how far it has read in each file, so the next run reads only new data. Normal runs look only at files changed since the last successful run (on WSL, with one `find` command). A full scan runs on the first run, once a week, when the settings change, or when the quick check fails. See [the scan design and measured results](docs/design/conversation-scan-optimization.md).

**Step 2: one headless AI call per day (`tracker.js`).** For each day to process, plain Node.js code loads the cleaned conversations and puts all of them into one prompt, one "job" per conversation. It runs the AI command-line tool once:

- Claude: `claude -p` with tools turned off, no saved session, and `--json-schema`.
- Codex: `codex exec` with `--ephemeral`, a read-only sandbox, and `--output-schema`.

The answer must match a JSON schema: one summary per conversation, with a title, a body and any PR, ticket or commit identifiers. Node checks each summary. A missing or invalid summary is retried once. If it fails again, the tracker writes a plain fallback summary for that conversation, marks it, and logs the error to `ai-summary-errors.jsonl`. A day larger than a fixed size (600,000 characters for Claude, 800,000 for Codex) is split into several calls at conversation boundaries; a conversation is never cut.

Then plain code, not the AI, writes the Markdown journal. Summaries are cached, so a rerun only calls the AI for conversations that changed. The cache key includes the cleaned text, the prompt version, the provider, the model, the reasoning level and your custom instructions.

The AI tools use your existing Claude or Codex login. The tracker needs no API key. The cleaned conversations are sent to Anthropic or OpenAI through those tools, so the summaries are not made offline.

## Supported agents

| Agent | Where the tracker reads it | Notes |
|---|---|---|
| Claude Code | `~/.claude` on Windows and in WSL | Labeled "Claude Code" and "Claude Code (WSL)". |
| Codex | `~/.codex` on Windows and in WSL | Labeled "Codex" and "Codex (WSL)". |
| Grok | `~/.grok` on Windows and in WSL | |
| Factory | `~/.factory` on Windows | |
| OpenCode | `~/.local/share/opencode/opencode.db` | |
| Cursor | not indexed | Cursor's local records have no reliable per-message dates, so the indexer skips them. |

Helper sessions that an agent starts for itself (sub-agents) are filtered out. Sessions started from the T3 Code desktop app are labeled, for example "Claude Code (WSL) via T3 Code".

## Requirements

- Node.js 24 or later. The tracker has no npm dependencies. It uses Node's built-in `node:sqlite`, which prints an "experimental" warning.
- The Claude Code CLI or the Codex CLI, installed and logged in.
- Windows with WSL is the setup it was built for. On Windows:
  - WSL agents are read through `\\wsl$` and `\\wsl.localhost` paths.
  - Claude summaries run through WSL first and fall back to a Windows install of Claude.
  - Codex summaries run only through WSL, unless you set `CODEX_CLI_PATH`.
- Python 3 is needed only for Echo's tests and Echo itself.

## Install

```bash
git clone <this repo> daily-ai-tracker
cd daily-ai-tracker
```

1. Copy `tracker-config.example.json` to `tracker-config.json` and set:
   - `outputDir`: where journals go. Default: an `ai-tracker` folder in your user folder.
   - `wslDistro`: your WSL distro name. Default: `Ubuntu`.
   - `wslHome`: your home folder inside WSL. Default: `/home/<your user name in lower case>`.
2. Optional: copy `tracker-settings.example.json` to `tracker-settings.json` to choose the summary provider. You can also change it later in the control page. Without the file, the tracker uses Claude `sonnet` with medium reasoning.
3. Index and summarize yesterday by hand to check the setup:

```bash
node index-conversations.js
node tracker.js --dry-run
node tracker.js
```

Useful commands:

| Command | What it does |
|---|---|
| `node index-conversations.js` | Index new conversation data. |
| `node index-conversations.js --full-scan` | Check every source file. |
| `node tracker.js` | Catch up: write journals for missed days, up to yesterday (at most 14 days). |
| `node tracker.js --date 2026-10-14` | Write one day. Skips the day if its journal exists. |
| `node tracker.js --date 2026-10-14 --force` | Rewrite one day. |
| `node tracker.js --force-window` | Catch up further than 14 days without overwriting journals. |
| `node control-panel.js` | Open the local control page. |
| `node validate-month.js --month 2026-07 --output <new folder>` | Rebuild a whole month into a separate folder, to compare with the live journals. |
| `npm test` | Run all tests (tracker and Echo). |

### Settings

Every machine setting can come from an environment variable, which wins over the config file.

| Variable | Meaning |
|---|---|
| `AI_TRACKER_OUTPUT_DIR` | Output folder. |
| `AI_TRACKER_WSL_DISTRO` | WSL distro name. |
| `AI_TRACKER_WSL_HOME` | Home folder inside WSL, for example `/home/dev`. |
| `AI_TRACKER_CONFIG_PATH` | Use a different `tracker-config.json`. |
| `AI_TRACKER_SETTINGS_PATH` | Use a different `tracker-settings.json`. |
| `AI_TRACKER_SUMMARY_PROVIDER`, `AI_TRACKER_SUMMARY_MODEL`, `AI_TRACKER_SUMMARY_REASONING` | Override the summary settings for one run. |
| `AI_TRACKER_CUSTOM_INSTRUCTIONS` | Extra summary instructions for one run. |
| `AI_TRACKER_SUMMARIZER_TIMEOUT_MS` | Time limit for one day's AI call. Default: 3 hours. |
| `CLAUDE_CLI_PATH`, `CODEX_CLI_PATH` | Full path to the CLI, if it is not found. |
| `CODEX_MODELS_CACHE` | Codex model list file for the control page. |

### Output folder

```text
<outputDir>/
  2026/10/14.md                      daily journal
  conversations/<agent>/<session>/   cleaned dialogue per day (.md and .json)
  summaries/<agent>/<session>/       AI summary per day (.json)
  ai-summary-errors.jsonl            only failures and fallbacks
  tracker.log                        log of scheduled runs
  .conversation-index/               scan checkpoint and date index
  .summary-work/                     prompts and answers of each AI call
  .last-run.json                     last processed day
```

### Control page

`node control-panel.js` starts a page on 127.0.0.1 (local only) and opens it in your browser. Changes need a token that only that page has. On the page you can:

- choose Claude or Codex, the model, the reasoning level, and your own extra summary instructions;
- see the Windows scheduled task's state and next run;
- see the summary error log;
- compare Claude and Codex on one day, written to a separate folder;
- rebuild a month into a separate folder.

Comparisons and rebuilds go under `validation-output/` in the project, never into your live journals.

## Scheduling

**Windows Task Scheduler.** Run once:

```bash
node setup-scheduler.js
```

This writes `run-tracker.bat` and registers a daily task named `DailyTrackerAI` at 11:30 AM. The batch file runs the indexer, stops if indexing fails, then runs the tracker. Both append to `<outputDir>/tracker.log`. To remove the task: `node setup-scheduler.js --remove`. The schedule time is set in `setup-scheduler.js` (`SCHEDULE_TIME`).

**Linux or WSL with cron.** The repo has no cron installer, but the two scripts are plain command-line programs, so a crontab line works. Use full paths, because cron starts with a short PATH:

```cron
30 11 * * * cd /path/to/daily-ai-tracker && /path/to/node index-conversations.js >> /path/to/ai-tracker/tracker.log 2>&1 && /path/to/node tracker.js >> /path/to/ai-tracker/tracker.log 2>&1
```

Running inside Linux, the tracker reads `~/.claude`, `~/.codex` and the other folders in your Linux home and labels them without "(WSL)". I have checked this only with test data, not in daily use.

## Echo

Echo answers "where was that conversation where we...?". You describe what you remember. Echo finds the conversation in the tracker's archive and reopens the original Claude Code or Codex session in the folder where it ran.

- It keeps a local SQLite full-text index of the tracker's journals, the cleaned conversations, and native Claude and Codex session files from the last 8 days.
- To search, it runs headless Codex (`codex exec`) in a read-only, ephemeral sandbox with your normal Codex login. Codex searches the index with different words, reads promising conversations, and must answer in a fixed JSON schema that includes a short quote from the conversation as evidence.
- Before it resumes anything, the server checks the answer. The session must exist in the index. The evidence quote (at least 30 characters) must appear in that session's saved summary or dialogue. The original session file and its working folder must still exist; the folder is read from the session file, not from the AI. Echo opens a session by itself only when there is exactly one high-confidence match that passed every check. Otherwise you choose.
- Echo never runs a command or path written by the AI. Resume uses fixed commands (`codex resume <id>`, `claude --resume <id>`) in a new [Herdr](https://github.com/herdrdev/herdr) terminal tab.

Setup and details: [echo/README.md](echo/README.md).

## Limits and known issues

- **Built for Windows with WSL.** The scheduler and the control page's schedule view are Windows-only. Linux use is checked only with test data.
- **Some summaries still fall back.** From August to mid-October 2026, the error log had 319 entries. 307 were Codex not writing the summary for one conversation. After the retry, 99 conversation-days kept the plain fallback summary.
- **Busy days are slow.** The whole day goes into one prompt. A day with 23 conversations took 30 to 60 minutes with high reasoning.
- **Windows file errors.** The log sometimes shows `EPERM` errors when renaming temporary index files, and the quick scan falls back to a full scan when `wsl.exe` times out.
- **Cursor is not indexed.** See the agents table.
- **The Claude model list is fixed.** Claude Code has no command that lists models, so the control page offers known aliases and accepts any model ID you type.
- **The day boundary uses local time.** If you change time zones, a conversation can move to a different day.
- **Echo needs Herdr to resume, and `ECHO_WINDOWS_HOME` for Windows sessions.** If the tracker runs inside Linux instead of Windows, Echo can list a recent native session twice, once with "(WSL)" in the agent name.
- **The AI sees your conversations.** Summaries and Echo searches send conversation text to Anthropic or OpenAI through their CLIs.

## How it was built

Built with Claude Code and Codex under my direction: I set the requirements and checked the results, and the AI agents wrote the code.

More reading: [the April 2026 repair](docs/case-study-april-repair.md) and [the design notes](docs/design/).

## License

MIT. See [LICENSE](LICENSE). Echo's bundled fonts (Syne and IBM Plex Mono) use the SIL Open Font License; their license files are in [`echo/public/fonts/`](echo/public/fonts/).
