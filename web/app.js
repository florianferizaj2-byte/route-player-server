const el = id => document.getElementById(id);
const stateNames = { unused:'未激活',active:'已激活',disabled:'已停用',expired:'已到期',unbound:'已解绑',redeem_expired:'超过激活期限' };
const errors = { invalid_credentials:'账号或密码不正确',invalid_username:'账号须为 3–32 位字母、数字或下划线',invalid_password:'密码须为 8–128 位',unauthorized:'请重新登录',rate_limited:'操作过于频繁，请稍后重试',invalid_card_settings:'请检查数量、有效天数和时间',invalid_origin:'请求来源不正确，请从后台页面操作',card_limit:'卡密数量达到上限',server_error:'服务器暂时无法处理请求' };
let page=1,total=0,generated=[],editing=null;
const notice = (text,error=false) => { el('notice').textContent=text; el('notice').dataset.error=error; };
const date = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '尚未激活';
const text = (tag,value) => { const n=document.createElement(tag); n.textContent=value; return n; };
async function api(path, method='GET', data) {
  const response = await fetch(`/v1/admin/${path}`,{method,credentials:'same-origin',headers:data ? {'Content-Type':'application/json'} : {},body:data ? JSON.stringify(data) : undefined});
  const result=await response.json();
  if(!response.ok){ if(response.status===401) signedOut(); throw new Error(errors[result.error] ?? '操作失败，请检查服务器连接'); }
  return result;
}
async function run(button, operation) {
  if(button) button.disabled=true;
  try{await operation();}catch(error){notice(error.message,true);}finally{if(button)button.disabled=false;}
}
function signedOut(){el('dashboard').hidden=true;el('loginPanel').hidden=false;el('logout').hidden=true;generated=[];el('codes').value='';el('generated').hidden=true;}
async function signedIn(user){el('dashboard').hidden=false;el('loginPanel').hidden=true;el('logout').hidden=false;el('adminName').textContent=user.username;await loadCards();}
el('loginForm').addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{const form=new FormData(event.target);const result=await api('login','POST',{username:form.get('username'),password:form.get('password')});event.target.reset();notice('已登录');await signedIn(result.user);});});
el('logout').onclick=()=>run(el('logout'),async()=>{await api('logout','POST',{});signedOut();notice('已退出登录');});
el('generateForm').addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{const form=new FormData(event.target);const deadline=form.get('redeemBefore');const result=await api('cards','POST',{label:form.get('label'),count:Number(form.get('count')),durationDays:Number(form.get('durationDays')),redeemBefore:deadline?new Date(deadline).getTime():null});generated=result.cards;el('codes').value=generated.map(c=>c.code).join('\n');el('generated').hidden=false;notice(`已生成 ${generated.length} 张卡密，请保存完整卡密。`);page=1;await loadCards();});});
el('downloadCodes').onclick=()=>{if(!generated.length)return;const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;const csv='\uFEFF卡密,批次,有效天数,最晚激活时间\r\n'+generated.map(c=>[c.code,c.label,c.durationDays,c.redeemBefore?date(c.redeemBefore):''].map(quote).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`路线定位卡密-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
el('clearCodes').onclick=()=>{generated=[];el('codes').value='';el('generated').hidden=true;};
function confirmAction(title,body,operation){el('confirmTitle').textContent=title;el('confirmBody').textContent=body;el('confirmDialog').showModal();el('acceptConfirm').onclick=()=>run(el('acceptConfirm'),async()=>{await operation();el('confirmDialog').close();await loadCards();});}
el('cancelConfirm').onclick=()=>el('confirmDialog').close();
function action(label,fn,cls=''){const b=text('button',label);b.type='button';b.className=cls;b.onclick=()=>run(b,fn);return b;}
async function loadCards(){const result=await api(`cards?page=${page}&q=${encodeURIComponent(el('search').value)}`);total=result.total;const tbody=el('cards');tbody.replaceChildren();for(const c of result.cards){const tr=document.createElement('tr');const title=document.createElement('td');title.append(text('strong',c.label||'未命名批次'),text('small',`尾号 ${c.hint}`));const status=document.createElement('td');const badge=text('span',stateNames[c.state]);badge.className='badge';badge.dataset.state=c.state;status.append(badge);const expiry=document.createElement('td');expiry.append(text('span',c.expiresAt?date(c.expiresAt):`${c.durationDays} 天 · 首次激活起`));if(c.redeemBefore)expiry.append(text('small',`最晚激活：${date(c.redeemBefore)}`));const owner=document.createElement('td');owner.append(text('span',c.username||'未绑定'));if(c.deviceId)owner.append(text('code',c.deviceId));const controls=document.createElement('td');const row=document.createElement('div');row.className='rowActions';row.append(action('有效期',async()=>openEdit(c)),action(c.disabled?'启用':'停用',async()=>confirmAction(c.disabled?'启用此卡密？':'停用此卡密？',`尾号 ${c.hint}。停用后 App 下次联网核验会停止移动。`,async()=>{await api(`cards/${c.id}`,'PATCH',{disabled:!c.disabled});notice(c.disabled?'卡密已启用':'卡密已停用');}),c.disabled?'':'danger'));if(c.deviceId)row.append(action('解绑',async()=>confirmAction('解绑当前设备？','账号和原到期时间会保留；该账号可用原卡密绑定新设备。',async()=>{await api(`cards/${c.id}/unbind`,'POST',{});notice('设备已解绑');})));controls.append(row);tr.append(title,status,expiry,owner,controls);tbody.append(tr);}el('total').textContent=`${total} 张`;el('empty').hidden=result.cards.length>0;el('page').textContent=`第 ${page} / ${Math.max(1,Math.ceil(total/50))} 页`;el('previous').disabled=page===1;el('next').disabled=page*50>=total;}
function localDate(value){const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function openEdit(c){editing=c;el('editHint').textContent=c.expiresAt?'修改已激活卡密的到期时间。':'未激活卡密会在首次激活时按此天数计时。';el('daysRow').hidden=!!c.expiresAt;el('expiryRow').hidden=!c.expiresAt;el('editDays').value=c.durationDays;el('editExpiry').value=c.expiresAt?localDate(c.expiresAt):'';el('editDialog').showModal();}
el('editForm').addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{await api(`cards/${editing.id}`,'PATCH',editing.expiresAt?{expiresAt:new Date(el('editExpiry').value).getTime()}:{durationDays:Number(el('editDays').value)});el('editDialog').close();notice('有效期已更新');await loadCards();});});
el('cancelEdit').onclick=()=>el('editDialog').close();
el('searchForm').addEventListener('submit',event=>{event.preventDefault();page=1;run(event.submitter,loadCards);});
el('refresh').onclick=()=>run(el('refresh'),loadCards);el('previous').onclick=()=>{page--;run(null,loadCards);};el('next').onclick=()=>{page++;run(null,loadCards);};
el('loadUsers').onclick=()=>run(el('loadUsers'),async()=>{const result=await api('users');el('users').replaceChildren(...result.users.map(u=>text('li',`${u.username} · 注册于 ${date(u.createdAt)}`)));if(!result.users.length)el('users').append(text('li','暂无注册账号'));});
run(null,async()=>{try{const result=await api('me');await signedIn(result.user);}catch{signedOut();notice('输入管理员账号和密码登录。');}});
