#!/usr/bin/env python3
"""Local conversation catalogue and read-only search tools for the finding agent."""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sqlite3
import sys

# Windows user folder as seen from WSL, for example /mnt/c/Users/me. Optional.
WINDOWS_HOME = os.environ.get('ECHO_WINDOWS_HOME', '')
# The tracker's output folder. The tracker's default is <user folder>/ai-tracker.
ROOT = pathlib.Path(os.environ.get('ECHO_TRACKER') or (pathlib.Path(WINDOWS_HOME) if WINDOWS_HOME else pathlib.Path.home()) / 'ai-tracker')
STATE = pathlib.Path(os.environ.get('ECHO_STATE', pathlib.Path.home() / '.local/state/conversation-finder'))
DB = STATE / 'catalog.sqlite'
UUID = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'


def local_path(value):
  value = str(value or '')
  if value.startswith('\\\\'):
    parts = [x for x in value.split('\\') if x]
    if len(parts) > 2 and parts[0].lower() in ('wsl$', 'wsl.localhost'):
      if parts[1].lower() != os.environ.get('WSL_DISTRO_NAME', 'Ubuntu').lower():
        return ''
      return '/' + '/'.join(parts[2:])
  if re.match(r'^[A-Za-z]:[\\/]', value):
    return '/mnt/' + value[0].lower() + '/' + value[3:].replace('\\', '/')
  return value if value.startswith('/') else ''


def connection(write=False):
  if write:
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(DB, timeout=30)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.executescript('''
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, stamp TEXT);
      CREATE TABLE IF NOT EXISTS docs(
        id INTEGER PRIMARY KEY, source TEXT UNIQUE, file TEXT, session_key TEXT,
        session_id TEXT, agent TEXT, project TEXT, date TEXT, title TEXT,
        summary TEXT, content TEXT, original TEXT, priority INTEGER
      );
      CREATE INDEX IF NOT EXISTS docs_session ON docs(session_key);
      CREATE INDEX IF NOT EXISTS docs_file ON docs(file);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(title, summary, content, content=docs, content_rowid=id);
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO search(rowid,title,summary,content) VALUES(new.id,new.title,new.summary,new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO search(search,rowid,title,summary,content) VALUES('delete',old.id,old.title,old.summary,old.content);
      END;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    ''')
  else:
    conn = sqlite3.connect('file:' + str(DB) + '?mode=ro', uri=True, timeout=30)
  conn.row_factory = sqlite3.Row
  return conn


def text_content(value):
  if isinstance(value, str):
    return value
  if isinstance(value, list):
    return '\n'.join(x.get('text', '') for x in value if isinstance(x, dict) and x.get('type') in ('text', 'input_text', 'output_text'))
  return ''


def usable(text):
  return bool(text.strip()) and not text.lstrip().startswith(('# AGENTS.md instructions', '<environment_context>', '<INSTRUCTIONS>', '<system-reminder>', '<local-command-caveat>', '<command-name>'))


def transcript(messages):
  result = []
  first = ''
  for message in messages:
    role = message.get('role', '')
    if role not in ('user', 'assistant'):
      continue
    body = text_content(message.get('content', ''))
    if not usable(body):
      continue
    if role == 'user' and not first:
      first = re.sub(r'\s+', ' ', body).strip()[:160]
    result.append(role.upper() + ': ' + body)
  return '\n\n'.join(result), first


def daily_docs(path):
  text = path.read_text(encoding='utf-8')
  date = '-'.join(path.parts[-3:])[:-3]
  for section_index, section in enumerate(re.split(r'(?m)^### ', text)[1:]):
    lines = section.splitlines()
    title = re.sub(r'^(?:<a[^>]*></a>)?\s*\d+\.\s*', '', lines[0]).strip()
    match = re.search(r'> \*\*(.+?)\*\* · (.*?) · .*?Chat: `([^`]+)`', section)
    if not match:
      continue
    agent, project, key = match.groups()
    sid_match = re.search(UUID, key)
    sid = sid_match.group() if sid_match else key.split(':')[-1]
    key = agent + ':' + sid
    summary = section[match.end():].strip()
    summary = re.sub(r'\nCleaned conversation:.*', '', summary, flags=re.S)
    yield dict(source=str(path) + '#' + key + ':' + str(section_index), file=str(path), session_key=key, session_id=sid, agent=agent, project=project, date=date, title=title, summary=summary, content='', original='', priority=3)


def cleaned_docs(path):
  data = json.loads(path.read_text(encoding='utf-8'))
  session = data.get('session') or {}
  if not session.get('id'):
    return
  content, title = transcript(data.get('messages', []))
  if not content:
    return
  original = ''
  state_path = path.parent / '.source-state.json'
  if state_path.exists():
    state = json.loads(state_path.read_text(encoding='utf-8'))
    if state.get('excluded'):
      return
    original = state.get('sourcePath', '')
  agent = session.get('agent', path.parent.parent.name)
  sid = session['id']
  yield dict(source=str(path), file=str(path), session_key=agent + ':' + sid, session_id=sid, agent=agent, project=session.get('project', ''), date=data.get('date', path.stem), title=title or 'Saved conversation', summary='', content=content, original=original, priority=1)


def live_doc(path, agent):
  sid = ''
  project = ''
  date = ''
  messages = []
  with path.open(encoding='utf-8', errors='replace') as stream:
    for line in stream:
      try:
        item = json.loads(line)
      except ValueError:
        continue
      if agent.startswith('Codex'):
        payload = item.get('payload') or {}
        if item.get('type') == 'session_meta':
          sid = payload.get('id', '')
          project = payload.get('cwd', '')
          if payload.get('source') in ('exec', 'subagent') or isinstance(payload.get('source'), dict):
            return
        if item.get('type') == 'response_item' and payload.get('type') == 'message':
          messages.append(payload)
      else:
        if item.get('isSidechain'):
          return
        sid = item.get('sessionId', sid)
        project = item.get('cwd', project)
        if item.get('type') in ('user', 'assistant') and isinstance(item.get('message'), dict):
          messages.append(item['message'])
      date = str(item.get('timestamp', date))[:10]
  content, title = transcript(messages)
  if not sid or not content:
    return
  yield dict(source=str(path), file=str(path), session_key=agent + ':' + sid, session_id=sid, agent=agent, project=project, date=date, title=title or 'Recent conversation', summary='', content=content, original=str(path), priority=0)


def sources():
  if not ROOT.is_dir():
    raise ValueError('Tracker folder is missing: ' + str(ROOT))
  for year in sorted(ROOT.glob('20[0-9][0-9]')):
    for path in year.glob('*/*.md'):
      yield path, daily_docs, None
  for path in (ROOT / 'conversations').glob('*/*/20*.json'):
    yield path, cleaned_docs, None
  cutoff = (dt.datetime.now().timestamp() - 8 * 86400)
  homes = [(pathlib.Path.home(), ' (WSL)')] + ([(pathlib.Path(WINDOWS_HOME), '')] if WINDOWS_HOME else [])
  for home, suffix in homes:
    for folder, glob, agent in [('.codex/sessions', '*/*/*/*.jsonl', 'Codex'), ('.claude/projects', '*/*.jsonl', 'Claude Code')]:
      for path in (home / folder).glob(glob):
        if path.stat().st_mtime >= cutoff:
          yield path, live_doc, agent + suffix


def build():
  conn = connection(True)
  seen = set()
  updated = 0
  warnings = 0
  for path, parser, agent in sources():
    name = str(path)
    seen.add(name)
    stat = path.stat()
    stamp = str(stat.st_mtime_ns) + ':' + str(stat.st_size)
    state = path.parent / '.source-state.json'
    if parser == cleaned_docs and state.exists():
      stamp += ':' + str(state.stat().st_mtime_ns)
    previous = conn.execute('SELECT stamp FROM files WHERE path=?', (name,)).fetchone()
    if previous and previous['stamp'] == stamp:
      continue
    try:
      docs = list(parser(path, agent) if agent else parser(path))
    except (ValueError, OSError, TypeError, KeyError):
      warnings += 1
      continue
    conn.execute('DELETE FROM docs WHERE file=?', (name,))
    for doc in docs:
      conn.execute('INSERT INTO docs(source,file,session_key,session_id,agent,project,date,title,summary,content,original,priority) VALUES(:source,:file,:session_key,:session_id,:agent,:project,:date,:title,:summary,:content,:original,:priority)', doc)
    conn.execute('INSERT OR REPLACE INTO files VALUES(?,?)', (name, stamp))
    updated += 1
    if updated % 100 == 0:
      conn.commit()
      print(json.dumps({'phase': 'indexing', 'files': updated}), flush=True)
  for row in conn.execute('SELECT path FROM files').fetchall():
    # Keep older native sessions once indexed; remove only files actually deleted.
    if row['path'] not in seen and not pathlib.Path(row['path']).exists():
      conn.execute('DELETE FROM docs WHERE file=?', (row['path'],))
      conn.execute('DELETE FROM files WHERE path=?', (row['path'],))
  conn.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('indexedAt', dt.datetime.now(dt.timezone.utc).isoformat()))
  conn.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('warnings', str(warnings)))
  conn.commit()
  print(json.dumps({**stats(conn), 'updatedFiles': updated}), flush=True)


def stats(conn):
  row = conn.execute('SELECT COUNT(DISTINCT session_key) AS sessions, MIN(date) AS earliest, MAX(date) AS latest FROM docs').fetchone()
  return {**dict(row), 'agents': [dict(r) for r in conn.execute('SELECT agent,COUNT(DISTINCT session_key) AS count FROM docs GROUP BY agent ORDER BY count DESC')], **dict(conn.execute('SELECT key,value FROM meta').fetchall())}


def session(conn, key, include_content=False):
  rows = conn.execute('SELECT * FROM docs WHERE session_key=? ORDER BY priority DESC,date DESC', (key,)).fetchall()
  if not rows:
    return None
  top = dict(rows[0])
  result = {k: top[k] for k in ('session_key','session_id','agent','project','title')}
  result.update(date=max(r['date'] for r in rows), firstDate=min(r['date'] for r in rows), summary=next((r['summary'] for r in rows if r['summary']), ''), originals=list(dict.fromkeys(r['original'] for r in rows if r['original'])), files=list(dict.fromkeys(r['file'] for r in rows)))
  if include_content:
    result['documents'] = [{k: r[k] for k in ('date','file','summary','content')} for r in rows]
  return result


def handoff(conn, key):
  """Saved summaries plus cleaned-dialogue files, for starting a fresh chat instead of a full resume."""
  rows = conn.execute('SELECT date,title,summary,file,priority FROM docs WHERE session_key=? ORDER BY date,id', (key,)).fetchall()
  if not rows:
    raise ValueError('Conversation not found')
  summaries = [{'date': r['date'], 'title': r['title'], 'summary': r['summary'].strip()} for r in rows if r['priority'] == 3 and r['summary'].strip()]
  transcripts = []
  for r in rows:
    if r['priority'] == 1:
      readable = pathlib.Path(r['file']).with_suffix('.md')
      transcripts.append(str(readable) if readable.exists() else r['file'])
  return {'summaries': summaries, 'transcripts': list(dict.fromkeys(transcripts))}


def search(conn, query, mode='all', limit=15, agent='', after=''):
  exact_id = re.search(UUID, query)
  if exact_id:
    keys = conn.execute('SELECT DISTINCT session_key FROM docs WHERE session_id=? AND agent LIKE ? AND date>=?', (exact_id.group(), '%' + agent + '%', after)).fetchall()
    return [session(conn, row['session_key']) for row in keys][:limit]
  terms = re.findall(r'[\w]+', query, flags=re.UNICODE)[:30]
  if not terms:
    return []
  expression = (' OR ' if mode == 'any' else ' AND ').join('"' + t.replace('"', '""') + '"' for t in terms)
  rows = conn.execute('''SELECT d.session_key,snippet(search, -1, '', '', ' … ', 42) AS excerpt,
    bm25(search, 7.0, 4.0, 1.0) AS score FROM search JOIN docs d ON d.id=search.rowid
    WHERE search MATCH ? AND d.agent LIKE ? AND d.date >= ? ORDER BY score LIMIT 200''', (expression, '%' + agent + '%', after)).fetchall()
  found = []
  seen = set()
  for row in rows:
    if row['session_key'] in seen:
      continue
    seen.add(row['session_key'])
    detail = session(conn, row['session_key'])
    detail.pop('files')
    detail.pop('originals')
    detail['summary'] = detail['summary'][:1800]
    detail['excerpt'] = row['excerpt'][:1200]
    found.append(detail)
    if len(found) >= limit:
      break
  return found


def main():
  parser = argparse.ArgumentParser(description='Search saved AI conversations. Search all terms first, then try synonyms or --mode any. Read promising sessions to verify.')
  subs = parser.add_subparsers(dest='command', required=True)
  subs.add_parser('build')
  subs.add_parser('stats')
  s = subs.add_parser('search')
  s.add_argument('--query', required=True)
  s.add_argument('--mode', choices=['all','any'], default='all')
  s.add_argument('--limit', type=int, default=15)
  s.add_argument('--agent', default='')
  s.add_argument('--after', default='')
  r = subs.add_parser('read')
  r.add_argument('--key', required=True)
  r.add_argument('--query', default='')
  r.add_argument('--offset', type=int, default=0)
  r.add_argument('--limit', type=int, default=24000)
  d = subs.add_parser('detail')
  d.add_argument('--key', required=True)
  h = subs.add_parser('handoff')
  h.add_argument('--key', required=True)
  v = subs.add_parser('verify')
  v.add_argument('--key', required=True)
  v.add_argument('--evidence', required=True)
  recent = subs.add_parser('recent')
  recent.add_argument('--limit', type=int, default=6)
  args = parser.parse_args()
  if args.command == 'build':
    build()
    return
  conn = connection()
  if args.command == 'stats':
    result = stats(conn)
  elif args.command == 'search':
    result = search(conn, args.query, args.mode, min(max(args.limit,1),40), args.agent, args.after)
  elif args.command == 'handoff':
    result = handoff(conn, args.key)
  elif args.command == 'recent':
    keys = conn.execute('SELECT session_key,MAX(date) AS last FROM docs GROUP BY session_key ORDER BY last DESC,MAX(id) DESC LIMIT ?', (min(args.limit,20),))
    result = [session(conn, r['session_key']) for r in keys]
  elif args.command == 'verify':
    normalize = lambda value: re.sub(r'\s+', ' ', value).strip().lower()
    needle = normalize(args.evidence)
    rows = conn.execute('SELECT summary, content FROM docs WHERE session_key=?', (args.key,)).fetchall()
    result = {'verified': len(needle) >= 30 and any(needle in normalize(r['summary'] + '\n' + r['content']) for r in rows)}
  else:
    result = session(conn, args.key, args.command == 'read')
    if not result:
      raise ValueError('Conversation not found')
    if args.command == 'read':
      docs = result.pop('documents')
      content = '\n\n'.join('DATE: ' + d['date'] + '\n' + (d['content'] or d['summary']) for d in docs)
      if args.query:
        terms = re.findall(r'\w+', args.query.lower())
        windows = []
        for match in re.finditer('|'.join(re.escape(t) for t in terms), content, re.I) if terms else []:
          start, end = max(0,match.start()-700), min(len(content),match.end()+1600)
          if windows and start <= windows[-1][1]:
            windows[-1] = (windows[-1][0],end)
          else:
            windows.append((start,end))
        content = '\n\n[…]\n\n'.join(content[start:end] for start,end in windows)
      limit = min(max(args.limit,100),60000)
      offset = max(args.offset,0)
      result['totalCharacters'] = len(content)
      result['text'] = content[offset:offset+limit]
      result['nextOffset'] = offset+limit if offset+limit < len(content) else None
  print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
  try:
    main()
  except Exception as error:
    print(json.dumps({'error': str(error)}), file=sys.stderr)
    sys.exit(1)
