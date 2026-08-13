// /public/js/lease-form.js — Deal Sheet: Leasing Record
(function () {
  const cfg = window.DealSheetConfig;
  const api = window.DealSheetApi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,\s%]/g, "")); return isNaN(n) ? 0 : n; };
  const fmt = (n) => Number(n || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Live comma-formatting for $ fields, as the user types. Preserves the
  // caret position by digit-count rather than raw character offset, so
  // inserting/removing a comma doesn't visibly move the cursor.
  function formatMoneyLive(el) {
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    // Count digits AND the decimal point (never commas) up to the caret —
    // this survives reformatting even when the caret sits right after a
    // decimal point that hasn't had a digit typed after it yet.
    const meaningfulBefore = (raw.slice(0, caret).match(/[\d.]/g) || []).length;

    let clean = raw.replace(/[^\d.]/g, "");
    const firstDot = clean.indexOf(".");
    if (firstDot !== -1) clean = clean.slice(0, firstDot + 1) + clean.slice(firstDot + 1).replace(/\./g, "");
    let [intPart, decPart] = clean.split(".");
    if (decPart != null) decPart = decPart.slice(0, 2);
    intPart = (intPart || "").replace(/^0+(?=\d)/, "");

    if (!intPart && decPart == null) { el.value = ""; return; }
    const withCommas = intPart ? Number(intPart).toLocaleString("en-NZ") : "0";
    el.value = decPart != null ? `${withCommas}.${decPart}` : withCommas;

    let seen = 0, pos = el.value.length;
    if (meaningfulBefore === 0) { pos = 0; }
    else {
      for (let i = 0; i < el.value.length; i++) {
        if (/[\d.]/.test(el.value[i])) seen++;
        if (seen === meaningfulBefore) { pos = i + 1; break; }
      }
    }
    el.setSelectionRange(pos, pos);
  }

  const DIVISIONS = ["Industrial","Office","Retail","Investment Sales","Land","Rural & Agribusiness","Other"];
  const DEAL_TYPES = ["Standard Lease","Relocation","Expansion","Assignment","Renegotiation"];
  let BROKERS = [];

  // Rental schedule lines — mirrors api/_lib/leases.js RENTAL_LINES.
  const RENTAL_LINES = [
    { key:"retail",    label:"Retail",        unit:"sqm",  rateLabel:"$ psqm" },
    { key:"office",    label:"Office",        unit:"sqm",  rateLabel:"$ psqm" },
    { key:"warehouse", label:"Warehouse",     unit:"sqm",  rateLabel:"$ psqm" },
    { key:"industrial",label:"Industrial",    unit:"sqm",  rateLabel:"$ psqm" },
    { key:"yard",      label:"Yard",          unit:"sqm",  rateLabel:"$ psqm" },
    { key:"canopy",    label:"Canopy / Deck", unit:"sqm",  rateLabel:"$ psqm" },
    { key:"naming",    label:"Naming Rights", unit:null,   rateLabel:"" },
    { key:"carparks",  label:"Carparks",      unit:"cpks", rateLabel:"$ ppkpw" },
    { key:"other1",    label:"Other",         unit:null,   rateLabel:"" },
    { key:"other2",    label:"Other",         unit:null,   rateLabel:"" },
  ];

  const emptyRental = () => {
    const r = {};
    RENTAL_LINES.forEach(l => { r[l.key] = { qty:"", rate:"", total:"", desc:"" }; });
    r.opex = "";
    return r;
  };

  const state = {
    currentId: null,
    saveTimer: null,
    userName: "",
    triedSubmit: false,
    resumed: false,
    returnNote: "",
    dealStatus: "draft", // a brand-new, never-saved sheet is implicitly a draft
    f: {
      ownership: { salespeople: [], division: "Industrial", office: "Christchurch" },
      property: { address:"", buildingName:"", propertyType:"", level:"", unit:"", city:"Christchurch" },
      lessor:   { name:"", phone:"", contactName:"", email:"", postalAddress:"", city:"", country:"New Zealand", postcode:"", solicitorName:"", solicitorFirm:"", solicitorEmail:"", parentCompany:"" },
      lessee:   { name:"", phone:"", contactName:"", email:"", postalAddress:"", city:"", country:"New Zealand", postcode:"", solicitorName:"", solicitorFirm:"", solicitorEmail:"" },
      invoiceToLessee: false,
      billingDifferent: false,
      billing:  { name:"", phone:"", contactName:"", email:"", postalAddress:"", city:"", country:"New Zealand", postcode:"" },
      lease: {
        dateOfAgreement:"", unconditionalDate:"", occupancyDate:"",
        termYears:"", rorYears:"", rorTimes:"",
        commencementDate:"", expiryDate:"", rentReviewPeriod:"",
        dealType:"", leaseBasis:"Net", incentives:"",
      },
      rental: emptyRental(),
      // Manual overrides for the schedule totals (blank = use calculated).
      rentalOverride: { net:"", gross:"" },
      depositToTrust: false,
      deposit: { amount:"", dateReceived:"", receiptNo:"", earlyRelease:false,
                 lessorAuthSent:false, lessorAuthReceived:false, lesseeAuthSent:false, lesseeAuthReceived:false },
      // Commission amounts are entered manually for leases.
      comm: { feeDesc:"", fee:"", otherDesc:"", otherFee:"", adminFee:true,
              recoverMarketingDesc:"", recoverMarketing:"", recoverOtherDesc:"", recoverOther:"" },
      splits: [ {person:"",pct:"",fixed:""},{person:"",pct:"",fixed:""},{person:"",pct:"",fixed:""},{person:"",pct:"",fixed:""},{person:"",pct:"",fixed:""} ],
      thirdParty: [ {name:"",pct:"",fixed:""},{name:"",pct:"",fixed:""},{name:"",pct:"",fixed:""} ],
      tenantSource: "", tenantSourceOther: "", tenantReferralWho: "",
      confidential: false,
      checklist: { agencyAgreement:false, unconditionalConfirmation:false, leaseValueConfirmation:false,
                   marketingReport:false, amlComplete:false, leaseDeed:false, appraisals:false,
                   executedAgreement:false },
      attachments: {},
      extraAttachments: [], // "Other Documents" — free-form, description required, draft-only
    },
  };

  // ---------- path get/set ----------
  const get = (path) => path.split(".").reduce((o,k) => (o||{})[k], state.f);
  const set = (path, val) => {
    const keys = path.split("."); const last = keys.pop();
    let o = state.f; keys.forEach(k => { o = o[k] = o[k] ?? {}; });
    o[last] = val;
  };

  // ---------- derived (mirrors api/_lib/leases.js) ----------
  function derive() {
    const f = state.f, r = f.rental;

    const lineTotals = {};
    RENTAL_LINES.forEach(({ key, unit }) => {
      const line = r[key] || {};
      let t;
      if (key === "carparks") t = num(line.qty) * num(line.rate) * 52;
      else if (unit === "sqm") t = num(line.qty) * num(line.rate);
      else t = num(line.total);
      // An explicitly entered total wins over the calculated one.
      if (unit && line.total !== "" && line.total != null) t = num(line.total);
      lineTotals[key] = t;
    });

    const calcNet = Object.values(lineTotals).reduce((a,b) => a+b, 0);
    const opex = num(r.opex);
    // Manual overrides win over the calculated figures when present.
    const netRental = f.rentalOverride.net !== "" ? num(f.rentalOverride.net) : calcNet;
    const calcGross = netRental + opex;
    const grossRental = f.rentalOverride.gross !== "" ? num(f.rentalOverride.gross) : calcGross;
    const totalArea = RENTAL_LINES.filter(l => l.unit === "sqm")
      .reduce((a,l) => a + num((r[l.key]||{}).qty), 0);

    const adminFee = f.comm.adminFee ? 500 : 0;
    const recoverMarketing = num(f.comm.recoverMarketing);
    const recoverOther = num(f.comm.recoverOther);
    const totalInvoice = num(f.comm.fee) + num(f.comm.otherFee) + adminFee
      + recoverMarketing + recoverOther;

    // commissionBase is the actual commission-earning amount — the admin
    // fee and cost recoveries are pass-throughs, not commission, so
    // neither third parties nor salespeople take a share of them.
    const commissionBase = totalInvoice - adminFee - recoverMarketing - recoverOther;

    // A split can be a fixed $ amount OR a percentage. Fixed wins when set.
    const tpAmount = (s, base) => num(s.fixed) > 0 ? num(s.fixed) : (num(s.pct)/100)*base;
    const thirdPartyPctTotal = f.thirdParty.reduce((a,s) => a + num(s.pct), 0);
    const thirdPartyTotal = f.thirdParty.reduce((a,s) => a + tpAmount(s, commissionBase), 0);
    // Salespeople DO split the admin fee between them (third parties
    // still don't) — added back in here, after the third-party share
    // is taken out of the pure commission.
    const internalPool = (commissionBase - thirdPartyTotal) + adminFee;
    const internalPctTotal = f.splits.reduce((a,s) => a + num(s.pct), 0);
    const internalFixedTotal = f.splits.reduce((a,s) => a + (num(s.fixed) > 0 ? num(s.fixed) : 0), 0);
    // With fixed amounts in the mix, "100%" no longer strictly applies —
    // consider it balanced if the paid-out internal total matches the pool.
    const internalPaid = f.splits.reduce((a,s) => a + (num(s.fixed) > 0 ? num(s.fixed) : (num(s.pct)/100)*internalPool), 0);
    const internalOk = Math.abs(internalPaid - internalPool) < 1
      || internalPctTotal === 0 && internalFixedTotal === 0;

    // #12 — deposit shortfall against the total to invoice.
    const depositAmount = num(f.deposit.amount);
    const depositShort = f.depositToTrust && depositAmount > 0 && depositAmount < totalInvoice;
    const depositGap = depositShort ? totalInvoice - depositAmount : 0;

    return { lineTotals, netRental, calcNet, opex, grossRental, calcGross, totalArea,
             adminFee, totalInvoice, commissionBase, thirdPartyPctTotal,
             thirdPartyTotal, internalPool, internalPctTotal, internalPaid, internalOk,
             tpAmount, depositAmount, depositShort, depositGap };
  }

  function splitStatusText(d) {
    if (d.internalPctTotal === 0 && d.internalPaid === 0) return "No salesperson split entered";
    const paid = "$" + fmt(d.internalPaid) + " of $" + fmt(d.internalPool);
    return d.internalOk ? `Salesperson split balances (${paid}) ✓`
                        : `Salesperson split ${paid} — doesn't balance`;
  }

  function validate(d) {
    const f = state.f, m = [];
    if (!f.ownership.salespeople.length) m.push("Salesperson");
    if (!f.property.address.trim()) m.push("Property address");
    if (!f.lessor.name) m.push("Lessor name");
    if (!f.lessee.name) m.push("Lessee name");
    if (!f.lease.dateOfAgreement) m.push("Date of agreement");
    if (!f.lease.commencementDate) m.push("Commencement date");
    if (!f.lease.termYears) m.push("Lease term");
    if (!d.grossRental) m.push("Rental schedule");
    if (!d.totalInvoice) m.push("Commission amount");
    if (d.internalPaid === 0) m.push("Commission split");
    else if (!d.internalOk) m.push("Salesperson split must balance to the pool");
    if (d.thirdPartyTotal >= d.totalInvoice) m.push("Third-party share can't exceed the commission");
    if (!f.tenantSource) m.push("Tenant source");
    const c = f.checklist;
    if (!c.agencyAgreement) m.push("Checklist — signed agency agreement");
    if (!c.unconditionalConfirmation) m.push("Checklist — confirmation of unconditional");
    if (!c.leaseValueConfirmation) m.push("Checklist — confirmation of lease value");
    if (!c.amlComplete) m.push("Checklist — AML complete");
    if (!c.leaseDeed) m.push("Checklist — lease deed");
    return m;
  }

  // ---------- autosave ----------
  let saveState = "";
  function scheduleAutosave() {
    clearTimeout(state.saveTimer);
    saveState = "Saving…"; updateSaveState();
    state.saveTimer = setTimeout(async () => {
      try {
        const r = await api.saveDraft(state.f, state.currentId, "lease");
        state.currentId = r.id;
        saveState = "Draft saved";
      } catch (e) { saveState = "Save failed — will retry"; }
      updateSaveState();
    }, 1500);
  }
  function updateSaveState() { const el = $("saveState"); if (el) el.textContent = saveState; }

  // ---------- builders ----------
  const txt = (path, label, opts = {}) => {
    const { ph = "", type = "text", span = 1, req = false, money = false } = opts;
    return `<label class="fld span${span}"><span class="lbl">${label}${req ? '<em class="req">*</em>' : ''}</span>
      <input type="${type}" ${money ? 'data-money' : ''} data-path="${path}" value="${esc(get(path))}" placeholder="${esc(ph)}" /></label>`;
  };
  const sel = (path, label, options, span = 1) =>
    `<label class="fld span${span}"><span class="lbl">${label}</span>
      <select data-path="${path}"><option value="">Select…</option>
      ${options.map(o => `<option value="${esc(o)}" ${get(path)===o?"selected":""}>${esc(o)}</option>`).join("")}
      </select></label>`;
  const chk = (path, label) =>
    `<label class="chk"><input type="checkbox" data-path="${path}" ${get(path)?"checked":""} /><span>${label}</span></label>`;
  const party = (base, solicitor, req) => `<div class="grid">
    ${txt(base+".name","Name",{span:2,req})}${txt(base+".phone","Phone")}
    ${txt(base+".contactName","Contact name",{span:2})}${txt(base+".email","Email",{type:"email"})}
    ${txt(base+".postalAddress","Postal address",{span:2})}${txt(base+".postcode","Postcode")}
    ${txt(base+".city","City")}${txt(base+".country","Country")}
    ${solicitor ? txt(base+".solicitorName","Solicitor")+txt(base+".solicitorFirm","Firm")+txt(base+".solicitorEmail","Solicitor email",{type:"email"}) : ""}
  </div>`;
  const section = (n, title, note, inner) => `<section class="card"><header class="cardHead">
    <span class="secNo">${n}</span><div><h2>${title}</h2>${note?`<p class="note">${note}</p>`:""}</div></header>${inner}</section>`;

  function uploadSlot(slotKey, label) {
    const a = state.f.attachments[slotKey];
    if (a) {
      return `<div class="upSlot done" data-slot="${slotKey}">
        <span class="upFile">📎 ${esc(a.name)}</span>
        <button type="button" class="upRemove" data-slot="${slotKey}">Remove</button></div>`;
    }
    return `<div class="upSlot" data-slot="${slotKey}">
      <label class="upBtn">Attach file<input type="file" class="upInput" data-slot="${slotKey}" hidden /></label>
      <span class="upHint">${label}</span>
      <span class="upProgress hidden" data-slot="${slotKey}">Uploading…</span></div>`;
  }

  function extraAttachmentsList() {
    const items = state.f.extraAttachments || [];
    if (!items.length) return `<p class="dim" style="margin:4px 0 10px">None added yet.</p>`;
    return `<ul class="attachList extraList">${items.map((a) => `<li>
        <span>📎 <strong>${esc(a.description || "(no description)")}</strong> — ${esc(a.name)}</span>
        <span class="attachBtns">
          ${state.dealStatus === "draft" ? `<button type="button" class="rmBtn" data-extra-remove="${esc(a.slot)}">Remove</button>` : ""}
        </span></li>`).join("")}</ul>`;
  }

  // ---------- render ----------
  function render() {
    const d = derive();
    const missing = validate(d);
    const f = state.f;

    const brokerChips = BROKERS.map((b) => `<label class="brokerChip ${f.ownership.salespeople.includes(b.code)?"on":""}">
      <input type="checkbox" class="brokerBox" value="${b.code}" ${f.ownership.salespeople.includes(b.code)?"checked":""} />
      <span>${esc(b.name)}</span></label>`).join("");

    // Rental schedule rows
    const rentalRows = RENTAL_LINES.map(l => {
      const line = f.rental[l.key] || {};
      const calc = d.lineTotals[l.key];
      const showCalc = calc ? fmt(calc) : "";
      const isOther = l.key === "other1" || l.key === "other2";
      if (isOther) {
        // "Other" lines: a description spanning the area+rate columns,
        // then a manual total.
        return `<tr>
          <td>${l.label}</td>
          <td colspan="2"><input class="cell" data-path="rental.${l.key}.desc" value="${esc(line.desc)}" placeholder="Description (e.g. signage, storage)" /></td>
          <td class="r"><input class="cell r" data-money data-recalc data-path="rental.${l.key}.total" value="${esc(line.total)}" placeholder="0.00" /></td>
        </tr>`;
      }
      return `<tr>
        <td>${l.label}</td>
        <td>${l.unit ? `<input class="cell" data-recalc data-path="rental.${l.key}.qty" value="${esc(line.qty)}" placeholder="${l.unit}" />` : ""}</td>
        <td>${l.rateLabel ? `<input class="cell" data-money data-recalc data-path="rental.${l.key}.rate" value="${esc(line.rate)}" placeholder="${l.rateLabel}" />` : ""}</td>
        <td class="r"><input class="cell r" data-money data-recalc data-path="rental.${l.key}.total" value="${esc(line.total)}" placeholder="${showCalc || "0.00"}" /></td>
      </tr>`;
    }).join("");

    // Split dropdowns offer only the brokers chosen in section 1.
    const dealBrokers = BROKERS.filter((b) => f.ownership.salespeople.includes(b.code));
    const splitRows = f.splits.map((s,i) => `<tr>
      <td><select class="cell" data-path="splits.${i}.person">
        <option value="">${dealBrokers.length?"Select…":"Add salespeople in section 1"}</option>
        ${dealBrokers.map((b) => `<option value="${esc(b.name)}" ${s.person===b.name?"selected":""}>${esc(b.name)}</option>`).join("")}
        </select></td>
      <td><input class="cell" data-recalc data-path="splits.${i}.pct" value="${esc(s.pct)}" placeholder="%" ${num(s.fixed)>0?"disabled":""} /></td>
      <td><input class="cell r" data-money data-recalc data-path="splits.${i}.fixed" value="${esc(s.fixed)}" placeholder="fixed $" /></td>
      <td class="r mono" id="splitAmt${i}">${(num(s.fixed)||num(s.pct))?fmt(d.tpAmount(s,d.internalPool)):"—"}</td></tr>`).join("");

    const tpRows = f.thirdParty.map((s,i) => `<tr>
      <td><input class="cell" data-path="thirdParty.${i}.name" value="${esc(s.name)}" placeholder="Company / office" /></td>
      <td><input class="cell" data-recalc data-path="thirdParty.${i}.pct" value="${esc(s.pct)}" placeholder="%" ${num(s.fixed)>0?"disabled":""} /></td>
      <td><input class="cell r" data-money data-recalc data-path="thirdParty.${i}.fixed" value="${esc(s.fixed)}" placeholder="fixed $" /></td>
      <td class="r mono" id="tpAmt${i}">${(num(s.fixed)||num(s.pct))?fmt(d.tpAmount(s,d.commissionBase)):"—"}</td></tr>`).join("");

    $("app").innerHTML = `
      <header class="top">
        <div class="brand"><span class="brandMark">SIC</span>
          <div><h1>Deal Sheet — Leasing Record</h1><p>South Island Commercial (2004) Limited · Colliers</p></div></div>
        <div style="text-align:right">
          <a href="admin.html" class="linkBtn" style="display:inline-block;margin-bottom:8px">← All deal sheets</a>
          <div class="accountsBox"><span class="tag">Completed by accounts</span>
          <div class="acctFields"><label><span>Deal No.</span><input disabled placeholder="—" /></label></div></div>
        </div>
      </header>
      <p class="mandate">Complete <strong>all</strong> categories for commission to be paid promptly.</p>
      ${state.returnNote ? `<div class="warnBanner"><strong>Returned by accounts.</strong> ${esc(state.returnNote.replace(/^Returned to broker:\s*/, ""))}</div>` : ""}
      ${state.triedSubmit && missing.length ? `<div class="warnBanner"><strong>Not ready to send.</strong> Outstanding: ${missing.map(esc).join(" · ")}</div>` : ""}

      <div class="layout">
        <div class="col">
          ${section("1","Deal ownership","Select every broker on this deal.",`
            <div class="brokerPick">
              <span class="lbl">Salesperson<em class="req">*</em>
                <span class="dim">${f.ownership.salespeople.length} selected</span></span>
              <div class="brokerGrid">${brokerChips}</div>
            </div>
            <div class="grid" style="margin-top:12px">
              ${sel("ownership.division","Division",DIVISIONS)}
              ${txt("ownership.office","Office")}</div>`)}

          ${section("2","Property details","",`
            <div class="grid">
              ${txt("property.address","Address",{span:3,req:true,ph:"e.g. Unit 2, 14 Leeds Street, Hornby"})}
              ${txt("property.buildingName","Building name",{span:2})}${txt("property.level","Level")}
              ${txt("property.unit","Unit")}${txt("property.city","City")}
              ${txt("property.propertyType","Property type",{ph:"e.g. Warehouse"})}</div>`)}

          ${section("3","Landlord","",party("lessor",true,true) +
            `<div class="grid" style="margin-top:10px">${txt("lessor.parentCompany","Landlord parent company",{span:3})}</div>`)}

          ${section("4","Tenant","",party("lessee",true,true) +
            `<div style="margin-top:10px">${chk("invoiceToLessee","Raise the invoice to the Tenant")}</div>`)}

          ${section("5","Billing entity","Legal entity for invoicing. Leave unticked if the same as the Landlord.",`
            ${chk("billingDifferent","Billing entity differs from the Landlord")}
            ${f.billingDifferent ? party("billing",false,false) : ""}`)}

          ${section("6","Lease details","",`
            <div class="grid">
              ${txt("lease.dateOfAgreement","Date of agreement",{type:"date",req:true})}
              ${txt("lease.unconditionalDate","Unconditional date",{type:"date"})}
              ${txt("lease.occupancyDate","Occupancy date",{type:"date"})}
              ${txt("lease.termYears","Lease term (years)",{req:true,ph:"e.g. 6"})}
              ${txt("lease.rorTimes","Rights of renewal (number)",{ph:"e.g. 2"})}
              ${txt("lease.rorYears","ROR term each (years)",{ph:"e.g. 3"})}
              ${txt("lease.commencementDate","Commencement date",{type:"date",req:true})}
              ${txt("lease.expiryDate","Expiry date",{type:"date"})}
              ${txt("lease.rentReviewPeriod","Rent review period",{ph:"e.g. 2 yearly"})}
              ${sel("lease.dealType","Deal type",DEAL_TYPES)}
              ${sel("lease.leaseBasis","Lease basis",["Net","Gross","Vacant"])}
              ${txt("lease.incentives","Incentives",{span:3,ph:"e.g. 3 months rent free"})}</div>`)}

          ${section("7","Trust deposit","Complete only if a deposit is paid into the Colliers trust account.",`
            ${chk("depositToTrust","A deposit will be paid into the trust account")}
            ${f.depositToTrust ? `<div class="grid" style="margin-top:10px">
                ${txt("deposit.amount","Deposit amount (inc GST)",{ph:"e.g. $5,000 inc GST",money:true})}${txt("deposit.dateReceived","Date received",{type:"date"})}
                ${txt("deposit.receiptNo","Trust receipt no.")}</div>
                <div class="authRow" style="margin-top:8px">${chk("deposit.earlyRelease","Early release required")}
                ${f.deposit.earlyRelease?`<div class="authGrid"><span class="authLbl">Authorisation forms</span>
                  ${chk("deposit.lessorAuthSent","Landlord — sent")}${chk("deposit.lessorAuthReceived","Landlord — received")}
                  ${chk("deposit.lesseeAuthSent","Tenant — sent")}${chk("deposit.lesseeAuthReceived","Tenant — received")}</div>`:""}</div>` : ""}`)}

          ${section("8","Rental schedule","Line totals calculate from area × rate — overtype any total to set it manually. The Net and Gross totals are also editable. Carpark rate is per park per week.",`
            <table class="tbl rentalTbl">
              <thead><tr><th></th><th>Area / Number</th><th>Net rental rate</th><th class="r">Total rental $</th></tr></thead>
              <tbody>${rentalRows}</tbody>
              <tfoot>
                <tr class="sub"><td colspan="3">Total Net Rental (excl GST)</td>
                  <td class="r"><input class="cell r mono" data-money data-recalc data-path="rentalOverride.net" value="${f.rentalOverride.net!==""?esc(f.rentalOverride.net):fmt(d.calcNet)}" placeholder="0.00" id="netRentalCell" /></td></tr>
                <tr><td colspan="3">Plus Opex</td><td class="r"><input class="cell r" data-money data-recalc data-path="rental.opex" value="${esc(f.rental.opex)}" placeholder="0.00" /></td></tr>
                <tr class="total"><td colspan="3">Total Gross Rental (excl GST) p.a.</td>
                  <td class="r"><input class="cell r mono" data-money data-recalc data-path="rentalOverride.gross" value="${f.rentalOverride.gross!==""?esc(f.rentalOverride.gross):fmt(d.calcGross)}" placeholder="0.00" id="grossRentalCell" /></td></tr>
              </tfoot></table>
              ${f.rentalOverride.net!==""||f.rentalOverride.gross!==""?`<p class="note" style="margin-top:6px">Manual total in use. Calculated: net $${fmt(d.calcNet)}, gross $${fmt(d.calcGross)}. Clear the field to revert.</p>`:""}`)}

          ${section("9","Commission calculation","Enter the commission amounts directly.",`
            <table class="tbl"><thead><tr><th>Item</th><th>Description</th><th class="r">Amount $</th></tr></thead>
              <tbody>
                <tr><td>Commission (per scale of fees)</td>
                  <td><input class="cell" data-path="comm.feeDesc" value="${esc(f.comm.feeDesc)}" placeholder="Description (optional)" /></td>
                  <td class="r"><input class="cell r" data-money data-recalc data-path="comm.fee" value="${esc(f.comm.fee)}" placeholder="0.00" /></td></tr>
                <tr><td>Other / consultancy</td>
                  <td><input class="cell" data-path="comm.otherDesc" value="${esc(f.comm.otherDesc)}" placeholder="Please specify" /></td>
                  <td class="r"><input class="cell r" data-money data-recalc data-path="comm.otherFee" value="${esc(f.comm.otherFee)}" placeholder="0.00" /></td></tr>
                <tr><td colspan="2"><div class="feeRow">
                  <label class="chk"><input type="checkbox" id="feeAdmin" ${f.comm.adminFee?"checked":""} /><span>Administration fee ($500)</span></label>
                  </div></td><td class="r mono" id="adminFeeCell">${fmt(d.adminFee)}</td></tr>
                <tr><td>Recover marketing costs</td>
                  <td><input class="cell" data-path="comm.recoverMarketingDesc" value="${esc(f.comm.recoverMarketingDesc)}" placeholder="Description (optional)" /></td>
                  <td class="r"><input class="cell r" data-money data-recalc data-path="comm.recoverMarketing" value="${esc(f.comm.recoverMarketing)}" placeholder="0.00" /></td></tr>
                <tr><td>Recover other costs</td>
                  <td><input class="cell" data-path="comm.recoverOtherDesc" value="${esc(f.comm.recoverOtherDesc)}" placeholder="Please specify" /></td>
                  <td class="r"><input class="cell r" data-money data-recalc data-path="comm.recoverOther" value="${esc(f.comm.recoverOther)}" placeholder="0.00" /></td></tr>
                <tr class="total"><td colspan="2">Total amount to be invoiced (excl GST)</td><td class="r mono" id="totalInvoiceCell">${fmt(d.totalInvoice)}</td></tr>
              </tbody></table>`)}

          ${section("10","Commission split","Third parties take a percentage of the commission (excluding the administration fee), or a fixed dollar amount. Salespeople then split what remains.",`
            <h3 class="subHead">Third party / other office <span class="dim">(conjunctional / referral — % of commission, or a fixed $)</span></h3>
            <table class="tbl"><thead><tr><th>Company / office</th><th>%</th><th class="r">Fixed $</th><th class="r">Amount $</th></tr></thead><tbody>${tpRows}</tbody></table>
            <div class="poolNote" id="poolNote" ${d.thirdPartyTotal?"":'style="display:none"'}>${d.thirdPartyTotal?`Third party share: <b>$${fmt(d.thirdPartyTotal)}</b> of $${fmt(d.commissionBase)} commission`:""}</div>
            <h3 class="subHead">Salespeople <span class="dim">(split the remaining $<span id="internalPoolLbl">${fmt(d.internalPool)}</span>)</span></h3>
            <table class="tbl"><thead><tr><th>Salesperson</th><th>%</th><th class="r">Fixed $</th><th class="r">Amount $</th></tr></thead><tbody>${splitRows}</tbody></table>
            <div class="splitStatus ${d.internalOk?"ok":"bad"}" id="splitStatus">${splitStatusText(d)}</div>`)}

          ${section("11","Tenant source","",`
            <div class="grid">
              ${sel("tenantSource","Tenant source",["Advert","Sign","Website","Relationship","Moving Times","Canvassing","Referral","Other"],2)}
              ${f.tenantSource==="Referral" ? txt("tenantReferralWho","Referral from") : ""}
              ${f.tenantSource==="Other" ? txt("tenantSourceOther","Please specify") : ""}</div>`)}

          ${section("12","Mandatory checklist","The invoice will not be raised until every relevant box is ticked.",`
            <div class="checkRow">${chk("checklist.agencyAgreement","Signed agency agreement attached")}${uploadSlot("agencyAgreement","")}</div>
            <div class="checkRow">${chk("checklist.unconditionalConfirmation","Confirmation of unconditional attached")}${uploadSlot("unconditionalConfirmation","")}</div>
            <div class="checkRow">${chk("checklist.leaseValueConfirmation","Confirmation of lease value")}${uploadSlot("leaseValueConfirmation","e.g. schedule from the lease agreement")}</div>
            <div class="checkRow">${chk("checklist.amlComplete","AML complete")}${uploadSlot("amlComplete","")}</div>
            <div class="checkRow">${chk("checklist.leaseDeed","Lease deed attached")}${uploadSlot("leaseDeed","")}</div>
            ${f.depositToTrust ? `<div class="checkRow">${chk("checklist.appraisals","Appraisals (trust deals) (optional)")}${uploadSlot("appraisals","")}</div>` : ""}`)}

          ${section("13","Other Documents","Not mandatory — attach anything else useful for the file. Available while this deal sheet is still a draft.",`
            <div class="checkRow">${chk("checklist.marketingReport","Marketing campaign report attached (optional)")}${uploadSlot("marketingReport","")}</div>
            <div class="checkRow">${chk("checklist.executedAgreement","Executed lease agreement attached (optional)")}${uploadSlot("executedAgreement","")}</div>
            <h3 class="subHead" style="margin-top:14px">Any other document</h3>
            ${extraAttachmentsList()}
            ${state.dealStatus === "draft" ? `<div class="extraUpload">
              <input id="extraDesc" placeholder="Description for the file (required)" />
              <label class="upBtn">Choose file<input type="file" id="extraFile" hidden /></label>
              <span id="extraFileName" class="dim"></span>
              <button id="extraUploadBtn" class="miniBtn" type="button" disabled>Add document</button>
              <span id="extraUploadStatus" class="miniStatus"></span>
            </div>` : `<p class="note">Other documents can only be added while this deal sheet is a draft.</p>`}`)}

          ${section("14","Sign-off","",`<div class="grid">
            <label class="fld span2"><span class="lbl">Prepared by</span>
              <input disabled value="${esc(state.userName || "")}" /></label>
            <label class="fld"><span class="lbl">Date</span><input disabled value="${new Date().toLocaleDateString("en-NZ")}" /></label></div>
            <div class="confidentialRow" style="margin-top:12px">
              ${chk("confidential","Confidential / Private Sale (exclude from PropCMA)")}
              <p class="note" style="margin-top:4px">When ticked, this deal will <strong>not</strong> be written to PropCMA comparables or the Excel sheet when invoiced.</p></div>
            <p class="note" style="margin-top:8px">Manager approval to pay commission is completed by accounts / management after submission.</p>`)}
        </div>

        <aside class="rail">
          <div class="railCard">
            <h3>Summary</h3>
            <dl class="railList">
              <div><dt>Net rental p.a.</dt><dd>$${fmt(d.netRental)}</dd></div>
              <div><dt>Gross rental p.a.</dt><dd>$${fmt(d.grossRental)}</dd></div>
              <div><dt>Total area</dt><dd>${d.totalArea ? fmt(d.totalArea)+" m²" : "—"}</dd></div>
              <div><dt>To invoice</dt><dd>$${fmt(d.totalInvoice)}</dd></div>
              ${f.depositToTrust ? `<div><dt>Deposit</dt><dd>$${fmt(d.depositAmount)}</dd></div>` : ""}
              <div><dt>Salesperson split</dt><dd class="${!d.internalOk?"bad":""}">${d.internalPaid?"$"+fmt(d.internalPaid):"—"}</dd></div>
            </dl>
            <div class="depositWarn ${d.depositShort?"":"hidden"}" id="depositWarn">Deposit is <b>$${fmt(d.depositGap)}</b> short of the $${fmt(d.totalInvoice)} to invoice</div>
            <div class="railStatus ${missing.length?"":"ok"}">${missing.length?`${missing.length} item${missing.length===1?"":"s"} outstanding`:"Ready to send"}</div>
            <button class="primary" id="sendBtn">Send to accounts</button>
            <button class="ghostLight" id="printBtn">Print / Save as PDF</button>
            <div class="saveState" id="saveState">${esc(saveState)}</div>
          </div>
        </aside>
      </div>`;

    wire();
  }

  // ---------- events ----------
  function wire() {
    $("app").querySelectorAll("[data-path]").forEach((el) => {
      const path = el.dataset.path;
      if (el.type === "checkbox") {
        el.onchange = () => { set(path, el.checked); scheduleAutosave(); render(); };
      } else if (el.tagName === "SELECT") {
        el.onchange = () => { set(path, el.value); scheduleAutosave(); render(); };
      } else if (el.hasAttribute("data-recalc")) {
        el.oninput = () => {
          if (el.hasAttribute("data-money")) formatMoneyLive(el);
          set(path, el.value); scheduleAutosave(); refreshDerived();
        };
        // Money fields (right-aligned) reformat with thousands separators
        // when the user leaves the field — not while typing, to avoid
        // cursor jumps. Net/gross override fields are handled separately.
        if (el.classList.contains("r") && !["netRentalCell","grossRentalCell"].includes(el.id)) {
          el.onblur = () => {
            const v = num(el.value);
            if (v) { el.value = fmt(v); }
          };
        }
      } else {
        el.oninput = () => {
          if (el.hasAttribute("data-money")) formatMoneyLive(el);
          set(path, el.value); scheduleAutosave();
        };
      }
    });

    $("app").querySelectorAll(".brokerBox").forEach((box) => {
      box.onchange = () => {
        const code = box.value;
        const list = state.f.ownership.salespeople;
        if (box.checked) {
          if (!list.includes(code)) list.push(code);
        } else {
          state.f.ownership.salespeople = list.filter((c) => c !== code);
          // Clear any split row assigned to a broker no longer on the deal.
          const name = (BROKERS.find((b) => b.code === code) || {}).name;
          state.f.splits.forEach((s) => { if (s.person === name) s.person = ""; });
        }
        scheduleAutosave();
        render();
      };
    });

    const feeAdmin = $("feeAdmin");
    if (feeAdmin) feeAdmin.onchange = () => { state.f.comm.adminFee = feeAdmin.checked; scheduleAutosave(); render(); };

    $("sendBtn").onclick = onSend;
    const pb = $("printBtn");
    if (pb) pb.onclick = doPrint;

    wireUploads();
  }

  // Re-render just the calculated figures, so typing isn't interrupted.
  // This must update BOTH the summary rail and the totals sitting inside
  // the rental / commission tables — those are where the user is looking.
  function refreshDerived() {
    const d = derive();

    // --- rental table: per-line totals (shown as the input's placeholder
    //     when the user hasn't typed an explicit total) ---
    RENTAL_LINES.forEach((l) => {
      const el = $("app").querySelector(`[data-path="rental.${l.key}.total"]`);
      if (el && document.activeElement !== el) {
        el.placeholder = d.lineTotals[l.key] ? fmt(d.lineTotals[l.key]) : "0.00";
      }
    });
    // Net/gross show the calculated figure (comma-formatted) unless the
    // user has typed a manual override or is currently editing the field.
    const netEl = $("netRentalCell"), grossEl = $("grossRentalCell");
    if (netEl && document.activeElement !== netEl && state.f.rentalOverride.net === "")
      netEl.value = fmt(d.calcNet);
    if (grossEl && document.activeElement !== grossEl && state.f.rentalOverride.gross === "")
      grossEl.value = fmt(d.calcGross);

    const setText = (sel, val) => {
      const el = $("app").querySelector(sel);
      if (el) el.textContent = val;
    };
    setText("#adminFeeCell", fmt(d.adminFee));
    setText("#totalInvoiceCell", fmt(d.totalInvoice));

    // --- split tables: per-row amounts, disable % when fixed is set ---
    state.f.splits.forEach((s, i) => {
      setText(`#splitAmt${i}`, (num(s.fixed) || num(s.pct)) ? fmt(d.tpAmount(s, d.internalPool)) : "—");
      const pctEl = $("app").querySelector(`[data-path="splits.${i}.pct"]`);
      if (pctEl) pctEl.disabled = num(s.fixed) > 0;
    });
    state.f.thirdParty.forEach((s, i) => {
      setText(`#tpAmt${i}`, (num(s.fixed) || num(s.pct)) ? fmt(d.tpAmount(s, d.commissionBase)) : "—");
      const pctEl = $("app").querySelector(`[data-path="thirdParty.${i}.pct"]`);
      if (pctEl) pctEl.disabled = num(s.fixed) > 0;
    });
    setText("#internalPoolLbl", fmt(d.internalPool));
    const poolNote = $("app").querySelector("#poolNote");
    if (poolNote) {
      poolNote.innerHTML = d.thirdPartyTotal
        ? `Third party share: <b>$${fmt(d.thirdPartyTotal)}</b> of $${fmt(d.commissionBase)} commission`
        : "";
      poolNote.style.display = d.thirdPartyTotal ? "" : "none";
    }
    const ss = $("app").querySelector("#splitStatus");
    if (ss) { ss.textContent = splitStatusText(d); ss.className = "splitStatus " + (d.internalOk ? "ok" : "bad"); }

    // #12 deposit shortfall warning
    const dw = $("app").querySelector("#depositWarn");
    if (dw) {
      dw.classList.toggle("hidden", !d.depositShort);
      if (d.depositShort) dw.innerHTML = `Deposit is <b>$${fmt(d.depositGap)}</b> short of the $${fmt(d.totalInvoice)} to invoice`;
    }

    // --- summary rail ---
    const dds = $("app").querySelectorAll(".railList dd");
    if (dds[0]) dds[0].textContent = "$" + fmt(d.netRental);
    if (dds[1]) dds[1].textContent = "$" + fmt(d.grossRental);
    if (dds[2]) dds[2].textContent = d.totalArea ? fmt(d.totalArea) + " m²" : "—";
    if (dds[3]) dds[3].textContent = "$" + fmt(d.totalInvoice);
    // Deposit + split rows shift depending on whether the deposit row shows.
    const splitDd = $("app").querySelector(".railList div:last-child dd");
    if (splitDd) { splitDd.textContent = d.internalPaid ? "$" + fmt(d.internalPaid) : "—"; splitDd.className = !d.internalOk ? "bad" : ""; }
    if (state.f.depositToTrust && dds.length >= 6) dds[4].textContent = "$" + fmt(d.depositAmount);

    const missing = validate(d);
    const st = $("app").querySelector(".railStatus");
    if (st) {
      st.textContent = missing.length ? `${missing.length} item${missing.length === 1 ? "" : "s"} outstanding` : "Ready to send";
      st.className = "railStatus" + (missing.length ? "" : " ok");
    }
  }

  function wireUploads() {
    $("app").querySelectorAll(".upInput").forEach((input) => {
      input.onchange = async () => {
        const slot = input.dataset.slot, file = input.files[0];
        if (!file) return;
        if (!state.currentId) {
          try { const r = await api.saveDraft(state.f, null, "lease"); state.currentId = r.id; }
          catch (e) { alert("Couldn't start a draft to attach to: " + e.message); return; }
        }
        const prog = $("app").querySelector(`.upProgress[data-slot="${slot}"]`);
        if (prog) prog.classList.remove("hidden");
        try {
          const r = await api.uploadAttachment(state.currentId, slot, file);
          state.f.attachments[slot] = { name: r.file_name, path: r.storage_path, size: r.size_bytes };
          scheduleAutosave(); render();
        } catch (e) {
          alert("Upload failed: " + e.message);
          if (prog) prog.classList.add("hidden");
        }
      };
    });
    $("app").querySelectorAll(".upRemove").forEach((btn) => {
      btn.onclick = async () => {
        const slot = btn.dataset.slot;
        try { await api.removeAttachment(state.currentId, slot); } catch (e) { /* ignore */ }
        delete state.f.attachments[slot];
        scheduleAutosave(); render();
      };
    });

    // ---- Other Documents: free-form, description required, draft-only ----
    let pendingExtraFile = null;
    const descEl = $("extraDesc"), fileBtn = $("extraFile"),
          fileNameEl = $("extraFileName"), uploadBtn = $("extraUploadBtn"),
          statusEl = $("extraUploadStatus");
    const updateExtraReady = () => {
      if (uploadBtn) uploadBtn.disabled = !(pendingExtraFile && descEl && descEl.value.trim());
    };
    if (fileBtn) fileBtn.onchange = () => {
      pendingExtraFile = fileBtn.files[0] || null;
      if (fileNameEl) fileNameEl.textContent = pendingExtraFile ? pendingExtraFile.name : "";
      updateExtraReady();
    };
    if (descEl) descEl.oninput = updateExtraReady;
    if (uploadBtn) uploadBtn.onclick = async () => {
      const description = descEl.value.trim();
      if (!description || !pendingExtraFile) return;
      if (!state.currentId) {
        try { const r = await api.saveDraft(state.f, null, "lease"); state.currentId = r.id; }
        catch (e) { alert("Couldn't start a draft to attach to: " + e.message); return; }
      }
      uploadBtn.disabled = true;
      if (statusEl) statusEl.textContent = "Uploading…";
      try {
        const r = await api.uploadExtraAttachment(state.currentId, description, pendingExtraFile);
        state.f.extraAttachments = state.f.extraAttachments || [];
        state.f.extraAttachments.push({ slot: r.slot, description, name: r.name, size: r.size });
        scheduleAutosave(); render();
      } catch (e) {
        if (statusEl) statusEl.textContent = "Upload failed";
        uploadBtn.disabled = false;
        alert("Upload failed: " + e.message);
      }
    };
    $("app").querySelectorAll("[data-extra-remove]").forEach((btn) => {
      btn.onclick = async () => {
        const slot = btn.dataset.extraRemove;
        if (!confirm("Remove this document? This cannot be undone.")) return;
        btn.disabled = true; btn.textContent = "Removing…";
        try {
          await api.removeAttachment(state.currentId, slot);
          state.f.extraAttachments = (state.f.extraAttachments || []).filter((a) => a.slot !== slot);
          scheduleAutosave(); render();
        } catch (e) {
          alert("Could not remove: " + e.message);
          btn.disabled = false; btn.textContent = "Remove";
        }
      };
    });
  }

  // ---------- print ----------
  async function doPrint() {
    if (!state.currentId) {
      try { const r = await api.saveDraft(state.f, null, "lease"); state.currentId = r.id; }
      catch (e) { alert("Save the deal sheet before printing: " + e.message); return; }
    } else {
      try { await api.saveDraft(state.f, state.currentId, "lease"); } catch (e) { /* print anyway */ }
    }
    api.openPrint(state.currentId);
  }

  // ---------- submit ----------
  async function onSend() {
    state.triedSubmit = true;
    const d = derive();
    const missing = validate(d);
    if (missing.length) { render(); window.scrollTo({top:0,behavior:"smooth"}); return; }
    if (!confirm("Send this leasing deal sheet to accounts?")) return;
    try {
      clearTimeout(state.saveTimer);
      const r = await api.saveDraft(state.f, state.currentId, "lease");
      state.currentId = r.id;
      await api.submit(state.currentId);
      showDone();
    } catch (e) {
      alert("Could not send: " + e.message);
    }
  }

  function showDone() {
    const d = derive(), f = state.f;
    $("app").innerHTML = `<div class="done">
      <div class="doneMark">✓</div>
      <h1>Leasing deal sheet sent to accounts</h1>
      <p><strong>${esc(f.property.address||"—")}</strong> — gross rental $${fmt(d.grossRental)} p.a., total to invoice $${fmt(d.totalInvoice)} excl GST.</p>
      <p class="dim">Accounts will invoice the client, assign the Deal No., and process commission. You'll be copied on the confirmation.</p>
      <div class="doneBtns">
        <button class="primary" id="adminBtn">Return to deal sheets</button>
        <button class="ghost" id="againBtn">Start a new deal sheet</button>
      </div></div>`;
    $("againBtn").onclick = () => { location.href = "admin.html"; };
    $("adminBtn").onclick = () => { location.href = "admin.html"; };
  }

  // ---------- boot ----------
  (async function boot() {
    if (cfg.DEMO_MODE) $("demoBadge").classList.remove("hidden");
    try {
      const account = await window.DealSheetAuth.init();
      if (!account) return;
    } catch (e) {
      $("gate").innerHTML = `<div class="inner">Sign-in failed: ${esc(e.message)}</div>`;
      return;
    }
    state.userName = window.DealSheetAuth.account?.name
      || window.DealSheetAuth.account?.username || "";

    if (!cfg.DEMO_MODE) {
      try {
        await api.listMine();
        BROKERS = (await api.listBrokers()).map((b) => ({ code: b.code, name: b.first_name }));
      } catch (e) {
        if (e.status === 403) {
          $("gate").innerHTML = `<div class="inner gateMsg">
            <h2>Access not set up yet</h2>
            <p>${esc(e.message)}</p>
            <p class="dim">Send the Object ID above to your administrator.</p></div>`;
          return;
        }
      }
    }

    const urlId = new URLSearchParams(location.search).get("id");
    if (urlId && !cfg.DEMO_MODE) {
      try {
        const deal = await api.get(urlId);
        if (!["draft","rejected"].includes(deal.status)) {
          $("gate").innerHTML = `<div class="inner gateMsg"><h2>This deal sheet can't be edited</h2>
            <p>It's already with accounts (status: ${esc(deal.status)}).</p>
            <p class="dim"><a href="admin.html">Back to my deal sheets</a></p></div>`;
          return;
        }
        state.currentId = deal.id;
        state.dealStatus = deal.status;
        state.f = Object.assign(state.f, deal.form || {});
        state.returnNote = (deal.events || []).filter((e) => (e.note||"").startsWith("Returned to broker:")).pop()?.note || "";
      } catch (e) {
        $("gate").innerHTML = `<div class="inner gateMsg"><h2>Couldn't open that deal sheet</h2>
          <p>${esc(e.message)}</p><p class="dim"><a href="admin.html">Back to my deal sheets</a></p></div>`;
        return;
      }
    }

    if (cfg.DEMO_MODE && !BROKERS.length) {
      BROKERS = (await api.listBrokers()).map((b) => ({ code: b.code, name: b.first_name }));
      state.userName = "Demo Admin";
    }

    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    render();
  })();
})();
