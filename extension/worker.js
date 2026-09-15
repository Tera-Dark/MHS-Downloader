'use strict';
importScripts('core-policy.js','adapter.js');
const BASE='http://127.0.0.1:47653/v1',PANEL=chrome.runtime.getURL('panel.html');
let busy=false,timer,navChain=Promise.resolve(),lastBeat=0;
const fault=(code,message)=>Object.assign(Error(message),{code});
async function request(path,body,token){
  const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),8000);
  try{
    const headers={'X-Archive-Extension':chrome.runtime.id};if(token)headers.Authorization='Bearer '+token;if(body!==undefined)headers['Content-Type']='application/json';
    const r=await fetch(BASE+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:ctl.signal,credentials:'omit',cache:'no-store'});
    let d;try{d=await r.json();}catch{throw fault('BAD_RESPONSE','本机接口没有返回 JSON，请检查 47653 端口是否被占用');}
    if(!r.ok)throw fault(d.code||'HTTP_'+r.status,d.error||'本机请求失败');return d;
  }catch(e){if(e.name==='AbortError'||e instanceof TypeError)throw fault('OFFLINE','本机程序未连接。请运行 START-WINDOWS.bat，并检查本地网络权限');throw e;}finally{clearTimeout(timeout);}
}
async function token(){const s=await chrome.storage.local.get(['mhsToken','hybridToken']);return s.mhsToken||s.hybridToken;}
async function api(path,body,override){const t=override||await token();if(!t)throw fault('NOT_PAIRED','请先在“连接”页粘贴本机令牌');return request(path,body,t);}
async function health(){
  let h;try{h=await request('/health');}catch(e){if(e.code==='OFFLINE')throw e;throw fault('VERSION','请退出旧 Hybrid 本机程序，更新并启动 MHS-Downloader 0.8.0');}
  if(h.service!=='mhs-downloader'||h.protocol!==3)throw fault('VERSION','本机程序版本不匹配；需要同时更新 native 和 extension 到 0.8.0');return h;
}
function schedule(ms=500){clearTimeout(timer);timer=setTimeout(()=>tick().catch(console.error),ms);}
async function saveSlots(slots){await chrome.storage.session.set({mhsSlots:slots});}
async function reserve(seconds=1.5){
  let ok=false;
  navChain=navChain.catch(()=>{}).then(async()=>{const {mhsNavAt=0}=await chrome.storage.session.get('mhsNavAt');if(Date.now()>=mhsNavAt+seconds*1000){await chrome.storage.session.set({mhsNavAt:Date.now()});ok=true;}});
  await navChain;return ok;
}
async function tabSlot(slots,name){
  let s=slots[name];if(s)try{await chrome.tabs.get(s.id);return s;}catch{delete slots[name];}
  const t=await chrome.tabs.create({url:'about:blank',active:false});s=slots[name]={id:t.id,target:'',since:Date.now()};await saveSlots(slots);await chrome.tabs.update(t.id,{autoDiscardable:false});return s;
}
async function ready(slots,name,url,delay){
  const s=await tabSlot(slots,name),t=await chrome.tabs.get(s.id);
  if(s.target!==url||t.url==='about:blank'){
    if(!await reserve(delay))return null;
    Object.assign(s,{target:url,since:Date.now(),images:[],quietAt:0,scrolls:0});await saveSlots(slots);await chrome.tabs.update(s.id,{url,active:false});return null;
  }
  if(t.discarded){s.since=Date.now();await saveSlots(slots);await chrome.tabs.reload(s.id);return null;}
  if(t.status!=='complete'){if(Date.now()-s.since>45000)throw fault('PAGE_TIMEOUT','页面加载超过 45 秒');return null;}
  const actual=ArchivePolicy.siteURL(t.url,/\/artworks\//.test(url)?'artwork':'profile');
  if(actual!==url){await hold('NAVIGATION','任务页离开预期地址，请检查登录或验证');throw fault('HOLD','任务页重定向，等待人工处理');}return s;
}
async function dom(id,op,args={}){const r=await chrome.scripting.executeScript({target:{tabId:id},func:pageTask,args:[{op,...args}]});const d=r[0]?.result;if(!d)throw fault('DOM','无法读取页面，检查站点权限');if(d.blocked){await hold('AUTH',d.blocked);throw fault('HOLD',d.blocked);}return d;}
async function mounted(id){const r=await chrome.scripting.executeScript({target:{tabId:id},world:'MAIN',func:readMountedWorks});return r[0]?.result||{links:[],keys:[]};}
async function hold(code,reason,until=0){const value={code,reason,until};await chrome.storage.local.set({mhsPendingHold:value});await api('/hold',value);await chrome.storage.local.remove('mhsPendingHold');}
async function checkpoint(j,c,links=[],state='running',reason=''){return api('/jobs/'+j.id+'/discovery',{revision:j.revision,cursor:c,links,state,reason,expected:c.expected??null});}
const isSystem=e=>['OFFLINE','NOT_PAIRED','TOKEN_INVALID','VERSION','HOLD','NOT_PAIRED','CLIENT_ORIGIN_DENIED'].includes(e.code);
async function scan(j,slots){
  let c=JSON.parse(j.cursor||'{}');c.found||=[];c.seen||=[];c.unresolved||=[];
  const found=new Set(c.found),seen=new Set(c.seen);let slot=await tabSlot(slots,'profile');const container=Number(c.pass||0);
  if(c.reset){
    if(!await reserve(j.page_delay))return;
    // Persist reset completion; a restarted worker can safely navigate to the same public URL.
    Object.assign(c,{reset:false,last_progress:Date.now(),quietAt:0,y:0,returning:false,click:null,unresolved:[],seen:[]});
    slot.target='';await saveSlots(slots);await checkpoint(j,c);return;
  }
  if(c.returning){
    const t=await chrome.tabs.get(slot.id);
    if(t.status!=='complete'){if(Date.now()-slot.since>45000)throw fault('PAGE_TIMEOUT','返回列表超时');return;}
    if(ArchivePolicy.siteURL(t.url,'profile')===j.source){c.returning=false;await checkpoint(j,c);return;}
    if(t.url==='about:blank'){await ready(slots,'profile',j.source,j.page_delay);return;}
    if(!ArchivePolicy.siteURL(t.url)){await hold('NAVIGATION','恢复列表时遇到未知页面');return;}
    if(!await reserve(j.page_delay))return;
    try{await chrome.tabs.goBack(slot.id);}catch{await chrome.tabs.update(slot.id,{url:j.source,active:false});}
    slot.since=Date.now();slot.target=j.source;await saveSlots(slots);return;
  }
  if(c.click){
    const t=await chrome.tabs.get(slot.id),all=await chrome.tabs.query({});
    const child=all.find(x=>x.openerTabId===slot.id&&!c.click.known.includes(x.id)&&ArchivePolicy.siteURL(x.url||x.pendingUrl));
    const link=ArchivePolicy.siteURL(t.url)||ArchivePolicy.siteURL(child?.url||child?.pendingUrl);
    if(!link&&Date.now()-c.click.at<6500)return;
    if(t.url!==j.source&&t.url!=='about:blank'&&!ArchivePolicy.siteURL(t.url)){await hold('NAVIGATION','卡片跳转到未知页面');return;}
    if(link)found.add(link);else c.unresolved.push(c.click.key);
    seen.add(c.click.key);Object.assign(c,{found:[...found],seen:[...seen],click:null,returning:t.url!==j.source,last_progress:link?Date.now():c.last_progress});
    const saved=await checkpoint(j,c,link?[link]:[]);if(saved.stale)return;
    if(child)await chrome.tabs.remove(child.id);return;
  }
  slot=await ready(slots,'profile',j.source,j.page_delay);if(!slot)return;
  const snap=await dom(slot.id,'scan',{container});
  if(c.y&&snap.y<c.y-12){
    c.restore=(c.restore||0)+1;
    if(c.restore>40){await checkpoint(j,c,[],'partial','滚动位置未能恢复');return;}
    await dom(slot.id,'restore',{y:c.y,container});await checkpoint(j,c);return;
  }
  c.restore=0;
  // Resolve IDs from actual mounted component props instead of clicking every opaque card.
  let extra={links:[],keys:[]};try{extra=await mounted(slot.id);}catch{}
  const fresh=[];for(const raw of [...snap.links,...extra.links]){const u=ArchivePolicy.siteURL(raw);if(u&&!found.has(u)){found.add(u);fresh.push(u);}}
  for(const key of extra.keys||[])seen.add(key);
  Object.assign(c,{found:[...found],seen:[...seen],expected:snap.expected??c.expected,y:snap.y,height:snap.height,container:snap.container,containers:snap.containers,loading:snap.loading,card_count:snap.card_count,metadata_links:extra.links.length});
  c.startedAt||=Date.now();c.last_progress||=Date.now();
  if(fresh.length){c.last_progress=Date.now();c.quietAt=0;}
  const saved=await checkpoint(j,c,fresh);
  if(saved.stale||['limited','partial','finished','retry_wait'].includes(saved.state))return;
  if(c.expected!=null&&found.size>=c.expected&&c.expected>0){await checkpoint(j,c,[],'finished','已达到页面标示数量');return;}
  if(Date.now()-c.last_progress>45000){await checkpoint(j,c,[],'partial','45 秒未发现新作品，切换恢复策略');return;}
  const opaque=snap.cards.find(card=>!card.url&&!seen.has(card.key));
  if(opaque){
    if(!await reserve(j.page_delay))return;
    c.click={key:opaque.key,at:Date.now(),known:(await chrome.tabs.query({})).map(t=>t.id)};await checkpoint(j,c);
    const r=await chrome.scripting.executeScript({target:{tabId:slot.id},world:'MAIN',func:clickProfileCard,args:[opaque.key]});
    const clicked=r[0]?.result;
    if(clicked?.captured){found.add(clicked.captured);seen.add(opaque.key);Object.assign(c,{found:[...found],seen:[...seen],click:null,last_progress:Date.now()});await checkpoint(j,c,[clicked.captured]);}return;
  }
  const quiet=Date.now()-c.last_progress;c.quiet_seconds=Math.floor(quiet/1000);
  // Slow loading does not count as an end. It does have a bounded watchdog.
  if(snap.loading){if(quiet>45000)await checkpoint(j,c,[],'partial','列表持续加载超过 45 秒');else await checkpoint(j,c);return;}
  if(!found.size&&Date.now()-c.startedAt<45000){await dom(slot.id,'advance',{container});return;}
  if(snap.bottom&&quiet>=10000){
    const incomplete=(c.expected!=null&&found.size<c.expected)||c.unresolved.length||(!found.size&&c.expected!==0);
    await checkpoint(j,c,[],incomplete?'partial':'finished',incomplete?'到底后等待仍未补齐，安排有上限的补扫':'列表稳定到底；未发现更多公开作品');return;
  }
  if(snap.bottom&&quiet>2000&&!c.poked){await dom(slot.id,'poke',{container});c.poked=true;c.y=0;}
  else{const moved=await dom(slot.id,'advance',{container});c.y=moved.y;c.poked=false;}
  await checkpoint(j,c);
}
async function parseWork(w,slots){
  try{
    const s=await ready(slots,'detail',w.url,w.page_delay);if(!s)return;
    const d=await dom(s.id,'detail');const old=new Map((s.images||[]).map(x=>[x.url,x]));const n=old.size;for(const im of d.images||[])old.set(im.url,im);s.images=[...old.values()].slice(0,30);
    if(old.size!==n)s.quietAt=Date.now();s.quietAt||=Date.now();
    if(!old.size){if(Date.now()-s.since>45000)throw fault('PAGE_TIMEOUT','45 秒内未找到详情展示图');await saveSlots(slots);return;}
    if(!d.bottom&&s.scrolls<12){await dom(s.id,'advance');s.scrolls++;await saveSlots(slots);return;}
    if(Date.now()-s.quietAt<900){await saveSlots(slots);return;}
    await api('/parsed',{job:w.job,url:w.url,revision:w.revision,images:s.images,title:d.title});s.target='';await saveSlots(slots);
  }catch(e){if(isSystem(e))throw e;await api('/work-failed',{job:w.job,url:w.url,revision:w.revision,error:e.message});if(slots.detail)slots.detail.target='';await saveSlots(slots);}
}
async function tick(){
  if(busy)return;busy=true;let delay=500;
  try{
    const s=await chrome.storage.session.get(['mhsArm','mhsSlots']);
    if(!s.mhsArm){delay=10000;return;}
    const pending=(await chrome.storage.local.get('mhsPendingHold')).mhsPendingHold;if(pending){await api('/hold',pending);await chrome.storage.local.remove('mhsPendingHold');}
    const next=await api('/next');
    if(next.boot_id!==s.mhsArm){await chrome.storage.session.remove('mhsArm');return;}
    if(Date.now()-lastBeat>15000){await api('/heartbeat',{message:'采集器已获用户启动指令'});lastBeat=Date.now();}
    if(next.hold){delay=5000;return;}
    if(!next.scan&&!next.work){delay=2000;return;}
    const slots=s.mhsSlots||{};
    if(next.scan)try{await scan(next.scan,slots);}catch(e){if(isSystem(e))throw e;const latest=await api('/next');if(latest.scan?.id===next.scan.id)await checkpoint(latest.scan,JSON.parse(latest.scan.cursor||'{}'),[],'partial','扫描错误：'+e.message);}
    if(next.work)await parseWork(next.work,slots);
    await chrome.storage.local.set({mhsStatus:{at:Date.now(),error:''}});
  }catch(e){delay=5000;await chrome.storage.local.set({mhsStatus:{at:Date.now(),error:e.message}});}finally{busy=false;schedule(delay);}
}
async function panelTab(msg,sender){
  if(sender.id!==chrome.runtime.id||sender.url?.split(/[?#]/)[0]!==PANEL)throw fault('FORBIDDEN','请从米画师页面的 MHS 浮动面板操作');
  const id=sender.tab?.id??msg.tabId;if(!Number.isInteger(id))throw fault('NO_TAB','无法识别所在米画师页面，请刷新页面');
  const tab=await chrome.tabs.get(id);if(!/^https:\/\/www\.mihuashi\.com\//.test(tab.url||''))throw fault('FORBIDDEN','面板仅在米画师页面工作');return tab;
}
async function arm(result){await chrome.storage.session.set({mhsArm:result.boot_id});schedule(100);}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(!msg?.type?.startsWith('MHS_'))return;
  (async()=>{
    const tab=await panelTab(msg,sender);
    if(msg.type==='MHS_CONTEXT')return {url:tab.url,defaults:(await chrome.storage.local.get('mhsDefaults')).mhsDefaults||null};
    if(msg.type==='MHS_CLOSE'){await chrome.tabs.sendMessage(tab.id,{type:'MHS_HIDE'});return {};}
    if(msg.type==='MHS_DIAGNOSE')return health();
    if(msg.type==='MHS_PAIR'){
      const t=String(msg.token||'').trim();if(!/^[A-Za-z0-9_-]{32,256}$/.test(t))throw fault('TOKEN','请复制完整令牌，不要包含提示文字');
      const h=await health();await api('/pair',{},t);const state=await api('/state',undefined,t);await chrome.storage.local.set({mhsToken:t});
      // Pairing only authenticates. It NEVER arms the collector or changes a job state.
      return {state,health:h};
    }
    if(msg.type==='MHS_STATE'){const state=await api('/state');if(state.name!=='MHS-Downloader'||!state.boot_id)throw fault('VERSION','请退出旧 Hybrid 本机程序，并启动 MHS-Downloader 0.8.0');return {...state,browserStatus:(await chrome.storage.local.get('mhsStatus')).mhsStatus,armed:Boolean((await chrome.storage.session.get('mhsArm')).mhsArm)};}
    if(['MHS_CREATE','MHS_CONTROL','MHS_PAUSE_ALL','MHS_EXPORT','MHS_DIAGNOSTIC','MHS_FOLDER','MHS_CLEAR_HOLD'].includes(msg.type))await health();
    if(msg.type==='MHS_CREATE'){
      const r=await api('/jobs',{source:msg.source,mode:msg.mode,settings:msg.settings,start:true});
      await chrome.storage.local.set({mhsDefaults:msg.settings});if(r.started)await arm(r);return r;
    }
    if(msg.type==='MHS_CONTROL'&&/^[a-f0-9]{32}$/.test(msg.id)){
      const r=await api('/jobs/'+msg.id+'/control',{action:msg.action,settings:msg.settings});if(['resume','rescan','retry','refresh-links','configure'].includes(msg.action))await arm(r);return r;
    }
    if(msg.type==='MHS_PAUSE_ALL'){const r=await api('/pause-all',{});await chrome.storage.session.remove('mhsArm');return r;}
    if(msg.type==='MHS_EXPORT'&&/^[a-f0-9]{32}$/.test(msg.id))return api('/jobs/'+msg.id+'/export',{kind:msg.kind});
    if(msg.type==='MHS_DIAGNOSTIC'&&/^[a-f0-9]{32}$/.test(msg.id))return api('/jobs/'+msg.id+'/diagnostic',{});
    if(msg.type==='MHS_FOLDER')return api('/open-folder',{folder:msg.folder});
    if(msg.type==='MHS_CLEAR_HOLD')return api('/clear-hold',{confirmed:true});
    throw fault('UNKNOWN','未知面板操作');
  })().then(data=>reply({ok:true,data})).catch(e=>reply({ok:false,error:e.message,code:e.code}));return true;
});
chrome.action.onClicked.addListener(async tab=>{
  if(!/^https:\/\/www\.mihuashi\.com\//.test(tab.url||'')){await chrome.tabs.create({url:'https://www.mihuashi.com/',active:true});return;}
  try{await chrome.tabs.sendMessage(tab.id,{type:'MHS_TOGGLE'});}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});await chrome.tabs.sendMessage(tab.id,{type:'MHS_TOGGLE'});}
});
chrome.webRequest.onHeadersReceived.addListener(d=>{
  if(!(d.statusCode===429||(d.type==='main_frame'&&[401,403].includes(d.statusCode))))return;
  chrome.storage.session.get('mhsSlots').then(async({mhsSlots={}})=>{if(!Object.values(mhsSlots).some(s=>s.id===d.tabId))return;const retry=d.responseHeaders?.find(h=>h.name.toLowerCase()==='retry-after')?.value;await hold(String(d.statusCode),'任务页返回 HTTP '+d.statusCode,d.statusCode===429?ArchivePolicy.retryUntil(retry)/1000:0);}).catch(console.error);
},{urls:['https://www.mihuashi.com/*','https://image-assets.mihuashi.com/*']},['responseHeaders']);
chrome.tabs.onUpdated.addListener((_id,change)=>{if(change.status==='complete')schedule(300);});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='mhs-recover')tick().catch(console.error);});
async function setup(){await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.alarms.create('mhs-recover',{periodInMinutes:1});schedule(500);}
chrome.runtime.onStartup.addListener(()=>chrome.storage.session.remove('mhsArm').then(setup).catch(console.error));
chrome.runtime.onInstalled.addListener(()=>chrome.storage.session.remove('mhsArm').then(setup).catch(console.error));
setup().catch(console.error);
