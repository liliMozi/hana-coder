(function(){
/* Frame fit: fixed height in chat, fill the window when popped out (same rule as the Issue cards). */
function fitFrame(){document.documentElement.classList.toggle('hc-fill',(window.innerHeight||0)>570+40)}
window.addEventListener('resize',fitFrame);fitFrame();
const initial=JSON.parse(document.querySelector('[data-card-state]').textContent);
const declaration=JSON.parse(document.querySelector('[data-card-manifest]').textContent);
let model=initial.model,selected=null,caps={},store=Promise.resolve(),ready=false;
const TYPES=['fix','feature','refactor','docs','chore'];
const palette={fix:['#eee5d3','#8a7448'],feature:['#e1e9dc','#607454'],refactor:['#e9e2ed','#80688b'],docs:['#dfe8ec','#607c8b'],chore:['#e7e4df','#7a7266']};
const $=id=>document.getElementById(id);
function el(t,c,v){const e=document.createElement(t);if(c)e.className=c;if(v!==undefined)e.textContent=v;return e}
function ensure(){
  if(!Array.isArray(model.checkedIds))model.checkedIds=[];
  if(!TYPES.includes(model.branchType))model.branchType='fix';
  if(typeof model.branchName!=='string')model.branchName='';
  if(!model.operation||typeof model.operation!=='object')model.operation=null;
}
function eligible(row){
  if(!row||typeof row.id!=='string'||!row.id)return false;
  if(row.id===model.repoPath||row.branch==='main')return false;
  if(row.error||row.detached||row.locked||row.prunable)return false;
  return true;
}
function retainChecks(){
  const allowed=new Set(model.rows.filter(eligible).map(r=>r.id));
  model.checkedIds=model.checkedIds.filter(id=>allowed.has(id));
}
function controlsReady(){
  return ready&&caps.emit==='available'&&['available','local_fallback'].includes(caps.state)&&caps['data.get']&&['available','local_fallback'].includes(caps['data.get'].status)&&model.phase==='idle'&&!model.operation&&!!model.repoPath;
}
function persist(){if(!['available','local_fallback'].includes(caps.state))return Promise.resolve(false);ensure();model.selected=selected;model.branchType=$('branchType').value;model.branchName=$('branchName').value;const copy=JSON.parse(JSON.stringify(model));const next=store.then(async()=>{const r=await window.card.state.set('model',copy);if(!r.ok)throw Error(r.error||'保存失败');return true});store=next.catch(()=>{});return next.catch(e=>{model.message='状态保存失败：'+e.message;$('status').textContent=model.message;return false})}
function formatTime(value,now=new Date()){const d=new Date(value);if(Number.isNaN(d.getTime()))return '';const hh=String(d.getHours()).padStart(2,'0'),mm=String(d.getMinutes()).padStart(2,'0');const same=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();return (same?'':(d.getMonth()+1)+'月'+d.getDate()+'日 ')+hh+':'+mm}
function checkbox(row){
  const input=el('input','pick');input.type='checkbox';const ok=eligible(row);
  input.disabled=!ok||!controlsReady();input.checked=ok&&model.checkedIds.includes(row.id);
  input.setAttribute('aria-label',ok?'选择 '+row.branch:(row.branch==='main'||row.id===model.repoPath?'主工作树，不参与合并清理':'此工作树当前不可选择'));
  input.addEventListener('click',event=>event.stopPropagation());
  input.addEventListener('change',()=>{if(!eligible(row))return;model.checkedIds=input.checked?[...new Set([...model.checkedIds,row.id])]:model.checkedIds.filter(id=>id!==row.id);draw();persist()});
  return input;
}
function syncSelect(){
  const select=$('branchType');if(select.value!==model.branchType)select.value=model.branchType;
  if($('branchName').value!==model.branchName)$('branchName').value=model.branchName;
  const colors=palette[model.branchType]||palette.fix,host=document.querySelector('.type-select');
  host.style.setProperty('--type-bg',colors[0]);host.style.setProperty('--type-ink',colors[1]);
  const shown=host.querySelector('.hs-select__value');if(shown)shown.textContent=model.branchType;
}
function draw(){ensure();retainChecks();const refreshing=model.phase==='scan'||model.phase==='agent';const busy=refreshing||!!model.operation;const can=controlsReady();
$('repoLabel').textContent=model.repoLabel||'仓库未绑定';
$('cancel').hidden=!(model.phase==='agent'||model.operation);$('cancel').textContent=model.operation?'停止等待':'取消本次刷新';
$('refresh').disabled=busy||!ready||!declaration.toolBindings?.scan||caps.invoke!=='available'||caps.emit!=='available';
$('refresh').classList.toggle('busy',refreshing);$('refresh').textContent=refreshing?'正在刷新…':'刷新';$('refresh').setAttribute('aria-busy',String(refreshing));
$('createTree').disabled=!can;$('mergeTrees').disabled=!can||!model.checkedIds.length;
$('mergeTrees').textContent='合并并清理'+(model.checkedIds.length?' · '+model.checkedIds.length:'');
$('selectAll').disabled=!can||!model.rows.some(eligible);$('branchType').disabled=!can;$('branchName').disabled=!can;
const trigger=document.querySelector('.type-select .hs-select__trigger');if(trigger)trigger.disabled=!can;
syncSelect();
$('updated').textContent=formatTime(model.at);$('updated').dateTime=model.at;$('updated').setAttribute('aria-label','更新时间 '+formatTime(model.at));
$('status').textContent=(model.message||'').startsWith('已更新')?'':(model.message||'');
$('stats').replaceChildren(el('span','hs-badge hs-badge--pending',model.rows.length+' 个工作树'),el('span','hs-badge hs-badge--good',model.rows.filter(r=>!r.error&&!r.status).length+' 个干净'));
if(selected&&!model.rows.some(r=>r.id===selected))selected=null;const area=$('pages');area.replaceChildren();
if(!selected){const map=el('div','map');model.rows.forEach(r=>{const row=el('div','entry pick-row');const b=el('button','entry');b.type='button';const top=el('div','top');top.append(el('span','branch',r.branch),el('span','hs-badge '+((r.error||r.status)?'hs-badge--warn':'hs-badge--good'),r.error?'读取失败':r.status?'有改动':'干净'));b.append(top,el('p','summary',model.summaries[r.id]||'简介待补充'));b.onclick=()=>{selected=r.id;draw();persist()};row.append(checkbox(r),b);map.append(row)});area.append(map)}else{const r=model.rows.find(r=>r.id===selected),label=el('label','detail-pick'),g=el('section','group');label.append(checkbox(r),document.createTextNode(eligible(r)?'选择此工作树':(r.branch==='main'||r.id===model.repoPath?'主工作树 · 受保护':'此工作树当前不可选择')));g.append(el('p','branch',r.branch),el('p','summary',model.summaries[r.id]||'简介待补充'));for(const [k,v] of [['目录',r.id],['提交',r.head],['上游',r.upstream||'未设置上游'],['改动',r.error||r.status||'无未提交文件'],['近期提交',r.commits||'首次快照未收录']])g.append(el('p','line',k+'\n'+v));area.append(label,g)}
const choices=model.rows.filter(eligible);$('selectAll').checked=choices.length>0&&choices.every(r=>model.checkedIds.includes(r.id));$('selectAll').indeterminate=model.checkedIds.length>0&&model.checkedIds.length<choices.length;
const idx=selected?model.rows.findIndex(r=>r.id===selected)+1:0;$('dots').replaceChildren();[null,...model.rows.map(r=>r.id)].forEach((id,i)=>{const b=el('button','dot'+(i===0?' home':'')+(i===idx?' on':''));b.type='button';b.setAttribute('aria-label',i?'工作树 '+model.rows[i-1].branch:'总览');if(i===0){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M4 9.5 9 4Q12 .8 15 4L20 9.5Q22 11.5 22 14V17Q22 22 17 22H7Q2 22 2 17V14Q2 11.5 4 9.5Z');const ring=path.cloneNode();ring.setAttribute('class','home-ring');const gap=path.cloneNode();gap.setAttribute('class','home-gap');path.setAttribute('class','home-shape');svg.append(ring,gap,path);b.append(svg);}b.onclick=()=>{selected=id;draw();persist()};$('dots').append(b)});$('prev').disabled=idx===0;$('next').disabled=idx===model.rows.length}
function step(d){const ids=[null,...model.rows.map(r=>r.id)],i=ids.indexOf(selected);selected=ids[Math.max(0,Math.min(ids.length-1,i+d))];draw();persist()}
function finishOperation(data){
  const failed=data.phase==='error';
  model.operation=null;model.phase='idle';
  model.message=failed?(data.error||data.message||'操作失败，仓库未被此卡改写。'):((data.message||'请求已完成。')+' 请刷新查看仓库事实。');
  draw();persist();
}
function accept(data){
  if(!data)return;
  if(data.kind==='worktree-operation'){
    if(!model.operation||data.requestId!==model.operation.requestId)return;
    if(data.phase!=='done'&&data.phase!=='error')return;
    finishOperation(data);return;
  }
  if((data.kind&&data.kind!=='worktree-enrich')||data.refreshId!==model.refreshId||model.phase!=='agent')return;
  if(data.phase!=='done'&&data.phase!=='error')return;
  if(data.phase==='done'){for(const r of model.rows){const text=data.summaries&&data.summaries[r.id];if(typeof text!=='string'){model.phase='idle';model.message='简介返回不完整，请重新刷新。';draw();persist();return;}}model.summaries=Object.fromEntries(model.rows.map(r=>[r.id,data.summaries[r.id]]));model.message='';}else model.message=data.error||'Agent 补充失败；工作树事实已保留。';
  model.phase='idle';draw();persist();
}
function extract(result){const texts=[];function walk(x){if(typeof x==='string')texts.push(x);else if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object')Object.values(x).forEach(walk)}walk(result);const text=texts.find(t=>t.includes('HANA_SNAPSHOT='));if(!text)throw Error('命令未返回完整快照，请重试；当前数据未替换。');const match=text.match(/HANA_SNAPSHOT=(\{[^\n]*\})/);if(!match)throw Error('快照格式不完整');const s=JSON.parse(match[1]);if(!Array.isArray(s.rows)||typeof s.at!=='string')throw Error('快照格式无效');return s}
async function refresh(){if(model.phase!=='idle'||model.operation||$('refresh').disabled)return;model.refreshId=crypto.randomUUID();model.phase='scan';model.message='正在读取本地工作树…';draw();try{if(!await persist())throw Error('无法保存请求状态');const out=await window.card.invoke('scan');if(!out.ok)throw Error(out.error||'读取失败');const snap=extract(out.result);model.rows=snap.rows;model.at=snap.at;model.summaries=Object.fromEntries(model.rows.filter(r=>model.summaries[r.id]).map(r=>[r.id,model.summaries[r.id]]));retainChecks();model.phase='agent';model.message='条目已更新，Agent 正在补充简介…';draw();if(!await persist())throw Error('无法保存新快照');const sent=await window.card.emit('hana-corder.enrich-worktrees',{repoPath:model.repoPath,refreshId:model.refreshId,instruction:'读取本事件来源卡片 state.model，核对 refreshId。采集已完成，根据 rows 提交/改动补齐每个工作树的一句话用途；仅名称推断要注明，祖先提交不是本分支用途。用 update_card_data 向来源 cardEntityId 写 {kind:"worktree-enrich",refreshId,phase:"done",summaries:{[完整工作树id]:简介}}；失败写同kind/id及phase:"error",error。回复会复位按钮。不改代码，不推送，不删除工作树。'});if(!sent.ok)throw Error(sent.error||'无法请求 Agent')}catch(e){model.phase='idle';model.message='刷新失败：'+e.message;draw();await persist()}}
async function release(error){model.operation=null;model.phase='idle';model.message=error;draw();await persist()}
async function createTree(){
  if(!controlsReady())return;
  const name=$('branchName').value.trim(),type=$('branchType').value;
  if(!TYPES.includes(type))return;
  const requestId=crypto.randomUUID();
  model.branchType=type;model.branchName=name;
  model.operation={requestId,action:'create',type,name,baseBranch:'main'};
  model.message='正在提交新建请求…';draw();
  if(!await persist()){await release('状态保存失败，新建请求未发出。');return}
  const sent=await window.card.emit('hana-corder.create-worktree',{repoPath:model.repoPath,requestId,instruction:'这是用户在当前卡片明确提交的新建工作树请求。读取来源 state.model.operation，仅当 requestId 匹配且 action 为 create 时执行。基于本地 main，按仓库既有目录规范创建；name 为空时根据当前聊天生成名称，真实语义未知才询问。不要把卡片快照当作最新事实，执行前自行核对。仅创建本地工作树与分支，不推送、不操作远端。完成后用 update_card_data 向来源 cardEntityId 写 {kind:"worktree-operation",requestId,phase:"done",message}；失败写同 kind/requestId、phase:"error" 与 error。卡片不会伪造工作树列表。'});
  if(!sent.ok)await release('新建请求发送失败：'+(sent.error||'无法请求 Agent')+' 输入已保留。');
}
async function mergeTrees(){
  if(!controlsReady())return;
  const targets=model.rows.filter(r=>model.checkedIds.includes(r.id)&&eligible(r)).map(r=>({id:r.id,branch:r.branch,head:r.head}));
  if(!targets.length)return;
  const requestId=crypto.randomUUID();
  model.operation={requestId,action:'merge',targets,baseBranch:'main'};
  model.message='正在提交合并并清理请求…';draw();
  if(!await persist()){await release('状态保存失败，合并请求未发出。');return}
  const sent=await window.card.emit('hana-corder.merge-worktrees',{repoPath:model.repoPath,requestId,instruction:'这是用户在当前卡片明确提交的合并并清理请求。读取来源 state.model.operation，仅当 requestId 匹配且 action 为 merge 时处理其中完整 targets。只处理选定的本地工作树和分支，执行前按仓库规范重新检查、验证、合并和清理。不丢弃未提交修改，不 force，不删除主树或当前执行所在树，不推送，不删除远端。冲突或检查失败时停止受影响对象并报告。卡片快照不是最新事实。用 update_card_data 向来源 cardEntityId 写 {kind:"worktree-operation",requestId,phase:"done",message}；失败写同 kind/requestId、phase:"error" 与 error。'});
  if(!sent.ok)await release('合并请求发送失败：'+(sent.error||'无法请求 Agent')+' 选择已保留。');
}
function stopWaiting(){
  if(model.operation){const id=model.operation.requestId;model.operation=null;model.phase='idle';model.message='已停止等待请求 '+id+'。已发出的任务不会撤销，迟到结果会被忽略。';draw();persist();return}
  if(model.phase==='agent'){model.phase='idle';model.refreshId=null;model.message='已取消等待，可重新刷新；迟到的旧结果不会覆盖此卡。';draw();persist()}
}
function toggleAll(){
  if(!controlsReady()){$('selectAll').checked=false;return}
  const ids=model.rows.filter(eligible).map(r=>r.id);
  model.checkedIds=$('selectAll').checked?ids:[];draw();persist();
}
function tint(){model.branchType=$('branchType').value;syncSelect();persist()}
if(window.HanaCardStyle)window.HanaCardStyle.mount(document.querySelector('.new-tree'));
$('refresh').onclick=refresh;$('cancel').onclick=stopWaiting;$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);
$('createTree').onclick=createTree;$('mergeTrees').onclick=mergeTrees;$('selectAll').onchange=toggleAll;
$('branchType').addEventListener('change',tint);
$('branchName').addEventListener('input',()=>{model.branchName=$('branchName').value;persist()});
window.refresh=refresh;window.createTree=createTree;window.mergeTrees=mergeTrees;
draw();
(async()=>{ensure();if(!window.card){model.message='离线快照：刷新需要 Hana 宿主。';draw();return}const c=await window.card.capabilities();if(!c.ok){model.message=c.error||'宿主不可用';draw();return}caps=c.result.capabilities;const stateOk=['available','local_fallback'].includes(caps.state);if(stateOk){const s=await window.card.state.get('model');if(!s.ok){model.message=s.error||'状态读取失败';draw();return}if(s.result.value)model=s.result.value;ensure();selected=model.selected||null;retainChecks()}const dataOk=caps['data.get']&&['available','local_fallback'].includes(caps['data.get'].status);if(!dataOk||!stateOk){model.message='当前宿主仅可查看快照，缺少状态或数据回写能力。';draw();return}const off=window.card.data.onChange(accept);window.addEventListener('pagehide',()=>{if(typeof off==='function')off()},{once:true});const d=await window.card.data.get();if(d.ok)accept(d.result.data);else{model.message=d.error||'数据读取失败';draw();return}if(model.phase==='scan'){model.phase='idle';model.message='上次读取被中断，可以重新刷新。'}if(model.operation)model.message='已有请求仍在等待。可以停止等待；此卡不会自动重发。';if(!declaration.toolBindings?.scan)model.message=(model.operation?model.message+' ':'')+'当前模板未绑定仓库，请用配方准备脚本生成卡片。';ready=true;draw();await persist()})();
})();
