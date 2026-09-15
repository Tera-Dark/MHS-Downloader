"""Real Chromium + embedded extension + native API; entirely synthetic website.
Runs its own disposable native process on 47653. Do NOT run alongside a real engine.
Requires playwright and its Chromium. No live site credentials or APIs used.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit
import requests
from PIL import Image
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parents[1]
PROFILE='https://www.mihuashi.com/profiles/900000001'
WORK='https://www.mihuashi.com/artworks/900000001'
ASSET='https://image-assets.mihuashi.com/mhs-fixture.png'
out=io.BytesIO();Image.new('RGB',(800,800),'#39735d').save(out,'PNG');PNG=out.getvalue()
SIMPLE=f'<!doctype html><title>合成测试页 · 非真实画师</title><p>精选作品 1</p><a href="{WORK}"><img width="500" height="500" src="{ASSET}"></a>'
DETAIL=f'<!doctype html><title>合成测试作品</title><main><img width="500" height="500" src="{ASSET}"></main>'
# A nested scroller + virtual viewport. Initially 14 loaded, only 5 mounted.
# First next page takes 12 seconds (> the old five unchanged snapshots).
VIRTUAL='''<!doctype html><meta charset="utf-8"><title>合成虚拟列表测试</title>
<style>html,body{height:100%;overflow:hidden;margin:0}.scroll-list{height:480px;width:600px;overflow-y:auto;position:relative}.pad{position:relative}.user-artwork{position:absolute;height:96px;left:0}img{width:85px;height:85px}.loading-spinner{position:fixed;right:100px;top:100px}</style>
<p>精选作品 91</p><div class="scroll-list"><div class="pad"></div></div><div class="loading-spinner" style="display:none">正在加载</div>
<script>
const sc=document.querySelector('.scroll-list'),pad=document.querySelector('.pad'),loader=document.querySelector('.loading-spinner');
let loaded=14,busy=false;const all=Array.from({length:91},(_,i)=>({id:910000000+i,url:'https://image-assets.mihuashi.com/mhs-fixture.png',likes_count:1}));
function render(){pad.style.height=loaded*100+'px';pad.innerHTML='';pad.__vue__={_data:{artworks:all.slice(0,loaded)}};
 const from=Math.min(loaded-5,Math.floor(sc.scrollTop/100));for(let i=Math.max(0,from);i<Math.min(from+5,loaded);i++){const c=document.createElement('div');c.className='user-artwork';c.style.top=(i*100)+'px';c.__vue__={_props:{artwork:all[i]}};c.innerHTML='<img src="https://image-assets.mihuashi.com/'+i+'.png">';c.onclick=()=>{window.cardClicks=(window.cardClicks||0)+1};pad.append(c);}}
sc.addEventListener('scroll',()=>{render();if(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-100&&!busy&&loaded<91){busy=true;loader.style.display='block';setTimeout(()=>{loaded=Math.min(91,loaded+14);busy=false;loader.style.display='none';render()},loaded===14?12000:150)}});render();
</script>'''


def wait(page,fn,seconds=45,label='condition'):
    end=time.monotonic()+seconds;last=None
    while time.monotonic()<end:
        last=fn()
        if last:return last
        page.wait_for_timeout(250)
    raise AssertionError('Timed out: '+label)

with tempfile.TemporaryDirectory() as data,tempfile.TemporaryDirectory() as profile:
    client=requests.Session();client.trust_env=False
    try:
        client.get('http://127.0.0.1:47653/v1/health',timeout=.5)
    except requests.RequestException:pass
    else:raise SystemExit('47653 already in use; close the existing engine before this isolated test')
    native=subprocess.Popen([sys.executable,str(ROOT/'native/server.py'),'--data',data],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        end=time.monotonic()+10
        while time.monotonic()<end:
            try:
                if client.get('http://127.0.0.1:47653/v1/health',timeout=1).ok:break
            except requests.RequestException:pass
            time.sleep(.1)
        else:raise AssertionError('Native did not start')
        token=(Path(data)/'pairing-token.txt').read_text().strip()
        with sync_playwright() as p:
            ctx=p.chromium.launch_persistent_context(profile,channel='chromium',headless=True,args=[f'--disable-extensions-except={ROOT/"extension"}',f'--load-extension={ROOT/"extension"}','--no-sandbox'],viewport={'width':1440,'height':1050})
            errors=[];traffic=[]
            ctx.on('page',lambda pg:pg.on('pageerror',lambda e:errors.append(str(e))))
            visits={}
            def site_route(r):
                url=r.request.url;visits[url]=visits.get(url,0)+1
                body=DETAIL if '/artworks/' in url else VIRTUAL if '/profiles/900000002' in url else SIMPLE
                if '/profiles/900000003' in url:
                    n=14 if visits[url]==1 else 91
                    body='<title>合成补扫测试</title><p>精选作品 91</p>'+''.join(f'<a style="display:block;height:7px" href="https://www.mihuashi.com/artworks/{920000000+i}">作品{i}</a>' for i in range(n))
                r.fulfill(content_type='text/html; charset=utf-8',body=body)
            ctx.route('https://www.mihuashi.com/**',site_route)
            ctx.route('https://image-assets.mihuashi.com/**',lambda r:r.fulfill(content_type='image/png',body=PNG))
            ctx.on('request',lambda r:traffic.append((r.method,urlsplit(r.url).path)) if r.url.startswith('http://127.0.0.1:47653') else None)
            sw=ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker');eid=sw.url.split('/')[2]
            page=ctx.new_page();page.goto(PROFILE);page.keyboard.press('Alt+m')
            frame=wait(page,lambda:next((f for f in page.frames if f.url.endswith('/panel.html')),None),label='embedded frame')
            expect(frame.locator('#start')).to_be_enabled()
            assert page.evaluate("document.querySelector('#mhs-downloader-host').shadowRoot===null")
            assert frame.locator('#source').input_value()==''
            frame.locator('[data-tab="connect"]').click();frame.locator('#diagnose').click();expect(frame.locator('#notice')).to_contain_text('0.8.0')
            frame.locator('#token').fill('wrong_token_'*4);frame.locator('#pair').click();expect(frame.locator('#notice')).to_contain_text('令牌错误')
            frame.locator('#token').fill(token);frame.locator('#pair').click();expect(frame.locator('#notice')).to_contain_text('连接成功')
            expect(frame.locator('#connection-text')).to_contain_text('已连接')
            page.wait_for_timeout(2200)
            assert not any(path=='/v1/next' for _,path in traffic),'Pairing must not poll next'
            assert token not in page.content()
            result=frame.evaluate("async()=>await send('STATE')");assert result['jobs']==[]
            print('PASS embedded panel; actual token error/pair/GET state; no preset, no next after pairing; closed shadow/SOP boundary')
            frame.locator('[data-tab="collect"]').click()
            if os.environ.get('MHS_SCREENSHOT'):frame.locator('body').screenshot(path=os.environ['MHS_SCREENSHOT'])
            frame.locator('#use-current').click();expect(frame.locator('#source')).to_have_value(PROFILE)
            frame.locator('#mode').select_option('links');frame.locator('#start').click();expect(frame.locator('#notice')).to_contain_text('任务已启动')
            def saved():
                s=frame.evaluate("async()=>await send('STATE')")
                return next((j for j in s['jobs'] if j['files'].get('link')==1 and j['works'].get('ready')==1),None)
            first=wait(page,saved,label='profile -> detail -> persisted native link')
            assert any(path.endswith('/discovery') for _,path in traffic) and any(path=='/v1/parsed' for _,path in traffic)
            print('PASS actual browser discovery -> detail -> native SQLite link, not just UI/mocked runtime')
            frame.locator('#pause-all').click();expect(frame.locator('#notice')).to_contain_text('全部任务已暂停')
            frame.locator('[data-tab="collect"]').click();frame.locator('#source').fill('https://www.mihuashi.com/profiles/900000002')
            frame.locator('#max_images').fill('0');frame.locator('#max_works').fill('0');frame.locator('#start').click();expect(frame.locator('#notice')).to_contain_text('任务已启动')
            def complete91():
                s=frame.evaluate("async()=>await send('STATE')")
                return next((j for j in s['jobs'] if j['source'].endswith('/900000002') and sum(j['works'].values())==91 and j['scan_state']=='finished'),None)
            large=wait(page,complete91,75,'14/91 delayed nested virtual-list completion')
            tabs=[x for x in ctx.pages if x.url.endswith('/profiles/900000002')]
            assert tabs and tabs[0].evaluate('window.cardClicks||0')==0,'Mounted IDs must avoid per-card clicks'
            assert large['diagnostics']['container'].startswith('div.scroll-list')
            assert large['expected']==91
            print('PASS 14/91 -> 91/91 with 12-second loading, nested scroller, five mounted cards, zero card-click navigation')
            frame.locator('#pause-all').click();expect(frame.locator('#notice')).to_contain_text('全部任务已暂停')
            frame.locator('[data-tab="collect"]').click();frame.locator('#source').fill('https://www.mihuashi.com/profiles/900000003');frame.locator('#start').click()
            def recovered():
                s=frame.evaluate("async()=>await send('STATE')")
                return next((j for j in s['jobs'] if j['source'].endswith('/900000003') and sum(j['works'].values())==91 and j['scan_state']=='finished'),None)
            third=wait(page,recovered,65,'automatic persisted rescan after premature 14/91')
            assert third['scan_attempt']==1 and visits['https://www.mihuashi.com/profiles/900000003']==2
            events=frame.evaluate("async()=>(await send('STATE')).events")
            assert any(e['kind']=='rescan_scheduled' and e['job']==third['id'] for e in events)
            assert any(e['kind']=='auto_rescan' and e['job']==third['id'] for e in events)
            print('PASS incomplete first pass automatically reloaded after persisted backoff and recovered 14/91 -> 91/91')
            frame.locator('#pause-all').click();expect(frame.locator('#notice')).to_contain_text('全部任务已暂停')
            # Actual UI setting modification and local export initiation.
            card=frame.locator('[data-id="'+first['id']+'"]');card.locator('summary').click()
            card.locator('[name="concurrency"]').fill('2');card.locator('[data-action="configure"]').click()
            expect(frame.locator('#notice')).to_contain_text('新设置已保存')
            card.locator('[data-export="zip"]').click();expect(frame.locator('#notice')).to_contain_text('正在本机生成')
            exported=wait(page,lambda:next((e for e in frame.evaluate("async()=>(await send('STATE')).exports") if e['state']=='complete'),None),15,'actual local export')
            assert Path(exported['path']).is_file()
            frame.locator('#pause-all').click();expect(frame.locator('#notice')).to_contain_text('全部任务已暂停')
            print('PASS in-panel configure-and-continue and native ZIP export')
            # A directly opened extension panel cannot operate outside a real MHS parent.
            standalone=ctx.new_page();standalone.goto(f'chrome-extension://{eid}/panel.html')
            expect(standalone.locator('#notice')).to_contain_text('仅在米画师');expect(standalone.locator('#start')).to_be_disabled();standalone.close()
            page.reload();page.keyboard.press('Alt+m');frame=wait(page,lambda:next((f for f in page.frames if f.url.endswith('/panel.html')),None))
            expect(frame.locator('#connection-text')).to_contain_text('已连接',timeout=12000)
            assert frame.locator('#source').input_value()==''
            r=frame.evaluate("async()=>await send('STATE')");assert all(j['state']=='paused' for j in r['jobs']) and not r['armed']
            assert not errors,errors
            print('PASS pause/reopen preserves progress, source stays blank; standalone control refused; no UI JS exceptions')
            print('Sanitized observed transport:',json.dumps(sorted(set(traffic))))
            # Arm a task, then actually restart Chromium with the same persisted profile.
            frame.evaluate("async(id)=>await send('CONTROL',{id,action:'resume'})",first['id'])
            assert frame.evaluate("async()=>(await send('STATE')).armed")
            ctx.close();traffic2=[]
            ctx=p.chromium.launch_persistent_context(profile,channel='chromium',headless=True,args=[f'--disable-extensions-except={ROOT/"extension"}',f'--load-extension={ROOT/"extension"}','--no-sandbox'],viewport={'width':1440,'height':1050})
            ctx.route('https://www.mihuashi.com/**',site_route)
            ctx.route('https://image-assets.mihuashi.com/**',lambda r:r.fulfill(content_type='image/png',body=PNG))
            ctx.on('request',lambda r:traffic2.append(urlsplit(r.url).path) if r.url.startswith('http://127.0.0.1:47653') else None)
            pg=ctx.new_page();pg.goto(PROFILE);pg.keyboard.press('Alt+m');fr=wait(pg,lambda:next((f for f in pg.frames if f.url.endswith('/panel.html')),None))
            expect(fr.locator('#connection-text')).to_contain_text('已连接',timeout=12000);pg.wait_for_timeout(2200)
            assert '/v1/next' not in traffic2
            assert not fr.evaluate("async()=>(await send('STATE')).armed")
            assert fr.locator('#source').input_value()==''
            fr.evaluate("async()=>await send('PAUSE_ALL')")
            print('PASS actual Chromium restart with persisted token and active history does not arm or poll the queue')
            ctx.close()
    finally:
        native.terminate();native.wait(timeout=30);client.close()
