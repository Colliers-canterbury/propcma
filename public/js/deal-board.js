/* =====================================================================
   Prototype. Persists locally so it is fully clickable with no backend.
   To go live, replace save()/load() with fetch() against
   /api/deal-board — the render layer below does not change.
   ===================================================================== */
const MEETINGS={
 industrial:{title:'Industrial Meeting',
  stages:['Submissions','Campaigns','Advanced','Under contract','Unconditional'],
  deals:[
   {s:'Campaigns',a:'121 Worcester St',t:'Asking $970,000',f:0,b:'PM/ML',st:'Live',aml:'Y'},
   {s:'Campaigns',a:'756 Halswell Junction Rd',t:'PBN',f:0,b:'OS/CK',st:'Live',aml:'Y'},
   {s:'Campaigns',a:'27a Tanya St',t:'Deadline 5 Oct',f:0,b:'RM',st:'Live',aml:'Y'},
   {s:'Campaigns',a:'198 Yaldhurst Rd',t:'Auction 30 Nov',f:0,b:'RM',st:'Live',aml:'Y'},
   {s:'Campaigns',a:'596 Ferry Rd',t:'Auction 30 Nov',f:0,b:'OS/CK',st:'Live',aml:'Y'},
   {s:'Campaigns',a:'209 Hilton Highway',t:'Deadline',f:0,b:'CK/WF',st:'Upcoming',aml:'Y'},
   {s:'Under contract',a:'29 Kilmarnock St',t:'',f:100000,b:'OS/CK',st:'',aml:'Y'},
   {s:'Under contract',a:'7 Waimakariri Park Dr',t:'23 Nov',f:70000,b:'OS/CK/JM',st:'',aml:'Y'},
   {s:'Under contract',a:'39 Hands Rd',t:'',f:20000,b:'CK/OS',st:'',aml:'WIP'},
   {s:'Advanced',a:'19 Hynds Dr (Development)',t:'',f:70000,b:'HP',st:'DBL',aml:'Y'},
   {s:'Advanced',a:'8 Holt Place',t:'',f:0,b:'CK',st:'Sale',aml:''},
   {s:'Unconditional',a:'22 Clarence St South',t:'Invoiced',f:85000,b:'SS/EC',st:'',aml:'Y'},
   {s:'Unconditional',a:'264 Russley Rd (Airpark Lease)',t:'',f:200000,b:'OS/CK',st:'',aml:'Y'},
   {s:'Unconditional',a:'7, 11 Pereita Dr & 135 Hoskyns Rd',t:'',f:190000,b:'SS',st:'',aml:'Y'},
   {s:'Submissions',a:'888 Colombo St',t:'',f:0,b:'',st:'',aml:''},
   {s:'Submissions',a:'46 Belfast Rd',t:'',f:50000,b:'',st:'Investment',aml:''}],
  fines:[['SS',0],['PM',20],['CK',0],['OS',0],['RM',10],['EC',0],['HP',0],['JM',0]],
  register:[
   {n:'Storerite Logistics & LK Transport',r:'Tenant — 2,500-3,000m² warehouse with decent yard',ag:'EC',h:'Motivated'},
   {n:'Trade Direct',r:'Tenant — 1,000m² storage, any location',ag:'CK',h:'Luke warm'},
   {n:'Adairs',r:'Tenant — 6,000-10,000m² warehouse',ag:'EC',h:'Motivated'},
   {n:'Fabrum Solutions',r:'Tenant — 16,500m² yard, Hornby',ag:'EC',h:'Motivated'},
   {n:'Tourism Holdings',r:'Tenant — 27,000m² yard area, 30 March',ag:'CK',h:'Motivated'},
   {n:'Kitchen Concepts',r:'Buyer — 1,200m² warehouse, 100m² showroom',ag:'SS',h:'Slow'},
   {n:'Masons Engineering',r:'Buyer — 250-500m² warehouse, 150-250m² office',ag:'HP',h:'Luke warm'}]},
 investment:{title:'Investment Sales Meeting',
  stages:['Submissions','Campaigns / sole agency','Advanced','Conditional','Unconditional','Tracking / WIP'],
  deals:[
   {s:'Submissions',a:'183 William St, Kaiapoi',t:'',f:0,b:'BC',st:'Submitted',aml:''},
   {s:'Submissions',a:'273 Cashel St',t:'',f:0,b:'CD/LW',st:'Pending',aml:''},
   {s:'Submissions',a:'20 Moorhouse Ave',t:'',f:0,b:'MM/MO',st:'Committed',aml:''},
   {s:'Campaigns / sole agency',a:'56 Langdons Rd (MSD)',t:'2026',f:0,b:'CD/HD',st:'Deadline',aml:''},
   {s:'Campaigns / sole agency',a:'188 Main Rd',t:'',f:125000,b:'CD',st:'',aml:''},
   {s:'Campaigns / sole agency',a:'394 Colombo St',t:'',f:40000,b:'WF',st:'',aml:''},
   {s:'Campaigns / sole agency',a:'310 Tuam St',t:'',f:30000,b:'BC/MM',st:'',aml:''},
   {s:'Advanced',a:'295 Blenheim Rd',t:'June',f:70000,b:'WF/BB',st:'',aml:''},
   {s:'Advanced',a:'214 Main South Rd',t:'Late June',f:80000,b:'WF/ND',st:'',aml:''},
   {s:'Advanced',a:'Woolston Club',t:'22 June',f:150000,b:'CD',st:'',aml:''},
   {s:'Advanced',a:'Athol St',t:'',f:90000,b:'HD',st:'',aml:''},
   {s:'Conditional',a:'99 Packe St',t:'Late June',f:157500,b:'CD/WF',st:'',aml:''},
   {s:'Conditional',a:'10 Show Place',t:'July',f:500000,b:'MM',st:'',aml:''},
   {s:'Conditional',a:'14 Kirkwood Ave',t:'17 Jul',f:250000,b:'WF/CD',st:'',aml:''},
   {s:'Conditional',a:'25 Link Drive',t:'This week',f:190000,b:'WF/SS',st:'',aml:''},
   {s:'Unconditional',a:'85 D\u2019Archiac',t:'Late June',f:90000,b:'MO/ML/MM',st:'',aml:''},
   {s:'Unconditional',a:'98-100 Leinster',t:'May',f:80000,b:'CD/LW',st:'',aml:''},
   {s:'Unconditional',a:'177 Cashel St',t:'Mid June',f:60000,b:'MO/MM',st:'',aml:''},
   {s:'Tracking / WIP',a:'Hanmer Springs Motel',t:'Paused',f:140000,b:'MM/WF',st:'',aml:''},
   {s:'Tracking / WIP',a:'Temuka Pub',t:'',f:30000,b:'ML',st:'',aml:''}],
  fines:[['MM',0],['HD',10],['NG',10],['LW',20],['CD',25],['WF',100],['ML',45],['MO',35],['BC',35]],
  register:[
   {n:'James Murdoch',r:'Buyer — $3.5m on an investment before year end',ag:'CK',h:'Motivated'},
   {n:'Geoff Hay',r:'Buyer — investment with a national tenant',ag:'CK',h:'Luke warm'},
   {n:'Irene Hayward',r:'Buyer — $500-700k investment',ag:'OS',h:'Luke warm'}]}
};
const HEAT=['Motivated','Luke warm','Slow'], KEY='dealboard:v3';
let mem=null,state=null,which='industrial',tab='board',collapsed={},current=null,proj=false;

const $=s=>document.querySelector(s);
const money=n=>n?'$'+Math.round(n).toLocaleString():'—';
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const M=()=>MEETINGS[which], S=()=>state[which];
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('on');setTimeout(()=>e.classList.remove('on'),1900)}

/* --- save indicator: a failure must be loud, never a silent revert --- */
function setSaver(s,msg){const e=$('#saver');e.className='saver '+s;e.textContent=msg}
async function save(){
  setSaver('','Saving…');
  try{ await window.storage.set(KEY,JSON.stringify(state)); setSaver('ok','Saved'); }
  catch(err){
    mem=JSON.stringify(state);
    setSaver('err','NOT SAVED — copy your changes');
    console.error(err);
  }
}
async function load(){
  try{const r=await window.storage.get(KEY); if(r&&r.value)return JSON.parse(r.value);}
  catch(e){ if(mem)return JSON.parse(mem); }
  return null;
}
function fresh(){const o={};for(const k in MEETINGS){const m=MEETINGS[k];
  o[k]={date:new Date().toISOString().slice(0,10),apologies:'',notes:'',
    deals:m.deals.map((d,i)=>({id:k+i,...d})),
    fines:m.fines.map(f=>({b:f[0],amt:f[1]})),
    register:m.register.map((r,i)=>({id:'r'+k+i,...r}))};}
  return o;}
const stageTotal=st=>S().deals.filter(d=>d.s===st).reduce((a,d)=>a+(+d.f||0),0);
const tagClass=v=>{v=(v||'').toLowerCase();return v.includes('live')?'live':(v.includes('pend')||v.includes('upcom'))?'pending':''};

function renderTally(){
  const st=M().stages,s=S();
  const banked=stageTotal(st.find(x=>/uncondition/i.test(x))||st[st.length-1]);
  const pipe=s.deals.reduce((a,d)=>a+(+d.f||0),0);
  const fines=s.fines.reduce((a,f)=>a+(+f.amt||0),0);
  $('#tally').innerHTML=`
   <div><div class="k">Deals</div><div class="v">${s.deals.length}</div></div>
   <div><div class="k">Unconditional</div><div class="v">${money(banked)}</div></div>
   <div><div class="k">Pipeline</div><div class="v">${money(pipe)}</div></div>
   <div><div class="k">Fines pot</div><div class="v">$${fines}</div></div>
   <div><div class="k">Buyers &amp; tenants</div><div class="v">${s.register.length}</div></div>`;
}

/* ---- pipeline: same board whether on the desk or the projector ---- */
function renderBoard(){
  const wrap=$('#stages');wrap.innerHTML='';
  M().stages.forEach(st=>{
    const rows=S().deals.filter(d=>d.s===st);
    const sec=document.createElement('section');
    sec.className='stage'+(current===st?' current':'');
    sec.innerHTML=`<header>
        <button class="caret x">${collapsed[st]?'▸':'▾'}</button>
        <h2>${esc(st)}</h2><span class="pill">${rows.length}</span>
        <span class="tot">${money(stageTotal(st))}</span></header>
      ${collapsed[st]?'':`<table><thead><tr>
        <th style="width:16px"></th><th>Address</th><th style="width:15%">Timing</th>
        <th style="width:12%" class="num">Fee</th><th style="width:11%">Status</th>
        <th style="width:12%">Broker</th><th style="width:6%">AML</th><th style="width:26px"></th>
      </tr></thead><tbody></tbody></table>
      <button class="addrow">+ Add to ${esc(st.toLowerCase())}</button>`}`;
    /* clicking a stage header marks where the meeting is up to */
    sec.querySelector('header').onclick=e=>{
      if(e.target.closest('.caret')){collapsed[st]=!collapsed[st];renderBoard();return}
      current=current===st?null:st;renderBoard();
    };
    if(!collapsed[st]){
      const tb=sec.querySelector('tbody');
      rows.forEach(d=>tb.appendChild(dealRow(d)));
      sec.querySelector('.addrow').onclick=()=>{
        const d={id:'d'+Date.now(),s:st,a:'',t:'',f:0,b:'',st:'',aml:''};
        S().deals.push(d);save();renderBoard();renderTally();
        const c=wrap.querySelector(`[data-id="${d.id}"] [contenteditable]`);if(c)c.focus();
      };
    }
    sec.addEventListener('dragover',e=>{e.preventDefault();sec.classList.add('drop-target')});
    sec.addEventListener('dragleave',()=>sec.classList.remove('drop-target'));
    sec.addEventListener('drop',()=>{
      sec.classList.remove('drop-target');
      const d=S().deals.find(x=>x.id===dragId);if(!d)return;
      if(d.s!==st){d.s=st;toast(`${d.a||'Deal'} → ${st}`)}
      save();renderBoard();renderTally();
    });
    wrap.appendChild(sec);
  });
}
let dragId=null;
function dealRow(d){
  const tr=document.createElement('tr');
  tr.className='row';tr.dataset.id=d.id;tr.draggable=true;
  tr.innerHTML=`<td class="grip">⠿</td>
    <td class="addr"><div contenteditable data-k="a" data-ph="Address">${esc(d.a)}</div></td>
    <td><div contenteditable data-k="t" data-ph="—">${esc(d.t)}</div></td>
    <td class="num"><div contenteditable data-k="f" data-ph="0">${d.f?(+d.f).toLocaleString():''}</div></td>
    <td><div contenteditable data-k="st" data-ph="—" class="stt">${esc(d.st)}</div></td>
    <td class="brk"><div contenteditable data-k="b" data-ph="—">${esc(d.b)}</div></td>
    <td><div contenteditable data-k="aml" data-ph="—">${esc(d.aml)}</div></td>
    <td><button class="x">×</button></td>`;
  const stt=tr.querySelector('.stt');if(d.st)stt.classList.add('tag',tagClass(d.st));
  tr.querySelectorAll('[contenteditable]').forEach(el=>{
    /* highlight while editing so the room can see what's being changed */
    el.addEventListener('focus',()=>tr.classList.add('editing'));
    el.addEventListener('blur',()=>{
      tr.classList.remove('editing');
      const k=el.dataset.k,v=el.textContent.trim();
      const was=d[k];
      d[k]= k==='f' ? (parseFloat(v.replace(/[^0-9.]/g,''))||0) : v;
      if(String(was)!==String(d[k])){
        save();
        tr.classList.add('saved');setTimeout(()=>tr.classList.remove('saved'),1500);
        if(k==='f'||k==='st'){renderBoard();renderTally()}
      }
    });
    el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el.blur()}});
  });
  tr.querySelector('.x').onclick=()=>{
    if(!confirm(`Remove ${d.a||'this deal'}?`))return;
    state[which].deals=S().deals.filter(x=>x.id!==d.id);
    save();renderBoard();renderTally();
  };
  tr.addEventListener('dragstart',()=>{dragId=d.id;tr.classList.add('dragging')});
  tr.addEventListener('dragend',()=>tr.classList.remove('dragging'));
  tr.addEventListener('dragover',e=>{e.preventDefault();tr.classList.add('over')});
  tr.addEventListener('dragleave',()=>tr.classList.remove('over'));
  tr.addEventListener('drop',e=>{
    e.preventDefault();e.stopPropagation();tr.classList.remove('over');
    const arr=S().deals,from=arr.findIndex(x=>x.id===dragId);
    if(from<0||dragId===d.id)return;
    const moved=arr.splice(from,1)[0];moved.s=d.s;
    arr.splice(arr.findIndex(x=>x.id===d.id),0,moved);
    save();renderBoard();renderTally();
  });
  return tr;
}

function renderFines(){
  const box=$('#fines');box.innerHTML='';
  S().fines.forEach((f,i)=>{
    const el=document.createElement('span');
    el.className='fine'+(f.amt>0?' hot':'');
    el.innerHTML=`<b>${esc(f.b)}</b> $<span contenteditable>${f.amt}</span><button>×</button>`;
    el.querySelector('span[contenteditable]').addEventListener('blur',e=>{
      f.amt=parseInt(e.target.textContent.replace(/\D/g,''))||0;save();renderFines();renderTally();
    });
    el.querySelector('button').onclick=()=>{S().fines.splice(i,1);save();renderFines();renderTally()};
    box.appendChild(el);
  });
  $('#fineTot').textContent='$'+S().fines.reduce((a,f)=>a+(+f.amt||0),0);
}
$('#addFine').onclick=()=>{const b=prompt('Broker initials');if(!b)return;
  S().fines.push({b:b.toUpperCase(),amt:10});save();renderFines();renderTally()};

let regQ='',regAgent='';
function renderRegister(){
  const agents=[...new Set(S().register.map(r=>r.ag))].filter(Boolean).sort();
  $('#agentChips').innerHTML=agents.map(a=>`<button class="chip${regAgent===a?' on':''}" data-a="${a}">${a}</button>`).join(' ');
  $('#agentChips').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    regAgent=regAgent===b.dataset.a?'':b.dataset.a;renderRegister()});
  const tb=$('#regBody');tb.innerHTML='';
  S().register.filter(r=>(!regAgent||r.ag===regAgent)&&(r.n+' '+r.r).toLowerCase().includes(regQ.toLowerCase()))
   .forEach(r=>{
    const tr=document.createElement('tr');tr.className='row';
    tr.innerHTML=`<td class="addr"><div contenteditable data-k="n">${esc(r.n)}</div></td>
      <td><div contenteditable data-k="r">${esc(r.r)}</div></td>
      <td class="brk"><div contenteditable data-k="ag">${esc(r.ag)}</div></td>
      <td><select class="mini">${HEAT.map(h=>`<option${h===r.h?' selected':''}>${h}</option>`).join('')}</select></td>
      <td><button class="x">×</button></td>`;
    tr.querySelectorAll('[contenteditable]').forEach(el=>el.addEventListener('blur',()=>{
      if(r[el.dataset.k]!==el.textContent.trim()){r[el.dataset.k]=el.textContent.trim();save()}}));
    tr.querySelector('select').onchange=e=>{r.h=e.target.value;save()};
    tr.querySelector('.x').onclick=()=>{state[which].register=S().register.filter(x=>x.id!==r.id);
      save();renderRegister();renderTally()};
    tb.appendChild(tr);
  });
}
$('#regSearch').oninput=e=>{regQ=e.target.value;renderRegister()};
$('#addReg').onclick=()=>{S().register.unshift({id:'r'+Date.now(),n:'',r:'',ag:'',h:'Motivated'});
  save();renderRegister();renderTally();
  const f=$('#regBody').querySelector('[contenteditable]');if(f)f.focus()};

$('#rollBtn').onclick=()=>{
  const last=M().stages.find(s=>/uncondition/i.test(s))||M().stages[M().stages.length-1];
  const n=S().deals.filter(d=>d.s===last).length;
  if(!confirm(`Start next week's agenda?\n\n• ${n} unconditional deal(s) archive out\n• everything else carries over in place\n• fines reset, minutes clear`))return;
  const s=S();
  s.deals=s.deals.filter(d=>d.s!==last);
  s.fines.forEach(f=>f.amt=0);s.notes='';s.apologies='';
  s.date=new Date().toISOString().slice(0,10);
  current=null;save();renderAll();toast(`Rolled forward — ${n} archived`);
};

$('#projBtn').onclick=()=>{
  proj=!proj;document.body.classList.toggle('proj',proj);
  $('#projBtn').classList.toggle('on',proj);
  $('#projBtn').textContent=proj?'Exit projector':'Projector';
  if(proj&&document.documentElement.requestFullscreen)
    document.documentElement.requestFullscreen().catch(()=>{});
  else if(!proj&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});
};
$('#swapMeeting').onclick=()=>{
  which=which==='industrial'?'investment':'industrial';
  $('#swapMeeting').textContent=which==='industrial'?'Switch to Investment':'Switch to Industrial';
  collapsed={};current=null;renderAll();
};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');tab=b.dataset.tab;
  ['board','register'].forEach(t=>$('#tab-'+t).hidden=t!==tab);
  if(tab==='register')renderRegister();
});
$('#apologies').addEventListener('blur',e=>{S().apologies=e.target.textContent.trim();save()});
$('#notes').addEventListener('blur',e=>{S().notes=e.target.value;save()});

function renderAll(){
  $('#mtgTitle').textContent=M().title;
  $('#mtgDate').textContent=new Date(S().date+'T00:00:00')
    .toLocaleDateString('en-NZ',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase();
  $('#apologies').textContent=S().apologies;
  $('#notes').value=S().notes;
  renderTally();renderBoard();renderFines();
  if(tab==='register')renderRegister();
}
(async()=>{state=await load()||fresh();renderAll();})();
