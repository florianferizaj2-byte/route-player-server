import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createAccountServer } from '../app.mjs';

const document = { format:'route-player',version:1,coordinateSystem:'WGS84',id:'353f7128-b86d-4f3f-a03e-95bd7dc75130',name:'成都 & 往返 <路线>',createdAt:1791792000000,
  draft:{mode:'PATH',repeat:'PING_PONG',speed:7.25,twoPoints:[[30.1,104.2],[30.2,104.3]],pathPoints:[[30.57227,104.06654],[30.573,104.065],[30.574,104.07]]}};
async function setup(t, options={}) {
  const directory=await mkdtemp(join(tmpdir(),'route-account-'));
  let now=1791792000000;
  const configuration={dataDirectory:directory,adminUsername:'admin',adminPassword:'TestAdminPassword-4937',clock:()=>now,...options};
  let instance=await createAccountServer(configuration);
  await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));
  let base=`http://127.0.0.1:${instance.server.address().port}`;
  let cookie='';
  async function request(path,method='GET',data,token) {
    const response=await fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`} : {}),...(path.startsWith('/v1/admin/')?{Cookie:cookie,Origin:base}:{})},body:data?JSON.stringify(data):undefined});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  t.after(async()=>{await new Promise(resolve=>instance.server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return {request,directory,get instance(){return instance;},get base(){return base;},setNow(value){now=value;},
    async restart(){await new Promise(resolve=>instance.server.close(resolve));instance=await createAccountServer(configuration);await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${instance.server.address().port}`;},
    async admin(){assert.equal((await request('/v1/admin/login','POST',{username:'admin',password:configuration.adminPassword})).status,200);},
    async user(username='tester',deviceId='device_install_123456789'){const r=await request('/v1/auth/register','POST',{username,password:'Password-82731',deviceId});assert.equal(r.status,201);return r.body;},
    async card(settings={}){await this.admin();const r=await request('/v1/admin/cards','POST',{count:1,durationDays:30,label:'测试批次',...settings});assert.equal(r.status,201);return r.body.cards[0];}};
}
test('registration, persisted login, logout and session revocation',async t=>{
  const c=await setup(t),u=await c.user();assert.equal(u.activation.state,'inactive');assert.equal(u.user.username,'tester');assert.match(u.token,/^[a-f0-9]{64}$/);
  assert.equal((await c.request('/v1/account/me','GET',null,u.token)).status,200);
  assert.equal((await c.request('/v1/auth/login','POST',{username:'tester',password:'WrongPassword123',deviceId:'device_install_123456789'})).status,401);
  await c.restart();assert.equal((await c.request('/v1/account/me','GET',null,u.token)).body.user.username,'tester');
  assert.equal((await c.request('/v1/auth/logout','POST',{},u.token)).status,200);
  assert.equal((await c.request('/v1/account/me','GET',null,u.token)).status,401);
});
test('admin batches generate unique full codes once; store contains no passwords, codes or bearer tokens',async t=>{
  const c=await setup(t),u=await c.user(),first=await c.card({count:50});
  const list=await c.request('/v1/admin/cards');assert.equal(list.body.cards.length,50);assert.equal(list.body.total,50);
  assert.equal(new Set(c.instance.store.state.cards.map(v=>v.codeHash)).size,50);
  assert.equal(list.body.cards.some(v=>'code' in v||'codeHash' in v),false);
  const database=await readFile(join(c.directory,'accounts.json'),'utf8');
  for(const secret of ['TestAdminPassword-4937','Password-82731',u.token,first.code])assert.equal(database.includes(secret),false);
});
test('activation binds account/device and starts duration once; reactivation is idempotent',async t=>{
  const c=await setup(t),u=await c.user(),card=await c.card();
  const first=await c.request('/v1/account/activate','POST',{code:card.code},u.token);assert.equal(first.body.activation.state,'active');
  const expiry=first.body.activation.expiresAt;assert.equal(expiry,1791792000000+30*86400000);
  c.setNow(1791792000000+3600000);
  assert.equal((await c.request('/v1/account/activate','POST',{code:card.code.toLowerCase()},u.token)).body.activation.expiresAt,expiry);
  const other=await c.user('another');assert.equal((await c.request('/v1/account/activate','POST',{code:card.code},other.token)).body.error,'card_owned');
});
test('disable, enable, unbind, device transfer and expiry changes take effect in account status',async t=>{
  const c=await setup(t),u=await c.user(),card=await c.card();
  const activated=await c.request('/v1/account/activate','POST',{code:card.code},u.token);const expiry=activated.body.activation.expiresAt;
  await c.request(`/v1/admin/cards/${card.id}`,'PATCH',{disabled:true});assert.equal((await c.request('/v1/account/me','GET',null,u.token)).body.activation.state,'disabled');
  assert.equal((await c.request('/v1/account/activate','POST',{code:card.code},u.token)).body.error,'card_disabled');
  await c.request(`/v1/admin/cards/${card.id}`,'PATCH',{disabled:false});
  const moved=await c.request('/v1/auth/login','POST',{username:'tester',password:'Password-82731',deviceId:'new_device_install_987654'});
  assert.equal((await c.request('/v1/account/me','GET',null,moved.body.token)).body.activation.state,'other_device');
  assert.equal((await c.request('/v1/account/activate','POST',{code:card.code},moved.body.token)).body.error,'card_bound');
  await c.request(`/v1/admin/cards/${card.id}/unbind`,'POST',{});assert.equal((await c.request('/v1/account/me','GET',null,u.token)).body.activation.state,'unbound');
  const restored=await c.request('/v1/account/activate','POST',{code:card.code},moved.body.token);assert.equal(restored.body.activation.expiresAt,expiry);
  assert.equal((await c.request('/v1/account/me','GET',null,u.token)).body.activation.state,'other_device');
  await c.request(`/v1/admin/cards/${card.id}`,'PATCH',{expiresAt:1791792000000-1000});assert.equal((await c.request('/v1/account/me','GET',null,moved.body.token)).body.activation.state,'expired');
});
test('route backup, list, download and delete preserve both drafts, settings and Unicode names',async t=>{
  const c=await setup(t),u=await c.user(),card=await c.card();await c.request('/v1/account/activate','POST',{code:card.code},u.token);
  const upload=await c.request('/v1/routes','POST',{document},u.token);assert.equal(upload.status,201);const id=upload.body.route.id;
  const second=await c.request('/v1/routes','POST',{document:{...document,name:'新版'}},u.token);assert.notEqual(id,second.body.route.id);
  const list=await c.request('/v1/routes','GET',null,u.token);assert.equal(list.body.routes.length,2);assert.equal(list.body.routes.find(r=>r.id===id).repeat,'PING_PONG');
  await c.restart();assert.deepEqual((await c.request(`/v1/routes/${id}`,'GET',null,u.token)).body.document,document);
  assert.equal((await c.request(`/v1/routes/${id}`,'DELETE',null,u.token)).status,200);
  assert.equal((await c.request(`/v1/routes/${id}`,'GET',null,u.token)).status,404);
});
test('users cannot read/delete other accounts backups; expired cards permit downloading own data only',async t=>{
  const c=await setup(t),u=await c.user(),other=await c.user('another'),card=await c.card();
  assert.equal((await c.request('/v1/routes','POST',{document},u.token)).status,403);
  await c.request('/v1/account/activate','POST',{code:card.code},u.token);const upload=await c.request('/v1/routes','POST',{document},u.token);const id=upload.body.route.id;
  assert.equal((await c.request('/v1/routes','GET',null,other.token)).body.routes.length,0);
  assert.equal((await c.request(`/v1/routes/${id}`,'GET',null,other.token)).status,404);
  assert.equal((await c.request(`/v1/routes/${id}`,'DELETE',null,other.token)).status,404);
  await c.request(`/v1/admin/cards/${card.id}`,'PATCH',{disabled:true});
  assert.equal((await c.request(`/v1/routes/${id}`,'GET',null,u.token)).status,200);
  assert.equal((await c.request('/v1/routes','POST',{document},u.token)).status,403);
});
test('simultaneous redemption of the same card has exactly one owner',async t=>{
  const c=await setup(t),a=await c.user('user_a'),b=await c.user('user_b'),card=await c.card();
  const results=await Promise.all([a,b].map(u=>c.request('/v1/account/activate','POST',{code:card.code},u.token)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.ok(c.instance.store.state.cards[0].userId);
});
test('expiry and redemption deadlines are server-controlled; unbind does not renew validity',async t=>{
  const c=await setup(t),u=await c.user(),card=await c.card({durationDays:0.001,redeemBefore:1791792000000+100000});
  await c.request('/v1/account/activate','POST',{code:card.code},u.token);c.setNow(1791792000000+90000);
  assert.equal((await c.request('/v1/account/me','GET',null,u.token)).body.activation.state,'expired');
  await c.request(`/v1/admin/cards/${card.id}/unbind`,'POST',{});assert.equal((await c.request('/v1/account/activate','POST',{code:card.code},u.token)).body.error,'card_expired');
  const unused=await c.card({redeemBefore:1791792000000+100000});c.setNow(1791792000000+100001);
  assert.equal((await c.request('/v1/account/activate','POST',{code:unused.code},u.token)).body.error,'card_redeem_expired');
});
test('validation refuses malformed settings, oversized routes, non-WGS84 and unsupported versions',async t=>{
  const c=await setup(t),u=await c.user(),card=await c.card();await c.request('/v1/account/activate','POST',{code:card.code},u.token);
  for(const invalid of [{...document,version:2},{...document,coordinateSystem:'GCJ02'},{...document,draft:{...document.draft,speed:121}},
    {...document,draft:{...document.draft,pathPoints:Array(201).fill([1,2])}}, {...document,draft:{...document.draft,pathPoints:[[NaN,0],[0,1]]}}, {...document,name:''}]) {
    assert.equal((await c.request('/v1/routes','POST',{document:invalid},u.token)).status,400);
  }
  assert.equal((await c.request('/v1/admin/cards','POST',{count:501,durationDays:30,label:'a'})).status,400);
  assert.equal((await c.request('/v1/auth/register','POST',{username:'../a',password:'Password82731',deviceId:'device_install_123456789'})).status,400);
});
test('password changes invalidate all sessions and allow login with the new password',async t=>{
  const c=await setup(t),u=await c.user();
  assert.equal((await c.request('/v1/auth/password','POST',{currentPassword:'Password-82731',password:'NewPassword-7392'},u.token)).status,200);
  assert.equal((await c.request('/v1/account/me','GET',null,u.token)).status,401);
  assert.equal((await c.request('/v1/auth/login','POST',{username:'tester',password:'NewPassword-7392',deviceId:'device_install_123456789'})).status,200);
});
test('admin requires cookies and same-origin mutations; user bearer cannot administer cards',async t=>{
  const c=await setup(t),u=await c.user();assert.equal((await c.request('/v1/admin/cards','GET',null,u.token)).status,401);await c.admin();
  const wrong=await fetch(c.base+'/v1/admin/cards',{method:'POST',headers:{Cookie:'rp_admin=bad',Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(wrong.status,401);
  const adminSession=c.instance.store.state.sessions.find(s=>s.deviceId==='admin-browser');assert.ok(adminSession);
  const response=await fetch(c.base+'/v1/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'TestAdminPassword-4937'})});
  const cookie=response.headers.get('set-cookie');assert.ok(cookie.includes('HttpOnly'));assert.ok(cookie.includes('SameSite=Strict'));
  const csrf=await fetch(c.base+'/v1/admin/cards',{method:'POST',headers:{Cookie:cookie.split(';')[0],Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
});
test('health and admin assets serve correct content and restrictive browser policy',async t=>{
  const c=await setup(t);assert.equal((await c.request('/health')).body.status,'ok');
  for(const path of ['/admin','/admin/app.js','/admin/style.css']){const response=await fetch(c.base+path);assert.equal(response.status,200);assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));assert.ok((await response.text()).length>100);}
});
test('auth rate limits return 429 and reset after the window',async t=>{
  const c=await setup(t,{authRateLimit:2});await c.user();
  assert.equal((await c.request('/v1/auth/login','POST',{username:'tester',password:'wrongpass',deviceId:'device_install_123456789'})).status,401);
  assert.equal((await c.request('/v1/auth/login','POST',{username:'tester',password:'wrongpass',deviceId:'device_install_123456789'})).status,429);
  c.setNow(1791792000000+60000);assert.equal((await c.request('/v1/auth/login','POST',{username:'tester',password:'Password-82731',deviceId:'device_install_123456789'})).status,200);
});
