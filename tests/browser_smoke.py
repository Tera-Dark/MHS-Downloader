"""Real Chromium extension/UI bridge smoke test, synthetic website only.

Start the engine with a NEW disposable --data directory on port 47653 first.
Usage: python tests/browser_smoke.py --data <temporary-directory>
Requires playwright + its Chromium; never use your archive data directory.
"""
import argparse
import io
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--data', required=True)
parser.add_argument('--screenshot')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
token = (Path(args.data) / 'pairing-token.txt').read_text().strip()
output = io.BytesIO()
Image.new('RGB', (800, 800), '#315b43').save(output, 'PNG')
png = output.getvalue()
profile_url = 'https://www.mihuashi.com/profiles/987654321'
work_url = 'https://www.mihuashi.com/artworks/987654321'
image_url = 'https://image-assets.mihuashi.com/hybrid-smoke-fixture.png'
profile_html = f'''<!doctype html><title>本地测试画师的主页</title><p>精选作品 1</p>
<a href="{work_url}" data-artwork-id="987654321"><img src="{image_url}" width="500" height="500"></a>'''
detail_html = f'''<!doctype html><title>本地测试作品</title><main><img src="{image_url}" width="500" height="500"></main>'''

with sync_playwright() as p, tempfile.TemporaryDirectory() as browser_profile:
    context = p.chromium.launch_persistent_context(
        browser_profile, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={root / "extension"}', f'--load-extension={root / "extension"}', '--no-sandbox'],
        viewport={'width': 1440, 'height': 1050},
    )
    try:
        context.route('https://www.mihuashi.com/**', lambda route: route.fulfill(
            content_type='text/html; charset=utf-8', body=detail_html if '/artworks/' in route.request.url else profile_html))
        context.route('https://image-assets.mihuashi.com/**', lambda route: route.fulfill(content_type='image/png', body=png))
        traffic = []
        def capture(req):
            if req.url.startswith('http://127.0.0.1:47653'):
                headers = req.all_headers()
                traffic.append({'method': req.method, 'path': urlsplit(req.url).path,
                                'origin': headers.get('origin', '<absent>'),
                                'extension_header': bool(headers.get('x-archive-extension'))})
        context.on('request', capture)
        sw = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'chrome-extension://{eid}/hybrid.html')
        page.locator('#diagnose').click()
        expect(page.locator('#pairMessage')).to_contain_text('版本 0.7.1')
        print('PASS service health diagnosis in real extension')

        page.locator('#token').fill('invalid_token_' * 4)
        page.locator('#pairButton').click()
        expect(page.locator('#pairMessage')).to_contain_text('TOKEN_INVALID')
        print('PASS wrong token: visible actionable error')
        page.locator('#token').fill(token)
        page.locator('#pairButton').click()
        expect(page.locator('#pairMessage')).to_contain_text('连接成功')
        expect(page.locator('#connection')).to_contain_text('已连接')
        print('PASS POST pair and subsequent real GET state')
        # Do not run synthetic parsing against an existing real queue.
        state = page.evaluate("async () => (await chrome.runtime.sendMessage({type:'HYBRID_STATE'})).data")
        assert not state['jobs'], 'Use a NEW disposable data directory, not a real archive'
        assert page.locator('#consent').count() == 0
        page.locator('#source').fill(profile_url)
        page.locator('#mode').select_option('links')
        page.locator('#createForm button[type=submit]').click()
        expect(page.locator('#taskMessage')).to_contain_text('任务已加入本机队列')
        expect(page.locator('#jobs')).to_contain_text(profile_url)
        print('PASS add task without checkbox, visible success and queue row')
        # Observe real pipeline: browser scans synthetic profile, parses detail, persists links.
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            result = page.evaluate("async () => await chrome.runtime.sendMessage({type:'HYBRID_STATE'})")
            if result.get('ok') and any(j['works'].get('ready') == 1 and j['files'].get('link') == 1 for j in result['data']['jobs']):
                break
            page.wait_for_timeout(500)
        else:
            raise AssertionError('Synthetic parsing did not finish: ' + json.dumps(result, ensure_ascii=False))
        print('PASS synthetic profile -> detail -> native persistent link record')
        awaitable = page.locator('#jobs button').first
        awaitable.click()
        expect(page.locator('#jobs')).to_contain_text('继续任务', timeout=10000)
        print('PASS pause updates button label despite focus')
        page.close()
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'chrome-extension://{eid}/hybrid.html')
        expect(page.locator('#connection')).to_contain_text('已连接', timeout=15000)
        expect(page.locator('#jobs')).to_contain_text(profile_url)
        print('PASS close/reopen console restores connection and task')
        if args.screenshot:
            page.screenshot(path=args.screenshot, full_page=True)
        assert not errors, errors
        seen = list({(r['method'], r['path'], r['origin'], r['extension_header']) for r in traffic})
        print('Observed sanitized transport:', json.dumps(sorted(seen), ensure_ascii=False))
        print('PASS no UI JavaScript exceptions')
    finally:
        context.close()
