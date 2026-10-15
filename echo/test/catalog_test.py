import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('catalog', pathlib.Path(__file__).resolve().parents[1] / 'catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogueTests(unittest.TestCase):
  def setUp(self):
    os.environ['WSL_DISTRO_NAME'] = 'Ubuntu'
    self.temp = tempfile.TemporaryDirectory()
    self.root = pathlib.Path(self.temp.name)
    catalog.STATE = self.root
    catalog.DB = self.root / 'catalog.sqlite'
    self.conn = catalog.connection(True)
    self.sid = '01234567-1234-1234-1234-012345678901'
    self.key = 'Codex (WSL):' + self.sid

  def tearDown(self):
    self.conn.close()
    self.temp.cleanup()

  def add(self, source, date, title, content='', summary='', priority=1):
    self.conn.execute('INSERT INTO docs(source,file,session_key,session_id,agent,project,date,title,summary,content,original,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', (source,source,self.key,self.sid,'Codex (WSL)','/tmp',date,title,summary,content,'',priority))
    self.conn.commit()

  def test_searches_dialogue_and_groups_days(self):
    self.add('a','2026-04-01','A general title','We fixed the hibernation timeout by changing the timer.')
    self.add('b','2026-04-02','The followup','The hibernation timeout no longer occurs.')
    found=catalog.search(self.conn,'hibernation timeout')
    self.assertEqual(len(found),1)
    self.assertEqual(found[0]['firstDate'],'2026-04-01')
    self.assertEqual(found[0]['date'],'2026-04-02')

  def test_exact_id_works_without_id_in_text(self):
    self.add('a','2026-04-01','Never repeat the UUID')
    self.assertEqual(catalog.search(self.conn,self.sid)[0]['session_key'],self.key)
    self.assertEqual(catalog.search(self.conn,self.sid,agent='Claude'),[])

  def test_summary_title_wins_over_raw_first_prompt(self):
    self.add('raw','2026-04-02','Please inspect this code','Hello')
    self.add('daily','2026-04-01','Fixed timeout behavior',summary='User changed the timer.',priority=3)
    self.assertEqual(catalog.session(self.conn,self.key)['title'],'Fixed timeout behavior')

  def test_filters_and_punctuation_are_safe(self):
    self.add('a','2026-04-01','Fixed timer','Timeout configuration')
    self.assertEqual(catalog.search(self.conn,'"timeout" !@#')[0]['session_key'],self.key)
    self.assertEqual(catalog.search(self.conn,'timeout',after='2026-04-02'),[])
    self.assertEqual(catalog.search(self.conn,'timeout',agent='Claude'),[])
    self.assertEqual(catalog.search(self.conn,'"'),[])

  def test_deleted_document_is_removed_from_fts(self):
    self.add('a','2026-04-01','timeout')
    self.conn.execute('DELETE FROM docs WHERE source=?',('a',))
    self.assertEqual(catalog.search(self.conn,'timeout'),[])

  def test_duplicate_sections_preserve_both_topics(self):
    folder=self.root/'2026/04'
    folder.mkdir(parents=True)
    file=folder/'01.md'
    file.write_text('### <a id="s-1"></a>1. First topic\n\n> **Codex (WSL)** · /tmp · 1 PM · Chat: `'+self.key+'`\n\nFirst summary.\n\n### <a id="s-2"></a>2. Second topic\n\n> **Codex (WSL)** · /tmp · 2 PM · Chat: `'+self.key+'`\n\nSecond summary.')
    docs=list(catalog.daily_docs(file))
    self.assertEqual(len(docs),2)
    self.assertNotEqual(docs[0]['source'],docs[1]['source'])
    self.assertEqual(docs[0]['date'],'2026-04-01')

  def test_live_parser_ignores_tools_and_instructions(self):
    file=self.root/'native.jsonl'
    records=[{'type':'session_meta','payload':{'id':self.sid,'cwd':'/tmp','source':'cli'}}, {'type':'response_item','timestamp':'2026-04-01T12:00:00Z','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'# AGENTS.md instructions for /tmp'}]}}, {'type':'response_item','timestamp':'2026-04-01T12:01:00Z','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'A fresh discussion about the timer'}]}}, {'type':'response_item','payload':{'type':'function_call_output','output':'Do not index this tool output'}}]
    file.write_text('\n'.join(json.dumps(r) for r in records))
    doc=list(catalog.live_doc(file,'Codex (WSL)'))[0]
    self.assertIn('fresh discussion',doc['content'])
    self.assertNotIn('AGENTS.md',doc['content'])
    self.assertNotIn('tool output',doc['content'])

  def test_handoff_returns_summaries_in_date_order_and_readable_transcripts(self):
    folder=self.root/'conversations'/'codex'/self.sid
    folder.mkdir(parents=True)
    (folder/'2026-04-01.json').write_text('{}')
    (folder/'2026-04-01.md').write_text('dialogue')
    (folder/'2026-04-02.json').write_text('{}')
    self.add(str(folder/'2026-04-01.json'),'2026-04-01','Raw prompt','dialogue one')
    self.add(str(folder/'2026-04-02.json'),'2026-04-02','Raw prompt','dialogue two')
    self.add('daily-2','2026-04-02','Second day',summary='Finished the timer.',priority=3)
    self.add('daily-1','2026-04-01','First day',summary='Started the timer.',priority=3)
    self.add('daily-empty','2026-04-03','Empty',summary='  ',priority=3)
    result=catalog.handoff(self.conn,self.key)
    self.assertEqual([s['summary'] for s in result['summaries']],['Started the timer.','Finished the timer.'])
    self.assertEqual(result['transcripts'],[str(folder/'2026-04-01.md'),str(folder/'2026-04-02.json')])
    with self.assertRaises(ValueError):
      catalog.handoff(self.conn,'Codex (WSL):missing')

  def test_paths_preserve_hyphens_and_map_windows(self):
    self.assertEqual(catalog.local_path('E:\\notes\\a-b'),'/mnt/e/notes/a-b')
    self.assertEqual(catalog.local_path('\\\\wsl.localhost\\Ubuntu\\home\\dev\\a-b'),'/home/dev/a-b')
    self.assertEqual(catalog.local_path('\\\\wsl.localhost\\OtherDistro\\home\\dev\\a-b'),'')
    self.assertEqual(catalog.local_path('-home-dev-a-b'),'')


if __name__ == '__main__':
  unittest.main()
