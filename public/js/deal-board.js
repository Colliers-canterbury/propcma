/* =====================================================================
   Deal board — render + interaction.

   Persistence goes through window.DealBoardApi (js/deal-board-api.js),
   which calls /api/deal-board/*. Every edit writes through immediately
   on blur; the indicator top-right shows Saved / NOT SAVED.

   State is kept in the shape the render code uses (short keys: a, t, f,
   b, st, aml) and mapped to and from API field names in fromApi() /
   toApi() below. Only those two functions know both shapes.
   ===================================================================== */
const HEAT=['Motivated','Luke warm','Slow'], KEY='dealboard:v3';
let mem=null,state=null,which='industrial',tab='board',collapsed={},current=null,proj=false;

const $=s=>document.querySelector(s);
const money=n=>n?'$'+Math.round(n).toLocaleString():'—';
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TITLES={industrial:'Industrial Meeting',investment:'Investment Sales Meeting'};
const S=()=>state[which];
const M=()=>({title:TITLES[which], stages:(S().stages||[]).map(x=>x.name)});
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('on');setTimeout(()=>e.classList.remove('on'),1900)}

/* --- save indicator: a failure must be loud, never a silent revert --- */
function setSaver(st,msg){const e=$('#saver');e.className='saver '+st;e.textContent=msg}

/* Every write goes through here. On 401 the token is refreshed once and
   the call retried — a token expiring mid-meeting is the likeliest real
   failure, and it should be invisible rather than red. */
async function persist(fn, what){
  setSaver('','Saving…');
  try{
    const r = await fn();
    setSaver('ok','Saved');
    return r;
  }catch(err){
    if(err.status===401){
      try{
        const r = await fn();
        setSaver('ok','Saved');
        return r;
      }catch(e2){ err.status = e2.status; }
    }
    console.error(what, err);
    setSaver('err','NOT SAVED — '+(err.message||'check your connection'));
    toast('Not saved: '+what);
    throw err;
  }
}

/* --- shape mapping: API field names <-> the short keys render uses --- */
function fromApi(dept, payload){
  const stageName = {};
  payload.stages.forEach(st=>{ stageName[st.id]=st.name; });
  return {
    stages: payload.stages,
    stageIdByName: Object.fromEntries(payload.stages.map(st=>[st.name, st.id])),
    date: payload.meeting?.meeting_date || new Date().toISOString().slice(0,10),
    apologies: payload.meeting?.apologies || '',
    notes: payload.meeting?.minutes || '',
    deals: payload.deals.map(d=>({
      id:d.id, s:stageName[d.stage_id]||'', a:d.address||'', t:d.timing||'',
      f:Number(d.fee_nzd)||0, b:d.brokers||'', st:d.status_note||'',
      aml:AML_OUT[d.aml]||''
    })),
    fines: (payload.fines||[]).map(f=>({b:f.broker_code, amt:Number(f.amount_nzd)||0})),
    register: payload.requirements.map(r=>({
      id:r.id, n:r.party_name, r:r.requirement, ag:r.broker_code||'',
      h:HEAT_OUT[r.temperature]||'Motivated'
    }))
  };
}
const AML_IN  = {'Y':'complete','WIP':'wip','N':'not_required','':'not_started'};
const AML_OUT = {complete:'Y', wip:'WIP', not_required:'N', not_started:''};
const HEAT_IN = {'Motivated':'motivated','Luke warm':'luke_warm','Slow':'slow'};
const HEAT_OUT= {motivated:'Motivated', luke_warm:'Luke warm', slow:'Slow'};

/* Field-level write for one deal. k is the short key that changed. */
function saveDealField(d, k){
  const map = {
    a:  () => ({address: d.a}),
    t:  () => ({timing: d.t}),
    f:  () => ({fee_nzd: d.f}),
    st: () => ({status_note: d.st}),
    aml:() => ({aml: AML_IN[(d.aml||'').toUpperCase()] || 'not_started'}),
    b:  () => ({brokers: d.b.split('/').map(x=>x.trim()).filter(Boolean)}),
  };
  if(!map[k]) return Promise.resolve();
  return persist(()=>DealBoardApi.editDeal(d.id, map[k]()), d.a||'deal');
}

function saveMeetingField(patch){
  return persist(()=>DealBoardApi.saveMeeting(which, S().date, patch), 'meeting notes');
}
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
      rows.forEach(d=>{
        try{ tb.appendChild(dealRow(d)); }
        catch(err){ console.error('row failed:', d, err); }
      });
      sec.querySelector('.addrow').onclick=()=>{
        const d={id:'tmp'+Date.now(),s:st,a:'',t:'',f:0,b:'',st:'',aml:'',isNew:true};
        S().deals.push(d);renderBoard();renderTally();
        const c=wrap.querySelector(`[data-id="${d.id}"] [contenteditable]`);if(c)c.focus();
      };
    }
    sec.addEventListener('dragover',e=>{e.preventDefault();sec.classList.add('drop-target')});
    sec.addEventListener('dragleave',()=>sec.classList.remove('drop-target'));
    sec.addEventListener('drop',()=>{
      sec.classList.remove('drop-target');
      const d=S().deals.find(x=>x.id===dragId);if(!d||d.isNew)return;
      if(d.s===st)return;
      const from=d.s; d.s=st; renderBoard(); renderTally();
      persist(()=>DealBoardApi.moveDeal(d.id, S().stageIdByName[st], null),
              d.a||'deal')
        .then(()=>toast(`${d.a||'Deal'} → ${st}`))
        .catch(()=>{ d.s=from; renderBoard(); renderTally(); });
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
  // classList.add('') throws — only add the colour class when there is one.
  const stt=tr.querySelector('.stt');
  if(d.st){
    stt.classList.add('tag');
    const tc=tagClass(d.st); if(tc) stt.classList.add(tc);
  }
  tr.querySelectorAll('[contenteditable]').forEach(el=>{
    /* highlight while editing so the room can see what's being changed */
    el.addEventListener('focus',()=>tr.classList.add('editing'));
    el.addEventListener('blur',()=>{
      tr.classList.remove('editing');
      const k=el.dataset.k,v=el.textContent.trim();
      const was=d[k];
      d[k]= k==='f' ? (parseFloat(v.replace(/[^0-9.]/g,''))||0) : v;
      if(String(was)!==String(d[k])){
        const done=()=>{
          tr.classList.add('saved');setTimeout(()=>tr.classList.remove('saved'),1500);
          if(k==='f'||k==='st'){renderBoard();renderTally()}
        };
        if(d.isNew){
          // A new row is only created server-side once it has an address.
          if(!d.a) return;
          persist(()=>DealBoardApi.addDeal(which, S().stageIdByName[d.s], {
            address:d.a, timing:d.t, fee_nzd:d.f, status_note:d.st,
            brokers:d.b.split('/').map(x=>x.trim()).filter(Boolean)
          }), d.a).then(row=>{ d.id=row.id; delete d.isNew; done(); }).catch(()=>{});
        }else{
          saveDealField(d,k).then(done).catch(()=>{});
        }
      }
    });
    el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el.blur()}});
  });
  tr.querySelector('.x').onclick=()=>{
    if(!confirm(`Remove ${d.a||'this deal'}?`))return;
    const go=()=>{state[which].deals=S().deals.filter(x=>x.id!==d.id);renderBoard();renderTally()};
    if(d.isNew){go();return}
    persist(()=>DealBoardApi.removeDeal(d.id), d.a||'deal').then(go).catch(()=>{});
  };
  tr.addEventListener('dragstart',()=>{dragId=d.id;tr.classList.add('dragging')});
  tr.addEventListener('dragend',()=>tr.classList.remove('dragging'));
  tr.addEventListener('dragover',e=>{e.preventDefault();tr.classList.add('over')});
  tr.addEventListener('dragleave',()=>tr.classList.remove('over'));
  tr.addEventListener('drop',e=>{
    e.preventDefault();e.stopPropagation();tr.classList.remove('over');
    const arr=S().deals,from=arr.findIndex(x=>x.id===dragId);
    if(from<0||dragId===d.id)return;
    const moved=arr[from]; if(moved.isNew)return;
    const prevStage=moved.s;
    arr.splice(from,1);moved.s=d.s;
    const at=arr.findIndex(x=>x.id===d.id);
    arr.splice(at,0,moved);
    renderBoard();renderTally();
    // afterId = the row it now sits below, or null for top of the stage
    const above=arr.slice(0,at).reverse().find(x=>x.s===moved.s);
    persist(()=>DealBoardApi.moveDeal(moved.id, S().stageIdByName[moved.s],
                                      above?above.id:null), moved.a||'deal')
      .catch(()=>{ moved.s=prevStage; renderBoard(); renderTally(); });
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
      f.amt=parseInt(e.target.textContent.replace(/\D/g,''))||0;
      renderFines();renderTally();
      persist(()=>DealBoardApi.setFine(which,S().date,f.b,f.amt),'fine for '+f.b).catch(()=>{});
    });
    el.querySelector('button').onclick=()=>{
      S().fines.splice(i,1);renderFines();renderTally();
      persist(()=>DealBoardApi.setFine(which,S().date,f.b,0),'fine for '+f.b).catch(()=>{});
    };
    box.appendChild(el);
  });
  $('#fineTot').textContent='$'+S().fines.reduce((a,f)=>a+(+f.amt||0),0);
}
$('#addFine').onclick=()=>{const b=prompt('Broker initials');if(!b)return;
  const code=b.toUpperCase();
  S().fines.push({b:code,amt:10});renderFines();renderTally();
  persist(()=>DealBoardApi.setFine(which,S().date,code,10),'fine for '+code).catch(()=>{});
};

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
      const k=el.dataset.k, v=el.textContent.trim();
      if(r[k]===v) return;
      r[k]=v;
      const field={n:'party_name',r:'requirement',ag:'broker_code'}[k];
      if(r.isNew){
        if(!r.n) return;
        persist(()=>DealBoardApi.addRequirement(which,{
          party_name:r.n, requirement:r.r, broker_code:r.ag||null,
          temperature:HEAT_IN[r.h]||'motivated'
        }), r.n).then(row=>{r.id=row.id;delete r.isNew}).catch(()=>{});
      }else{
        persist(()=>DealBoardApi.editRequirement(r.id,{[field]:v}), r.n||'requirement').catch(()=>{});
      }
    }));
    tr.querySelector('select').onchange=e=>{
      r.h=e.target.value;
      if(r.isNew)return;
      persist(()=>DealBoardApi.editRequirement(r.id,{temperature:HEAT_IN[r.h]}), r.n||'requirement').catch(()=>{});
    };
    tr.querySelector('.x').onclick=()=>{
      const go=()=>{state[which].register=S().register.filter(x=>x.id!==r.id);renderRegister();renderTally()};
      if(r.isNew){go();return}
      persist(()=>DealBoardApi.removeRequirement(r.id), r.n||'requirement').then(go).catch(()=>{});
    };
    tb.appendChild(tr);
  });
}
$('#regSearch').oninput=e=>{regQ=e.target.value;renderRegister()};
$('#addReg').onclick=()=>{
  S().register.unshift({id:'tmp'+Date.now(),n:'',r:'',ag:'',h:'Motivated',isNew:true});
  renderRegister();renderTally();
  const f=$('#regBody').querySelector('[contenteditable]');if(f)f.focus()};

$('#rollBtn').onclick=()=>{
  const last=M().stages.find(s=>/uncondition/i.test(s))||M().stages[M().stages.length-1];
  const n=S().deals.filter(d=>d.s===last).length;
  if(!confirm(`Start next week's agenda?\n\n• ${n} unconditional deal(s) archive out\n• everything else carries over in place\n• fines reset, minutes clear`))return;
  const next=new Date();next.setDate(next.getDate()+7);
  const nextDate=next.toISOString().slice(0,10);
  persist(()=>DealBoardApi.rollForward(which,nextDate),'roll forward')
    .then(async r=>{
      current=null;
      await loadBoard();
      toast(`Rolled forward — ${r?.archived_count ?? n} archived`);
    }).catch(()=>{});
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
  collapsed={};current=null;
  loadBoard().catch(()=>{});
};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');tab=b.dataset.tab;
  ['board','register'].forEach(t=>$('#tab-'+t).hidden=t!==tab);
  if(tab==='register')renderRegister();
});
$('#apologies').addEventListener('blur',e=>{
  const v=e.target.textContent.trim();
  if(v===S().apologies)return;
  S().apologies=v; saveMeetingField({apologies:v}).catch(()=>{});
});
$('#notes').addEventListener('blur',e=>{
  const v=e.target.value;
  if(v===S().notes)return;
  S().notes=v; saveMeetingField({minutes:v}).catch(()=>{});
});

function renderAll(){
  $('#mtgTitle').textContent=M().title;
  $('#mtgDate').textContent=new Date(S().date+'T00:00:00')
    .toLocaleDateString('en-NZ',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase();
  $('#apologies').textContent=S().apologies;
  $('#notes').value=S().notes;
  renderTally();renderBoard();renderFines();
  if(tab==='register')renderRegister();
}
async function loadBoard(){
  setSaver('','Loading…');
  const payload=await DealBoardApi.getBoard(which);
  state[which]=fromApi(which,payload);
  setSaver('ok','Ready');
  renderAll();
}

(async()=>{
  try{
    const account=await window.DealSheetAuth.init();
    if(!account) return;               // redirecting to sign in
    document.getElementById('gate').style.display='none';
    state={};
    await loadBoard();
  }catch(err){
    console.error(err);
    document.getElementById('gate').innerHTML=
      '<div class="inner">Could not sign in — '+(err.message||'try reloading')+'</div>';
  }
})();
