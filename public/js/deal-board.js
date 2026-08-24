/* =====================================================================
   Deal board — render + interaction.

   Persistence goes through window.DealBoardApi (js/deal-board-api.js),
   which calls /api/deal-board/*. Every edit writes through immediately
   on blur; the indicator top-right shows Saved / NOT SAVED.

   State is kept in the shape the render code uses (short keys: a, t, f,
   b, st, aml) and mapped to and from API field names in fromApi() /
   toApi() below. Only those two functions know both shapes.
   ===================================================================== */
/* Which stages offer an outcome instead of a plain remove, what the
   options are, and where each one sends the deal. */
const OUTCOMES={
  'Submissions':             [['won','Win','Campaigns / sole agency'],
                              ['lost','Lost','Lost']],
  'Campaigns / sole agency': [['withdrawn','Withdrawn','Withdrawn']],
  'Unconditional':           [['sold','Sold','Sold'],
                              ['leased','Leased','Leased']]
};
const TODAY=()=>new Date().toISOString().slice(0,10);
/* Form controls do not print their values — a date input shows 'dd.'
   and a select prints blank. Each control therefore carries a hidden
   text twin that only appears on paper. */
const printDate=v=>v
  ? new Date(v+'T00:00:00').toLocaleDateString('en-NZ',
      {day:'2-digit',month:'short',year:'numeric'})
  : '';
const pt=txt=>`<span class="printonly">${esc(txt||'')}</span>`;

const STATUSES=['Pending','Submitted','Committed','Deadline','Auction','Priced','Off-Market'];
const HEAT=['Motivated','Luke warm','Slow'], KEY='dealboard:v3';
let mem=null,state=null,which='',tab='board',collapsed={},current=null,proj=false;

const $=s=>document.querySelector(s);
/* Bind only if the element is present. A page/script version mismatch
   should degrade to a missing button, not a blank screen. */
function on(sel, ev, fn){
  const el=$(sel);
  if(!el){ console.warn('deal-board: missing element', sel); return; }
  el.addEventListener(ev, fn);
}
function click(sel, fn){ on(sel,'click',fn); }
const money=n=>n?'$'+Math.round(n).toLocaleString():'—';
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let UNITS=[];   // [{slug, name, is_rollup}] from the API
const isRollup=slug=>{
  const u=UNITS.find(x=>x.slug===slug);
  return !!(u && u.is_rollup);
};
const titleFor=slug=>{
  const u=UNITS.find(x=>x.slug===slug);
  if(!u) return 'Meeting';
  return u.is_rollup ? u.name+' Dashboard' : u.name+' Meeting';
};
const S=()=>state[which];
const M=()=>({title:titleFor(which), stages:(S().stages||[]).map(x=>x.name)});
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
    // Minutes and fines are written against today. The most recent
    // meeting's text is still shown so nothing appears to vanish.
    date: new Date().toISOString().slice(0,10),
    apologies: payload.meeting?.apologies || '',
    minutes: payload.meeting?.minutes || '',
    deals: payload.deals.map(d=>({
      id:d.id, s:stageName[d.stage_id]||'', a:d.address||'', t:d.timing||'',
      f:Number(d.fee_nzd)||0, b:d.brokers||'', st:d.status_note||'', out:d.outcome||'',
      td:d.timing_date||'', tn:d.tenant||'',
      pr:(d.probability===null||d.probability===undefined)?'':Number(d.probability),
      aml:AML_OUT[d.aml]||''
    })),
    fines: (payload.fines||[]).map(f=>({b:f.broker_code, amt:Number(f.amount_nzd)||0})),
    options: payload.options||{},
    weights: Object.fromEntries((payload.weights||[]).map(w=>[w.stage_name, Number(w.pct)||0])),
    outcomes: Object.assign({}, payload.outcomes||{}),
    noteSections: payload.noteSections||[],
    notes: (payload.notes||[]).map(n=>({
      id:n.id, section:n.section, body:n.body||'', sort_order:n.sort_order,
      t:n.timing||'', td:n.timing_date||'', f:Number(n.fee_nzd)||0,
      st:n.status_note||'', b:n.broker_codes||'', aml:n.aml||'',
      ll:n.landlord||'', at:n.agency_type||''
    })),
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
    td: () => ({timing_date: d.td || null}),
    tn: () => ({tenant: d.tn}),
    pr: () => ({probability: d.pr===''?null:Number(d.pr)}),
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
const stageTotal=st=>visibleDeals().filter(d=>d.s===st)
  .reduce((a,d)=>a+(brokerFilter?shareOf(d):(+d.f||0)),0);

/* Weighted pipeline: Unconditional counts in full, other stages at the
   percentage set under Pipeline Settings. A stage with no weighting
   contributes nothing — Sold, Withdrawn and Lost must not inflate a
   forward-looking figure. */
function weightFor(stage){
  if(/^uncondition/i.test(stage)) return 1;
  const w=(S().weights||{})[stage];
  return w===undefined ? 0 : w/100;
}
/* A deal's own probability wins where it has one — leasing records it
   per deal rather than inheriting a stage-wide figure. */
function dealWeight(d){
  return (d.pr==='' || d.pr===null || d.pr===undefined)
    ? weightFor(d.s) : Number(d.pr)/100;
}
function weightedPipeline(){
  return visibleDeals().reduce((a,d)=>a+(+d.f||0)*dealWeight(d),0);
}
/* Colour by what the status means for the deal, not by exact spelling —
   legacy values from the sheets ('Live', 'PBN') still land sensibly. */
const tagClass=v=>{
  v=(v||'').toLowerCase();
  if(!v) return '';
  if(/committ|priced|live|uncondition/.test(v)) return 'live';
  if(/pend|submit|upcom|deadline|auction/.test(v)) return 'pending';
  return '';
};

function renderTally(){
  // On the broker tab the headline strip belongs to that broker.
  if(brokerFilter){ renderBrokerTally(); return; }
  const st=M().stages,s=S(),vis=visibleDeals();
  const banked=stageTotal(st.find(x=>/uncondition/i.test(x))||st[st.length-1]);
  const pipe=vis.reduce((a,d)=>a+(+d.f||0),0);
  const fines=s.fines.reduce((a,f)=>a+(+f.amt||0),0);
  const out=S().outcomes||{};
  $('#tally').innerHTML=`
   <div><div class="k">Deals</div><div class="v">${vis.length}</div></div>
   <div><div class="k">Unconditional</div><div class="v">${money(banked)}</div></div>
   <div><div class="k">Pipeline (weighted)</div><div class="v">${money(weightedPipeline())}</div>
     <div class="sub">${money(pipe)} unweighted</div></div>
   <div><div class="k">Won</div><div class="v">${out.won||0}</div></div>
   <div><div class="k">Lost</div><div class="v">${out.lost||0}</div></div>
   <div><div class="k">Buyers &amp; tenants</div><div class="v">${S().register.length}</div></div>`;
}

/* ---- pipeline: same board whether on the desk or the projector ---- */
/* Row handlers call renderBoard() with no argument after an edit, so
   the target is remembered — otherwise an edit made on the Broker
   Pipeline tab would redraw the main board instead. */
let boardTarget='#stages';
function renderBoard(target){
  if(target) boardTarget=target;
  const wrap=$(boardTarget); if(!wrap) return;
  wrap.innerHTML='';
  M().stages.forEach(st=>{
    const rows=visibleDeals().filter(d=>d.s===st);
    const sec=document.createElement('section');
    sec.className='stage'+(current===st?' current':'');
    sec.innerHTML=`<header>
        <button class="caret x">${collapsed[st]?'▸':'▾'}</button>
        <h2>${esc(st)}</h2><span class="pill">${rows.length}</span>
        <span class="tot">${money(stageTotal(st))}</span></header>
      ${collapsed[st]?'':`<table><thead><tr>
        <th style="width:16px"></th><th style="width:172px">Stage</th>
        ${(S().options||{}).show_tenant?'<th style="width:22%">Tenant</th>':''}
        <th${(S().options||{}).show_tenant?' style="width:22%"':''}>Address</th>
        <th style="width:120px">Timing</th>
        <th style="width:92px" class="num">Fee</th>
        ${(S().options||{}).show_probability?'<th style="width:56px" class="num">Prob</th>':''}
        <th style="width:96px">Status</th>
        <th style="width:76px">Broker</th>
        <th style="width:40px" class="noprint">AML</th>
        <th style="width:92px" class="noprint"></th>
      </tr></thead><tbody></tbody></table>
      <button class="addrow">+ Add to ${esc(st.toLowerCase())}</button>`}`;
    /* clicking a stage header marks where the meeting is up to */
    sec.querySelector('header').onclick=e=>{
      if(e.target.closest('.caret')){collapsed[st]=!collapsed[st];renderBoard();return}
      current=current===st?null:st;renderBoard();
    };
    if(!collapsed[st]){
      const tb=sec.querySelector('tbody');
      if(!rows.length){
        tb.innerHTML='<tr><td colspan="9" class="empty">'+
          (fromDate||toDate ? 'Nothing in this date range.' : 'Nothing here yet.')+'</td></tr>';
      }
      rows.forEach(d=>{
        try{ tb.appendChild(dealRow(d)); }
        catch(err){ console.error('row failed:', d, err); }
      });
      sec.querySelector('.addrow').onclick=()=>{
        const d={id:'tmp'+Date.now(),s:st,a:'',tn:'',t:'',td:/^uncondition/i.test(st)?TODAY():'',f:0,pr:'',b:'',st:'',aml:'',isNew:true};
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
  // Note lists are department-wide, not per broker.
  if(!brokerFilter) renderNoteSections(wrap);
}

/* Free-text lists that sit between the stages. Each item is one line
   the EA types; the × ticks it off once actioned. */
let dragId=null;

/* Status picker. Any value already in the data that is not on the list
   is kept as an extra option — 'Live', 'PBN', 'DBL' and so on are still
   in the imported rows, and silently blanking them would lose meaning
   the room put there. */
function statusSelect(val){
  const opts=STATUSES.slice();
  if(val && !opts.some(o=>o.toLowerCase()===val.toLowerCase())) opts.unshift(val);
  return `<select class="statuspick"><option value="">—</option>`+
    opts.map(o=>`<option value="${esc(o)}"${
      o.toLowerCase()===(val||'').toLowerCase()?' selected':''}>${esc(o)}</option>`).join('')+
    `</select>`;
}

/* The action at the end of a row: an outcome picker on the stages that
   have one, a plain remove everywhere else. */
function outcomeControl(d){
  const opts=OUTCOMES[d.s];
  if(!opts) return '<button class="x" title="Remove">×</button>';
  return `<select class="outcome"><option value="">—</option>`+
    opts.map(o=>`<option value="${o[0]}">${o[1]}</option>`).join('')+
    `</select>`;
}

function dealRow(d){
  const tr=document.createElement('tr');
  tr.className='row'; tr.dataset.id=d.id; tr.draggable=true;
  const stageOpts=(S().stages||[]).slice().sort((a,b)=>a.position-b.position)
    .map(x=>`<option value="${esc(x.name)}"${x.name===d.s?' selected':''}>${esc(x.name)}</option>`).join('');
  tr.innerHTML=`<td class="grip">⠿</td>
    <td class="stagesel"><select class="stagepick">${stageOpts}</select>${pt(d.s)}</td>
    ${(S().options||{}).show_tenant
      ? `<td class="addr"><div contenteditable data-k="tn" data-ph="Tenant">${esc(d.tn)}</div></td>` : ''}
    <td class="${(S().options||{}).show_tenant?'':'addr'}"><div contenteditable data-k="a" data-ph="Address">${esc(d.a)}</div></td>
    <td class="timingcell"><input type="date" class="dateinput" value="${esc(d.td)}">${
      (!d.td && d.t) ? `<span class="legacy">${esc(d.t)}</span>` : ''}${
      pt(d.td?printDate(d.td):d.t)}</td>
    ${brokerFilter
      ? `<td class="num sharecell">${d.f?money(shareOf(d)):'—'}${
          brokersOf(d).length>1
            ? `<span class="fullfee">of ${money(d.f)}</span>` : ''}</td>`
      : `<td class="num"><div contenteditable data-k="f" data-ph="0">${
          d.f?(+d.f).toLocaleString():''}</div></td>`}
    ${(S().options||{}).show_probability
      ? `<td class="num prob"><div contenteditable data-k="pr" data-ph="—">${d.pr===''?'':d.pr}</div></td>` : ''}
    <td class="statuscell">${statusSelect(d.st)}${pt(d.st)}</td>
    <td class="brk"><div contenteditable data-k="b" data-ph="—">${esc(d.b)}</div></td>
    <td class="amlcell noprint"><input type="checkbox" class="amlbox"
      ${d.aml==='Y'?'checked':''} title="AML complete"></td>
    <td class="actcell noprint">${outcomeControl(d)}</td>`;

  const sel=tr.querySelector('.statuspick');
  if(sel){
    sel.className='statuspick '+(tagClass(d.st)||'');
    sel.onchange=()=>{
      const was=d.st; d.st=sel.value;
      persist(()=>DealBoardApi.editDeal(d.id,{status_note:d.st}), d.a||'deal')
        .then(()=>{renderBoard();renderTally()})
        .catch(()=>{ d.st=was; renderBoard(); });
    };
  }

  tr.querySelectorAll('[contenteditable]').forEach(el=>{
    el.addEventListener('focus',()=>tr.classList.add('editing'));
    el.addEventListener('blur',()=>{
      tr.classList.remove('editing');
      const k=el.dataset.k, v=el.textContent.trim();
      const was=d[k];
      d[k]= k==='f' ? (parseFloat(v.replace(/[^0-9.]/g,''))||0)
          : k==='pr' ? (v===''?'':Math.max(0,Math.min(100,parseFloat(v.replace(/[^0-9.]/g,''))||0)))
          : v;
      if(String(was)!==String(d[k])){
        const done=()=>{
          tr.classList.add('saved');setTimeout(()=>tr.classList.remove('saved'),1500);
          if(k==='f'||k==='pr'){renderBoard();renderTally()}
        };
        if(d.isNew){
          if(!d.a) return;
          persist(()=>DealBoardApi.addDeal(which, S().stageIdByName[d.s], {
            address:d.a, tenant:d.tn||null, timing:d.t, timing_date:d.td||null,
            fee_nzd:d.f, probability:d.pr===''?null:Number(d.pr), status_note:d.st,
            brokers:d.b.split('/').map(x=>x.trim()).filter(Boolean)
          }), d.a).then(row=>{ d.id=row.id; delete d.isNew; done(); }).catch(()=>{});
        }else{
          saveDealField(d,k).then(done).catch(()=>{});
        }
      }
    });
    el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el.blur()}});
  });

  // stage picker — same effect as dragging, easier on a projector
  const sp=tr.querySelector('.stagepick');
  if(sp) sp.onchange=()=>{
    const to=sp.value, from=d.s;
    if(to===from) return;
    if(d.isNew){ d.s=to; renderBoard(); renderTally(); return; }
    d.s=to;
    // Landing in Unconditional dates the deal today unless it already
    // carries a date the room agreed on.
    if(/^uncondition/i.test(to) && !d.td){
      d.td=TODAY();
      DealBoardApi.editDeal(d.id,{timing_date:d.td}).catch(()=>{});
    }
    renderBoard(); renderTally();
    persist(()=>DealBoardApi.moveDeal(d.id, S().stageIdByName[to], null), d.a||'deal')
      .then(()=>toast(`${d.a||'Deal'} → ${to}`))
      .catch(()=>{ d.s=from; renderBoard(); renderTally(); });
  };

  // AML — a tick means complete. Rows imported as WIP show a dash until
  // someone decides; ticking or unticking resolves it.
  const ab=tr.querySelector('.amlbox');
  if(ab){
    if(d.aml==='WIP'){ ab.indeterminate=true; ab.title='AML in progress'; }
    ab.onchange=()=>{
      const was=d.aml;
      d.aml=ab.checked?'Y':'';
      ab.indeterminate=false;
      saveDealField(d,'aml')
        .then(()=>{tr.classList.add('saved');setTimeout(()=>tr.classList.remove('saved'),1500)})
        .catch(()=>{ d.aml=was; renderBoard(); });
    };
  }

  // timing date
  const di=tr.querySelector('.dateinput');
  if(di) di.onchange=()=>{
    const was=d.td;
    d.td=di.value||'';
    if(d.isNew) return;
    saveDealField(d,'td')
      .then(()=>{tr.classList.add('saved');setTimeout(()=>tr.classList.remove('saved'),1500);
                 renderBoard();renderTally()})
      .catch(()=>{ d.td=was; renderBoard(); });
  };

  const xb=tr.querySelector('.x');
  if(xb) xb.onclick=()=>{
    if(!confirm(`Remove ${d.a||'this deal'}?`))return;
    const go=()=>{state[which].deals=S().deals.filter(x=>x.id!==d.id);renderBoard();renderTally()};
    if(d.isNew){go();return}
    persist(()=>DealBoardApi.removeDeal(d.id), d.a||'deal').then(go).catch(()=>{});
  };

  const oc=tr.querySelector('.outcome');
  if(oc) oc.onchange=()=>{
    const val=oc.value; if(!val) return;
    const row=(OUTCOMES[d.s]||[]).find(o=>o[0]===val);
    if(!row){oc.value='';return}
    const label=row[1], dest=row[2];
    if(!confirm(`Mark ${d.a||'this deal'} as ${label}?\n\nIt moves to ${dest}.`)){
      oc.value=''; return;
    }
    if(d.isNew){ d.s=dest; d.out=val; renderBoard(); renderTally(); return; }
    const from=d.s, wasOut=d.out;
    const stamp=/^uncondition/i.test(dest) ? TODAY() : undefined;
    d.s=dest; d.out=val; if(stamp) d.td=stamp;
    S().outcomes[val]=(S().outcomes[val]||0)+1;
    renderBoard(); renderTally();
    persist(()=>DealBoardApi.setOutcome(d.id, val, S().stageIdByName[dest], stamp), d.a||'deal')
      .then(()=>toast(`${d.a||'Deal'} → ${dest}`))
      .catch(()=>{ d.s=from; d.out=wasOut;
        S().outcomes[val]=Math.max(0,(S().outcomes[val]||1)-1);
        renderBoard(); renderTally(); });
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
    const above=arr.slice(0,at).reverse().find(x=>x.s===moved.s);
    persist(()=>DealBoardApi.moveDeal(moved.id, S().stageIdByName[moved.s],
                                      above?above.id:null), moved.a||'deal')
      .catch(()=>{ moved.s=prevStage; renderBoard(); renderTally(); });
  });
  return tr;
}

/* Sole agency expiries lapse quietly. Classify each so the board can
   surface them: expired, expiring within 60 days, or fine. */
function expiryState(dateStr){
  if(!dateStr) return '';
  const d=new Date(dateStr+'T00:00:00');
  if(isNaN(d)) return '';
  const days=Math.floor((d - new Date(TODAY()+'T00:00:00'))/86400000);
  if(days<0) return 'expired';
  if(days<=60) return 'soon';
  return 'ok';
}
function expiryDays(dateStr){
  const d=new Date(dateStr+'T00:00:00');
  return Math.floor((d - new Date(TODAY()+'T00:00:00'))/86400000);
}
/* Only sections whose Timing column is genuinely an expiry date. */
const EXPIRY_SECTIONS=['Sole Agencies'];
/* Extra column per section: Sole Agencies tracks the landlord, the two
   agency-pipeline sections track the agency type. */
/* Extra columns per section. All three agency registers track the
   landlord; the two agency-pipeline sections also track the type. */
const LANDLORD_COL={key:'ll', label:'Landlord',    width:160};
const TYPE_COL    ={key:'at', label:'Agency type', width:110};
const NOTE_EXTRA={
  'Sole Agencies':    [LANDLORD_COL],
  'Pending Agencies': [TYPE_COL, LANDLORD_COL],
  'New Agencies':     [TYPE_COL, LANDLORD_COL]
};
let expiryFilter=false;

function renderNoteSections(wrap){
  const secs=S().noteSections||[];
  const stageCount=(S().stages||[]).length;
  secs.slice().sort((a,b)=>a.position-b.position).forEach(ns=>{
    const isExpirySec=EXPIRY_SECTIONS.indexOf(ns.name)>=0;
    const extras=NOTE_EXTRA[ns.name]||[];
    let items=(S().notes||[]).filter(n=>n.section===ns.name)
      .sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
    if(isExpirySec){
      // Soonest first — an expiry list is only useful in date order.
      items=items.slice().sort((a,b)=>{
        if(!a.td) return 1; if(!b.td) return -1;
        return a.td<b.td?-1:a.td>b.td?1:0;
      });
      if(expiryFilter){
        items=items.filter(n=>{
          const st=expiryState(n.td);
          return st==='expired'||st==='soon';
        });
      }
    }
    const flagged=isExpirySec
      ? (S().notes||[]).filter(n=>n.section===ns.name &&
          ['expired','soon'].indexOf(expiryState(n.td))>=0).length
      : 0;
    const sec=document.createElement('section');
    sec.className='notes';
    sec.innerHTML=`<header><h2>${esc(ns.name)}</h2>
        <span class="pill">${items.length}</span>
        ${flagged?`<button class="expbtn${expiryFilter?' on':''}">${
          expiryFilter?'Show all':`${flagged} expiring or expired`}</button>`:''}
        <span class="tot">${isExpirySec?'':money(items.reduce((a,n)=>a+(+n.f||0),0))}</span></header>
      <table><thead><tr>
        <th>Detail</th>
        ${extras.map(x=>`<th style="width:${x.width}px">${x.label}</th>`).join('')}
        <th style="width:${isExpirySec?150:120}px">${isExpirySec?'Expiry':'Timing'}</th>
        <th style="width:88px" class="num">Fee</th><th style="width:92px">Status</th>
        <th style="width:70px">Broker</th>
        <th style="width:38px" class="noprint">AML</th>
        <th style="width:26px" class="noprint"></th>
      </tr></thead><tbody></tbody></table>
      <button class="addrow">+ Add to ${esc(ns.name.toLowerCase())}</button>`;
    const tb=sec.querySelector('tbody');
    if(!items.length){
      tb.innerHTML='<tr><td colspan="'+(7+extras.length)+'" class="empty">'+
        (expiryFilter&&isExpirySec ? 'Nothing expiring in the next 60 days.'
                                   : 'Nothing this week.')+'</td></tr>';
    }
    items.forEach(n=>{
      try{ tb.appendChild(noteRow(n,ns.name,isExpirySec,extras)); }
      catch(err){ console.error('note row failed:', n, err); }
    });
    const eb=sec.querySelector('.expbtn');
    if(eb) eb.onclick=()=>{ expiryFilter=!expiryFilter; renderBoard(); };
    sec.querySelector('.addrow').onclick=()=>{
      const n={id:'tmp'+Date.now(),section:ns.name,body:'',t:'',td:'',f:0,st:'',b:'',aml:'',ll:'',at:'',isNew:true};
      S().notes.push(n);renderBoard();
      const el=wrap.querySelector(`[data-nid="${n.id}"] [contenteditable]`);if(el)el.focus();
    };
    const before=[...wrap.children].find((c,i)=>i<stageCount &&
      (S().stages[i]||{}).position>ns.position);
    wrap.insertBefore(sec, before||null);
  });
}

function expiryBadge(td){
  const st=expiryState(td); if(st==='ok'||!st) return '';
  const days=expiryDays(td);
  return st==='expired'
    ? `<span class="expbadge expired">expired ${Math.abs(days)}d ago</span>`
    : `<span class="expbadge soon">${days}d left</span>`;
}

function noteRow(n, section, isExpiry, extras){
  const tr=document.createElement('tr');
  tr.className='row'; tr.dataset.nid=n.id;
  tr.innerHTML=`
    <td class="addr"><div contenteditable data-k="body" data-ph="Type here…">${esc(n.body)}</div></td>
    ${(extras||[]).map(x=>
      `<td><div contenteditable data-k="${x.key}" data-ph="—">${esc(n[x.key]||'')}</div></td>`).join('')}
    <td class="timingcell"><input type="date" class="dateinput" value="${esc(n.td)}">${
      isExpiry && n.td ? expiryBadge(n.td)
        : (!n.td && n.t) ? `<span class="legacy">${esc(n.t)}</span>` : ''}${
      pt(n.td?printDate(n.td):n.t)}</td>
    <td class="num"><div contenteditable data-k="f" data-ph="0">${n.f?(+n.f).toLocaleString():''}</div></td>
    <td class="statuscell">${statusSelect(n.st)}${pt(n.st)}</td>
    <td class="brk"><div contenteditable data-k="b" data-ph="—">${esc(n.b)}</div></td>
    <td class="amlcell noprint"><input type="checkbox" class="amlbox" ${n.aml==='Y'?'checked':''}></td>
    <td class="noprint"><button class="x" title="Actioned — clear it">×</button></td>`;

  const flash=()=>{tr.classList.add('saved');setTimeout(()=>tr.classList.remove('saved'),1500)};
  const fieldMap={body:'body', f:'fee_nzd', b:'broker_codes',
                  ll:'landlord', at:'agency_type'};

  /* A new row is only created server-side once it has some text. */
  function saveNote(patch){
    if(n.isNew){
      if(!n.body) return Promise.resolve();
      return persist(()=>DealBoardApi.addNote(which,section,n.body),'note')
        .then(row=>{
          n.id=row.id; delete n.isNew;
          const rest={timing_date:n.td||null, fee_nzd:n.f,
                      status_note:n.st||null, broker_codes:n.b||null, aml:n.aml||null,
                      landlord:n.ll||null, agency_type:n.at||null};
          return DealBoardApi.editNote(n.id, rest).catch(()=>{});
        }).then(flash);
    }
    return persist(()=>DealBoardApi.editNote(n.id, patch),'note').then(flash);
  }

  tr.querySelectorAll('[contenteditable]').forEach(el=>{
    el.addEventListener('focus',()=>tr.classList.add('editing'));
    el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el.blur()}});
    el.addEventListener('blur',()=>{
      tr.classList.remove('editing');
      const k=el.dataset.k, v=el.textContent.trim();
      const was=n[k];
      n[k]= k==='f' ? (parseFloat(v.replace(/[^0-9.]/g,''))||0) : v;
      if(String(was)===String(n[k])) return;
      saveNote({[fieldMap[k]]: n[k]}).then(()=>{ if(k==='f') renderBoard(); }).catch(()=>{});
    });
  });

  const di=tr.querySelector('.dateinput');
  if(di) di.onchange=()=>{ n.td=di.value||''; saveNote({timing_date:n.td||null}).catch(()=>{}); };

  const sel=tr.querySelector('.statuspick');
  if(sel){
    sel.className='statuspick '+(tagClass(n.st)||'');
    sel.onchange=()=>{ n.st=sel.value; saveNote({status_note:n.st||null})
      .then(()=>renderBoard()).catch(()=>{}); };
  }

  const ab=tr.querySelector('.amlbox');
  if(ab){
    if(n.aml==='WIP') ab.indeterminate=true;
    ab.onchange=()=>{ n.aml=ab.checked?'Y':''; ab.indeterminate=false;
      saveNote({aml:n.aml||null}).catch(()=>{}); };
  }

  tr.querySelector('.x').onclick=()=>{
    const go=()=>{state[which].notes=S().notes.filter(x=>x.id!==n.id);renderBoard()};
    if(n.isNew){go();return}
    persist(()=>DealBoardApi.clearNote(n.id),'note').then(go).catch(()=>{});
  };
  return tr;
}

/* Fines for this meeting. The chips show a running total per broker;
   the Add row below adds to it, editing a chip sets it outright. */
function renderFines(bumped){
  const box=$('#fines'); if(!box) return;
  box.innerHTML='';
  const list=S().fines.filter(f=>f.amt>0)
    .sort((a,b)=>b.amt-a.amt || a.b.localeCompare(b.b));
  if(!list.length){
    box.innerHTML='<span style="color:var(--ink-3);font-size:12px">No fines yet this week.</span>';
  }
  list.forEach(f=>{
    const el=document.createElement('span');
    el.className='fine hot'+(f.b===bumped?' bumped':'');
    el.title='Click the amount to correct it';
    el.innerHTML=`<b>${esc(f.b)}</b> $<span contenteditable>${f.amt}</span><button title="Clear">×</button>`;
    el.querySelector('span[contenteditable]').addEventListener('blur',e=>{
      const v=parseInt(e.target.textContent.replace(/\D/g,''))||0;
      if(v===f.amt){renderFines();return}
      f.amt=v;renderFines();renderTally();
      persist(()=>DealBoardApi.setFine(which,S().date,f.b,f.amt),'fine for '+f.b)
        .then(renderFinesYtd).catch(()=>{});
    });
    el.querySelector('button').onclick=()=>{
      if(!confirm(`Clear ${f.b}'s fine of $${f.amt}?`))return;
      f.amt=0;renderFines();renderTally();
      persist(()=>DealBoardApi.setFine(which,S().date,f.b,0),'fine for '+f.b)
        .then(renderFinesYtd).catch(()=>{});
    };
    box.appendChild(el);
  });
  const ft=$('#fineTot');
  if(ft) ft.textContent='$'+S().fines.reduce((a,f)=>a+(+f.amt||0),0);
}

/* Broker rankings — read-only mirror of the commission workbook.
   Rendered as a panel under the Targets stage. */
/* Competition ranking: equal fees share a position and the next
   broker skips accordingly — 1, 2, 3, 4=, 4=, 6. Expects the list
   already sorted by fees, highest first. */
function withRanks(list){
  let pos=0, prev=null;
  return list.map((b,i)=>{
    if(prev===null || b.fees!==prev){ pos=i+1; prev=b.fees; }
    return Object.assign({}, b, {rank:pos});
  }).map((b,i,arr)=>{
    const tied=arr.filter(x=>x.rank===b.rank).length>1;
    return Object.assign({}, b, {rankLabel: b.rank + (tied?'=':'')});
  });
}

async function renderRankings(){
  const pane=$('#rankingsPane'); if(!pane) return;
  let d;
  try{ d=await DealBoardApi.rankings(which); }
  catch(e){ pane.innerHTML='<div class="card">Could not load the rankings.</div>'; return; }
  if(!d.brokers.length){
    pane.innerHTML='<div class="card">No rankings recorded yet.</div>'; return;
  }
  const asAt=d.synced_at
    ? new Date(d.synced_at).toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric'})
    : '';
  const totFees=d.brokers.reduce((a,b)=>a+b.fees,0);
  const totBudget=d.brokers.reduce((a,b)=>a+(b.budget||0),0);
  const totPct=totBudget?Math.min(100,totFees/totBudget*100):0;

  pane.innerHTML=`<section class="ranks">
    <header><h2>${d.year} rankings</h2>
      <span class="as-at">${asAt?'from the master report, as at '+asAt:''}</span>
      <button class="src" id="syncRanks">Refresh rankings</button>
    </header>
    <table><thead><tr>
      <th style="width:30px" class="rank">#</th>
      <th style="width:34px"></th><th>Broker</th>
      <th style="width:118px" class="num">Fees</th>
      <th style="width:118px" class="num">Budget</th>
      <th>Progress</th><th class="pc"></th>
    </tr></thead><tbody>${withRanks(d.brokers).map(b=>{
      const pct=b.budget?Math.min(100,b.fees/b.budget*100):0;
      const short=b.budget&&pct<50;
      return `<tr><td class="rank${b.rank<=3?' top':''}">${b.rank<=3?`<span>${b.rankLabel}</span>`:b.rankLabel}</td>
        <td class="brk">${esc(b.code)}</td><td>${esc(b.name)}</td>
        <td class="num">${money(b.fees)}</td>
        <td class="num">${b.budget?money(b.budget):'—'}</td>
        <td><div class="bar"><i class="${short?'short':''}" style="width:${pct}%"></i></div></td>
        <td class="pc">${b.budget?pct.toFixed(0)+'%':''}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr>
      <td></td><td></td><td class="lbl">Total</td>
      <td class="num">${money(totFees)}</td>
      <td class="num">${totBudget?money(totBudget):'—'}</td>
      <td><div class="bar"><i style="width:${totPct}%"></i></div></td>
      <td class="pc">${totBudget?totPct.toFixed(0)+'%':''}</td>
    </tr></tfoot></table></section>`;

  /* Pulls from the master report. Until the Graph permission is granted
     the endpoint replies that rankings are manual — the button reports
     that plainly rather than pretending it worked. */
  const btn=$('#syncRanks');
  if(btn) btn.onclick=async()=>{
    btn.disabled=true; btn.textContent='Refreshing…';
    try{
      const r=await DealBoardApi.syncRankings();
      if(r && r.skipped){
        toast('Rankings are updated by hand at the moment');
        console.info('sync-rankings:', r.skipped);
      }else{
        const n=(r.results||[]).reduce((a,x)=>a+(x.updated||0),0);
        toast(n?`Updated ${n} broker${n===1?'':'s'}`:'No changes');
        const bad=(r.results||[]).reduce((a,x)=>a.concat(x.unmatched||[]),[]);
        if(bad.length) console.warn('names with no broker code:', bad);
      }
      await renderRankings();
      return;
    }catch(e){
      toast(e.status===401||e.status===403
        ? 'You need manager access to refresh'
        : 'Could not refresh: '+(e.message||'unknown error'));
    }
    btn.disabled=false; btn.textContent='Refresh rankings';
  };
}

/* Management — a rollup across the operating units. Each unit's
   weighted pipeline uses that unit's own percentages; a blended rate
   would misstate both. */
async function renderManagement(){
  const pane=$('#mgmtPane'); if(!pane) return;
  pane.innerHTML='<div class="card">Loading…</div>';
  let d;
  try{ d=await DealBoardApi.getSummary(); }
  catch(e){ pane.innerHTML='<div class="card">Could not load the dashboard.</div>'; return; }

  const t=d.totals||{};
  const asAt=d.synced_at
    ? new Date(d.synced_at).toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric'})
    : '';
  const maxW=Math.max(1,...(d.units||[]).map(u=>u.weighted));

  const tally=`<div class="tally" style="margin-bottom:12px;border:1px solid var(--line)">
    <div><div class="k">Deals</div><div class="v">${t.deals||0}</div></div>
    <div><div class="k">Unconditional</div><div class="v">${money(t.unconditional)}</div></div>
    <div><div class="k">Pipeline (weighted)</div><div class="v">${money(t.weighted)}</div>
      <div class="sub">${money(t.unweighted)} unweighted</div></div>
    <div><div class="k">Won</div><div class="v">${t.won||0}</div></div>
    <div><div class="k">Lost</div><div class="v">${t.lost||0}</div></div>
  </div>`;

  const units=`<section class="mgmt-units">
    <header><h2>By business unit</h2></header>
    <table><thead><tr>
      <th>Unit</th><th style="width:60px" class="num">Deals</th>
      <th style="width:118px" class="num">Unconditional</th>
      <th style="width:118px" class="num">Weighted</th>
      <th style="width:118px" class="num">Unweighted</th>
      <th style="width:110px">Share</th>
      <th style="width:52px" class="num">Won</th><th style="width:52px" class="num">Lost</th>
    </tr></thead><tbody>${(d.units||[]).map(u=>`
      <tr><td class="unit">${esc(u.name)}</td>
        <td class="num">${u.deals}</td>
        <td class="num">${money(u.unconditional)}</td>
        <td class="num">${money(u.weighted)}</td>
        <td class="num">${money(u.unweighted)}</td>
        <td><div class="share"><i style="width:${(u.weighted/maxW*100).toFixed(0)}%"></i></div></td>
        <td class="wl">${u.won}</td><td class="wl">${u.lost}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td class="lbl">Company</td>
      <td class="num">${t.deals||0}</td>
      <td class="num">${money(t.unconditional)}</td>
      <td class="num">${money(t.weighted)}</td>
      <td class="num">${money(t.unweighted)}</td>
      <td></td>
      <td class="wl">${t.won||0}</td><td class="wl">${t.lost||0}</td>
    </tr></tfoot></table></section>`;

  const r=d.ranking||[];
  const totFees=r.reduce((a,b)=>a+b.fees,0);
  const totBudget=r.reduce((a,b)=>a+(b.budget||0),0);
  const totPct=totBudget?Math.min(100,totFees/totBudget*100):0;
  const ranking=!r.length ? '' : `<section class="ranks">
    <header><h2>${d.year} company ranking</h2>
      <span class="as-at">${asAt?'from the master report, as at '+asAt:''}</span></header>
    <table><thead><tr>
      <th style="width:30px" class="rank">#</th>
      <th style="width:34px"></th><th>Broker</th>
      <th style="width:118px" class="num">Fees</th>
      <th style="width:118px" class="num">Budget</th>
      <th>Progress</th><th class="pc"></th>
    </tr></thead><tbody>${withRanks(r).map(b=>{
      const pct=b.budget?Math.min(100,b.fees/b.budget*100):0;
      return `<tr><td class="rank${b.rank<=3?' top':''}">${b.rank<=3?`<span>${b.rankLabel}</span>`:b.rankLabel}</td>
        <td class="brk">${esc(b.code)}</td>
        <td>${esc(b.name)}${b.units>1?' <span class="as-at">'+b.units+' units</span>':''}</td>
        <td class="num">${money(b.fees)}</td>
        <td class="num">${b.budget?money(b.budget):'—'}</td>
        <td><div class="bar"><i class="${b.budget&&pct<50?'short':''}" style="width:${pct}%"></i></div></td>
        <td class="pc">${b.budget?pct.toFixed(0)+'%':''}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td></td><td></td><td class="lbl">Total</td>
      <td class="num">${money(totFees)}</td>
      <td class="num">${totBudget?money(totBudget):'—'}</td>
      <td><div class="bar"><i style="width:${totPct}%"></i></div></td>
      <td class="pc">${totBudget?totPct.toFixed(0)+'%':''}</td>
    </tr></tfoot></table></section>`;

  pane.innerHTML=tally+units+ranking;
}

/* Broker Pipeline — the same stage sections, filtered to one broker.
   Shared deals (LW/WF) appear for both, counted in full for each: this
   is a view of what a broker is working on, not a fee split. */
function brokerOptions(){
  const seen={};
  S().deals.forEach(d=>brokersOf(d).forEach(c=>{ seen[c]=(seen[c]||0)+1; }));
  return Object.keys(seen).sort().map(c=>{
    const b=(brokerList||[]).find(x=>x.code===c);
    return {code:c, name:b?b.first_name:'', count:seen[c]};
  });
}

function renderBrokerTally(){
  const tally=$('#brokerTally'); if(!tally) return;
  const mine=visibleDeals();
  const banked=mine.filter(d=>/^uncondition/i.test(d.s)).reduce((a,d)=>a+shareOf(d),0);
  const weighted=mine.reduce((a,d)=>a+shareOf(d)*dealWeight(d),0);
  const raw=mine.reduce((a,d)=>a+shareOf(d),0);
  const won=S().deals.filter(d=>d.out==='won'&&brokersOf(d).indexOf(brokerFilter)>=0).length;
  const lost=S().deals.filter(d=>d.out==='lost'&&brokersOf(d).indexOf(brokerFilter)>=0).length;
  tally.innerHTML=`
    <div><div class="k">Deals</div><div class="v">${mine.length}</div></div>
    <div><div class="k">Unconditional</div><div class="v">${money(banked)}</div></div>
    <div><div class="k">Pipeline (weighted)</div><div class="v">${money(weighted)}</div>
      <div class="sub">${money(raw)} unweighted</div></div>
    <div><div class="k">Won</div><div class="v">${won}</div></div>
    <div><div class="k">Lost</div><div class="v">${lost}</div></div>`;
}

function renderBrokerPipeline(){
  const sel=$('#brokerPick'); if(!sel) return;
  const opts=brokerOptions();

  if(sel.dataset.unit!==which){
    sel.dataset.unit=which;
    sel.innerHTML='<option value="">Choose a broker…</option>'+
      opts.map(o=>`<option value="${esc(o.code)}"${o.code===brokerFilter?' selected':''}>${
        esc(o.code)}${o.name?' — '+esc(o.name):''} (${o.count})</option>`).join('');
    sel.onchange=()=>{ brokerFilter=sel.value; renderBrokerPipeline(); };
  }
  if(brokerFilter && !opts.some(o=>o.code===brokerFilter)){
    brokerFilter=''; sel.value='';
  }

  const note=$('#brokerNote');
  const tally=$('#brokerTally');
  const stages=$('#brokerStages');

  if(!brokerFilter){
    if(note) note.textContent='Pick a broker to see everything they are working on, including deals shared with others.';
    if(tally) tally.innerHTML='';
    if(stages) stages.innerHTML='';
    return;
  }

  const mine=visibleDeals();
  const shared=mine.filter(d=>brokersOf(d).length>1).length;

  if(note) note.innerHTML = shared
    ? `Fees shown are an <b>even split</b> by number of brokers — ${shared} of these ${
       shared===1?'deal is':'deals are'} shared. Actual commission splits are held in the finance workbook.`
    : 'Fees shown in full — none of these deals are shared.';

  renderBrokerTally();
  renderBoard('#brokerStages');
}

/* Pipeline Settings — the percentages behind the weighted total. */
function renderWeights(){
  const box=$('#weightRows'); if(!box) return;
  const rows=[['Conditional','Conditional'],
              ['Campaigns / sole agency','Campaign'],
              ['Submissions','Submission']];
  box.innerHTML=rows.map(r=>{
    const v=(S().weights||{})[r[0]];
    return `<div class="wrow">
      <label>${esc(r[1])}</label>
      <input type="number" min="0" max="100" step="1"
             data-stage="${esc(r[0])}" value="${v===undefined?'':v}">
      <span class="pcsign">%</span></div>`;
  }).join('')+
  `<div class="wrow"><label>Unconditional</label>
     <input type="number" value="100" disabled><span class="pcsign">%</span></div>`;

  box.querySelectorAll('input[data-stage]').forEach(inp=>{
    inp.onchange=()=>{
      const stage=inp.dataset.stage;
      const pct=Math.max(0,Math.min(100,parseFloat(inp.value)||0));
      inp.value=pct;
      const was=(S().weights||{})[stage];
      S().weights[stage]=pct;
      renderTally(); renderWeightExample();
      persist(()=>DealBoardApi.saveWeight(which,stage,pct),'weighting')
        .catch(()=>{ S().weights[stage]=was; renderWeights(); renderTally(); });
    };
  });
  renderWeightExample();
}

/* Show the arithmetic, so a number on the projector can be defended. */
function renderWeightExample(){
  const el=$('#weightExample'); if(!el) return;
  const parts=[];
  ['Unconditional','Conditional','Campaigns / sole agency','Submissions'].forEach(st=>{
    const raw=visibleDeals().filter(d=>d.s===st).reduce((a,d)=>a+(+d.f||0),0);
    if(!raw) return;
    const w=weightFor(st);
    parts.push(`${esc(st)} ${money(raw)} × ${(w*100).toFixed(0)}% = ${money(raw*w)}`);
  });
  el.innerHTML=parts.length
    ? parts.join('<br>')+`<br><b>Weighted pipeline ${money(weightedPipeline())}</b>` : '';
}

/* Season-to-date pot — fines accumulate across meetings until settled. */
async function renderFinesYtd(){
  const box=$('#finesYtd'); if(!box) return;
  let d;
  try{ d=await DealBoardApi.finesYtd(which); }
  catch(e){ box.innerHTML=''; return; }
  if(!d.brokers.length){
    box.innerHTML=`<div class="hd">${d.year} to date <b>$0</b></div>`+
      '<div class="none">Nothing owing.</div>';
    return;
  }
  box.innerHTML=`<div class="hd">${d.year} to date <b>$${d.total.toLocaleString()}</b></div>`+
    '<table>'+d.brokers.map(b=>
      `<tr><td class="c">${esc(b.code)}</td><td class="n">$${b.total.toLocaleString()}</td>`+
      `<td class="act"><button class="settle" data-c="${esc(b.code)}" data-a="${b.total}">settle</button></td></tr>`
    ).join('')+'</table>';
  box.querySelectorAll('button.settle').forEach(btn=>btn.onclick=()=>{
    const code=btn.dataset.c, owed=Number(btn.dataset.a);
    const raw=prompt(`Record a payment from ${code}.\n\nOutstanding: $${owed.toLocaleString()}\nAmount paid:`, owed);
    if(raw===null) return;
    const amt=parseFloat(String(raw).replace(/[^0-9.]/g,''));
    if(!amt||amt<=0) return;
    persist(()=>DealBoardApi.settleFine(which,code,amt),'settlement for '+code)
      .then(()=>{ toast(`${code} settled $${amt.toLocaleString()}`); renderFinesYtd(); })
      .catch(()=>{});
  });
}

/* Broker dropdown, loaded once from public.brokers */
let brokerList=[];   // also used by the Broker Pipeline picker
async function loadBrokers(){
  try{
    brokerList=await DealBoardApi.listBrokers();
  }catch(e){
    // Fall back to whoever already has a fine, so the picker still works.
    brokerList=S().fines.map(f=>({code:f.b,first_name:f.b}));
  }
  const sel=$('#fineBroker');
  if(!sel) return;
  sel.innerHTML='<option value="">Broker…</option>'+
    brokerList.map(b=>`<option value="${b.code}">${b.code} — ${esc(b.first_name)}</option>`).join('');
}

/* Adds to the broker's running total rather than replacing it. */
function addFine(){
  const selEl=$('#fineBroker'), amtEl=$('#fineAmount');
  if(!selEl||!amtEl) return;
  const code=selEl.value;
  const amt=parseInt(amtEl.value,10);
  if(!code){ selEl.focus(); return; }
  if(!amt||amt<0){ amtEl.focus(); return; }

  let f=S().fines.find(x=>x.b===code);
  if(!f){ f={b:code,amt:0}; S().fines.push(f); }
  const was=f.amt;
  f.amt=was+amt;

  renderFines(code);renderTally();
  toast(`${code} +$${amt} → $${f.amt}`);
  amtEl.value=10;
  selEl.focus();

  persist(()=>DealBoardApi.setFine(which,S().date,code,f.amt),'fine for '+code)
    .then(renderFinesYtd)
    .catch(()=>{ f.amt=was; renderFines(); renderTally(); });
}
click('#addFine', addFine);
on('#fineAmount','keydown',e=>{ if(e.key==='Enter'){e.preventDefault();addFine()} });

let fromDate='', toDate='';
/* A deal passes the filter when it has a date inside the range.
   Undated deals are shown only when no range is set — otherwise a
   range would silently hide everything that has not been dated yet,
   and the totals would look wrong for no visible reason. */
function inRange(d){
  if(!fromDate && !toDate) return true;
  if(!d.td) return false;
  if(fromDate && d.td < fromDate) return false;
  if(toDate   && d.td > toDate)   return false;
  return true;
}
/* Split 'LW/WF' into codes. A shared deal belongs to both brokers, so
   it appears in both their pipelines. */
function brokersOf(d){
  return (d.b||'').split('/').map(x=>x.trim().toUpperCase()).filter(Boolean);
}
let brokerFilter='';
/* A broker's share of a deal, split evenly by head count.
   This is an ASSUMPTION, not a commission figure — actual splits live
   in the finance workbook. Shown labelled, with the full fee alongside,
   so it is never mistaken for the real number. */
function shareOf(d){
  const n=brokersOf(d).length || 1;
  return (+d.f||0)/n;
}
function visibleDeals(){
  let list=S().deals.filter(inRange);
  if(brokerFilter) list=list.filter(d=>brokersOf(d).indexOf(brokerFilter)>=0);
  return list;
}

function applyDateFilter(){
  fromDate=($('#fromDate')||{}).value||'';
  toDate=($('#toDate')||{}).value||'';
  const note=$('#filterNote');
  if(note){
    const total=S().deals.length, shown=visibleDeals().length;
    const undated=S().deals.filter(d=>!d.td).length;
    note.textContent=(fromDate||toDate)
      ? `showing ${shown} of ${total}` + (undated?` · ${undated} undated hidden`:'')
      : '';
  }
  renderBoard();renderTally();
}
on('#fromDate','change',applyDateFilter);
on('#toDate','change',applyDateFilter);
click('#clearDates', ()=>{
  const f=$('#fromDate'), t=$('#toDate');
  if(f)f.value=''; if(t)t.value='';
  applyDateFilter();
});

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
on('#regSearch','input',e=>{regQ=e.target.value;renderRegister()});
click('#addReg', ()=>{
  S().register.unshift({id:'tmp'+Date.now(),n:'',r:'',ag:'',h:'Motivated',isNew:true});
  renderRegister();renderTally();
  const f=$('#regBody').querySelector('[contenteditable]');if(f)f.focus()});


/* Save meeting — a dated, self-contained snapshot the EA can keep.
   Opens a print view; the browser's "Save as PDF" destination writes
   the file. Nothing on the board changes: the sheet stays live. */
function saveMeetingSnapshot(){
  const d=new Date();
  const stamp=d.toLocaleDateString('en-NZ',
    {weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const fileStamp=d.toISOString().slice(0,10);

  const stages=(S().stages||[]).slice().sort((a,b)=>a.position-b.position);
  const noteSecs=(S().noteSections||[]).slice().sort((a,b)=>a.position-b.position);
  const fines=S().fines.filter(f=>f.amt>0).sort((a,b)=>b.amt-a.amt);

  const stageBlock=st=>{
    const rows=visibleDeals().filter(x=>x.s===st.name);
    if(!rows.length) return '';
    return `<section><h2>${esc(st.name)}<span>${rows.length} · ${money(stageTotal(st.name))}</span></h2>
      <table><thead><tr><th>Address</th><th>Timing</th><th class="n">Fee</th>
        <th>Status</th><th>Broker</th><th>AML</th></tr></thead><tbody>${
      rows.map(r=>`<tr><td>${r.tn?esc(r.tn)+' — ':''}${esc(r.a)}</td><td>${r.td?new Date(r.td+'T00:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric'}):(esc(r.t)||'—')}</td>
        <td class="n">${r.f?money(r.f):'—'}</td><td>${esc(r.st)||'—'}</td>
        <td class="m">${esc(r.b)||'—'}</td><td class="m">${esc(r.aml)||'—'}</td></tr>`).join('')
    }</tbody></table></section>`;
  };
  const noteBlock=ns=>{
    const items=(S().notes||[]).filter(n=>n.section===ns.name&&n.body);
    if(!items.length) return '';
    return `<section><h2>${esc(ns.name)}<span>${items.length}</span></h2>
      <table><thead><tr><th>Detail</th><th>Timing</th><th class="n">Fee</th>
        <th>Status</th><th>Broker</th><th>AML</th></tr></thead><tbody>${
      items.map(n=>`<tr><td>${esc(n.body)}</td>
        <td>${n.td?new Date(n.td+'T00:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric'}):(esc(n.t)||'—')}</td>
        <td class="n">${n.f?money(n.f):'—'}</td><td>${esc(n.st)||'—'}</td>
        <td class="m">${esc(n.b)||'—'}</td><td class="m">${n.aml==='Y'?'Y':'—'}</td></tr>`).join('')
    }</tbody></table></section>`;
  };

  const blocks=[];
  let ni=0;
  stages.forEach(st=>{
    while(ni<noteSecs.length && noteSecs[ni].position<st.position){
      blocks.push(noteBlock(noteSecs[ni++]));
    }
    blocks.push(stageBlock(st));
  });
  while(ni<noteSecs.length) blocks.push(noteBlock(noteSecs[ni++]));

  const html=`<!DOCTYPE html><html lang="en-NZ"><head><meta charset="utf-8">
<title>${esc(M().title)} — ${fileStamp}</title>
<style>
  @page{size:A4 portrait;margin:14mm}
  body{font:10pt/1.4 'Segoe UI',Arial,sans-serif;color:#101820;margin:0}
  header.doc{border-bottom:2px solid #16385c;padding-bottom:8px;margin-bottom:14px}
  header.doc h1{margin:0;font-size:16pt;text-transform:uppercase;letter-spacing:.04em;color:#16385c}
  header.doc .d{font-size:9pt;color:#555;margin-top:2px}
  .tot{display:flex;gap:22px;margin:10px 0 16px;font-size:9pt}
  .tot b{display:block;font-size:13pt}
  section{break-inside:avoid;margin-bottom:12px}
  h2{font-size:10pt;text-transform:uppercase;letter-spacing:.07em;color:#16385c;
     border-bottom:1px solid #ccc;padding-bottom:3px;margin:0 0 5px;display:flex}
  h2 span{margin-left:auto;font-weight:normal;color:#555;font-size:8.5pt}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;
     color:#666;border-bottom:1px solid #ddd;padding:2px 4px}
  td{padding:2px 4px;border-bottom:1px solid #f0f0f0;font-size:9pt;vertical-align:top}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  td.m{font-family:Consolas,monospace;font-size:8.5pt}
  ul{margin:0;padding-left:16px}li{font-size:9pt;padding:1px 0}
  .box{border:1px solid #ddd;padding:7px;font-size:9pt;white-space:pre-wrap;min-height:26px}
  .fines span{display:inline-block;border:1px solid #ccc;border-radius:9px;
    padding:1px 7px;margin:0 4px 4px 0;font-size:8.5pt}
  footer{margin-top:16px;border-top:1px solid #ddd;padding-top:5px;
    font-size:7.5pt;color:#777}
</style></head><body>
<header class="doc"><h1>${esc(M().title)}</h1><div class="d">${stamp}</div></header>
<div class="tot">
  <div>Deals<b>${S().deals.length}</b></div>
  <div>Unconditional<b>${money(stageTotal('Unconditional'))}</b></div>
  <div>Pipeline<b>${money(S().deals.reduce((a,x)=>a+(+x.f||0),0))}</b></div>
  <div>Fines this week<b>$${S().fines.reduce((a,f)=>a+(+f.amt||0),0)}</b></div>
</div>
${S().apologies?`<section><h2>Apologies</h2><div class="box">${esc(S().apologies)}</div></section>`:''}
${blocks.filter(Boolean).join('')}
${fines.length?`<section><h2>Fines</h2><div class="fines">${
  fines.map(f=>`<span>${esc(f.b)} $${f.amt}</span>`).join('')}</div></section>`:''}
<section><h2>Minutes / actions</h2><div class="box">${esc(S().minutes||'')}</div></section>
<footer>Snapshot taken ${d.toLocaleString('en-NZ')} — the board remains live and editable.</footer>
</body></html>`;

  const w=window.open('','_blank');
  if(!w){ alert('Please allow pop-ups to save the meeting.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(()=>w.print(), 350);
}
click('#saveMtgBtn', saveMeetingSnapshot);

click('#projBtn', ()=>{
  proj=!proj;document.body.classList.toggle('proj',proj);
  $('#projBtn').classList.toggle('on',proj);
  $('#projBtn').textContent=proj?'Exit projector':'Projector';
  if(proj&&document.documentElement.requestFullscreen)
    document.documentElement.requestFullscreen().catch(()=>{});
  else if(!proj&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});
});
/* Business unit switcher. Populated from the API so adding a unit in
   the database is all that is needed — no code change. */
async function loadUnits(){
  const sel=$('#unitPick'); if(!sel) return;
  try{ UNITS=await DealBoardApi.listDepartments(); }
  catch(e){ UNITS=[{slug:which,name:which}]; }
  sel.innerHTML=UNITS.map(u=>
    `<option value="${esc(u.slug)}"${u.slug===which?' selected':''}>${esc(u.name)}</option>`
  ).join('');
  sel.onchange=async()=>{
    which=sel.value;
    try{ window.name='db:'+which; }catch(e){}
    collapsed={}; current=null;
    try{ await loadBoard(); }
    catch(e){ setSaver('err','Could not load '+titleFor(which)); }
  };
}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');tab=b.dataset.tab;
  ['board','broker','register','rankings','settings','management'].forEach(t=>{
    const el=$('#tab-'+t); if(el) el.hidden = t!==tab;
  });
  // The broker filter must not leak into the main pipeline view.
  if(tab!=='broker') brokerFilter='';
  if(tab==='board'){ renderBoard('#stages'); renderTally(); }
  if(tab==='broker')renderBrokerPipeline();
  if(tab==='register')renderRegister();
  if(tab==='rankings')renderRankings();
  if(tab==='settings')renderWeights();
  if(tab==='management')renderManagement();
});
click('#clearApologies', ()=>{
  if(!S().apologies || !confirm('Clear the apologies?')) return;
  S().apologies=''; const el=$('#apologies'); if(el) el.textContent='';
  saveMeetingField({apologies:''}).catch(()=>{});
});
click('#clearNotes', ()=>{
  if(!S().minutes || !confirm('Clear the minutes and actions?')) return;
  S().minutes=''; const el=$('#minutesBox'); if(el) el.value='';
  saveMeetingField({minutes:''}).catch(()=>{});
});

on('#apologies','blur',e=>{
  const v=e.target.textContent.trim();
  if(v===S().apologies)return;
  S().apologies=v; saveMeetingField({apologies:v}).catch(()=>{});
});
on('#minutesBox','blur',e=>{
  const v=e.target.value;
  if(v===S().minutes)return;
  S().minutes=v; saveMeetingField({minutes:v}).catch(()=>{});
});

function renderAll(){
  $('#mtgTitle').textContent=M().title;
  // Always today — the board is live, not a dated snapshot. The Save
  // meeting PDF is what carries a fixed date.
  $('#mtgDate').textContent=new Date()
    .toLocaleDateString('en-NZ',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase();
  $('#apologies').textContent=S().apologies;
  const nEl=$('#minutesBox')||$('#notes'); if(nEl) nEl.value=S().minutes;
  renderTally();renderBoard('#stages');renderFines();renderFinesYtd();
  if(tab==='rankings')renderRankings();
  if(tab==='settings')renderWeights();
  if(tab==='register')renderRegister();
}
async function loadBoard(){
  setSaver('','Loading…');
  if(isRollup(which)){
    // Management has no board of its own — show only the dashboard.
    tab='management';
    document.querySelectorAll('.tabs button').forEach(b=>{
      b.classList.toggle('on', b.dataset.tab==='management');
      b.hidden = b.dataset.tab!=='management';
    });
    ['board','broker','register','rankings','settings','management'].forEach(t=>{
      const el=$('#tab-'+t); if(el) el.hidden = t!=='management';
    });
    const fb=$('#filterbar'); if(fb) fb.hidden=true;
    const tl=$('#tally'); if(tl) tl.innerHTML='';
    $('#mtgTitle').textContent=titleFor(which);
    $('#mtgDate').textContent=new Date()
      .toLocaleDateString('en-NZ',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase();
    setSaver('ok','Ready');
    await renderManagement();
    return;
  }
  document.querySelectorAll('.tabs button').forEach(b=>{
    b.hidden = b.dataset.tab==='management';
  });
  const fb=$('#filterbar'); if(fb) fb.hidden=false;
  if(tab==='management') tab='board';
  const payload=await DealBoardApi.getBoard(which);
  state[which]=fromApi(which,payload);
  setSaver('ok','Ready');
  renderAll();
}

const BOARD_VERSION='2026-08-21c';
console.info('deal-board.js', BOARD_VERSION);

/* Sanity check — a truncated or partial file should say so plainly
   rather than rendering an empty board. */
for(const fn of ['dealRow','noteRow','statusSelect','renderBoard','renderTally']){
  if(typeof window[fn]!=='function' && typeof eval('typeof '+fn)!=='function'){
    console.error('deal-board: missing function '+fn+' — deal-board.js may be incomplete');
  }
}

(async()=>{
  try{
    const account=await window.DealSheetAuth.init();
    if(!account) return;               // redirecting to sign in
    document.getElementById('gate').style.display='none';
    state={};
    UNITS=await DealBoardApi.listDepartments().catch(()=>[]);
    if(!UNITS.length) throw new Error('No business units configured');
    // Remember the last unit viewed, so switching is not undone on reload.
    const last=window.name && window.name.indexOf('db:')===0
      ? window.name.slice(3) : '';
    which = UNITS.some(u=>u.slug===last) ? last : UNITS[0].slug;
    await loadUnits();
    await loadBoard();
    await loadBrokers();
  }catch(err){
    console.error(err);
    document.getElementById('gate').innerHTML=
      '<div class="inner">Could not sign in — '+(err.message||'try reloading')+'</div>';
  }
})();
