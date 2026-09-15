"""Persistent job policy for MHS-Downloader. No implicit task creation or resume."""
import hashlib
import json
import sqlite3
import time
import uuid

DEFAULTS = dict(max_works=100, max_images=100, concurrency=3, page_delay=1.5,
                scan_retries=3, file_retries=3)
BOUNDS = dict(max_works=(0,5000), max_images=(0,10000), concurrency=(1,4),
              page_delay=(1,10), scan_retries=(0,5), file_retries=(0,5))


def settings(payload, base=None):
    if not isinstance(payload, dict): raise ValueError("设置必须为对象")
    result = dict(base or DEFAULTS)
    for name, (low, high) in BOUNDS.items():
        value = payload.get(name, result[name])
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f'{name} 需要数值')
        if not low <= value <= high or (name != 'page_delay' and value != int(value)):
            raise ValueError(f'{name} 应在 {low}–{high} 范围内')
        result[name] = float(value) if name == 'page_delay' else int(value)
    return result


class QueueService:
    def upgrade_queue(self):
        self.boot_id = uuid.uuid4().hex
        with self.db() as db:
            columns = {r[1] for r in db.execute('PRAGMA table_info(jobs)')}
            additions = dict(max_works='INTEGER NOT NULL DEFAULT 100', max_images='INTEGER NOT NULL DEFAULT 100',
                concurrency='INTEGER NOT NULL DEFAULT 3', page_delay='REAL NOT NULL DEFAULT 1.5',
                scan_retries='INTEGER NOT NULL DEFAULT 3', file_retries='INTEGER NOT NULL DEFAULT 3',
                scan_attempt='INTEGER NOT NULL DEFAULT 0', scan_next='REAL NOT NULL DEFAULT 0',
                revision='INTEGER NOT NULL DEFAULT 1', started_at='REAL',
                trigger='TEXT NOT NULL DEFAULT \'legacy_import\'')
            for name, spec in additions.items():
                if name not in columns:
                    db.execute(f'ALTER TABLE jobs ADD COLUMN {name} {spec}')
            db.execute('CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT,at REAL,kind TEXT,message TEXT)')
            db.execute("UPDATE jobs SET state='paused',revision=revision+1,reason='本机程序重新启动；进度已保留，等待手动继续' WHERE state='active'")
            self._event(db, None, 'engine_start', 'MHS-Downloader 已启动；没有自动恢复任何任务')
            db.execute("INSERT OR REPLACE INTO meta VALUES('_mhs_schema','8')")

    @staticmethod
    def _event(db, job, kind, message):
        db.execute('INSERT INTO events(job,at,kind,message) VALUES(?,?,?,?)',(job,time.time(),kind,message[:600]))
        db.execute('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-500 FROM events)')

    def create_job(self, payload):
        from engine import site_url
        source = str(payload.get('source','')).strip()
        try:
            source = site_url(source)
            profile = False
        except ValueError:
            source = site_url(source, True)
            profile = True
        config = settings(payload.get('settings', {}))
        mode = payload.get('mode','download')
        if mode not in ('download','links'): raise ValueError('无效任务模式')
        start = payload.get('start') is True
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute("SELECT id FROM jobs WHERE source=? AND mode=? AND state!='archived' ORDER BY created DESC LIMIT 1",(source,mode)).fetchone()
            if previous:
                return dict(id=previous[0],existing=True,boot_id=self.boot_id,started=False)
            jid, now = uuid.uuid4().hex, time.time()
            db.execute('INSERT INTO jobs(id,source,mode,state,scan_state,consent_at,created,updated,started_at,trigger,'+','.join(config)+') VALUES('+','.join('?' for _ in range(10+len(config)))+')',
                (jid,source,mode,'active' if start else 'paused','pending' if profile else 'finished',0,now,now,now if start else None,'manual_start' if start else 'saved_only',*config.values()))
            if not profile: db.execute('INSERT INTO works(job,url) VALUES(?,?)',(jid,source))
            self._event(db,jid,'manual_start' if start else 'created','由用户明确启动：'+source if start else '保存任务，未启动')
        self.wake.set()
        return dict(id=jid,existing=False,boot_id=self.boot_id,started=start)

    def _job(self, db, jid):
        r=db.execute('SELECT * FROM jobs WHERE id=?',(jid,)).fetchone()
        if not r: raise ValueError('任务不存在')
        return dict(r)

    @staticmethod
    def _valid(job,payload):
        return job['state']=='active' and type(payload.get('revision')) is int and payload['revision']==job['revision']

    @staticmethod
    def _limit_files(db, job):
        n=db.execute('SELECT COUNT(*) FROM files WHERE job=?',(job['id'],)).fetchone()[0]
        return n>=(job['max_images'] or 10000),n

    def snapshot(self):
        with self.db() as db:
            jobs=[dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY created DESC LIMIT 100")]
            for j in jobs:
                cursor=json.loads(j.pop('cursor','{}'))
                j['diagnostics']={k:cursor.get(k) for k in ('y','height','container','containers','loading','quiet_seconds','metadata_links','pass','card_count','last_progress')}
                j['works']={r[0]:r[1] for r in db.execute('SELECT state,COUNT(*) FROM works WHERE job=? GROUP BY state',(j['id'],))}
                j['files']={r[0]:r[1] for r in db.execute('SELECT state,COUNT(*) FROM files WHERE job=? GROUP BY state',(j['id'],))}
                b=db.execute('SELECT SUM(bytes),SUM(COALESCE(total,bytes)) FROM files WHERE job=?',(j['id'],)).fetchone()
                j['bytes'],j['total_bytes']=b[0] or 0,b[1] or 0
                j['settled']=j['scan_state'] in ('finished','partial','limited') and not any(j['works'].get(k) for k in ('pending','retry')) and not any(j['files'].get(k) for k in ('queued','retry','downloading'))
                j['settings']={k:j[k] for k in DEFAULTS}
            errors=[dict(r) for r in db.execute("SELECT f.job,f.work AS url,f.state,f.error FROM files f JOIN jobs j ON j.id=f.job WHERE f.error!='' AND j.state!='archived' ORDER BY f.rowid DESC LIMIT 20")]
            errors += [dict(r) for r in db.execute("SELECT w.job,w.url,w.state,w.error FROM works w JOIN jobs j ON j.id=w.job WHERE w.error!='' AND j.state!='archived' ORDER BY w.rowid DESC LIMIT 20")]
            events=[dict(r) for r in db.execute('SELECT * FROM events ORDER BY id DESC LIMIT 40')]
            exports=[dict(r) for r in db.execute('SELECT * FROM exports ORDER BY created DESC LIMIT 30')]
        return dict(version='0.8.0',name='MHS-Downloader',boot_id=self.boot_id,jobs=jobs,errors=errors,events=events,exports=exports,
                    hold=self.meta('hold'),collector=self.meta('collector'),workers=self.workers,root=str(self.root))

    def next_browser(self):
        hold=self.meta('hold')
        if hold: return dict(hold=hold,boot_id=self.boot_id)
        now=time.time()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            due=db.execute("SELECT * FROM jobs WHERE state='active' AND scan_state='retry_wait' AND scan_next<=?",(now,)).fetchall()
            for row in due:
                c=json.loads(row['cursor']); c={k:v for k,v in c.items() if k in ('found','expected')}
                c.update({'pass':row['scan_attempt'],'reset':True,'y':0})
                db.execute("UPDATE jobs SET scan_state='pending',cursor=?,reason='正在自动补扫；已有作品去重保留' WHERE id=?",(json.dumps(c),row['id']))
                self._event(db,row['id'],'auto_rescan',f"开始第 {row['scan_attempt']} 次自动补扫")
            scan=db.execute("SELECT * FROM jobs WHERE state='active' AND scan_state IN ('pending','running') ORDER BY created LIMIT 1").fetchone()
            work=db.execute("SELECT w.*,j.source,j.mode,j.revision,j.page_delay,j.file_retries FROM works w JOIN jobs j ON j.id=w.job WHERE j.state='active' AND w.state IN ('pending','retry') AND w.next_at<=? ORDER BY w.rowid LIMIT 1",(now,)).fetchone()
        return dict(scan=dict(scan) if scan else None,work=dict(work) if work else None,boot_id=self.boot_id)

    def discovery(self, jid, payload):
        from engine import site_url
        raw=payload.get('links',[])
        if not isinstance(raw,list) or len(raw)>5000: raise ValueError('发现列表超过 5000 条')
        links=[site_url(x) for x in raw]
        c=payload.get('cursor',{})
        if not isinstance(c,dict) or len(json.dumps(c))>1024*1024: raise ValueError('检查点过大或无效')
        status=payload.get('state','running')
        if status not in ('running','finished','partial','limited'): raise ValueError('无效扫描状态')
        reason=str(payload.get('reason',''))[:500]
        expected=payload.get('expected')
        if expected is not None and (isinstance(expected,bool) or not isinstance(expected,int) or not 0<=expected<=1000000): raise ValueError('无效作品数量')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            j=self._job(db,jid)
            if not self._valid(j,payload): return dict(stale=True)
            file_limit,_=self._limit_files(db,j)
            count=db.execute('SELECT COUNT(*) FROM works WHERE job=?',(jid,)).fetchone()[0]
            cap=j['max_works'] or 5000
            if not file_limit:
                for url in links:
                    if count>=cap: break
                    count+=db.execute('INSERT OR IGNORE INTO works(job,url) VALUES(?,?)',(jid,url)).rowcount
            expected=expected if expected is not None else j['expected']
            if file_limit or count>=cap:
                status='limited';reason='达到图片入队上限' if file_limit else '达到作品数量上限'
            attempt=j['scan_attempt'];next_at=0
            if status=='partial' and attempt<j['scan_retries']:
                attempt+=1;status='retry_wait';next_at=time.time()+min(120,8*2**(attempt-1))
                reason+=f'；将在 {int(next_at-time.time())+1} 秒内安排第 {attempt}/{j["scan_retries"]} 次补扫'
                self._event(db,jid,'rescan_scheduled',reason)
            c['found']=[r[0] for r in db.execute('SELECT url FROM works WHERE job=? ORDER BY rowid',(jid,))]
            c['expected']=expected
            db.execute('UPDATE jobs SET cursor=?,scan_state=?,expected=?,reason=?,scan_attempt=?,scan_next=?,updated=? WHERE id=?',
                       (json.dumps(c),status,expected,reason,attempt,next_at,time.time(),jid))
            if status in ('partial','limited','finished'): self._event(db,jid,'scan_'+status,reason)
        self.wake.set()
        return dict(count=count,state=status,next_at=next_at)

    def parsed(self,payload):
        from engine import site_url,asset_url
        jid,url=payload['job'],site_url(payload['url'])
        images=payload.get('images',[])
        if not isinstance(images,list) or not 1<=len(images)<=30: raise ValueError('详情需要 1–30 个有效图片候选')
        unique=[];seen=set()
        for im in images:
            u=asset_url(im['url'])
            if u not in seen: unique.append(im);seen.add(u)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE');j=self._job(db,jid)
            if not self._valid(j,payload): return dict(stale=True)
            w=db.execute('SELECT state FROM works WHERE job=? AND url=?',(jid,url)).fetchone()
            if not w: raise ValueError('详情不属于本任务')
            if w[0]=='ready': return dict(duplicate=True)
            limit,n=self._limit_files(db,j)
            remaining=(j['max_images']-n) if j['max_images'] else 10000-n
            for i,im in enumerate(unique,1):
                if remaining<=0: break
                fid=hashlib.sha256(f'{jid}:{url}:{i}'.encode()).hexdigest()
                inserted=db.execute('INSERT OR IGNORE INTO files(id,job,work,ordinal,url,state,observed_width,observed_height) VALUES(?,?,?,?,?,?,?,?)',
                    (fid,jid,url,i,im['url'],'queued' if j['mode']=='download' else 'link',int(im.get('width',0)),int(im.get('height',0)))).rowcount
                remaining-=inserted
            reserved=db.execute('SELECT COUNT(*) FROM files WHERE job=? AND work=?',(jid,url)).fetchone()[0]
            work_state='limited_images' if reserved<len(unique) else 'ready'
            db.execute("UPDATE works SET state=?,title=?,error='' WHERE job=? AND url=?",(work_state,str(payload.get('title',''))[:500],jid,url))
            if remaining<=0:
                db.execute("UPDATE jobs SET scan_state='limited',reason='达到图片入队上限；未解析作品已挂起' WHERE id=?",(jid,))
                db.execute("UPDATE works SET state='skipped_limit' WHERE job=? AND state IN ('pending','retry')",(jid,))
        self.wake.set();return dict(ok=True)

    def fail_work(self,payload):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE');j=self._job(db,payload['job'])
            if not self._valid(j,payload): return
            r=db.execute('SELECT attempts FROM works WHERE job=? AND url=?',(j['id'],payload['url'])).fetchone()
            if not r:return
            n=r[0]+1
            db.execute('UPDATE works SET state=?,attempts=?,next_at=?,error=? WHERE job=? AND url=?',
                       ('retry' if n<=j['file_retries'] else 'failed',n,time.time()+min(60,4*2**n),str(payload.get('error','解析失败'))[:500],j['id'],payload['url']))

    def claim(self):
        if self.meta('hold'): return None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute("SELECT f.*,j.file_retries FROM files f JOIN jobs j ON j.id=f.job WHERE j.state='active' AND f.state IN ('queued','retry') AND f.next_at<=? AND (SELECT COUNT(*) FROM files x WHERE x.job=j.id AND x.state='downloading')<j.concurrency ORDER BY f.rowid LIMIT 1",(time.time(),)).fetchone()
            if row:
                db.execute("UPDATE files SET state='downloading',attempts=attempts+1,error='' WHERE id=?",(row['id'],))
                return dict(row)

    def control(self,jid,action,config=None):
        from engine import site_url
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE');j=self._job(db,jid)
            if action=='pause':
                db.execute("UPDATE jobs SET state='paused',revision=revision+1,reason='用户暂停' WHERE id=?",(jid,))
            elif action=='archive':
                db.execute("UPDATE jobs SET state='archived',revision=revision+1 WHERE id=?",(jid,))
            elif action in ('resume','rescan','retry','configure'):
                if config is not None:
                    values=settings(config,{k:j[k] for k in DEFAULTS})
                    if values['max_works'] and values['max_works']<db.execute('SELECT COUNT(*) FROM works WHERE job=?',(jid,)).fetchone()[0]:
                        raise ValueError('新作品上限不能低于已经发现的数量；请另建任务')
                    if values['max_images'] and values['max_images']<db.execute('SELECT COUNT(*) FROM files WHERE job=?',(jid,)).fetchone()[0]:
                        raise ValueError('新图片上限不能低于已入队的数量；不会删除已有图片')
                    db.execute('UPDATE jobs SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),jid))
                    j.update(values)
                if action in ('rescan','retry','configure'):
                    if '/artworks/' not in j['source']:
                        db.execute("UPDATE jobs SET scan_state='pending',scan_attempt=0,scan_next=0,cursor=? WHERE id=?",(json.dumps({'reset':True,'y':0,'found':[r[0] for r in db.execute('SELECT url FROM works WHERE job=?',(jid,))]}),jid))
                    db.execute("UPDATE works SET state='pending',attempts=0,next_at=0,error='' WHERE job=? AND state IN ('failed','blocked','skipped_limit','limited_images')",(jid,))
                    db.execute("UPDATE files SET state='retry',attempts=0,next_at=0,error='' WHERE job=? AND state='failed'",(jid,))
                # Resuming a legacy partial scan must resume discovery, not merely reconnect.
                if action=='resume' and j['scan_state']=='partial':
                    db.execute("UPDATE jobs SET scan_state='pending',scan_attempt=0,cursor=? WHERE id=?",(json.dumps({'reset':True,'found':[r[0] for r in db.execute('SELECT url FROM works WHERE job=?',(jid,))]}),jid))
                db.execute("UPDATE jobs SET state='active',revision=revision+1,trigger='manual_resume',started_at=?,reason='用户明确继续任务',updated=? WHERE id=?",(time.time(),time.time(),jid))
            elif action=='refresh-links':
                db.execute("UPDATE works SET state='pending',attempts=0,next_at=0,error='' WHERE job=? AND url IN (SELECT work FROM files WHERE job=? AND state IN ('failed','blocked'))",(jid,jid))
                db.execute("DELETE FROM files WHERE job=? AND state IN ('failed','blocked')",(jid,))
                db.execute("UPDATE jobs SET state='active',revision=revision+1,started_at=?,trigger='manual_resume' WHERE id=?",(time.time(),jid))
            else: raise ValueError('未知任务操作')
            self._event(db,jid,'manual_'+action,'用户操作：'+action)
        self.wake.set();return dict(ok=True,boot_id=self.boot_id)

    def pause_all(self):
        with self.db() as db:
            db.execute("UPDATE jobs SET state='paused',revision=revision+1,reason='用户暂停全部任务' WHERE state='active'")
            self._event(db,None,'pause_all','用户暂停全部任务')
        return dict(ok=True)

    def diagnostic(self,jid):
        with self.db() as db:
            j=self._job(db,jid)
            files=[dict(r) for r in db.execute('SELECT ordinal,state,error,bytes,total FROM files WHERE job=?',(jid,))]
            works=[dict(r) for r in db.execute('SELECT url,state,attempts,error FROM works WHERE job=?',(jid,))]
        return dict(version='0.8.0',job=j,works=works,files=files,note='包含作品来源，但不含配对令牌或 Cookie')
