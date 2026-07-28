// /public/js/accounts.js — Accounts Deal Sheet Processing (vanilla)
(function () {
  const cfg = window.DealSheetConfig;
  const api = window.DealSheetApi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtSize = (b) => { b = Number(b||0); return b < 1024 ? b+" B" : b < 1048576 ? (b/1024).toFixed(0)+" KB" : (b/1048576).toFixed(1)+" MB"; };

  const META = {
    submitted:  { label: "Submitted",  cls: "sub" },
    processing: { label: "Processing", cls: "proc" },
    invoiced:   { label: "Invoiced",   cls: "inv" },
    rejected:   { label: "Returned",   cls: "rej" },
  };

  const state = { tab: "queue", queue: [], completed: [], drafts: [], selectedId: null, deal: null,
    filter: "all", note: "", pendingNums: {},
    brokers: [], admins: [], userRole: "" };

  async function loadQueue() {
    state.queue = await api.getQueue();
    // Drafts are shown at the bottom of the "All" filter, so load them up
    // front. Non-fatal — if it fails the queue still renders.
    try { state.drafts = await api.getDrafts(); } catch (e) { state.drafts = []; }
    // Deep-link from the notification email: ?id=<dealId> preselects it.
    const linkedId = new URLSearchParams(location.search).get("id");
    if (linkedId && state.queue.some((d) => d.id === linkedId)) {
      state.selectedId = linkedId;
    }
    if (!state.selectedId && state.queue.length) state.selectedId = state.queue[0].id;
    if (state.selectedId) await loadDeal(state.selectedId);
    render();
  }
  async function loadDeal(id) {
    state.selectedId = id;
    state.deal = await api.get(id);
    state.pendingNums = { dealNo: state.deal.deal_no || "" };
    state.note = "";
  }

  function counts() {
    return Object.entries(META).map(([k, m]) => {
      const c = state.queue.filter((d) => d.status === k).length;
      return c ? `<span class="pill ${m.cls}">${c} ${m.label.toLowerCase()}</span>` : "";
    }).join("");
  }

  function checklistOf(deal) {
    const c = (deal.form && deal.form.checklist) || {};
    const isLease = deal.deal_type === "lease";
    const items = isLease
      ? [
          ["agencyAgreement", "Signed agency agreement"],
          ["unconditionalConfirmation", "Confirmation of unconditional"],
          ["leaseValueConfirmation", "Confirmation of lease value"],
          ["marketingReport", "Marketing campaign report"],
          ["amlComplete", "AML complete"],
          ["leaseDeed", "Lease deed"],
        ]
      : [
          ["agencyAgreement", "Signed agency agreement"],
          ["unconditionalConfirmation", "Confirmation of unconditional"],
          ["salePriceConfirmation", "Confirmation of sale price"],
          ["marketingReport", "Marketing campaign report"],
          ["amlComplete", "AML complete"],
        ];
    if (deal.deposit_to_trust) {
      items.push(isLease
        ? ["appraisals", "Appraisals (trust deal)"]
        : ["spAgreement", "S&P agreement (trust deal)"]);
    }
    return items.map(([k, label]) => ({ ok: !!c[k], label }));
  }

  function render() {
    const showingDrafts = state.filter === "drafts";
    const queueItems = state.queue.filter((d) => d.status !== "invoiced")
      .filter((d) => state.filter === "all" || d.status === state.filter);
    // "All" shows the active queue first, then drafts at the bottom.
    // "Drafts" shows only drafts.
    const shown = showingDrafts
      ? state.drafts
      : state.filter === "all"
        ? [...queueItems, ...state.drafts]
        : queueItems;

    $("app").innerHTML = `
      <header class="top">
        <div class="brand"><span class="brandMark">SIC</span>
          <div><h1>Deal Sheet Processing</h1><p>Accounts · South Island Commercial (2004) Limited</p></div></div>
        <div class="counts">${counts()}</div>
      </header>
      <div class="tabs">
        <button class="tab ${state.tab==="queue"?"on":""}" data-tab="queue">Queue${
          state.queue.filter((d)=>d.status!=="invoiced").length?`<span class="badge">${state.queue.filter((d)=>d.status!=="invoiced").length}</span>`:""}</button>
        <button class="tab ${state.tab==="completed"?"on":""}" data-tab="completed">Completed</button>
        <button class="tab ${state.tab==="settings"?"on":""}" data-tab="settings">Settings</button>
      </div>
      ${state.tab !== "queue" ? `<div id="tabBody"></div>` : `
      <div class="layout accounts">
        <aside class="queue">
          <div class="filters">
            ${["all","submitted","processing","rejected"].map((s) =>
              `<button class="fbtn ${state.filter===s?"on":""}" data-filter="${s}">${s==="all"?"All":META[s].label}</button>`).join("")}
            <button class="fbtn ${state.filter==="drafts"?"on":""}" data-filter="drafts">Drafts${state.drafts.length?` (${state.drafts.length})`:""}</button>
          </div>
          ${shown.map((d) => `<button class="row ${state.selectedId===d.id?"sel":""}" data-id="${d.id}">
            <div class="rowTop"><strong>${d.deal_type==="lease"?`<span class="typePill lease">Lease</span> `:""}${esc(d.property_address||"—")}</strong>
              <span class="pill ${(META[d.status]||{cls:"pillDraft"}).cls}">${(META[d.status]||{label:"Draft"}).label}</span></div>
            <div class="rowSub">${esc(d.salesperson||"")} · ${esc(d.division||"")} · $${fmt(d.total_invoice_ex_gst)} to invoice
              ${d.deposit_to_trust?'<span class="trustDot"> · TRUST</span>':""}
              ${d.confidential?'<span class="confDot"> · CONFIDENTIAL</span>':""}</div></button>`).join("")
            || `<p class="empty">${showingDrafts?"No drafts in progress.":"No deal sheets in this state."}</p>`}
        </aside>
        <main id="detail"></main>
      </div>`}`;

    $("app").querySelectorAll("[data-tab]").forEach((b) =>
      b.onclick = async () => {
        state.tab = b.dataset.tab;
        if (state.tab === "completed" && !state.completed.length) await loadCompleted();
        if (state.tab === "settings" && !state.brokers.length) await loadSettings();
        render();
      });

    if (state.tab === "queue") {
      $("app").querySelectorAll("[data-filter]").forEach((b) =>
        b.onclick = async () => {
          state.filter = b.dataset.filter;
          if (state.filter === "drafts" && !state.drafts.length) {
            try { state.drafts = await api.getDrafts(); } catch (e) { /* leave empty */ }
          }
          state.selectedId = null; state.deal = null;
          render();
        });
      $("app").querySelectorAll("[data-id]").forEach((b) =>
        b.onclick = async () => { await loadDeal(b.dataset.id); render(); });
      renderDetail();
    } else if (state.tab === "completed") {
      renderCompleted();
    } else {
      renderSettings();
    }
  }

  // ---------- completed ----------
  async function loadCompleted() {
    state.completed = await api.getQueue("invoiced");
  }

  function renderCompleted() {
    const rows = [...state.completed].sort((a, b) =>
      new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));
    $("tabBody").innerHTML = rows.length ? `
      <table class="compTable">
        <thead><tr><th>Property</th><th>Vendor</th><th>Salespeople</th>
          <th class="r">Invoiced</th><th>Deal no.</th><th>Date</th><th></th></tr></thead>
        <tbody>${rows.map((d) => `<tr>
          <td><strong>${esc(d.property_address || "—")}</strong></td>
          <td>${esc(d.vendor_name || "—")}</td>
          <td>${esc(d.salesperson || "—")}</td>
          <td class="r mono">$${fmt(d.total_invoice_ex_gst)}</td>
          <td>${esc(d.deal_no || "—")}</td>
          <td>${d.submitted_at ? new Date(d.submitted_at).toLocaleDateString("en-NZ",{day:"2-digit",month:"short",year:"numeric"}) : "—"}</td>
          <td class="r"><button class="linkBtn" data-print="${d.id}">Print</button></td>
        </tr>`).join("")}</tbody></table>`
      : `<p class="empty">No completed deals yet.</p>`;
    $("tabBody").querySelectorAll("[data-print]").forEach((b) =>
      b.onclick = () => api.openPrint(b.dataset.print));
  }

  // ---------- settings ----------
  async function loadSettings() {
    [state.brokers, state.admins] = await Promise.all([
      api.listAllBrokers(), api.listAdmins(),
    ]);
  }

  function renderSettings() {
    $("tabBody").innerHTML = `<div class="setGrid">
      <div class="setCard">
        <h3>Brokers</h3>
        <p class="note">Selectable on deal sheets and CC'd when a deal is sent to accounts.
          Brokers don't sign in — Office Administrators file on their behalf.</p>
        ${state.brokers.map((b) => `<div class="setRow ${b.active?"":"inactive"}">
          <span class="nm">${esc(b.first_name)} <span class="dim">(${esc(b.code)})</span></span>
          <span class="em">${esc(b.email || "no email — won't be CC'd")}</span>
          ${b.active ? `<button data-rmb="${esc(b.code)}">Remove</button>` : `<span class="rl">removed</span>`}
        </div>`).join("") || `<p class="empty">No brokers yet.</p>`}
        <div class="addForm">
          <input id="bCode" placeholder="Code (e.g. OS)" maxlength="4" style="max-width:110px" />
          <input id="bName" placeholder="First name" />
          <input id="bEmail" placeholder="Email" type="email" />
          <button id="bAdd">Add / update</button>
        </div>
      </div>

      <div class="setCard">
        <h3>Office administrators &amp; accounts</h3>
        <p class="note">People who can sign in. Office administrators file deal sheets;
          accounts and managers process them and manage these settings.</p>
        ${state.admins.map((a) => `<div class="setRow ${a.active?"":"inactive"}">
          <span class="nm">${esc(a.display_name || "—")}</span>
          <span class="em">${esc(a.email || "")}</span>
          <span class="rl">${esc(a.role.replace("_"," "))}</span>
          ${a.active ? `<button data-rma="${esc(a.oid)}">Remove</button>` : `<span class="rl">removed</span>`}
        </div>`).join("") || `<p class="empty">None yet.</p>`}
        <div class="addForm">
          <input id="aOid" placeholder="Entra Object ID" />
          <input id="aName" placeholder="Full name" />
          <input id="aEmail" placeholder="Email" type="email" />
          <select id="aRole">
            <option value="office_admin">Office administrator</option>
            <option value="accounts">Accounts</option>
            <option value="manager">Manager</option>
          </select>
          <button id="aAdd">Add / update</button>
        </div>
        <p class="tiny">The Object ID comes from Entra ID (Users → select person → Object ID),
          or from the "Access not set up yet" message they see when they first sign in.</p>
      </div>
    </div>`;

    $("bAdd").onclick = async () => {
      const code = $("bCode").value.trim(), firstName = $("bName").value.trim();
      if (!code || !firstName) return alert("Code and first name are required.");
      try { await api.saveBroker({ code, firstName, email: $("bEmail").value.trim() });
        await loadSettings(); render(); } catch (e) { alert("Couldn't save: " + e.message); }
    };
    $("aAdd").onclick = async () => {
      const oid = $("aOid").value.trim();
      if (!oid) return alert("Object ID is required.");
      try { await api.saveAdmin({ oid, displayName: $("aName").value.trim(),
          email: $("aEmail").value.trim(), role: $("aRole").value });
        await loadSettings(); render(); } catch (e) { alert("Couldn't save: " + e.message); }
    };
    $("tabBody").querySelectorAll("[data-rmb]").forEach((b) => b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.rmb} from the broker list? Past deal sheets keep their record.`)) return;
      try { await api.removeBroker(b.dataset.rmb); await loadSettings(); render(); }
      catch (e) { alert("Couldn't remove: " + e.message); }
    });
    $("tabBody").querySelectorAll("[data-rma]").forEach((b) => b.onclick = async () => {
      if (!confirm("Remove this person's access?")) return;
      try { await api.removeAdmin(b.dataset.rma); await loadSettings(); render(); }
      catch (e) { alert("Couldn't remove: " + e.message); }
    });
  }

  function renderDetail() {
    const el = $("detail");
    const d = state.deal;
    if (!d) { el.innerHTML = ""; return; }
    const splits = d.splits || [];
    const events = d.events || [];
    const checks = checklistOf(d);
    const checklistOk = checks.every((c) => c.ok);

    el.className = "detail";
    const meta = META[d.status] || { cls: "pillDraft", label: "Draft" };
    const isDraft = d.status === "draft";
    el.innerHTML = `
      <div class="detailHead">
        <div><h2>${esc(d.property_address||"—")}</h2>
          <p class="dim">${isDraft ? "Draft — not yet submitted" : `Submitted ${d.submitted_at?new Date(d.submitted_at).toLocaleString("en-NZ"):"—"}`} · Broker ${esc(d.salesperson||"")} · ${esc(d.division||"")}</p></div>
        <div style="text-align:right">
          <span class="pill big ${meta.cls}">${meta.label}</span>
          <div><button class="linkBtn" id="printDeal" style="margin-top:8px">Print / Save as PDF</button></div>
        </div>
      </div>
      ${isDraft ? `<div class="draftBanner">View only — this draft is still being prepared by the office admin. It will appear in the queue once submitted.</div>` : ""}
      <div class="cols">
        <section class="panel">
          <h3>Deal</h3>
          <dl>
            <div><dt>${d.deal_type === "lease" ? "Lessor" : "Vendor"}</dt><dd>${esc(d.vendor_name||"—")}</dd></div>
            <div><dt>${d.deal_type === "lease" ? "Lessee" : "Purchaser"}</dt><dd>${esc(d.purchaser_name||"—")}</dd></div>
            <div><dt>${d.deal_type === "lease" ? "Commencement" : "Unconditional"}</dt><dd>${esc(
              d.deal_type === "lease"
                ? (d.form?.lease?.commencementDate || d.unconditional_date || "—")
                : (d.unconditional_date||"—"))}</dd></div>
            ${d.deal_type === "lease" ? `
            <div><dt>Lease term</dt><dd>${d.lease_term_years ? esc(d.lease_term_years) + " years" : "—"}</dd></div>
            <div><dt>Net rental p.a.</dt><dd>$${fmt(d.annual_net_rent)}</dd></div>
            <div><dt>Gross rental p.a. (excl GST)</dt><dd>$${fmt(d.annual_gross_rent || d.sale_price_ex_gst)}</dd></div>
            ` : `
            <div><dt>Sale price (excl GST)</dt><dd>$${fmt(d.sale_price_ex_gst)}</dd></div>
            `}
            <div class="hl"><dt>Total to invoice (excl GST)</dt><dd>$${fmt(d.total_invoice_ex_gst)}</dd></div>
          </dl>
          ${d.form && d.form.deposit && d.deposit_to_trust ? `<h3>Trust deposit</h3><dl>
            <div><dt>Amount</dt><dd>
              ${isDraft ? `$${fmt(d.form.deposit.amount)}` : `<span class="receiptEdit">
                <input id="depositAmount" value="${esc(d.form.deposit.amount||"")}" placeholder="Enter amount" />
                <button id="depositSave" class="miniBtn">Save</button>
                <span id="depositStatus" class="miniStatus"></span>
              </span>`}</dd></div>
            <div><dt>Receipt no.</dt><dd>
              ${isDraft ? esc(d.form.deposit.receiptNo||"—") : `<span class="receiptEdit">
                <input id="receiptNo" value="${esc(d.form.deposit.receiptNo||"")}" placeholder="Enter receipt no." />
                <button id="receiptSave" class="miniBtn">Save</button>
                <span id="receiptStatus" class="miniStatus"></span>
              </span>`}</dd></div>
</dl>` : ""}
          <h3>Commission split</h3>
          <table class="tbl"><tbody>${splits.map((s) =>
            `<tr><td>${esc(s.party_name)}</td><td class="r">${s.split_pct}%</td><td class="r mono">$${fmt(s.split_amount)}</td></tr>`).join("")||`<tr><td class="dim">No splits recorded</td></tr>`}</tbody></table>
          <h3>Mandatory checklist</h3>
          <ul class="checks">${checks.map((c) => `<li class="${c.ok?"":"bad"}">${c.label}</li>`).join("")}</ul>
          ${(d.attachments && d.attachments.length) ? `<h3>Attachments</h3>
          <ul class="attachList">${d.attachments.map((a) =>
            `<li><span>📎 ${esc(a.file_name)} <span class="dim">(${fmtSize(a.size_bytes)})</span></span>
             <button class="dlBtn" data-slot="${esc(a.slot)}">Download</button></li>`).join("")}</ul>` : ""}
        </section>

        <section class="panel actions">
          <h3>Process</h3>
          <label class="fld"><span class="lbl">Deal no.</span>
            <input id="dealNo" value="${esc(state.pendingNums.dealNo)}" ${d.status!=="submitted"?"disabled":""} placeholder="e.g. D-3073" /></label>

          ${d.status==="submitted" ? `
            <button class="primary" id="processBtn" ${!checklistOk?"disabled":""}>Assign number &amp; start processing</button>
            ${!checklistOk?`<p class="warn">Checklist incomplete — return to broker.</p>`:""}
            <div class="returnBox">
              <textarea id="returnNote" rows="2" placeholder="Reason for returning to broker…">${esc(state.note)}</textarea>
              <button class="ghost" id="returnBtn">Return to broker</button>
            </div>` : ""}
          ${d.status==="processing" ? `<button class="primary" id="invoiceBtn">Mark invoiced — commission approved</button>` : ""}
          ${d.status==="invoiced" ? `<p class="doneNote">✓ Invoiced. Deal ${esc(d.deal_no)}.</p>` : ""}
          ${d.status==="rejected" ? `<p class="warn">Returned to broker — awaiting resubmission.</p>` : ""}

          <h3 style="margin-top:18px">History</h3>
          <ol class="events">${events.map((ev) =>
            `<li><span class="mono dim">${new Date(ev.created_at).toLocaleString("en-NZ")}</span><br />${esc(ev.note||ev.to_status)}</li>`).join("")}</ol>
        </section>
      </div>`;

    const dealNo = $("dealNo");
    if (dealNo) dealNo.oninput = () => { state.pendingNums.dealNo = dealNo.value; toggleProcess(); };
    const note = $("returnNote");
    if (note) note.oninput = () => { state.note = note.value; const rb = $("returnBtn"); if (rb) rb.disabled = !note.value.trim(); };

    const prb = $("printDeal");
    if (prb) prb.onclick = () => api.openPrint(state.deal.id);

    const pb = $("processBtn");
    if (pb) { toggleProcess(); pb.onclick = doProcess; }
    const ib = $("invoiceBtn"); if (ib) ib.onclick = doInvoice;
    const rb = $("returnBtn"); if (rb) { rb.disabled = !state.note.trim(); rb.onclick = doReturn; }

    const rSave = $("receiptSave");
    if (rSave) rSave.onclick = async () => {
      const val = ($("receiptNo").value || "").trim();
      const rst = $("receiptStatus");
      rSave.disabled = true;
      if (rst) rst.textContent = "Saving…";
      try {
        await api.setReceipt(state.deal.id, { receiptNo: val });
        state.deal.form = state.deal.form || {};
        state.deal.form.deposit = { ...(state.deal.form.deposit || {}), receiptNo: val };
        if (rst) rst.textContent = "Saved ✓";
      } catch (e) {
        if (rst) rst.textContent = "Failed — try again";
      } finally {
        rSave.disabled = false;
      }
    };

    const dSave = $("depositSave");
    if (dSave) dSave.onclick = async () => {
      const val = ($("depositAmount").value || "").trim().replace(/[$,\s]/g, "");
      const dst = $("depositStatus");
      if (val && isNaN(parseFloat(val))) { if (dst) dst.textContent = "Enter a number"; return; }
      dSave.disabled = true;
      if (dst) dst.textContent = "Saving…";
      try {
        await api.setReceipt(state.deal.id, { amount: val });
        state.deal.form = state.deal.form || {};
        state.deal.form.deposit = { ...(state.deal.form.deposit || {}), amount: val };
        if (dst) dst.textContent = "Saved ✓";
      } catch (e) {
        if (dst) dst.textContent = "Failed — try again";
      } finally {
        dSave.disabled = false;
      }
    };

    el.querySelectorAll(".dlBtn").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Preparing…";
        try {
          const { url } = await api.attachmentUrl(state.deal.id, b.dataset.slot);
          window.open(url, "_blank");
        } catch (e) { alert("Could not get download link: " + e.message); }
        finally { b.disabled = false; b.textContent = "Download"; }
      };
    });
  }

  function toggleProcess() {
    const prb = $("printDeal");
    if (prb) prb.onclick = () => api.openPrint(state.deal.id);

    const pb = $("processBtn"); if (!pb) return;
    const checks = checklistOf(state.deal);
    const ok = checks.every((c) => c.ok) && state.pendingNums.dealNo.trim();
    pb.disabled = !ok;
  }

  async function doProcess() {
    try {
      await api.process(state.deal.id, { dealNo: state.pendingNums.dealNo.trim() });
      await refresh();
    } catch (e) { alert("Could not process: " + e.message); }
  }
  async function doInvoice() {
    try { await api.invoice(state.deal.id); await refresh(); }
    catch (e) { alert("Could not mark invoiced: " + e.message); }
  }
  async function doReturn() {
    if (!state.note.trim()) return;
    try { await api.returnToBroker(state.deal.id, state.note.trim()); await refresh(); }
    catch (e) { alert("Could not return: " + e.message); }
  }
  async function refresh() {
    await loadDeal(state.selectedId);
    state.queue = await api.getQueue();
    render();
  }

  (async function boot() {
    if (cfg.DEMO_MODE) $("demoBadge").classList.remove("hidden");
    try {
      const account = await window.DealSheetAuth.init();
      if (!account) return;
    } catch (e) {
      $("gate").innerHTML = `<div class="inner">Sign-in failed: ${esc(e.message)}</div>`;
      return;
    }
    try {
      await loadQueue();
    } catch (e) {
      if (e.status === 403) {
        // Two different 403s: not in app_users at all (message carries
        // the Object ID), or provisioned but not accounts/manager.
        const notSetUp = /Object ID/i.test(e.message || "");
        $("gate").innerHTML = notSetUp
          ? `<div class="inner gateMsg"><h2>Access not set up yet</h2>
             <p>${esc(e.message)}</p>
             <p class="dim">Send the Object ID above to your administrator.</p></div>`
          : `<div class="inner gateMsg"><h2>Accounts access required</h2>
             <p>This page is for the accounts team. Your account doesn't have that role.</p>
             <p class="dim"><a href="deal-sheet.html">Go to the deal sheet form instead</a></p></div>`;
        return;
      }
      $("gate").innerHTML = `<div class="inner">Couldn't load the queue: ${esc(e.message)}</div>`;
      return;
    }
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
  })();
})();
