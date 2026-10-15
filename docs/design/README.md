# Design notes

These notes were written while the features were designed, before or during the build. They explain the reasons behind the code. The code is the final word: a few planned items were changed or not built (for example, the control page has no "conversation sources" page).

- [conversation-scan-optimization.md](conversation-scan-optimization.md): how normal runs find changed files fast without missing work, with measured results.
- [daily-agent-transcripts.md](daily-agent-transcripts.md): the per-agent parsers, the 4 AM workday, and the cleaned conversation store.
- [complete-daily-ai-summaries.md](complete-daily-ai-summaries.md): one AI call per day, schema checks, retries and fallbacks.
- [provider-control-room.md](provider-control-room.md): choosing Claude or Codex, the summary cache, and the local control page.
