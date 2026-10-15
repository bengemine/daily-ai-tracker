# Case study: the April 2026 repair

In April 2026 the tracker quietly stopped writing real summaries. For 12 days the daily journals held raw fallback text instead. Some good journals from March were also overwritten with that text. This page explains what went wrong, how it was found, and what changed.

## The setup at the time

The tracker ran on Windows. Windows Task Scheduler started it every day at 11:30 AM. For each AI conversation of the day, it called the Claude Code command-line tool (`claude -p`) to write a short summary. If that call failed, it wrote a "fallback": a plain dump of the conversation's first message, tool counts and file names.

## What the damage looked like

- 12 daily journals contained fallback dumps instead of summaries.
- In those journals, the overview table at the top was broken. Rows ran into each other and headings appeared inside the table.
- 10 of the 12 files had been fine before. A catch-up run rewrote them with the broken output.

## How the work was done

The repair was done by AI coding agents (Claude Code with parallel helper agents) under my direction. I set four rules before any code changed:

1. Investigate first. Four read-only investigators mapped the code and the damage before anyone edited a file.
2. Protect the data. A byte-for-byte copy of the output folder (84 files) was taken first. One known good journal was kept as a reference and never touched.
3. Keep the daily schedule on. The fixes had to make the next scheduled run safe, even in the middle of the repair.
4. Write everything down. Every change went into a repair log.

## Root cause 1: the summarizer could not run Claude

This one had three layers. Each fix exposed the next problem.

**Layer 1: Claude was not on the PATH.** Task Scheduler starts programs with a minimal PATH (the list of folders Windows searches for programs). The `claude.cmd` launcher was not in it, so the tracker reported "claude CLI not found".

Fix: the tracker now looks in more places: an explicit `CLAUDE_CLI_PATH` setting, the PATH, the npm folders under `APPDATA` and `LOCALAPPDATA`, and the default nvm-for-Windows folder. The scheduled batch file also sets the PATH.

**Layer 2: Claude ran but returned nothing.** After the PATH fix, Claude started and exited with code 0, but its output was empty. Node.js was starting the `claude.cmd` wrapper with `shell: true`. On Windows, that combination drops the text piped to the program's input, so Claude never received the prompt.

Fix: a new helper, `resolveNpmCmdWrapper()`, reads the `.cmd` wrapper, finds the JavaScript file it would run, and starts `node` with that file directly, without a shell. The prompt now reaches Claude.

**Layer 3: the wrapper path was wrong.** The output was still empty. The `.cmd` file refers to its own folder through a batch variable, `%dp0%`. The new helper copied that text as it was, so the path pointed to a folder named `%dp0%` that did not exist.

Fix: one line that replaces `%dp0%` with the wrapper's real folder. This was the actual source of the fallback output all along. The first two fixes were needed, but not enough.

## Root cause 2: fallback text broke the journal table

When a summary failed, the first line of the fallback dump became the title in the overview table. The function that cleaned table cells, `escapeCell()`, only escaped the `|` character. Newlines and `#` headings in the dump broke the Markdown table.

Fix: `escapeCell()` now turns newlines and tabs into spaces, removes block prefixes such as `# `, `- ` and `> `, escapes `|`, and shortens long text. A new `flattenTitle()` picks one clean line for the title. 18 new tests cover these cases.

## Root cause 3: catch-up overwrote good files

Catch-up mode fills in missed days. It walked back to the oldest date it knew, with no limit, and rewrote every journal on the way. While root causes 1 and 2 were active, it replaced good March journals with broken ones.

Fix:

- An existing journal is never overwritten unless you pass `--force`.
- Catch-up covers at most the last 14 days unless you pass `--force-window`. It prints a warning when it trims the list.

5 new tests cover these rules.

## Result

- The 12 damaged days were regenerated one at a time: 12 succeeded, 0 failed.
- The reference journal was untouched.
- A final verification ran 10 checks, and all passed. They covered the scheduled task, the test suite, the structure of each regenerated file, the backup, and proof that the agents' own session files were never written to.
- The test suite ended at 314 passed, 2 failed and 4 skipped. The 2 failures were old tests that needed session files the agent tool had already deleted. They were not caused by the repair. (Those tests now use made-up test data.)

## Follow-up fixes the same week

- **Helper-agent noise.** Some agents start helper agents ("sub-agents") that write their own session files. The tracker counted them as separate conversations. A shared filter now recognizes them for Codex, Factory, OpenCode and Claude Code. On one busy day the journal went from 36 rows to 12. All 24 removed rows were Codex helper sessions, and no real conversation was dropped.
- **Better titles.** Some summaries started with a stock heading such as "Session Summary", so the table showed "(untitled)". The prompt now asks for a `TITLE:` line that names the goal of the conversation, and the parser skips stock headings.

## What I took from it

- An exit code of 0 with empty output is still a failure. Today an empty answer fails the JSON schema check, so the tracker retries once and then logs an error.
- Fix one layer, then check the real output again. Here, each fix looked complete until the output was checked.
- Protect good data before a repair: take a backup, keep a reference file, and make "do not overwrite" the default.
- A written log made it easy to see what changed and why.
