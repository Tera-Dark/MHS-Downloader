"""0.8 policy regressions: explicit intent, atomic budgets and bounded recovery."""
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from engine import Engine
from queue_service import settings


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.e=Engine(self.temp.name,start=False)
    def tearDown(self):
        self.e.close();self.temp.cleanup()
    def create(self,**kw):
        return self.e.create_job(dict(source='https://www.mihuashi.com/profiles/900001',mode='links',start=True,**kw))['id']
    def row(self,jid):
        with self.e.db() as db:return dict(db.execute('SELECT * FROM jobs WHERE id=?',(jid,)).fetchone())
    def discover(self,jid,ids,state='running',expected=91):
        return self.e.discovery(jid,dict(revision=self.row(jid)['revision'],links=['https://www.mihuashi.com/artworks/'+str(i) for i in ids],state=state,expected=expected,cursor={'y':500,'container':'div.scroll'}))
    def parse(self,jid,i,n=1):
        return self.e.parsed(dict(job=jid,revision=self.row(jid)['revision'],url='https://www.mihuashi.com/artworks/'+str(i),images=[dict(url='https://image-assets.mihuashi.com/test'+str(x)+'.png',width=800,height=800) for x in range(n)]))
    def test_legacy_upgrade_creates_backup_before_mutation(self):
        import sqlite3
        from engine import TransferEngine
        folder=Path(self.temp.name)/'legacy';old=TransferEngine(folder,start=False)
        with old.db() as db:
            db.execute("INSERT INTO jobs(id,source,mode,state,consent_at,created,updated) VALUES(?,?,?,'active',0,1,1)",('c'*32,'https://www.mihuashi.com/profiles/1','links'))
        old.close();new=Engine(folder,start=False)
        try:
            backup=sqlite3.connect(folder/'archive.pre-0.8.0.sqlite3')
            try:
                self.assertEqual(backup.execute('SELECT state FROM jobs').fetchone()[0],'active')
                self.assertNotIn('revision',[r[1] for r in backup.execute('PRAGMA table_info(jobs)')])
            finally:backup.close()
            self.assertEqual(new.snapshot()['jobs'][0]['state'],'paused')
        finally:new.close()
    def test_no_target_default(self):
        with self.assertRaises(ValueError):self.e.create_job({})
        self.assertEqual(self.e.snapshot()['jobs'],[])
    def test_create_without_start_stays_paused(self):
        result=self.e.create_job({'source':'https://www.mihuashi.com/artworks/1'})
        self.assertFalse(result['started']);self.assertEqual(self.row(result['id'])['state'],'paused');self.assertIsNone(self.e.next_browser()['work'])
    def test_existing_submission_never_resumes(self):
        jid=self.create();self.e.control(jid,'pause')
        result=self.e.create_job({'source':self.row(jid)['source'],'mode':'links','start':True})
        self.assertTrue(result['existing']);self.assertFalse(result['started']);self.assertEqual(self.row(jid)['state'],'paused')
    def test_restart_pauses_and_retains_history(self):
        jid=self.create();self.discover(jid,range(1,15));old_boot=self.e.boot_id
        self.e.close();self.e=Engine(self.temp.name,start=False)
        self.assertNotEqual(old_boot,self.e.boot_id);self.assertEqual(self.row(jid)['state'],'paused');self.assertIsNone(self.e.next_browser()['scan'])
        self.assertEqual(len(json.loads(self.row(jid)['cursor'])['found']),14)
        self.assertEqual(self.e.snapshot()['events'][0]['kind'],'engine_start')
    def test_atomic_work_limit(self):
        jid=self.create(settings={'max_works':20,'max_images':0})
        with ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(lambda i:self.discover(jid,range(i*20,(i+1)*20)),range(8)))
        self.assertEqual(sum(self.e.snapshot()['jobs'][0]['works'].values()),20);self.assertEqual(self.row(jid)['scan_state'],'limited')
    def test_atomic_image_limit(self):
        jid=self.create(settings={'max_works':0,'max_images':7});self.discover(jid,range(1,21))
        with ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(lambda i:self.parse(jid,i,3),range(1,21)))
        self.assertEqual(sum(self.e.snapshot()['jobs'][0]['files'].values()),7);self.assertEqual(self.row(jid)['scan_state'],'limited')
    def test_zero_means_safety_ceiling(self):
        jid=self.create(settings={'max_works':0,'max_images':0});self.discover(jid,range(1,151),expected=150)
        self.assertEqual(sum(self.e.snapshot()['jobs'][0]['works'].values()),150)
    def test_partial_retry_backoff_and_exhaustion(self):
        jid=self.create(settings={'scan_retries':2});self.discover(jid,range(1,15),state='partial')
        self.assertEqual(self.row(jid)['scan_state'],'retry_wait');self.assertIsNone(self.e.next_browser()['scan'])
        for attempt in [1,2]:
            with self.e.db() as db:db.execute('UPDATE jobs SET scan_next=0 WHERE id=?',(jid,))
            scan=self.e.next_browser()['scan'];self.assertEqual(json.loads(scan['cursor'])['pass'],attempt)
            self.assertTrue(json.loads(scan['cursor'])['reset']);self.assertEqual(len(json.loads(scan['cursor'])['found']),14)
            self.discover(jid,range(1,15),state='partial')
        self.assertEqual(self.row(jid)['scan_state'],'partial');self.assertEqual(self.row(jid)['scan_attempt'],2);self.assertIsNone(self.e.next_browser()['scan'])
    def test_retry_can_recover_14_of_91_without_duplicates(self):
        jid=self.create();self.discover(jid,range(1,15),state='partial')
        with self.e.db() as db:db.execute('UPDATE jobs SET scan_next=0 WHERE id=?',(jid,))
        self.e.next_browser();self.discover(jid,range(1,92),state='finished')
        self.assertEqual(self.row(jid)['scan_state'],'finished');self.assertEqual(sum(self.e.snapshot()['jobs'][0]['works'].values()),91)
    def test_user_limit_is_not_partial_failure(self):
        jid=self.create(settings={'max_works':14});self.discover(jid,range(1,92),state='partial')
        self.assertEqual(self.row(jid)['scan_state'],'limited');self.assertEqual(self.row(jid)['scan_attempt'],0)
    def test_disable_auto_recovery(self):
        jid=self.create(settings={'scan_retries':0});self.discover(jid,[1],state='partial');self.assertEqual(self.row(jid)['scan_state'],'partial')
    def test_stale_discovery_and_parse_after_pause_resume(self):
        jid=self.create();rev=self.row(jid)['revision'];self.discover(jid,[1]);self.e.control(jid,'pause');self.e.control(jid,'resume')
        r=self.e.discovery(jid,dict(revision=rev,links=['https://www.mihuashi.com/artworks/2']))
        self.assertTrue(r['stale'])
        r=self.e.parsed(dict(job=jid,revision=rev,url='https://www.mihuashi.com/artworks/1',images=[{'url':'https://image-assets.mihuashi.com/a.png'}]))
        self.assertTrue(r['stale']);self.assertEqual(sum(self.e.snapshot()['jobs'][0]['works'].values()),1);self.assertEqual(self.e.snapshot()['jobs'][0]['files'],{})
    def test_revision_is_required(self):
        jid=self.create();self.assertTrue(self.e.discovery(jid,{'links':[]})['stale'])
    def test_raise_image_limit_recovers_rest_of_same_work(self):
        jid=self.create(settings={'max_images':2});self.discover(jid,[1]);self.parse(jid,1,5)
        self.assertEqual(self.e.snapshot()['jobs'][0]['works'],{'limited_images':1})
        self.e.control(jid,'configure',{'max_images':5});self.parse(jid,1,5)
        self.assertEqual(sum(self.e.snapshot()['jobs'][0]['files'].values()),5);self.assertEqual(self.e.snapshot()['jobs'][0]['works'],{'ready':1})
    def test_limit_cannot_delete_reserved_data(self):
        jid=self.create();self.discover(jid,[1,2]);self.parse(jid,1,3)
        for conf in [{'max_works':1},{'max_images':2}]:
            with self.assertRaises(ValueError):self.e.control(jid,'configure',conf)
        self.assertEqual(sum(self.e.snapshot()['jobs'][0]['files'].values()),3)
    def test_settings_validation(self):
        for bad in [None,[],{'max_images':True},{'max_works':1.1},{'concurrency':9},{'scan_retries':-1},{'page_delay':float('nan')}]:
            with self.assertRaises(ValueError):settings(bad)
    def test_per_job_transfer_concurrency(self):
        jid=self.e.create_job(dict(source='https://www.mihuashi.com/profiles/900001',start=True,settings={'concurrency':2}))['id']
        self.discover(jid,[1]);self.parse(jid,1,8)
        with ThreadPoolExecutor(max_workers=8) as pool:claimed=list(pool.map(lambda _:self.e.claim(),range(8)))
        self.assertEqual(sum(x is not None for x in claimed),2)
    def test_pause_all_and_archive_preserve_files(self):
        jid=self.create();self.discover(jid,[1]);self.parse(jid,1);self.e.pause_all();self.assertEqual(self.row(jid)['state'],'paused')
        self.e.control(jid,'archive');self.assertEqual(self.e.snapshot()['jobs'][0]['state'],'archived');self.assertEqual(self.e.snapshot()['jobs'][0]['files'],{'link':1})
    def test_diagnostic_and_event_explain_start(self):
        jid=self.create();self.discover(jid,[1]);d=self.e.diagnostic(jid)
        self.assertEqual(d['job']['trigger'],'manual_start');self.assertNotIn('pairing-token',json.dumps(d));self.assertTrue(any(e['kind']=='manual_start' for e in self.e.snapshot()['events']))

if __name__=='__main__':unittest.main(verbosity=2)
