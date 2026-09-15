(() => {
  if (window.top!==window || document.getElementById('mhs-downloader-host'))return;
  const host=document.createElement('div');host.id='mhs-downloader-host';
  host.style.cssText='all:initial;position:fixed;z-index:2147483646;right:22px;bottom:22px;';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>
    :host{all:initial}button{font:600 13px system-ui,sans-serif;display:flex;align-items:center;gap:9px;color:#fff;background:#123f3a;border:1px solid #78a59a;border-radius:18px;padding:13px 17px;box-shadow:0 6px 24px #183b3933;cursor:pointer;transition:transform .15s}button:hover{transform:translateY(-2px);background:#18524b}button:focus-visible{outline:3px solid #8bdfc8;outline-offset:3px}svg{width:21px;height:21px}iframe{position:fixed;right:22px;bottom:83px;width:440px;height:min(780px,calc(100dvh - 108px));border:1px solid #d9e4df;border-radius:22px;background:#f6f8f5;box-shadow:0 20px 80px #153d343d;display:none;color-scheme:light}@media(max-width:500px){iframe{width:calc(100vw - 24px);right:12px;bottom:77px;height:calc(100dvh - 95px)}}
  </style><button type="button" title="MHS-Downloader · 打开采集面板（Alt+M）" aria-label="打开 MHS-Downloader 面板" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17V7l5 5 4-5 4 5 5-5v10M3 20h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>MHS</span></button>`;
  const button=shadow.querySelector('button');let frame,open=false;
  function setOpen(value){
    open=value;
    if(open&&!frame){frame=document.createElement('iframe');frame.src=chrome.runtime.getURL('panel.html');frame.title='MHS-Downloader 采集面板';frame.allow='clipboard-write';shadow.append(frame);}
    if(frame)frame.style.display=open?'block':'none';button.setAttribute('aria-expanded',String(open));
  }
  button.addEventListener('click',()=>setOpen(!open));
  chrome.runtime.onMessage.addListener((msg,sender)=>{if(sender.id!==chrome.runtime.id)return;if(msg.type==='MHS_TOGGLE')setOpen(!open);if(msg.type==='MHS_HIDE')setOpen(false);});
  document.addEventListener('keydown',e=>{if(e.altKey&&e.code==='KeyM'&&!e.repeat){e.preventDefault();setOpen(!open);}if(e.key==='Escape'&&open)setOpen(false);});
  document.documentElement.append(host);
})();
