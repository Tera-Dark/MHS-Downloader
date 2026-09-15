'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fields=['max_works','max_images','concurrency','page_delay','scan_retries','file_retries'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count=o=>Object.values(o||{}).reduce((s,n)=>s+n,0);
const size=n=>n<1024*1024?(n/1024).toFixed(1)+' KiB':(n/1024/1024).toFixed(1)+' MiB';
const date=t=>t?new Date(t*1000).toLocaleString('zh-CN',{hour12:false}):'—';
let tabId,state=null,polling=false,editing=false,activeView='collect';
async function send(type,data={}){const r=await chrome.runtime.sendMessage({type:'MHS_'+type,tabId,...data});if(!r?.ok)throw Object.assign(Error(r?.error||'扩展没有响应，请重新加载扩展并刷新米画师页面'),{code:r?.code});return r.data;}
function notice(text,error=false){$('#notice').textContent=text;$('#notice').className=error?'error':'';$('#notice').hidden=false;}
function view(name){activeView=name;$('#launchbar').hidden=name!=='collect';$$('.view').forEach(e=>e.hidden=e.id!=='view-'+name);$$('nav button').forEach(e=>e.classList.toggle('selected',e.dataset.tab===name));$('main').scrollTop=0;}
async function run(button,fn){if(button.disabled)return;const label=button.textContent;button.disabled=true;button.textContent='处理中…';try{await fn();}catch(e){notice(e.message,true);}finally{button.disabled=false;button.textContent=label;}}
function readSettings(root=document){const out={};for(const key of fields){const el=root.querySelector('[name="'+key+'"]');if(!el.reportValidity())throw Error('请检查数量和节奏输入范围');out[key]=Number(el.value);}return out;}
function fill(values){if(!values)return;for(const k of fields)if(values[k]!==undefined)$('#'+k).value=values[k];markPreset();}
function markPreset(){const c=Number($('#concurrency').value),d=Number($('#page_delay').value);const name=c===1&&d===3?'safe':c===3&&d===1.5?'balanced':c===4&&d===1?'fast':'';$$('[data-preset]').forEach(e=>e.classList.toggle('selected',e.dataset.preset===name));$('#speed-label').textContent={safe:'稳妥',balanced:'均衡',fast:'较快'}[name]||'自定义';}
function taskSettings(j){const labels=['最多作品 / 幅','最多图片 / 张','下载并发','页面间隔 / 秒','自动补扫次数','解析 / 文件重试'];const max=[5000,10000,4,10,5,5];return '<div class="two">'+fields.map((k,i)=>`<label>${labels[i]}<input name="${k}" type="number" required min="${i===2||i===3?1:0}" max="${max[i]}" step="${i===3?'.5':'1'}" value="${j.settings[k]}"></label>`).join('')+'</div>';}
function taskHTML(j){
  const works=count(j.works),files=count(j.files),done=(j.files.complete||0)+(j.files.link||0),failed=(j.files.failed||0)+(j.files.blocked||0)+(j.works.failed||0)+(j.works.blocked||0);
  let status=j.state==='paused'?'已暂停':j.state==='archived'?'已归档':({pending:'准备发现',running:'发现中',retry_wait:'等待补扫',partial:'扫描不完整',limited:'已到数量上限',finished:j.settled?'已完成':'解析 / 下载中'}[j.scan_state]||j.scan_state);
  if(j.state==='active'&&failed&&j.settled&&j.scan_state==='finished')status='存在失败/受限项';
  const warn=j.scan_state==='partial'||j.scan_state==='retry_wait'||failed;
  const expected=j.expected;const workDen=expected?Math.max(expected,works):Math.max(works,1);const workPercent=Math.min(100,works/workDen*100);
  const pending=(j.works.pending||0)+(j.works.retry||0),wait=(j.files.queued||0)+(j.files.retry||0);
  const retry=j.scan_state==='retry_wait'?` · ${Math.max(0,Math.ceil(j.scan_next-Date.now()/1000))} 秒后第 ${j.scan_attempt}/${j.scan_retries} 次补扫`:'';
  const primary=j.state==='active'&&!j.settled?'<button class="secondary small" data-action="pause">暂停</button>':'<button class="secondary small" data-action="resume">继续</button>';
  return `<article class="task" data-id="${j.id}"><div class="task-top"><div><strong class="task-title">${/\/artworks\//.test(j.source)?'单幅作品':'画师作品'} · ${j.mode==='links'?'链接采集':'图片下载'}</strong><span class="task-id">${j.id.slice(0,8)} · ${date(j.created)}</span></div><span class="badge ${j.state!=='active'?'gray':warn?'amber':''}">${status}</span></div>
    <a class="source-link" href="${esc(j.source)}" target="_blank" rel="noreferrer">${esc(j.source)} ↗</a>
    <div class="metric"><span>发现作品</span><b>${works} / ${expected??'总数未知'} 幅</b></div><div class="bar"><span style="width:${workPercent}%"></span></div>
    <div class="metric"><span>${j.mode==='links'?'已记录图片链接':'已保存图片'}</span><b>${done} / ${files} 张 · ${size(j.bytes)}</b></div><div class="bar download"><span style="width:${files?done/files*100:0}%"></span></div>
    <div class="task-reason ${warn?'warn':''}">${esc(j.reason||'等待队列处理')}${esc(retry)}<br>已解析 ${(j.works.ready||0)+(j.works.limited_images||0)} 幅 · 待解析 ${pending} · 待下载 ${wait} · 失败/受限 ${failed}<br>限制 ${j.max_works||'不限'} 幅 / ${j.max_images||'不限'} 张 · ${j.concurrency} 下载并发</div>
    <div class="task-actions">${primary}<button class="secondary small" data-action="rescan">重新补扫</button><button class="secondary small" data-export="zip">导出 ZIP</button><button class="secondary small" data-export="links">导出链接</button></div>
    <details data-detail="${j.id}"><summary>更多操作与任务设置</summary><div class="button-row"><button class="secondary small" data-action="retry">重试失败项并补扫</button><button class="secondary small" data-action="refresh-links">刷新失效图片链接</button></div>${taskSettings(j)}<p class="hint">不能将上限调低到已发现 / 入队数以下。保存会明确继续任务，已有文件不删除。</p><button class="primary wide" data-action="configure">保存设置并继续</button><p class="hint">滚动容器：${esc(j.diagnostics.container||'未探测')}<br>本轮读取组件链接：${j.diagnostics.metadata_links||0} · 静默观察：${j.diagnostics.quiet_seconds||0} 秒<br>启动来源：${esc(j.trigger)} · ${date(j.started_at)}</p><div class="button-row"><button class="secondary small" data-diagnostic="true">显示诊断 JSON</button><button class="secondary small" data-action="archive">归档任务（保留图片）</button></div><div class="diagnostic"></div></details></article>`;
}
function render(s){
  state=s;$('#connection-dot').className='dot online';$('#connection-text').textContent='本机已连接 · '+s.version;$('#data-root').textContent=s.root;
  $('#task-count').textContent=s.jobs.filter(j=>j.state!=='archived').length;
  $('#hold-box').hidden=!s.hold;$('#hold-reason').textContent=s.hold?(s.hold.reason+(s.hold.until?' · 最早解除时间 '+date(s.hold.until):'')):'';
  $('#browser-note').hidden=s.armed&&!s.browserStatus?.error;
  $('#browser-note').textContent=s.browserStatus?.error?'采集器提示：'+s.browserStatus.error:'页面采集器尚未启动。配对不会启动任务；请在目标任务上点“继续”，或新建任务。';
  $('#queue-summary').textContent=`${s.jobs.filter(j=>j.state==='active'&&!j.settled).length} 个进行中 · ${s.jobs.filter(j=>j.state==='paused').length} 个暂停`;
  if(!editing){
    const open=new Set($$('#jobs details[open]').map(e=>e.dataset.detail));
    const jobs=s.jobs.filter(j=>$('#show-history').checked||j.state!=='archived');
    $('#jobs').innerHTML=jobs.length?jobs.map(taskHTML).join(''):'<div class="empty"><span class="empty-icon">▧</span><strong>你的本地画集，从这里开始</strong><p>还没有任务。连接本机不会创建任何目标。</p><button class="secondary small" id="go-collect">去选择作品 →</button></div>';
    $$('#jobs details').forEach(e=>e.open=open.has(e.dataset.detail));
  }
  $('#error-count').textContent=s.errors.length;
  $('#errors').innerHTML=s.errors.length?s.errors.map(e=>`<div class="record-row"><strong>${esc(e.error)}</strong><small>${esc(e.url)} · ${esc(e.state)}</small></div>`).join(''):'<p>暂无错误。</p>';
  $('#exports').innerHTML=s.exports.length?s.exports.map(e=>`<div class="record-row"><strong>${{packing:'正在打包',complete:'导出完成',failed:'导出失败'}[e.state]||esc(e.state)}</strong><small>${date(e.created)} · ${e.job.slice(0,8)}</small>${esc(e.path||e.error||'文件将在本机 data/exports 生成')}</div>`).join(''):'<p>导出是当前快照，不代表整项任务已经完成。</p>';
  $('#events').innerHTML=s.events.map(e=>`<div class="record-row"><strong>${esc(e.message)}</strong><small>${date(e.at)} · ${e.job?.slice(0,8)||'系统'}</small></div>`).join('');
}
async function refresh(silent=false){if(polling)return;polling=true;try{render(await send('STATE'));}catch(e){$('#connection-dot').className='dot bad';$('#connection-text').textContent=e.code==='NOT_PAIRED'?'尚未连接 · 请前往连接页':e.code==='VERSION'?'版本不匹配 · 请更新本机程序':'本机连接不可用';if(!silent)notice(e.message,true);}finally{polling=false;}}
$$('nav button').forEach(b=>b.addEventListener('click',()=>view(b.dataset.tab)));
$('#close').addEventListener('click',()=>send('CLOSE').catch(e=>notice(e.message,true)));
$('#refresh').addEventListener('click',()=>run($('#refresh'),()=>refresh()));
$('#use-current').addEventListener('click',()=>run($('#use-current'),async()=>{const c=await send('CONTEXT');if(!/^https:\/\/www\.mihuashi\.com\/(profiles\/\d+|users\/[^/?#]+|artworks\/\d+)\/?([?#].*)?$/.test(c.url))throw Error('当前页不是画师主页或作品详情页，请先进入目标页面');$('#source').value=c.url;notice('已填入当前页，尚未启动。检查范围后再点开始。');}));
$$('[data-preset]').forEach(b=>b.addEventListener('click',()=>{const p={safe:[1,3],balanced:[3,1.5],fast:[4,1]}[b.dataset.preset];$('#concurrency').value=p[0];$('#page_delay').value=p[1];markPreset();}));
$('#concurrency').addEventListener('input',markPreset);$('#page_delay').addEventListener('input',markPreset);
$('#create-form').addEventListener('submit',e=>{e.preventDefault();run($('#start'),async()=>{const r=await send('CREATE',{source:$('#source').value.trim(),mode:$('#mode').value,settings:readSettings($('#create-form'))});view('tasks');notice(r.existing?'这个来源已有任务，没有自动恢复。请找到任务后点击“继续”，或调整该任务的设置。':'任务已启动。发现、解析和保存进度会分别显示。');await refresh(true);});});
$('#pair-form').addEventListener('submit',e=>{e.preventDefault();run($('#pair'),async()=>{const r=await send('PAIR',{token:$('#token').value});$('#token').value='';render(r.state);notice('连接成功，未启动任何采集。请去“采集作品”选择来源，或手动继续历史任务。');});});
$('#show-token').addEventListener('click',()=>{const hide=$('#token').type==='password';$('#token').type=hide?'text':'password';$('#show-token').textContent=hide?'隐藏':'显示';});
$('#diagnose').addEventListener('click',()=>run($('#diagnose'),async()=>{const h=await send('DIAGNOSE');notice('本机程序正常：'+h.service+' '+h.version+'。此检查不会创建或恢复任务。');}));
$('#pause-all').addEventListener('click',()=>run($('#pause-all'),async()=>{await send('PAUSE_ALL');notice('全部任务已暂停。正在传输的块结束后会保留检查点。');await refresh(true);}));
$('#clear-hold').addEventListener('click',()=>run($('#clear-hold'),async()=>{await send('CLEAR_HOLD');notice('已解除拦截；已暂停或浏览器重启后的任务仍需点击继续。');await refresh(true);}));
for(const [id,folder] of [['open-exports','exports'],['open-images','images'],['open-root','']])$('#'+id).addEventListener('click',()=>run($('#'+id),async()=>{await send('FOLDER',{folder});notice('已请求 Windows 打开目录。');}));
$('#show-history').addEventListener('change',()=>{if(state)render(state);});
$('#jobs').addEventListener('input',()=>{editing=true;});
$('#jobs').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;if(b.id==='go-collect'){view('collect');return;}
  const task=b.closest('[data-id]'),id=task?.dataset.id;if(!id)return;
  run(b,async()=>{
    if(b.dataset.action){
      const action=b.dataset.action;const settings=action==='configure'?readSettings(task):undefined;
      await send('CONTROL',{id,action,settings});editing=false;notice({pause:'任务已暂停，文件保留。',archive:'已移入历史，图片不会删除。',configure:'新设置已保存，任务已明确继续。'}[action]||'已明确继续任务；已有数据去重保留。');await refresh(true);
    }else if(b.dataset.export){await send('EXPORT',{id,kind:b.dataset.export});notice('正在本机生成导出快照，请查看下方“导出记录”。');await refresh(true);}
    else if(b.dataset.diagnostic){const d=await send('DIAGNOSTIC',{id});const area=document.createElement('textarea');area.className='diagnostic-text';area.readOnly=true;area.value=JSON.stringify(d,null,2);area.setAttribute('aria-label','诊断信息');task.querySelector('.diagnostic').replaceChildren(area);editing=true;area.focus();area.select();notice('可复制下方诊断信息。包含作品来源，不含配对令牌或 Cookie。');}
  });
});
(async()=>{try{tabId=(await chrome.tabs.getCurrent())?.id;const context=await send('CONTEXT');fill(context.defaults);await refresh(true);}catch(e){notice(e.message,true);$('#start').disabled=true;$('#pair').disabled=true;}setInterval(()=>refresh(true),1800);})();
