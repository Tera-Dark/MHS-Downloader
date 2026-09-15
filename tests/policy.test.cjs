const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context={URL};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/core-policy.js'),'utf8'),context);const p=context.ArchivePolicy;
test('valid source normalized without adding a default',()=>{assert.equal(p.siteURL('https://www.mihuashi.com/artworks/12/?x=1'),'https://www.mihuashi.com/artworks/12');assert.equal(p.siteURL(''),null);});
test('profile paths',()=>{assert.equal(p.siteURL('https://www.mihuashi.com/profiles/12','profile'),'https://www.mihuashi.com/profiles/12');assert.equal(p.siteURL('https://www.mihuashi.com/users/test','profile'),'https://www.mihuashi.com/users/test');});
test('host spoofing, userinfo, non HTTPS and extra ports refused',()=>{for(const u of ['https://www.mihuashi.com.evil.test/artworks/1','https://a:b@www.mihuashi.com/artworks/1','http://www.mihuashi.com/artworks/1','https://www.mihuashi.com:99/artworks/1'])assert.equal(p.siteURL(u),null);});
test('actual signed display image preserved; no original rewrite',()=>{const u='https://image-assets.mihuashi.com/test.png?signature=fixture';assert.equal(p.imageURL(u),u);});
test('thumbnails and foreign assets excluded',()=>{for(const u of ['https://image-assets.mihuashi.com/a!artwork.square','https://image-assets.mihuashi.com/a!avatar.small','https://evil.test/a.png'])assert.equal(p.imageURL(u),null);});
test('Retry-After never shortens a server delay',()=>{assert.equal(p.retryUntil('3600',0),3600000);assert.equal(p.retryUntil('3',0),60000);assert.equal(p.retryUntil('invalid',0),60000);});
test('blocked images are not labelled complete by the UI',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../extension/panel.js'),'utf8');
 const functionText=source.slice(source.indexOf('function taskHTML'),source.indexOf('\nfunction render'));
 const ctx={esc:String,count:o=>Object.values(o).reduce((s,n)=>s+n,0),size:String,date:String,taskSettings:()=>'',Date};vm.createContext(ctx);vm.runInContext(functionText+'\nglobalThis.renderTask=taskHTML;',ctx);
 const html=ctx.renderTask({id:'a'.repeat(32),source:'https://www.mihuashi.com/artworks/1',state:'active',scan_state:'finished',settled:true,works:{ready:1},files:{blocked:1},diagnostics:{},mode:'download',expected:1});
 assert.match(html,/存在失败\/受限项/);assert.doesNotMatch(html,/>已完成</);
});
