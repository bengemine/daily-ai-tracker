# Echo: find and reopen an old AI conversation

Echo is a small local web app. You describe a conversation you half remember. Echo finds it in the Daily AI Tracker's archive and reopens the original Claude Code or Codex session in a terminal tab, in the folder where it ran.

Echo runs inside WSL (Windows Subsystem for Linux) and opens at http://127.0.0.1:4317.

## What it does

- Type what you remember and press Enter. Shift + Enter adds a new line. Ctrl + K moves to the search box.
- If exactly one strong, verified match is found and **Auto-open a clear match** is on, Echo opens it.
- If several conversations could match, Echo shows them as choices with the evidence it found. Pick one and select **Resume conversation**.
- If one match is found but Echo is not sure, it still asks you to choose.
- **Read saved conversation** shows the saved dialogue without starting an agent.
- **New Claude chat from summary** starts a fresh Claude chat that only gets the tracker's saved summary of the old chat (about 2,000 characters), plus the paths to the full saved dialogue. This is cheaper than resuming a long chat. In one test, resuming a long chat reloaded 156,168 tokens on the first message; the summary hand-off for the same chat was a 1,929-character first message.
- **Cancel search** stops the background search.

Resume works for Claude Code and Codex, for both Windows and WSL sessions. Other agents in the archive can be found and read, but not resumed.

## What it searches

1. The tracker's daily journals (the AI-written summaries).
2. The tracker's cleaned conversations (user prompts and visible agent replies). Days that belong to the same session are grouped.
3. Native Claude Code and Codex session files changed in the last 8 days, so recent work is findable before the tracker's next daily run. Echo reads them from your WSL home and, if you set `ECHO_WINDOWS_HOME`, from your Windows user folder.

A Python script (`catalog.py`) keeps these in a local SQLite full-text index under `~/.local/state/conversation-finder/`. It re-reads only changed files. The server refreshes the index every 5 minutes, and **Refresh archive** refreshes it now.

## How the search works

1. The server starts `codex exec` with `--sandbox read-only`, `--ephemeral` and `--ignore-user-config`, so Codex can read files and run read-only commands but cannot change anything. It removes `OPENAI_API_KEY` and `CODEX_API_KEY` from the child process, so Codex uses your normal saved login.
2. Codex runs `catalog.py search` and `catalog.py read` to try different words and read promising conversations. The prompt tells it that your memory and the saved conversations are data, not instructions.
3. Codex must answer in the JSON shape in `search-schema.json`: `single`, `multiple` or `none`, and for each match a session key, a confidence level, a reason, and a short evidence quote copied word for word.
4. The server checks every match before showing it:
   - The session key must exist in the local index.
   - The evidence quote must be at least 30 characters and must appear in that session's saved summary or dialogue (spaces and letter case are ignored). A match whose quote fails this check is still listed, but it can never open by itself.
   - For resume, the session ID must be a real UUID, the original session file must still exist, the working folder is read from that session file (not from the AI), and the folder must still exist.
5. Echo opens a match by itself only when Codex returned exactly one match, with high confidence, a verified evidence quote, and a resumable original session.

Echo never runs a command or path written by the AI. The resume command is built from fixed parts (`codex resume <id>` or `claude --resume <id>`) after the checks above.

The index stays on your machine. During a search, Codex sends the parts of conversations it reads to OpenAI under your account, so this is not offline. Searches count against your Codex usage.

## How resume works

Echo opens the agent in a new tab of Herdr, a terminal multiplexer for coding agents. It reuses a Herdr workspace for the same folder (or a parent project folder) when one exists, and creates one when it does not. If the conversation is already open in Herdr, Echo selects that tab instead of starting a second copy. If Herdr is not running, Echo starts it in Windows Terminal. A PowerShell helper (`show-herdr.ps1`) brings the window to the front.

Echo does not send your search text to the resumed agent. You continue there yourself.

## Requirements

- Windows with WSL. The service is a systemd user service, so WSL needs systemd turned on.
- Node.js 22 or later and Python 3 with SQLite FTS5, inside WSL.
- The Codex CLI, logged in (`codex login`).
- Herdr, for resume. Search and reading work without it.
- Windows Terminal, to start Herdr when it is not running.
- Claude Code installed where the original Claude sessions ran, to resume those.
- The Daily AI Tracker's output folder. Echo stops with an error if the folder is missing.

## Setup

1. Copy `echo.env.example` to `echo.env` and set your values:

   | Setting | Meaning | Default |
   |---|---|---|
   | `ECHO_WINDOWS_HOME` | Your Windows user folder as a WSL path, for example `/mnt/c/Users/you`. Needed for Windows sessions. | empty (Windows sessions are skipped) |
   | `ECHO_TRACKER` | The tracker's output folder as a WSL path. | `$ECHO_WINDOWS_HOME/ai-tracker`, or `~/ai-tracker` |
   | `WSL_DISTRO_NAME` | Your WSL distro name. | `Ubuntu` |
   | `ECHO_PORT` | Port for the web page. The Windows launchers expect 4317. | `4317` |
   | `ECHO_STATE` | Folder for the index and temporary files. | `~/.local/state/conversation-finder` |
   | `ECHO_MODEL` | Codex model for search. | Codex's default |
   | `ECHO_HERDR_BIN` | Path to the Herdr program. | `~/.local/bin/herdr` |

2. Start it from WSL with `bash start.sh`. The first run writes the user service `~/.config/systemd/user/echo-conversation-finder.service`, enables it, and starts it.
3. On Windows, double-click `Start Echo.cmd`. It starts the service through WSL if needed and opens the page. If Echo lives on a Windows drive instead of inside WSL, set `ECHO_WSL_DISTRO` in Windows or pass `-Distro` to `Start Echo.ps1`.
4. Optional: run `install-shortcut.ps1` in PowerShell. It adds a desktop shortcut named "Echo - Find a Conversation" with the hotkey Ctrl + Alt + E, and a Start-menu shortcut named "Echo".

To run it in the foreground instead, use `bash serve.sh`.

Useful service commands:

```bash
journalctl --user -u echo-conversation-finder.service    # logs
systemctl --user restart echo-conversation-finder.service
systemctl --user disable --now echo-conversation-finder.service
```

## Safety

- The server listens on 127.0.0.1 only. It rejects requests whose Host or Origin is not the local page.
- Every change request (search, cancel, resume) needs a random token that the page gets when it loads.
- The page sends a strict Content-Security-Policy.
- Echo never writes to the tracker's files or to the agents' session files. Resuming hands the session to the normal agent CLI, which manages its own files.

## Tests

Run `npm test` in this folder (or `npm run test:echo` at the repo root). The tests use temporary indexes and stub agents. They do not touch your real sessions. Currently 12 Node tests and 9 Python tests.

Measured on the author's machine: a warm readiness check took 329 ms, and restarting a stopped service through the Windows launcher took about 3 seconds (WSL already running).

## Fonts

The page bundles two fonts under `public/fonts/`: Syne (`display.woff2`) and IBM Plex Mono (`mono.woff2`). Both use the SIL Open Font License; the license files are next to the fonts.
