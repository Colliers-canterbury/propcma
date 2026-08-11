// /public/js/form.js — Broker Deal Sheet (vanilla)
(function () {
  const cfg = window.DealSheetConfig;
  const api = window.DealSheetApi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return isNaN(n) ? 0 : n; };
  const fmt = (n) => n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  // Brokers are reference data loaded from the database (Settings tab
  // manages them). Populated during boot before the first render.
  let BROKERS = [];
  const TITLES = ["Freehold","Strata","Leasehold"];
  const BUYER = ["Advert","Sign","Website","Relationship","Target mailing","Referral","Canvassing","Other"];
  const LISTING = ["Referral","Canvassing","Relationship","Other"];

  const state = {
    currentId: null,
    saveTimer: null,
    userName: "",
    dealStatus: "draft", // a brand-new, never-saved sheet is implicitly a draft
    f: {
      ownership: { salespeople: [], division: "Industrial", office: "Christchurch" },
      property: { address:"", buildingName:"", propertyType:"", level:"", city:"Christchurch" },
      vendor: { name:"", phone:"", contactName:"", email:"", postalAddress:"", postcode:"", city:"", country:"NZ", fax:"", solicitorName:"", solicitorFirm:"", solicitorPhone:"", vendorGroup:"" },
      billingDifferent: false,
      billing: { name:"", phone:"", contactName:"", email:"", postalAddress:"", postcode:"", city:"", country:"NZ", fax:"" },
      invoicePurchaser: false,
      purchaser: { name:"", phone:"", contactName:"", email:"", postalAddress:"", postcode:"", city:"", country:"NZ", fax:"", solicitorName:"", solicitorFirm:"", solicitorPhone:"" },
      sale: { dateOfAgreement:"", unconditionalDate:"", salePrice:"", rentalBasis:"Net", rentalIncome:"", yieldManual:"", titleType:"Freehold", landArea:"", wale:"", tenancies:"", occupiedArea:"", auction:false, tenancySchedule:false },
      depositToTrust: false,
      deposit: { amount:"", dateReceived:"", receiptNo:"", earlyRelease:false, vendorAuthSent:false, vendorAuthReceived:false, purchaserAuthSent:false, purchaserAuthReceived:false },
      comm: { flatFee:false, flatFeeAmount:"", tiers:[{pct:"",base:""},{pct:"",base:""},{pct:"",base:""}], otherDesc:"", otherFee:"", adminFee:true, recoverMarketing:"", recoverOtherDesc:"", recoverOther:"" },
      splits: [ {person:"",pct:""},{person:"",pct:""},{person:"",pct:""},{person:"",pct:""},{person:"",pct:""} ],
      thirdParty: [ {name:"",pct:""},{name:"",pct:""},{name:"",pct:""} ],
      buyerSource:"", buyerSourceOther:"",
      listingSource:"", listingReferralWho:"", listingReferralInternal:"Yes", listingOther:"",
      checklist: { agencyAgreement:false, unconditionalConfirmation:false, salePriceConfirmation:false, marketingReport:false, amlComplete:false, spAgreement:false, executedAgreement:false },
      attachments: {},  // { slotKey: { name, path, size } } populated after upload
      extraAttachments: [], // "Other Documents" — free-form, description required, draft-only
    },
  };

  const get = (path) => path.split(".").reduce((o, k) => o?.[k], state.f);
  const set = (path, val) => {
    const keys = path.split("."); let o = state.f;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = val;
    scheduleAutosave();
    render();
  };

  // ---------- derived ----------
  // Commission model (Option B), mirrored server-side in api/_lib/deals.js:
  //  - Third parties take their % of the COMMISSION (excl. admin fee)
  //  - Salespeople split the REMAINDER (total invoiced less third-party $)
  function derive() {
    const f = state.f;
    const salePrice = num(f.sale.salePrice);
    const yieldCalc = salePrice > 0 && num(f.sale.rentalIncome) > 0 ? (num(f.sale.rentalIncome)/salePrice)*100 : 0;
    const yieldPct = f.sale.yieldManual !== "" ? num(f.sale.yieldManual) : yieldCalc;

    // Tiered commission: each tier's base auto-fills with whatever's
    // left of the sale price after the tiers above it, unless the user
    // has typed an explicit amount (which always wins). tierBases holds
    // the effective base shown/used per tier. Skipped entirely in Flat
    // Fee mode — the tiers aren't used, so nothing to compute.
    const tierBases = [];
    let remaining = salePrice;
    f.comm.tiers.forEach((t, i) => {
      const typed = t.base !== "" && t.base != null;
      const base = typed ? num(t.base) : Math.max(remaining, 0);
      tierBases[i] = base;
      remaining -= base;
    });
    const tierFees = f.comm.tiers.map((t,i) => (num(t.pct)/100) * tierBases[i]);
    // Flat Fee mode: a single typed dollar figure replaces the whole
    // tiered %-of-sale-price calculation.
    const commissionFee = f.comm.flatFee ? num(f.comm.flatFeeAmount) : tierFees.reduce((a,b)=>a+b,0);
    const adminFee = f.comm.adminFee ? 500 : 0;
    const recoverMarketing = num(f.comm.recoverMarketing);
    const recoverOther = num(f.comm.recoverOther);
    const totalInvoice = commissionFee + num(f.comm.otherFee) + adminFee
      + recoverMarketing + recoverOther;

    // commissionBase is the actual commission-earning amount — the admin
    // fee and cost recoveries are pass-throughs, not commission, so
    // neither third parties nor salespeople take a share of them.
    const commissionBase = totalInvoice - adminFee - recoverMarketing - recoverOther;
    const thirdPartyPctTotal = f.thirdParty.reduce((a,s)=>a+num(s.pct),0);
    const thirdPartyTotal = f.thirdParty.reduce((a,s)=>a + (num(s.pct)/100)*commissionBase, 0);
    // Salespeople DO split the admin fee between them (third parties
    // still don't) — added back in here, after the third-party share
    // is taken out of the pure commission.
    const internalPool = (commissionBase - thirdPartyTotal) + adminFee;
    const internalPctTotal = f.splits.reduce((a,s)=>a+num(s.pct),0);
    const internalOk = internalPctTotal === 0 || Math.abs(internalPctTotal-100) < 0.01;

    return { salePrice, yieldCalc, yieldPct, tierFees, tierBases, commissionFee, adminFee, totalInvoice,
             commissionBase, thirdPartyPctTotal, thirdPartyTotal, internalPool,
             internalPctTotal, internalOk };
  }

  function validate(d) {
    const f = state.f, m = [];
    if (!f.ownership.salespeople.length) m.push("Salesperson");
    if (!f.property.address || !f.property.address.trim()) m.push("Property address");
    if (!f.vendor.name) m.push("Vendor name");
    if (!f.sale.dateOfAgreement) m.push("Date of agreement");
    if (!f.sale.unconditionalDate) m.push("Unconditional date");
    if (!d.salePrice) m.push("Sale price");
    if (!d.totalInvoice) m.push("Commission calculation");
    // A tier with an amount typed but no percentage computes to $0 —
    // easy to do by mistake (typing the flat fee into the threshold
    // "base" box instead of setting a %), and the $500 admin fee alone
    // can make totalInvoice look non-zero even though the real
    // commission is $0. Only relevant when NOT using Flat Fee mode.
    if (f.comm.flatFee) {
      if (!num(f.comm.flatFeeAmount)) m.push("Flat fee amount");
    } else {
      f.comm.tiers.forEach((t, i) => {
        if (t.base !== "" && t.base != null && !num(t.pct)) {
          m.push(`Commission tier ${i+1} has an amount but no % — it will charge $0`);
        }
      });
    }
    if (d.salePrice > 0 && d.commissionBase <= 0) {
      m.push(f.comm.flatFee ? "Commission works out to $0 — check the flat fee amount"
                             : "Commission works out to $0 — check the tier percentages");
    }
    if (d.internalPctTotal === 0) m.push("Commission split");
    else if (!d.internalOk) m.push("Salesperson split must total 100%");
    if (d.thirdPartyPctTotal >= 100) m.push("Third-party share must be under 100%");
    if (!f.buyerSource) m.push("Buyer source");
    if (!f.listingSource) m.push("Listing source");
    if (!f.checklist.agencyAgreement) m.push("Checklist — signed agency agreement");
    if (!f.checklist.unconditionalConfirmation) m.push("Checklist — confirmation of unconditional");
    if (!f.checklist.executedAgreement) m.push("Checklist — executed sale & purchase agreement");
    if (!f.checklist.amlComplete) m.push("Checklist — AML complete");
    if (f.depositToTrust && !f.checklist.spAgreement) m.push("Checklist — S&P agreement (trust deal)");
    return m;
  }

  // ---------- autosave ----------
  let saveState = "";
  function scheduleAutosave() {
    clearTimeout(state.saveTimer);
    saveState = "Saving…"; updateSaveState();
    state.saveTimer = setTimeout(async () => {
      try {
        const r = await api.saveDraft(state.f, state.currentId);
        state.currentId = r.id;
        saveState = "Draft saved";
      } catch (e) { saveState = "Save failed — will retry"; }
      updateSaveState();
    }, 1500);
  }
  function updateSaveState() { const el = $("saveState"); if (el) el.textContent = saveState; }

  // ---------- small builders ----------
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
  const party = (base, solicitor) => `<div class="grid">
    ${txt(base+".name","Name",{span:2,req:base==="vendor"})}${txt(base+".phone","Phone")}
    ${txt(base+".contactName","Contact name",{span:2})}${txt(base+".email","Email",{type:"email"})}
    ${txt(base+".postalAddress","Postal address",{span:2})}${txt(base+".postcode","Postcode")}
    ${txt(base+".city","City")}${txt(base+".country","Country")}
    ${solicitor ? txt(base+".solicitorName","Solicitor")+txt(base+".solicitorFirm","Firm")+txt(base+".solicitorPhone","Solicitor phone") : ""}
  </div>`;
  const section = (n, title, note, inner) => `<section class="card"><header class="cardHead">
    <span class="secNo">${n}</span><div><h2>${title}</h2>${note?`<p class="note">${note}</p>`:""}</div></header>${inner}</section>`;

  // When yield isn't manually set, show the live calc as the input's placeholder.
  function yieldCalcPlaceholder(d) {
    return d.yieldCalc ? `auto: ${d.yieldCalc.toFixed(2)}` : "auto-calculated";
  }

  // File attachment slot: shows attach button, or the attached file with a remove option.
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

    const commRows = f.comm.flatFee
      ? `<tr><td>Commission (flat fee)</td><td colspan="2"></td>
          <td class="r"><input class="cell r" data-money data-recalc data-path="comm.flatFeeAmount" value="${esc(f.comm.flatFeeAmount)}" placeholder="0.00" /></td></tr>`
      : ["Commission","Second tier","Third tier"].map((label,i) => {
      const t = f.comm.tiers[i];
      const typed = t.base !== "" && t.base != null;
      // Show the typed amount, or the auto-calculated remainder for this
      // tier (only when there's something left to allocate).
      const shownBase = typed ? t.base
        : (d.tierBases[i] > 0 ? fmt(d.tierBases[i]) : "");
      return `<tr>
      <td>${label}</td>
      <td><input class="cell" data-recalc data-path="comm.tiers.${i}.pct" value="${esc(t.pct)}" placeholder="%" /></td>
      <td><input class="cell" data-money data-recalc data-path="comm.tiers.${i}.base" value="${esc(shownBase)}" placeholder="${i===0?"Sale price":"Remainder"}" /></td>
      <td class="r mono">${d.tierFees[i]?fmt(d.tierFees[i]):"—"}</td></tr>`;
    }).join("");

    // Section 9 split dropdowns offer only the brokers chosen in section 1
    const dealBrokers = BROKERS.filter((b) => f.ownership.salespeople.includes(b.code));
    const splitRows = f.splits.map((s,i) => `<tr>
      <td><select class="cell" data-path="splits.${i}.person">
        <option value="">${dealBrokers.length?"Select…":"Add salespeople in section 1"}</option>
        ${dealBrokers.map((b) => `<option value="${esc(b.name)}" ${s.person===b.name?"selected":""}>${esc(b.name)}</option>`).join("")}
        </select></td>
      <td><input class="cell" data-recalc data-path="splits.${i}.pct" value="${esc(s.pct)}" placeholder="%" /></td>
      <td class="r mono">${num(s.pct)?fmt((num(s.pct)/100)*d.internalPool):"—"}</td></tr>`).join("");
    const tpRows = f.thirdParty.map((s,i) => `<tr>
      <td><input class="cell" data-path="thirdParty.${i}.name" value="${esc(s.name)}" placeholder="Office / party" /></td>
      <td><input class="cell" data-recalc data-path="thirdParty.${i}.pct" value="${esc(s.pct)}" placeholder="%" /></td>
      <td class="r mono">${num(s.pct)?fmt((num(s.pct)/100)*d.commissionBase):"—"}</td></tr>`).join("");

    $("app").innerHTML = `
      <header class="top">
        <div class="brand"><span class="brandMark">SIC</span>
          <div><h1>Deal Sheet — Sales Record</h1><p>South Island Commercial (2004) Limited · Colliers</p></div></div>
        <div style="text-align:right">
          <a href="admin.html" class="linkBtn" style="display:inline-block;margin-bottom:8px">← All deal sheets</a>
          <div class="accountsBox"><span class="tag">Completed by accounts</span>
          <div class="acctFields"><label><span>Deal No.</span><input disabled placeholder="—" /></label></div></div>
        </div>
      </header>
      <p class="mandate">Complete <strong>all</strong> categories for commission to be paid promptly.
        Fields marked <em class="req">*</em> and the mandatory checklist must be complete before sending to accounts.</p>
      ${state.returnNote ? `<div class="warnBanner"><strong>Returned by accounts.</strong> ${esc(state.returnNote.replace(/^Returned to broker:\s*/, ""))}</div>` : ""}
      ${state.triedSubmit && missing.length ? `<div class="warnBanner"><strong>Not ready to send.</strong> Outstanding: ${missing.map(esc).join(" · ")}</div>` : ""}

      <div class="layout">
        <main>
          ${section("1","Deal ownership","Select every salesperson working this deal. Commission splits (section 9) can only be assigned to these people.",`
            <div class="grid">
              ${sel("ownership.division","Division",DIVISIONS)}${txt("ownership.office","Office")}
            </div>
            <div class="brokerPick">
              <span class="lbl">Salesperson<em class="req">*</em>
                <span class="dim">${f.ownership.salespeople.length} selected</span></span>
              <div class="brokerGrid">
                ${BROKERS.map((b) => `<label class="brokerChip ${f.ownership.salespeople.includes(b.code)?"on":""}">
                  <input type="checkbox" class="brokerBox" value="${b.code}" ${f.ownership.salespeople.includes(b.code)?"checked":""} />
                  <span>${esc(b.name)}</span></label>`).join("")}
              </div>
            </div>`)}

          ${section("2","Property details","",`
            <div class="grid">
              ${txt("property.address","Address",{span:3,req:true,ph:"e.g. 76 Columbia Ave, Hornby"})}
              ${txt("property.buildingName","Building name",{span:2})}${txt("property.propertyType","Property type")}
              ${txt("property.level","Level")}${txt("property.city","City",{span:2})}</div>`)}

          ${section("3","Vendor","",party("vendor",true)+`<div class="grid" style="margin-top:10px">${txt("vendor.vendorGroup","Vendor group",{ph:"Parent company / common name",span:3})}</div>`)}

          ${section("4","Billing entity","Legal entity for invoicing. Leave off if the same as the vendor.",
            chk("billingDifferent","Invoice a different legal entity to the vendor") + (f.billingDifferent?`<div style="margin-top:12px">${party("billing",false)}</div>`:""))}

          ${section("5","Purchaser","",
            chk("invoicePurchaser","Tick if the invoice needs to be raised to the purchaser") + `<div style="margin-top:12px">${party("purchaser",true)}</div>`)}

          ${section("6","Sale details","",`<div class="grid">
            ${txt("sale.dateOfAgreement","Date of agreement",{type:"date",req:true})}
            ${txt("sale.unconditionalDate","Unconditional date",{type:"date",req:true})}
            ${txt("sale.salePrice","Sale price (excl GST) $",{ph:"0.00",req:true,money:true})}
            ${sel("sale.rentalBasis","Rental basis",["Net","Gross","Vacant"])}
            ${f.sale.rentalBasis!=="Vacant" ? `${txt("sale.rentalIncome",(f.sale.rentalBasis)+" rental income $ p.a.",{money:true})}
            <label class="fld"><span class="lbl">${f.sale.rentalBasis} yield %</span>
              <input data-path="sale.yieldManual" value="${esc(f.sale.yieldManual)}" placeholder="${yieldCalcPlaceholder(d)}" /></label>` : ""}
            ${sel("sale.titleType","Title",TITLES)}${txt("sale.landArea","Land area (sqm)")}
            ${txt("sale.wale","WALE (Years)")}
            ${txt("sale.tenancies","No. of tenancies (incl. sub-tenancies)")}${txt("sale.occupiedArea","Occupied by area (sqm)")}</div>
            <div style="margin-top:10px">${chk("sale.auction","Sold at auction")}</div>
            <div style="margin-top:10px">${chk("sale.tenancySchedule","Tenancy schedule attached (if available)")}
              ${uploadSlot("tenancySchedule","optional — PDF or Excel")}</div>`)}

          ${section("7","Deposit — trust account","Complete if a deposit will be paid into the Colliers trust account.",
            chk("depositToTrust","Deposit paid into the trust account") + (f.depositToTrust?`
              <div class="grid" style="margin-top:12px">
                ${txt("deposit.amount","Deposit amount $",{money:true})}${txt("deposit.dateReceived","Date received",{type:"date"})}
                ${txt("deposit.receiptNo","Trust receipt no.")}</div>
              <div class="authRow">${chk("deposit.earlyRelease","Early release required")}
              ${f.deposit.earlyRelease?`<div class="authGrid"><span class="authLbl">Authorisation forms</span>
                ${chk("deposit.vendorAuthSent","Vendor — sent")}${chk("deposit.vendorAuthReceived","Vendor — received")}
                ${chk("deposit.purchaserAuthSent","Purchaser — sent")}${chk("deposit.purchaserAuthReceived","Purchaser — received")}</div>`:""}</div>`:""))}

          ${section("8","Commission calculation",f.comm.flatFee?"A single flat commission amount — the tiered % fields are hidden while this is on.":"Fees calculate automatically from the percentages you enter.",`
            <label class="chk flatFeeToggle"><input type="checkbox" id="flatFeeToggle" ${f.comm.flatFee?"checked":""} /><span>Flat Fee</span></label>
            <table class="tbl"><thead><tr><th>Tier</th><th>%</th><th>Of amount $</th><th class="r">Fee $</th></tr></thead>
            <tbody>${commRows}
              <tr><td>Other</td><td colspan="2"><input class="cell" data-path="comm.otherDesc" value="${esc(f.comm.otherDesc)}" placeholder="Please specify" /></td>
                <td class="r"><input class="cell r" data-money data-recalc data-path="comm.otherFee" value="${esc(f.comm.otherFee)}" placeholder="0.00" /></td></tr>
              <tr><td colspan="3"><div class="feeChoice">
                <label class="chk"><input type="checkbox" id="feeAdmin" ${f.comm.adminFee?"checked":""} /><span>Administration fee ($500)</span></label>
              </div></td><td class="r mono">${fmt(d.adminFee)}</td></tr>
              <tr><td>Recover marketing costs</td><td colspan="2"></td>
                <td class="r"><input class="cell r" data-money data-recalc data-path="comm.recoverMarketing" value="${esc(f.comm.recoverMarketing)}" placeholder="0.00" /></td></tr>
              <tr><td>Recover other costs</td><td colspan="2"><input class="cell" data-path="comm.recoverOtherDesc" value="${esc(f.comm.recoverOtherDesc)}" placeholder="Please specify" /></td>
                <td class="r"><input class="cell r" data-money data-recalc data-path="comm.recoverOther" value="${esc(f.comm.recoverOther)}" placeholder="0.00" /></td></tr>
            </tbody>
            <tfoot><tr><td colspan="3">Total amount to be invoiced (excl GST)</td><td class="r mono total">$${fmt(d.totalInvoice)}</td></tr></tfoot></table>`)}

          ${section("9","Commission split","Third parties take a percentage of the commission (excluding the administration fee). Salespeople then split what remains, which must total 100%.",`
            <h3 class="subHead">Third party / other office <span class="dim">(conjunctional / referral — % of commission)</span></h3>
            <table class="tbl"><tbody>${tpRows}</tbody></table>
            ${d.thirdPartyTotal ? `<div class="poolNote">Third party share: <b>$${fmt(d.thirdPartyTotal)}</b> of $${fmt(d.commissionBase)} commission</div>` : ""}
            <h3 class="subHead">Salespeople <span class="dim">(split the remaining $${fmt(d.internalPool)})</span></h3>
            <table class="tbl"><thead><tr><th>Salesperson</th><th>%</th><th class="r">Amount $</th></tr></thead><tbody>${splitRows}</tbody></table>
            <div class="splitStatus ${d.internalPctTotal===0?"":d.internalOk?"ok":"bad"}">Salesperson split: ${d.internalPctTotal.toFixed(2)}%${d.internalPctTotal!==0?(d.internalOk?" ✓":" — must equal 100%"):""}</div>`)}


          ${section("10","Buyer & listing source","",`<div class="grid">
            ${sel("buyerSource","Buyer source",BUYER)}${f.buyerSource==="Other"?txt("buyerSourceOther","Other — specify",{span:2}):""}</div>
            <div class="grid" style="margin-top:8px">${sel("listingSource","Listing source",LISTING)}
            ${f.listingSource==="Referral"?txt("listingReferralWho","Referral — who")+sel("listingReferralInternal","Internal referral",["Yes","No"]):""}
            ${f.listingSource==="Other"?txt("listingOther","Other — specify",{span:2}):""}</div>`)}

          ${section("11","Mandatory checklist","Tick each item. You may optionally attach the document — accounts can download it.",`<div class="checkStack">
            <div class="checkRow">${chk("checklist.agencyAgreement","Signed agency agreement attached")}${uploadSlot("agencyAgreement","")}</div>
            <div class="checkRow">${chk("checklist.unconditionalConfirmation","Confirmation of unconditional attached (from vendor or vendor's solicitor)")}${uploadSlot("unconditionalConfirmation","")}</div>
            <div class="checkRow">${chk("checklist.executedAgreement","Executed sale &amp; purchase agreement attached")}${uploadSlot("executedAgreement","")}</div>
            <div class="checkRow">${chk("checklist.amlComplete","AML complete")}${uploadSlot("amlComplete","")}</div>
            ${f.depositToTrust?`<div class="checkRow">${chk("checklist.spAgreement","Trust deal — sale and purchase agreement attached")}${uploadSlot("spAgreement","")}</div>`:""}</div>`)}

          ${section("12","Other Documents","Not mandatory — attach anything else useful for the file. Available while this deal sheet is still a draft.",`
            <div class="checkRow">${chk("checklist.marketingReport","Marketing campaign report attached (optional)")}${uploadSlot("marketingReport","")}</div>
            <div class="checkRow">${chk("checklist.salePriceConfirmation","Confirmation of sale price attached (e.g. first page of the S&amp;P agreement) (optional)")}${uploadSlot("salePriceConfirmation","")}</div>
            <h3 class="subHead" style="margin-top:14px">Any other document</h3>
            ${extraAttachmentsList()}
            ${state.dealStatus === "draft" ? `<div class="extraUpload">
              <input id="extraDesc" placeholder="Description for the file (required)" />
              <label class="upBtn">Choose file<input type="file" id="extraFile" hidden /></label>
              <span id="extraFileName" class="dim"></span>
              <button id="extraUploadBtn" class="miniBtn" type="button" disabled>Add document</button>
              <span id="extraUploadStatus" class="miniStatus"></span>
            </div>` : `<p class="note">Other documents can only be added while this deal sheet is a draft.</p>`}`)}

          ${section("13","Sign-off","",`<div class="grid">
            <label class="fld span2"><span class="lbl">Prepared by</span>
              <input disabled value="${esc(state.userName || "")}" /></label>
            <label class="fld"><span class="lbl">Date</span><input disabled value="${new Date().toLocaleDateString("en-NZ")}" /></label></div>
            <p class="note" style="margin-top:8px">Manager approval to pay commission is completed by accounts / management after submission.</p>`)}
        </main>

        <aside class="rail"><div class="railCard">
          <h3>Deal summary</h3>
          <dl>
            <div><dt>Property</dt><dd>${f.property.address?esc(f.property.address):"—"}</dd></div>
            <div><dt>Vendor</dt><dd>${esc(f.vendor.name||"—")}</dd></div>
            <div><dt>Sale price</dt><dd>${d.salePrice?"$"+fmt(d.salePrice):"—"}</dd></div>
            <div><dt>${f.sale.rentalBasis==="Vacant"?"Yield":f.sale.rentalBasis+" yield"}</dt><dd>${d.yieldPct?d.yieldPct.toFixed(2)+"%":"—"}</dd></div>
            <div class="hl"><dt>Total to invoice</dt><dd>$${fmt(d.totalInvoice)}</dd></div>
            <div><dt>Salesperson split</dt><dd class="${d.internalPctTotal&&!d.internalOk?"bad":""}">${d.internalPctTotal.toFixed(0)}%</dd></div>
          </dl>
          <div class="readiness">${missing.length===0?'<span class="ok">✓ Ready to send</span>':`${missing.length} item${missing.length===1?"":"s"} outstanding`}</div>
          <button class="primary" id="sendBtn">Send to accounts</button>
          <button class="ghostLight" id="printBtn">Print / Save as PDF</button>
          <div class="saveState" id="saveState">${saveState}</div>
          <p class="tiny">Sends the completed deal sheet to accounts for Deal No. assignment, invoicing and commission processing.</p>
        </div></aside>
      </div>

      <div class="overlay hidden" id="confirmModal"><div class="modal">
        <h3>Confirm and send to accounts</h3>
        <dl>
          <div><dt>Property</dt><dd>${esc(f.property.address||"—")}</dd></div>
          <div><dt>Vendor</dt><dd>${esc(f.vendor.name)}</dd></div>
          <div><dt>Sale price (excl GST)</dt><dd>$${fmt(d.salePrice)}</dd></div>
          <div><dt>Total to invoice (excl GST)</dt><dd>$${fmt(d.totalInvoice)}</dd></div>
          <div><dt>Prepared by</dt><dd>${esc(state.userName || "")}</dd></div>
        </dl>
        <p class="tiny">Once sent, changes must go through accounts. Check the figures above carefully.</p>
        <div class="modalBtns"><button class="ghost" id="cancelSend">Back to editing</button>
        <button class="primary" id="confirmSend">Confirm — send to accounts</button></div>
      </div></div>`;

    wire();
  }

  // ---------- event wiring (delegated where possible) ----------
  function wire() {
    $("app").querySelectorAll("[data-path]").forEach((el) => {
      const path = el.dataset.path;
      if (el.type === "checkbox") {
        el.onchange = () => set(path, el.checked);
      } else if (el.tagName === "SELECT" || el.type === "date") {
        // no typing caret to preserve — safe to re-render
        el.onchange = () => {
          if (path === "sale.rentalBasis" && el.value === "Vacant") {
            // Don't leave a stale rental figure sitting in the data once
            // the fields showing it are hidden.
            state.f.sale.rentalIncome = "";
            state.f.sale.yieldManual = "";
          }
          set(path, el.value);
        };
      } else {
        // text / textarea: update state + summary only, NEVER re-render
        // the form while typing (that was reversing text as the caret
        // jumped back to the start on each keystroke)
        el.oninput = () => {
          if (el.hasAttribute("data-money")) formatMoneyLive(el);
          setNoRender(path, el.value);
        };
        // numeric fields that drive table amounts recalc on blur
        if (el.hasAttribute("data-recalc")) el.onchange = () => set(path, el.value);
      }
    });

    const feeAdmin = $("feeAdmin");
    if (feeAdmin) feeAdmin.onchange = () => { state.f.comm.adminFee = feeAdmin.checked; scheduleAutosave(); render(); };

    const flatFeeToggle = $("flatFeeToggle");
    if (flatFeeToggle) flatFeeToggle.onchange = () => { state.f.comm.flatFee = flatFeeToggle.checked; scheduleAutosave(); render(); };

    // Broker multi-select
    $("app").querySelectorAll(".brokerBox").forEach((box) => {
      box.onchange = () => {
        const code = box.value;
        const list = state.f.ownership.salespeople;
        if (box.checked) {
          if (!list.includes(code)) list.push(code);
        } else {
          state.f.ownership.salespeople = list.filter((c) => c !== code);
          // clear any split row assigned to a broker no longer on the deal
          const name = (BROKERS.find((b) => b.code === code) || {}).name;
          state.f.splits.forEach((s) => { if (s.person === name) { s.person = ""; } });
        }
        scheduleAutosave();
        render();
      };
    });

    setupUploads();

    $("sendBtn").onclick = onSend;
    const pb2 = $("printBtn");
    if (pb2) pb2.onclick = doPrint;
    const cm = $("confirmModal");
    $("cancelSend").onclick = () => cm.classList.add("hidden");
    $("confirmSend").onclick = doSubmit;
    cm.onclick = (e) => { if (e.target === cm) cm.classList.add("hidden"); };
  }

  // Update value without touching the form DOM, so the caret stays put.
  // Only the summary rail's derived numbers refresh.
  function setNoRender(path, val) {
    const keys = path.split("."); let o = state.f;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = val;
    scheduleAutosave();
    updateSummary();
  }

  // Recompute and patch just the summary rail + readiness, in place.
  function updateSummary() {
    const d = derive();
    const missing = validate(d);
    const f = state.f;
    const rail = $("app").querySelector(".railCard");
    if (!rail) return;
    const dds = rail.querySelectorAll("dl dd");
    // order matches the summary dl below: property, vendor, sale price, yield, total, split
    if (dds[0]) dds[0].textContent = f.property.address || "—";
    if (dds[1]) dds[1].textContent = f.vendor.name || "—";
    if (dds[2]) dds[2].textContent = d.salePrice ? "$" + fmt(d.salePrice) : "—";
    if (dds[3]) dds[3].textContent = d.yieldPct ? d.yieldPct.toFixed(2) + "%" : "—";
    if (dds[4]) dds[4].textContent = "$" + fmt(d.totalInvoice);
    if (dds[5]) { dds[5].textContent = d.internalPctTotal.toFixed(0) + "%"; dds[5].className = d.internalPctTotal && !d.internalOk ? "bad" : ""; }
    const readiness = rail.querySelector(".readiness");
    if (readiness) readiness.innerHTML = missing.length === 0
      ? '<span class="ok">✓ Ready to send</span>'
      : `${missing.length} item${missing.length===1?"":"s"} outstanding`;
  }

  // ---------- file uploads ----------
  function setupUploads() {
    $("app").querySelectorAll(".upInput").forEach((inp) => {
      inp.onchange = async () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        const slot = inp.dataset.slot;
        await uploadFile(slot, file);
      };
    });
    $("app").querySelectorAll(".upRemove").forEach((btn) => {
      btn.onclick = async () => {
        const slot = btn.dataset.slot;
        try { await api.removeAttachment(state.currentId, slot); } catch (e) { /* ignore */ }
        delete state.f.attachments[slot];
        scheduleAutosave();
        render();
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
        try { const r = await api.saveDraft(state.f, null); state.currentId = r.id; }
        catch (e) { alert("Couldn't start a draft to attach to: " + e.message); return; }
      }
      uploadBtn.disabled = true;
      if (statusEl) statusEl.textContent = "Uploading…";
      try {
        const r = await api.uploadExtraAttachment(state.currentId, description, pendingExtraFile);
        state.f.extraAttachments = state.f.extraAttachments || [];
        state.f.extraAttachments.push({ slot: r.slot, description, name: r.name, size: r.size });
        scheduleAutosave();
        render();
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
          scheduleAutosave();
          render();
        } catch (e) {
          alert("Could not remove: " + e.message);
          btn.disabled = false; btn.textContent = "Remove";
        }
      };
    });
  }

  async function uploadFile(slot, file) {
    // ensure the deal has an id to attach to
    if (!state.currentId) {
      try { const r = await api.saveDraft(state.f, null); state.currentId = r.id; }
      catch (e) { alert("Couldn't start a draft to attach to: " + e.message); return; }
    }
    const prog = $("app").querySelector(`.upProgress[data-slot="${slot}"]`);
    if (prog) prog.classList.remove("hidden");
    try {
      const meta = await api.uploadAttachment(state.currentId, slot, file);
      state.f.attachments[slot] = { name: meta.name, path: meta.path, size: meta.size };
      scheduleAutosave();
      render();
    } catch (e) {
      if (prog) prog.classList.add("hidden");
      alert("Upload failed: " + e.message);
    }
  }

  function refreshDerivedOnly() {
    // lightweight: re-render fully but preserve focus
    const active = document.activeElement;
    const path = active?.dataset?.path;
    const selStart = active?.selectionStart, selEnd = active?.selectionEnd;
    render();
    if (path) {
      const again = $("app").querySelector(`[data-path="${CSS.escape(path)}"]`);
      if (again) { again.focus(); try { again.setSelectionRange(selStart, selEnd); } catch {} }
    }
  }

  // ---------- print ----------
  // Opens the server-rendered printable page, which calls window.print()
  // on load — the browser's own dialog produces the PDF.
  async function doPrint() {
    if (!state.currentId) {
      try { const r = await api.saveDraft(state.f, null); state.currentId = r.id; }
      catch (e) { alert("Save the deal sheet before printing: " + e.message); return; }
    } else {
      // flush any pending edits so the print reflects what's on screen
      try { await api.saveDraft(state.f, state.currentId); } catch (e) { /* print anyway */ }
    }
    api.openPrint(state.currentId);
  }

  // ---------- submit ----------
  function onSend() {
    const d = derive();
    const missing = validate(d);
    state.triedSubmit = true;
    if (missing.length) { window.scrollTo({ top: 0, behavior: "smooth" }); render(); return; }
    $("confirmModal").classList.remove("hidden");
  }

  async function doSubmit() {
    $("confirmSend").disabled = true;
    try {
      await api.saveDraft(state.f, state.currentId).then((r) => (state.currentId = r.id));
      await api.submit(state.currentId);
      showDone();
    } catch (e) {
      $("confirmModal").classList.add("hidden");
      state.triedSubmit = true;
      if (e.missing) { render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
      else alert("Could not send: " + e.message);
    } finally {
      const b = $("confirmSend"); if (b) b.disabled = false;
    }
  }

  function showDone() {
    const d = derive(), f = state.f;
    $("app").innerHTML = `<div class="done">
      <div class="doneMark">✓</div>
      <h1>Deal sheet sent to accounts</h1>
      <p><strong>${esc(f.property.address||"—")}</strong> — sale price $${fmt(d.salePrice)}, total to invoice $${fmt(d.totalInvoice)} excl GST.</p>
      <p class="dim">Accounts will invoice the client, assign the Deal No., and process commission. You'll be copied on the confirmation.</p>
      <div class="doneBtns">
        <button class="primary" id="adminBtn">Return to deal sheets</button>
        <button class="ghost" id="againBtn">Start a new deal sheet</button>
      </div></div>`;
    $("againBtn").onclick = () => { location.href = "deal-sheet.html"; };
    $("adminBtn").onclick = () => { location.href = "admin.html"; };
  }

  // ---------- boot ----------
  (async function boot() {
    if (cfg.DEMO_MODE) $("demoBadge").classList.remove("hidden");
    try {
      const account = await window.DealSheetAuth.init();
      if (!account) return; // redirecting to sign in
    } catch (e) {
      $("gate").innerHTML = `<div class="inner">Sign-in failed: ${esc(e.message)}</div>`;
      return;
    }
    state.userName = window.DealSheetAuth.account?.name
      || window.DealSheetAuth.account?.username || "";

    // Confirm the signed-in user is provisioned, and load the broker
    // reference list, before the first render.
    if (!cfg.DEMO_MODE) {
      try {
        await api.listMine();
        BROKERS = (await api.listBrokers()).map((b) => ({ code: b.code, name: b.first_name }));
      } catch (e) {
        if (e.status === 403) {
          $("gate").innerHTML = `<div class="inner gateMsg">
            <h2>Access not set up yet</h2>
            <p>${esc(e.message)}</p>
            <p class="dim">Send the Object ID above to your administrator — they'll add you to the Deal Sheet app.</p></div>`;
          return;
        }
        // other errors: let the form load; the action itself will report
      }
    }
    // Resume an existing draft / returned deal if ?id= is present
    const urlId = new URLSearchParams(location.search).get("id");
    if (urlId && !cfg.DEMO_MODE) {
      try {
        const deal = await api.get(urlId);
        if (!["draft", "rejected"].includes(deal.status)) {
          $("gate").innerHTML = `<div class="inner gateMsg"><h2>This deal sheet can't be edited</h2>
            <p>It's already with accounts (status: ${esc(deal.status)}). Contact accounts if it needs changing.</p>
            <p class="dim"><a href="admin.html">Back to my deal sheets</a></p></div>`;
          return;
        }
        state.currentId = deal.id;
        state.dealStatus = deal.status;
        state.f = Object.assign(state.f, deal.form || {});
        state.resumed = deal.status === "rejected";
        state.returnNote = (deal.events || []).filter((e) => (e.note || "").startsWith("Returned to broker:")).pop()?.note || "";
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
