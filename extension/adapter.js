// DOM adapter. Executed only in dedicated task tabs, never scrolls the user's tab.
function pageTask(args = {}) {
  const visible = el => {
    if (!el) return false;
    const r=el.getBoundingClientRect(), s=getComputedStyle(el);
    return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';
  };
  const art = input => {
    try { const u=new URL(input,location.href); return u.origin==='https://www.mihuashi.com' && /^\/artworks\/\d+\/?$/.test(u.pathname) ? u.origin+u.pathname.replace(/\/$/,'') : null; }
    catch { return null; }
  };
  const text=document.body?.innerText||'';
  const blocked=['请完成验证','请先完成验证','拖动滑块','安全验证','访问过于频繁','操作过于频繁','访问受限','登录后查看','登录后可查看','请先登录'].find(t=>text.includes(t)) || '';
  const dialogs=[...document.querySelectorAll('[role="dialog"],.el-dialog,.mhs-dialog,.modal')].filter(visible);
  const extractArtist = () => {
    const nameSelectors = [
      '.profile-header__name', '.user-name', '.artist-name', '.profile-name',
      '.painter-name', '.creator__name', '.user-info__name', '.user-info a',
      'a[href*="/profiles/"]', 'a[href*="/users/"]'
    ];
    for (const sel of nameSelectors) {
      const el = document.querySelector(sel);
      if (el && visible(el) && el.innerText && el.innerText.trim().length > 0) {
        const t = el.innerText.trim();
        if (t.length <= 40 && !/^(关注|粉丝|约稿|私信|主页|首页|米画师)$/.test(t)) return t;
      }
    }
    if (document.title) {
      let t = document.title.replace(/\s*[-_|]\s*米画师.*$/i, '').trim();
      if (t.includes('的主页')) return t.replace(/的主页.*$/, '').trim();
      if (t.includes('的作品')) {
        const parts = t.split(/\s*[-_|]\s*/);
        for (const p of parts) if (p.includes('的作品')) return p.replace(/的作品.*$/, '').trim();
      }
      if (t.includes(' - ')) return t.split(' - ')[0].trim();
      if (t && t.length <= 40) return t;
    }
    return '';
  };
  const base={pageURL:location.href,title:document.title,artist:extractArtist(),blocked:blocked||(dialogs.some(e=>/验证码|手机登录|扫码登录|短信登录/.test(e.innerText))?'登录或验证弹窗':'')};
  if (base.blocked) return base;
  const cards=[...document.querySelectorAll('.user-artwork,.masonry-artwork,[data-artwork-id],a[href*="/artworks/"]')].filter(e=>visible(e)&&!e.closest('aside,footer,[class*="recommend"],[class*="related"]'));
  const root=document.scrollingElement||document.documentElement;
  const candidates=new Set([root]);
  for (const card of cards.slice(0,25)) {
    let el=card.parentElement;
    for(let i=0;el&&i<12;i++,el=el.parentElement) {
      const s=getComputedStyle(el);
      if (/auto|scroll|overlay/.test(s.overflowY)&&el.clientHeight>80&&el.scrollHeight>el.clientHeight+2) candidates.add(el);
    }
  }
  if (candidates.size===1 && root.scrollHeight<=root.clientHeight+2) {
    for(const el of document.querySelectorAll('.el-scrollbar__wrap,[class*="scroll"],main')) {
      if (visible(el)&&el.clientHeight>80&&el.scrollHeight>el.clientHeight+2&&/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) candidates.add(el);
    }
  }
  let list=[...candidates].map(el=>({el,score:(el.scrollHeight>el.clientHeight+2?100000:0)+cards.filter(c=>el.contains(c)).length*100+(el===root?0:20)})).sort((a,b)=>b.score-a.score);
  const scrollable=list.filter(x=>x.el.scrollHeight>x.el.clientHeight+2);if(scrollable.length)list=scrollable;
  const index=Math.max(0,Number(args.container)||0)%list.length;
  const el=list[index].el;
  const describe=e=>e===root?'document':e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(typeof e.className==='string'?'.'+e.className.trim().replace(/\s+/g,'.').slice(0,80):'');
  const info=()=>({y:el.scrollTop,height:el.scrollHeight,viewport:el.clientHeight,bottom:el.scrollTop+el.clientHeight>=el.scrollHeight-8,container:describe(el),containers:list.map(x=>describe(x.el))});
  if (args.op==='advance'||args.op==='poke'||args.op==='restore') {
    const before=el.scrollTop;
    if(args.op==='restore') el.scrollTop=Math.max(0,Number(args.y)||0);
    else if(args.op==='poke') el.scrollTop=Math.max(0,el.scrollTop-Math.min(320,el.clientHeight*.6));
    else el.scrollTop=Math.min(el.scrollHeight,el.scrollTop+Math.max(240,el.clientHeight*.82));
    el.dispatchEvent(new Event('scroll',{bubbles:false}));
    if(el===root) window.dispatchEvent(new Event('scroll'));
    return {...base,...info(),moved:Math.abs(el.scrollTop-before)>1};
  }
  if(args.op==='detail') {
    const images=[];const seen=new Set();
    for(const im of document.images) {
      if(!visible(im)||!im.complete||im.naturalWidth<400||im.naturalHeight<400||im.naturalWidth*im.naturalHeight<360000)continue;
      if(im.closest('aside,footer,[class*="recommend"],[class*="related"],[class*="suggest"]'))continue;
      if(/avatar|badge|logo|qrcode|二维码|头像/i.test([im.className,im.alt,im.parentElement?.className].join(' ')))continue;
      try {
        const u=new URL(im.currentSrc||im.src);
        if(u.protocol!=='https:'||!['image-assets.mihuashi.com','www.mihuashi.com'].includes(u.hostname)||/!artwork\.square|!avatar\.|\/misc\//.test(u.href)||seen.has(u.href))continue;
        seen.add(u.href);images.push({url:u.href,width:im.naturalWidth,height:im.naturalHeight,kind:'detail_display'});
      }catch{}
    }
    return {...base,...info(),images:images.slice(0,30)};
  }
  const output=[];const seen=new Set();const links=new Set();
  for(const card of cards) {
    const im=card.matches('img')?card:card.querySelector('img');
    let url=art(card.matches('a')?card.href:card.querySelector('a[href]')?.href);
    const id=card.getAttribute('data-artwork-id');
    if(!url&&/^\d+$/.test(id||''))url=location.origin+'/artworks/'+id;
    for(const attr of ['data-artwork-url','data-work-url'])if(!url)url=art(card.getAttribute(attr));
    let key=url;
    if(!key&&im)try{const u=new URL(im.currentSrc||im.src);key=u.origin+u.pathname;}catch{}
    if(!key||seen.has(key))continue;
    seen.add(key);if(url)links.add(url);output.push({key,url});
  }
  for(const a of document.querySelectorAll('a[href]')) if(visible(a)&&!a.closest('aside,footer,[class*="recommend"],[class*="related"]')) {const u=art(a.href);if(u)links.add(u);}
  const loader=[...document.querySelectorAll('[aria-busy="true"],.loading-default,.loading-spinner,.el-loading-mask,.infinite-loading-container .infinite-status-prompt')].filter(visible);
  const loading=loader.some(e=>e.getAttribute('aria-busy')==='true'||/loading|spinner|mask/.test(e.className)&&!/没有更多|加载完成|全部加载/.test(e.textContent)||/加载中|正在加载/.test(e.textContent));
  const m=text.match(/精选作品\s*[(（]?\s*(\d+)/);
  return {...base,...info(),cards:output,links:[...links],expected:m?Number(m[1]):null,loading,card_count:output.length};
}

// Inspired by mounted artwork-prop discovery in storyAura/MihuashiDownloader.
// Narrow read: only mounted artwork/list components, only numeric IDs; no credentials,
// signed API calls, global application-state traversal or thumbnail URL rewriting.
function readMountedWorks() {
  const ids=new Set(),keys=new Set();let inspected=0;
  const consume=raw=>{
    if(raw&&typeof raw==='object'&&/^\d+$/.test(String(raw.id||''))&&(raw.url||raw.image_url||raw.artwork_type||raw.likes_count!==undefined))ids.add(String(raw.id));
  };
  const elements=[...document.querySelectorAll('.user-artwork,.masonry-artwork,[data-artwork-id]')].filter(e=>!e.closest('aside,footer,[class*="recommend"],[class*="related"]'));
  const visited=new Set();
  for(const card of elements.slice(0,300)) {
    let el=card;
    for(let depth=0;el&&depth<5;depth++,el=el.parentElement) {
      if(visited.has(el))continue;visited.add(el);
      const vm=el.__vue__,v3=el.__vueParentComponent;
      const bags=[vm?._props,vm?._data,vm?.$options?.propsData,v3?.props];
      for(const bag of bags) {
        if(!bag||typeof bag!=='object')continue;inspected++;
        consume(bag.artwork);
        if(depth<=2&&bag.artwork?.id){const im=card.querySelector("img");try{const u=new URL(im.currentSrc||im.src);keys.add(u.origin+u.pathname);}catch{}}
        if(Array.isArray(bag.artworks))bag.artworks.slice(0,5000).forEach(consume);
      }
    }
  }
  return {links:[...ids].slice(0,5000).map(id=>'https://www.mihuashi.com/artworks/'+id),keys:[...keys],inspected};
}

function clickProfileCard(key) {
  const match=[...document.images].find(im=>{try{const u=new URL(im.currentSrc||im.src);return u.origin+u.pathname===key;}catch{return false;}});
  if(!match)return {clicked:false};
  const original=window.open;let captured=null;
  const wrapper=function(url,...rest){try{const u=new URL(url,location.href);if(u.origin===location.origin&&/^\/artworks\/\d+\/?$/.test(u.pathname)){captured=u.origin+u.pathname.replace(/\/$/,'');return null;}}catch{}return original.call(window,url,...rest);};
  try {window.open=wrapper;match.click();}finally{if(window.open===wrapper)window.open=original;}
  return {clicked:true,captured};
}
