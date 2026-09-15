"""Loopback API integration using a disposable data directory, no website access."""
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import requests


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); cls.port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{cls.port}/v1'
        cls.origin = 'chrome-extension://' + 'a' * 32
        cls.process = subprocess.Popen([sys.executable, str(Path(__file__).resolve().parents[1] / 'native/server.py'), '--data', cls.temp.name, '--port', str(cls.port), '--workers', '1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.session = requests.Session(); cls.session.trust_env = False
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                token = (Path(cls.temp.name) / 'pairing-token.txt').read_text().strip()
                cls.headers = {'Origin':cls.origin, 'Authorization':'Bearer '+token}
                response = cls.session.post(cls.base+'/pair', headers=cls.headers, json={}, timeout=1)
                if response.status_code == 200: break
            except (OSError, requests.RequestException): pass
            time.sleep(0.05)
        else:
            cls.process.terminate(); cls.process.wait(timeout=5)
            raise AssertionError('Test API failed to start')
    @classmethod
    def tearDownClass(cls):
        cls.session.close(); cls.process.terminate(); cls.process.wait(timeout=30); cls.temp.cleanup()
    def test_paired_state(self):
        response=self.session.get(self.base+'/state',headers=self.headers,timeout=3)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'],self.origin)
    def test_bad_token_denied(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'Authorization':'Bearer invalid'},timeout=3)
        self.assertEqual(response.status_code,401)
    def test_web_origin_denied(self):
        response=self.session.post(self.base+'/pair',headers={**self.headers,'Origin':'https://www.mihuashi.com'},json={},timeout=3)
        self.assertEqual(response.status_code,403)
        self.assertNotIn('Access-Control-Allow-Origin',response.headers)
    def test_unpaired_extension_denied(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'Origin':'chrome-extension://'+'b'*32},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_host_rebinding_denied(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'Host':'attacker.invalid'},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_preflight(self):
        response=self.session.options(self.base+'/state',headers={'Origin':self.origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'},timeout=3)
        self.assertEqual(response.status_code,204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'],self.origin)
    def test_job_roundtrip_and_pause(self):
        response=self.session.post(self.base+'/jobs',headers=self.headers,json={'source':'https://www.mihuashi.com/artworks/999','mode':'links','consent':True},timeout=3)
        self.assertEqual(response.status_code,200,response.text)
        jid=response.json()['id']
        response=self.session.post(self.base+f'/jobs/{jid}/control',headers=self.headers,json={'action':'pause'},timeout=3)
        self.assertEqual(response.status_code,200)
        jobs=self.session.get(self.base+'/state',headers=self.headers,timeout=3).json()['jobs']
        self.assertEqual(next(j for j in jobs if j['id']==jid)['state'],'paused')
    def test_task_without_checkbox_is_accepted(self):
        response=self.session.post(self.base+'/jobs',headers=self.headers,json={'source':'https://www.mihuashi.com/artworks/111'},timeout=3)
        self.assertEqual(response.status_code,200)
    def test_ssrf_url_denied(self):
        response=self.session.post(self.base+'/jobs',headers=self.headers,json={'source':'http://127.0.0.1/internal','consent':True},timeout=3)
        self.assertEqual(response.status_code,400)

    def test_get_without_origin_with_client_header(self):
        headers={'Authorization':self.headers['Authorization'],'X-Archive-Extension':'a'*32}
        response=self.session.get(self.base+'/state',headers=headers,timeout=3)
        self.assertEqual(response.status_code,200,response.text)
        self.assertNotIn('Access-Control-Allow-Origin',response.headers)
    def test_identity_header_alone_is_not_authentication(self):
        response=self.session.get(self.base+'/state',headers={'X-Archive-Extension':'a'*32},timeout=3)
        self.assertEqual(response.status_code,401)
    def test_no_origin_no_identity_rejected(self):
        response=self.session.get(self.base+'/state',headers={'Authorization':self.headers['Authorization']},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_web_origin_cannot_spoof_identity_header(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'Origin':'https://evil.invalid','X-Archive-Extension':'a'*32},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_null_origin_rejected(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'Origin':'null','X-Archive-Extension':'a'*32},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_origin_identity_mismatch_rejected(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'X-Archive-Extension':'b'*32},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_unpaired_identity_without_origin_rejected(self):
        response=self.session.get(self.base+'/state',headers={'Authorization':self.headers['Authorization'],'X-Archive-Extension':'d'*32},timeout=3)
        self.assertEqual(response.status_code,403)
    def test_pairing_without_origin_with_valid_token(self):
        headers={'Authorization':self.headers['Authorization'],'X-Archive-Extension':'c'*32}
        response=self.session.post(self.base+'/pair',headers=headers,json={},timeout=3)
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.session.get(self.base+'/state',headers=headers,timeout=3).status_code,200)
    def test_health_probe_exposes_no_private_data(self):
        response=self.session.get(self.base+'/health',timeout=3)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(),{'service':'artwork-archive-hybrid','version':'0.7.1','protocol':2})
    def test_invalid_non_ascii_token_is_401_not_a_crash(self):
        response=self.session.get(self.base+'/state',headers={**self.headers,'Authorization':'Bearer é'},timeout=3)
        self.assertEqual(response.status_code,401)


if __name__ == '__main__': unittest.main(verbosity=2)
