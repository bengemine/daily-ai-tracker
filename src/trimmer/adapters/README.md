# Trimmer Adapter Contract

Each file in this directory implements a per-agent parser that strips raw
conversation data down to natural-language turns only.

## Exports

Every adapter module must export a single async function named `parse`:

```js
/**
 * @param {string | object} source
 *   - A file path (string) pointing to a JSONL transcript or SQLite database.
 *   - A raw JSONL string (multi-line text, no file I/O needed).
 *   - A better-sqlite3 Database handle (opened READ-ONLY by the caller).
 * @param {import('../types').TrimOptions} options
 * @returns {Promise<{
 *   messages: import('../types').CleanTurn[],
 *   stats: Partial<import('../types').TrimStats>,
 *   warnings: string[]
 * }>}
 */
async function parse(source, options) { ... }

module.exports = { parse };
```

## READ-ONLY Invariant (HARD RULE — never relax)

Adapters MUST NOT write, modify, delete, rename, or lock any file under:

- `~/.claude/`
- `~/.codex/`
- Cursor's `state.vscdb` (workspace or global)
- `~/.factory/`
- `~/.local/share/opencode/`

**Enforcement rules:**

- JSONL sources: use `fs.createReadStream` only. Never `fs.open` with
  write/append flags. Never `fs.writeFile` or `fs.appendFile` targeting
  these paths.
- SQLite sources: open with `readonly: true` (better-sqlite3) or `mode=ro`
  in the connection string. Never issue UPDATE, INSERT, or DELETE statements.
- All cleaned output lives in memory only. If a caching layer is ever added,
  the cache path must be inside the Daily AI Tracker project directory — never
  back in the adapter's own store.

## What to keep / drop

| Block / event type                        | Action          |
|-------------------------------------------|-----------------|
| `role: 'user'` natural-language message   | Keep as-is      |
| `role: 'assistant'` natural-language text | Keep as-is      |
| `type: 'thinking'` blocks                 | Drop            |
| `type: 'tool_use'` blocks                 | Drop (or note)  |
| `type: 'tool_result'` blocks              | Drop (or note)  |
| `type: 'system'` / system-reminder lines  | Drop            |
| `type: 'summary'` / `type: 'progress'`   | Drop            |
| `isSidechain: true` / `isMeta: true`      | Drop            |
| File dump / attachment blobs              | Drop            |

When `options.keepToolNotes` is true, add a short `actionNote` string to the
`CleanTurn` instead of silently removing tool blocks (e.g. `"[Tool: Edit]"`).

## Worked Example — Claude Code JSONL

Raw JSONL line from `~/.claude/projects/<hash>/conversation.jsonl`:

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "Let me check the file..." },
      { "type": "tool_use", "name": "Read", "input": { "file_path": "/src/index.js" } },
      { "type": "text", "text": "I've read the file. Here's what I found: the function is missing error handling." }
    ]
  },
  "timestamp": "2026-04-21T10:23:45.123Z"
}
```

After parsing with `flattenContentBlocks`:

```json
{
  "role": "assistant",
  "content": "I've read the file. Here's what I found: the function is missing error handling.",
  "timestamp": "2026-04-21T10:23:45.123Z"
}
```

The `thinking` and `tool_use` blocks are discarded. Only the `text` block survives.
