import io
import json
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import requests
from PIL import Image
from engine import Engine, Interrupted, asset_url, resume_plan, site_url


class Response:
    def __init__(self, data=b'', status=200, headers=None, fail=False):
        self.data = data
        self.status_code = status
        self.headers = requests.structures.CaseInsensitiveDict(headers or {})
        self.fail = fail
        self.closed = False
    def __enter__(self): return self
    def __exit__(self, *_): self.close()
    def close(self): self.closed = True
    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))
    def iter_content(self, _):
        if self.fail:
            yield self.data[:20]
            raise requests.ConnectionError('fixture interruption')
        yield self.data


class Session:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class PolicyTests(unittest.TestCase):
    def test_urls(self):
        self.assertEqual(site_url('https://www.mihuashi.com/artworks/12/'), 'https://www.mihuashi.com/artworks/12')
        self.assertEqual(site_url('https://www.mihuashi.com/users/abc', True), 'https://www.mihuashi.com/users/abc')
        for url in ['http://www.mihuashi.com/a', 'https://image-assets.mihuashi.com.evil.test/a', 'https://a:b@www.mihuashi.com/a', 'https://127.0.0.1/a', 'file:///a', 'https://www.mihuashi.com:8080/a']:
            with self.assertRaises(ValueError): asset_url(url)
    def test_200_never_appends(self):
        self.assertEqual(resume_plan(200, {'Content-Length':'100'}, 50, 'v1'), (False, 100))
    def test_valid_206(self):
        self.assertEqual(resume_plan(206, {'Content-Range':'bytes 50-99/100','Content-Length':'50','ETag':'v1'}, 50, 'v1'), (True, 100))
    def test_invalid_range_rejected(self):
        for headers in [
            {'Content-Range':'bytes 0-99/100'},
            {'Content-Range':'bytes 50-100/100'},
            {'Content-Range':'bytes 50-90/100'},
            {'Content-Range':'bytes 50-99/100','Content-Length':'40'},
            {'Content-Range':'bytes 50-99/*'},
            {'Content-Range':'bytes 50-99/100','Content-Encoding':'gzip'},
            {'Content-Range':'bytes 50-99/100','ETag':'v2'},
        ]:
            with self.assertRaises(ValueError): resume_plan(206, headers, 50, 'v1')


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = Engine(self.temp.name, start=False)
        self.job = self.engine.create_job({'source':'https://www.mihuashi.com/users/test', 'consent':True})['id']
        self.url = 'https://www.mihuashi.com/artworks/123'
        self.asset = 'https://image-assets.mihuashi.com/a.png'
        self.engine.discovery(self.job, {'links':[self.url], 'cursor':{'y':200}, 'expected':3})
        self.engine.parsed({'job':self.job, 'url':self.url, 'images':[{'url':self.asset,'width':800,'height':800}]})
        image = Image.new('RGB', (800,800), '#315b43')
        out = io.BytesIO(); image.save(out, format='PNG'); self.png=out.getvalue()
    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()
    def file(self):
        with self.engine.db() as db:
            return dict(db.execute('SELECT * FROM files WHERE job=?',(self.job,)).fetchone())
    def response(self, data=None, status=200, **headers):
        if data is None: data=self.png
        return Response(data,status,{'Content-Type':'image/png','Content-Length':str(len(data)),'ETag':'"v1"',**headers})
    def test_checkbox_not_required_and_no_confirmation_fabricated(self):
        jid=self.engine.create_job({'source':self.url})['id']
        with self.engine.db() as db:
            self.assertEqual(db.execute('SELECT consent_at FROM jobs WHERE id=?',(jid,)).fetchone()[0],0)
    def test_duplicate_submit_and_discovery(self):
        same = self.engine.create_job({'source':'https://www.mihuashi.com/users/test', 'consent':True})
        self.assertEqual(same['id'],self.job)
        self.engine.discovery(self.job,{'links':[self.url,self.url]})
        self.engine.parsed({'job':self.job,'url':self.url,'images':[{'url':self.asset}]})
        with self.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM works').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM files').fetchone()[0],1)
    def test_atomic_claim(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            results=list(pool.map(lambda _: self.engine.claim(),range(6)))
        self.assertEqual(sum(r is not None for r in results),1)
    def test_restart_requeues_only_unfinished(self):
        self.engine.claim()
        self.engine.close()
        self.engine = Engine(self.temp.name,start=False)
        self.assertEqual(self.file()['state'],'retry')
        self.assertEqual(json.loads(self.engine.next_browser()['scan']['cursor'])['y'],200)
    def test_full_download_and_hash(self):
        self.engine.download(Session(self.response()),self.engine.claim())
        record=self.file()
        self.assertEqual(record['state'],'complete')
        self.assertEqual((Path(self.temp.name)/record['path']).read_bytes(),self.png)
        self.assertEqual(record['bytes'],len(self.png))
    def test_correct_resume(self):
        record=self.file();part=Path(self.temp.name)/'parts'/(record['id']+'.part');part.write_bytes(self.png[:90])
        self.engine.update_file(record['id'],validator='"v1"')
        response=self.response(self.png[90:],206,**{'Content-Range':f'bytes 90-{len(self.png)-1}/{len(self.png)}'})
        session=Session(response)
        self.engine.download(session,self.engine.claim())
        self.assertEqual(session.calls[0][1]['headers']['Range'],'bytes=90-')
        self.assertEqual((Path(self.temp.name)/self.file()['path']).read_bytes(),self.png)
    def test_server_ignores_range_restarts(self):
        record=self.file();(Path(self.temp.name)/'parts'/(record['id']+'.part')).write_bytes(b'old bytes')
        self.engine.update_file(record['id'],validator='"old"')
        self.engine.download(Session(self.response()),self.engine.claim())
        self.assertEqual((Path(self.temp.name)/self.file()['path']).read_bytes(),self.png)
    def test_without_validator_restarts(self):
        record=self.file();(Path(self.temp.name)/'parts'/(record['id']+'.part')).write_bytes(b'invalid old')
        session=Session(self.response());self.engine.download(session,self.engine.claim())
        self.assertNotIn('Range',session.calls[0][1]['headers'])
    def test_truncated_transfer_can_resume_after_restart(self):
        record=self.engine.claim()
        response=self.response();response.fail=True
        with self.assertRaises(requests.ConnectionError): self.engine.download(Session(response),record)
        part=Path(self.temp.name)/'parts'/(record['id']+'.part')
        self.assertEqual(part.stat().st_size,20)
        self.engine.close();self.engine=Engine(self.temp.name,start=False)
        self.engine.download(Session(self.response(self.png[20:],206,**{'Content-Range':f'bytes 20-{len(self.png)-1}/{len(self.png)}'})),self.engine.claim())
        self.assertEqual(self.file()['state'],'complete')
    def test_bad_206_clears_partial(self):
        record=self.file();part=Path(self.temp.name)/'parts'/(record['id']+'.part');part.write_bytes(self.png[:90])
        self.engine.update_file(record['id'],validator='"v1"')
        with self.assertRaises(ValueError): self.engine.download(Session(self.response(self.png,206,**{'Content-Range':f'bytes 0-{len(self.png)-1}/{len(self.png)}'})),self.engine.claim())
        self.assertFalse(part.exists())
    def test_416_clears_bad_part(self):
        record=self.file();part=Path(self.temp.name)/'parts'/(record['id']+'.part');part.write_bytes(b'bad')
        self.engine.update_file(record['id'],validator='"v1"')
        self.engine.download(Session(Response(status=416)),self.engine.claim())
        self.assertEqual(self.file()['state'],'retry');self.assertFalse(part.exists())
    def test_403_does_not_stop_other_jobs(self):
        self.engine.download(Session(Response(status=403)),self.engine.claim())
        self.assertEqual(self.file()['state'],'blocked')
        self.assertIsNone(self.engine.meta('hold'))
    def test_429_holds_all_downloads(self):
        with self.assertRaises(Interrupted): self.engine.download(Session(Response(status=429,headers={'Retry-After':'120'})),self.engine.claim())
        self.assertEqual(self.engine.meta('hold')['code'],'429')
        self.assertIsNone(self.engine.claim())
        with self.assertRaises(ValueError): self.engine.clear_hold()
    def test_pause_stops_claim(self):
        self.engine.control(self.job,'pause');self.assertIsNone(self.engine.claim())
        self.engine.control(self.job,'resume');self.assertIsNotNone(self.engine.claim())
    def test_redirect_domain_guard(self):
        response=Response(status=302,headers={'Location':'http://127.0.0.1:8888/private'})
        session=Session(response)
        with self.assertRaises(ValueError): self.engine.download(session,self.engine.claim())
        self.assertEqual(len(session.calls),1)
    def test_non_image_response_rejected(self):
        with self.assertRaises(ValueError): self.engine.download(Session(Response(b'<html>login</html>',headers={'Content-Type':'text/html'})),self.engine.claim())
    def test_verified_same_url_reuses_file_without_network(self):
        self.engine.download(Session(self.response()),self.engine.claim())
        jid=self.engine.create_job({'source':self.url,'consent':True})['id']
        self.engine.parsed({'job':jid,'url':self.url,'images':[{'url':self.asset}]})
        session=Session()
        self.engine.download(session,self.engine.claim())
        self.assertEqual(session.calls,[])
        with self.engine.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM files WHERE state='complete'").fetchone()[0],2)
    def test_expired_link_can_be_reparsed_without_deleting_successes(self):
        self.engine.download(Session(Response(status=403)),self.engine.claim())
        self.engine.control(self.job,'refresh-links')
        work=self.engine.next_browser()['work']
        self.assertEqual(work['url'],self.url)
        self.engine.parsed({'job':self.job,'url':self.url,'images':[{'url':self.asset+'?fresh=1'}]})
        self.assertEqual(self.file()['url'],self.asset+'?fresh=1')
        self.assertEqual(self.file()['state'],'queued')
    def test_zip_contains_manifest_and_completed_file(self):
        self.engine.download(Session(self.response()),self.engine.claim())
        eid=self.engine.export(self.job)['id']
        for thread in self.engine.threads: thread.join(timeout=5)
        export=next(x for x in self.engine.snapshot()['exports'] if x['id']==eid)
        self.assertEqual(export['state'],'complete',export['error'])
        with zipfile.ZipFile(export['path']) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read('123/001.png'),self.png)
            self.assertEqual(json.loads(archive.read('manifest.json'))['job']['id'],self.job)


if __name__ == '__main__': unittest.main(verbosity=2)
