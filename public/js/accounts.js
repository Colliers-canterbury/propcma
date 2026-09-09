// /public/js/accounts.js — Accounts Deal Sheet Processing (vanilla)
(function () {
  const cfg = window.DealSheetConfig;
  const api = window.DealSheetApi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => {
    if (n == null || n === "") return "0.00";
    // Deposit/commission fields are live-formatted with commas as the
    // user types (public/js/form.js, lease-form.js), so stored values
    // may already contain them — strip before parsing, or Number()
    // returns NaN for e.g. "51,390.31".
    const v = typeof n === "number" ? n : parseFloat(String(n).replace(/[$,\s]/g, ""));
    return isNaN(v) ? "0.00" : v.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtSize = (b) => { b = Number(b||0); return b < 1024 ? b+" B" : b < 1048576 ? (b/1024).toFixed(0)+" KB" : (b/1048576).toFixed(1)+" MB"; };
  const yn = (b) => b ? "Yes" : "No";
  const dash = (v) => (v === null || v === undefined || v === "") ? "—" : esc(v);
  const nzDate = (v) => {
    if (!v) return "—";
    const dt = new Date(v);
    if (isNaN(dt.getTime())) return esc(String(v));
    return dt.toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" });
  };
  // Comma-safe number parsing — commission/rental fields are live-formatted
  // with thousands separators as the user types, so this strips that
  // before parsing (mirrors public/js/form.js and api/deal-sheets/[id]/print.js).
  const num = (v) => { const x = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return isNaN(x) ? 0 : x; };

  const META = {
    submitted:        { label: "Submitted",         cls: "sub" },
    invoiced:         { label: "Invoiced",           cls: "proc" },
    deposit_received: { label: "Deposit Received",   cls: "dep" },
    complete:         { label: "Complete",           cls: "inv" },
    rejected:         { label: "Returned",           cls: "rej" },
  };

  // Merged-letter downloads (see api/deal-sheets/[id]/letter.js). The two
  // Early Release letters use Vendor/Purchaser wording and only apply to
  // sale deals; the Disbursement letter works for both (it swaps in
  // Sale/Lease and Purchaser/Tenant wording server-side).
  const LETTER_ITEMS = [
    { type: "vendor",       label: "Early Release (Vendor)",    saleOnly: true },
    { type: "purchaser",    label: "Early Release (Purchaser)", saleOnly: true },
    { type: "disbursement", label: "Disbursement letter",       saleOnly: false },
  ];
  function lettersMenuHtml(d) {
    const items = LETTER_ITEMS.filter((li) => !li.saleOnly || d.deal_type !== "lease");
    return `<details class="lettersMenu" style="display:inline-block;position:relative;margin-top:8px">
      <summary class="linkBtn" style="cursor:pointer">Letters</summary>
      <div style="position:absolute;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #DCE2EC;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.14);padding:4px;min-width:210px;z-index:20;text-align:left">
        ${items.map((li) => `<button type="button" class="letterItem" data-letter="${li.type}" data-label="${esc(li.label)}"
          style="display:block;width:100%;text-align:left;background:none;border:0;padding:8px 10px;font:inherit;font-size:13px;cursor:pointer;border-radius:4px;color:inherit">${esc(li.label)}</button>`).join("")}
      </div>
    </details>`;
  }
  // Close any open Letters menu on an outside click — added once, not
  // per-render, since renderDetail() rebuilds this markup on every change.
  document.addEventListener("click", (e) => {
    document.querySelectorAll("details.lettersMenu[open]").forEach((d) => {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  const state = { tab: "queue", queue: [], completed: [], drafts: [], selectedId: null, deal: null,
    completedViewId: null,
    filter: "all", note: "", completeComment: "", pendingNums: {},
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
    state.completeComment = "";
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
    // Must match the backend's actual required set exactly (api/_lib/deals.js
    // and api/_lib/leases.js) — this list gates the Invoice button, so it
    // can never include an item the backend doesn't also require, or
    // accounts gets blocked over something that was never mandatory.
    const required = isLease
      ? [
          ["agencyAgreement", "Signed agency agreement"],
          ["unconditionalConfirmation", "Confirmation of unconditional"],
          ["executedAgreement", "Executed lease agreement"],
          ["amlComplete", "AML complete"],
        ]
      : [
          ["agencyAgreement", "Signed agency agreement"],
          ["unconditionalConfirmation", "Confirmation of unconditional"],
          ["executedAgreement", "Executed sale & purchase agreement"],
          ["amlComplete", "AML complete"],
        ];
    if (deal.deposit_to_trust && !isLease) required.push(["spAgreement", "S&P agreement (trust deal)"]);

    // Everything else — shown for visibility, never blocks anything.
    const optional = isLease
      ? [
          ["marketingReport", "Marketing campaign report"],
          ["leaseValueConfirmation", "Confirmation of lease value"],
          ["leaseDeed", "Lease deed"],
          ...(deal.deposit_to_trust ? [["appraisals", "Appraisals (trust deal)"]] : []),
        ]
      : [["marketingReport", "Marketing campaign report"]];

    return {
      required: required.map(([k, label]) => ({ key: k, ok: !!c[k], label })),
      optional: optional.map(([k, label]) => ({ key: k, ok: !!c[k], label })),
    };
  }

  function render() {
    const showingDrafts = state.filter === "drafts";
    const queueItems = state.queue.filter((d) => d.status !== "complete")
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
        <div class="headerRight">
          <a class="opsManualLink" href="operations-manual.html">📖 Operations Manual</a>
          <div class="counts">${counts()}</div>
        </div>
      </header>
      <div class="tabs">
        <button class="tab ${state.tab==="queue"?"on":""}" data-tab="queue">Queue${
          state.queue.filter((d)=>d.status!=="complete").length?`<span class="badge">${state.queue.filter((d)=>d.status!=="complete").length}</span>`:""}</button>
        <button class="tab ${state.tab==="completed"?"on":""}" data-tab="completed">Completed</button>
        <button class="tab ${state.tab==="settings"?"on":""}" data-tab="settings">Settings</button>
      </div>
      ${state.tab !== "queue" ? `<div id="tabBody"></div>` : `
      <div class="layout accounts">
        <aside class="queue">
          <div class="filters">
            ${["all","submitted","invoiced","deposit_received","rejected"].map((s) =>
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
        state.deal = null; state.selectedId = null; state.completedViewId = null;
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
    state.completed = await api.getQueue("complete");
  }

  function renderCompleted() {
    // Viewing a single completed deal's full detail (read-only —
    // renderDetail() already shows no action buttons for a 'complete'
    // status deal, just the checklist, attachments, splits and history).
    if (state.completedViewId && state.deal && state.deal.id === state.completedViewId) {
      $("tabBody").innerHTML = `<button class="linkBtn" id="backToCompleted" style="margin-bottom:10px">← Back to Completed</button>
        <div class="detail" id="detail"></div>`;
      renderDetail();
      $("backToCompleted").onclick = () => { state.completedViewId = null; state.deal = null; render(); };
      return;
    }

    const rows = [...state.completed].sort((a, b) =>
      new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));
    $("tabBody").innerHTML = rows.length ? `
      <table class="compTable">
        <thead><tr><th>Property</th><th>Vendor</th><th>Salespeople</th>
          <th class="r">Invoiced</th><th>Deal no.</th><th>Date</th><th colspan="2"></th></tr></thead>
        <tbody>${rows.map((d) => `<tr>
          <td><strong>${esc(d.property_address || "—")}</strong></td>
          <td>${esc(d.vendor_name || "—")}</td>
          <td>${esc(d.salesperson || "—")}</td>
          <td class="r mono">$${fmt(d.total_invoice_ex_gst)}</td>
          <td>${esc(d.deal_no || "—")}</td>
          <td>${d.submitted_at ? new Date(d.submitted_at).toLocaleDateString("en-NZ",{day:"2-digit",month:"short",year:"numeric"}) : "—"}</td>
          <td class="r"><button class="linkBtn" data-view="${d.id}">View</button></td>
          <td class="r"><button class="linkBtn" data-print="${d.id}">Print</button></td>
        </tr>`).join("")}</tbody></table>`
      : `<p class="empty">No completed deals yet.</p>`;
    $("tabBody").querySelectorAll("[data-print]").forEach((b) =>
      b.onclick = () => api.openPrint(b.dataset.print));
    $("tabBody").querySelectorAll("[data-view]").forEach((b) =>
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Opening…";
        try {
          state.completedViewId = b.dataset.view;
          await loadDeal(b.dataset.view);
          render();
        } catch (e) {
          alert("Could not open deal: " + e.message);
          b.disabled = false; b.textContent = "View";
        }
      });
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
    const { required: checks, optional: optionalChecks } = checklistOf(d);
    const checklistOk = checks.every((c) => c.ok);
    const allAttachments = d.attachments || [];
    const checklistAttachments = allAttachments.filter((a) => a.kind !== "extra");
    const extraAttachments = allAttachments.filter((a) => a.kind === "extra");

    el.className = "detail";
    const meta = META[d.status] || { cls: "pillDraft", label: "Draft" };
    const isDraft = d.status === "draft";
    // Accounts can complete/attach a missing mandatory item herself,
    // rather than always having to bounce the deal back to the broker
    // — available for as long as she's actively working the deal.
    const canEditChecklist = ["submitted", "invoiced", "deposit_received"].includes(d.status);
    const f = d.form || {};
    const comm = f.comm || {};

    // Tiered commission (sale only) — mirrors public/js/form.js and
    // api/deal-sheets/[id]/print.js: each tier's base is whatever's left
    // of the sale price after the tiers above it, unless a tier has an
    // explicit typed amount.
    const salePriceVal = num(d.sale_price_ex_gst ?? f.sale?.salePrice);
    const tierBases = [];
    let tierRemaining = salePriceVal;
    (comm.tiers || []).forEach((t, i) => {
      const typed = t.base !== "" && t.base != null;
      const base = typed ? num(t.base) : Math.max(tierRemaining, 0);
      tierBases[i] = base;
      tierRemaining -= base;
    });
    const tierFees = (comm.tiers || []).map((t, i) => (num(t.pct) / 100) * tierBases[i]);

    // Rights of renewal (lease only)
    const rorText = f.lease?.rorTimes
      ? `${esc(f.lease.rorTimes)} × ${dash(f.lease.rorYears)} year${num(f.lease.rorYears) === 1 ? "" : "s"}`
      : "—";
    el.innerHTML = `
      <div class="detailHead">
        <div><h2>${esc(d.property_address||"—")}</h2>
          <p class="dim">${isDraft ? "Draft — not yet submitted" : `Submitted ${d.submitted_at?new Date(d.submitted_at).toLocaleString("en-NZ"):"—"}`} · Broker ${esc(d.salesperson||"")} · ${esc(d.division||"")}</p></div>
        <div style="text-align:right">
          <span class="pill big ${meta.cls}">${meta.label}</span>
          <div style="display:flex;gap:10px;justify-content:flex-end;align-items:flex-start">
            <button class="linkBtn" id="printDeal" style="margin-top:8px">Print / Save as PDF</button>
            ${isDraft ? "" : lettersMenuHtml(d)}
          </div>
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
          ${d.deal_type === "lease" ? `
          <h3>Lease details</h3>
          <dl>
            <div><dt>Date of agreement</dt><dd>${nzDate(f.lease?.dateOfAgreement)}</dd></div>
            <div><dt>Occupancy date</dt><dd>${nzDate(f.lease?.occupancyDate)}</dd></div>
            <div><dt>Expiry date</dt><dd>${nzDate(f.lease?.expiryDate)}</dd></div>
            <div><dt>Rights of renewal</dt><dd>${rorText}</dd></div>
            <div><dt>Rent review period</dt><dd>${dash(f.lease?.rentReviewPeriod)}</dd></div>
            <div><dt>Deal type</dt><dd>${dash(f.lease?.dealType)}</dd></div>
            <div><dt>Lease basis</dt><dd>${dash(f.lease?.leaseBasis)}</dd></div>
            <div><dt>Incentives</dt><dd>${dash(f.lease?.incentives)}</dd></div>
          </dl>` : `
          <h3>Sale details</h3>
          <dl>
            <div><dt>Date of agreement</dt><dd>${nzDate(f.sale?.dateOfAgreement)}</dd></div>
            <div><dt>${esc(f.sale?.rentalBasis || "Net")} rental income</dt><dd>${f.sale?.rentalIncome ? "$" + fmt(f.sale.rentalIncome) : "—"}</dd></div>
            <div><dt>Yield</dt><dd>${f.sale?.yieldManual ? esc(f.sale.yieldManual) + " %" : "—"}</dd></div>
            <div><dt>Title</dt><dd>${dash(f.sale?.titleType)}</dd></div>
            <div><dt>Land area (sqm)</dt><dd>${dash(f.sale?.landArea)}</dd></div>
            <div><dt>Occupied by area (sqm)</dt><dd>${dash(f.sale?.occupiedArea)}</dd></div>
            <div><dt>WALE (years)</dt><dd>${dash(f.sale?.wale)}</dd></div>
            <div><dt>No. of tenancies</dt><dd>${dash(f.sale?.tenancies)}</dd></div>
            <div><dt>Sold at auction</dt><dd>${yn(f.sale?.auction)}</dd></div>
            <div><dt>Tenancy schedule attached</dt><dd>${yn(f.sale?.tenancySchedule)}</dd></div>
          </dl>`}
          ${!isDraft ? `<h3>Trust deposit</h3>
          ${d.deposit_to_trust ? `<dl>
            <div><dt>Amount</dt><dd>
              <span class="receiptEdit">
                <input id="trustAmount" value="${esc(d.form?.deposit?.amount||"")}" placeholder="0.00" />
              </span></dd></div>
            <div><dt>Receipt no.</dt><dd>
              <span class="receiptEdit">
                <input id="trustReceiptNo" value="${esc(d.form?.deposit?.receiptNo||"")}" placeholder="Enter receipt no." />
              </span></dd></div>
            <div><dt>Deposit notes</dt><dd>
              <span class="receiptEdit">
                <textarea id="trustNotes" rows="2" placeholder="e.g. when it's due, or where it should be paid to…">${esc(d.form?.deposit?.notes||"")}</textarea>
              </span></dd></div>
            <div><dt>Balance Due - Paid to:</dt><dd>
              <span class="receiptEdit">
                <input id="trustBalancePaidTo" value="${esc(d.form?.deposit?.balancePaidTo||"")}" placeholder="Firm name" />
              </span></dd></div>
            <div><dt>Bank A/C No:</dt><dd>
              <span class="receiptEdit">
                <input id="trustAccountNo" value="${esc(d.form?.deposit?.trustAccountNo||"")}" placeholder="Bank account number" />
              </span></dd></div>
            <div><dt>Balance Due $:</dt><dd>
              <span class="receiptEdit">
                <input id="trustBalanceDue" value="${esc(d.form?.deposit?.balanceDue||"")}" placeholder="0.00" />
              </span></dd></div>
            <div><dt></dt><dd>
              <button id="trustSave" class="miniBtn">Save</button>
              <span id="trustStatus" class="miniStatus"></span></dd></div>
          </dl>` : `
          <p class="note">Not flagged as a trust deposit by the office admin. If a deposit has come through to the trust account, add it here.</p>
          <button id="addTrustBtn" class="linkBtn">+ Add trust deposit</button>
          <div id="addTrustForm" class="hidden">
            <div class="grid" style="margin-top:8px">
              <label class="fld"><span class="lbl">Amount (excl GST)</span><input id="trustAmount" placeholder="0.00" /></label>
              <label class="fld"><span class="lbl">Receipt no.</span><input id="trustReceiptNo" placeholder="Enter receipt no." /></label>
            </div>
            <label class="fld" style="margin-top:8px"><span class="lbl">Deposit notes</span>
              <textarea id="trustNotes" rows="2" placeholder="e.g. when it's due, or where it should be paid to…"></textarea></label>
            <div class="grid" style="margin-top:8px">
              <label class="fld"><span class="lbl">Balance Due - Paid to:</span><input id="trustBalancePaidTo" placeholder="Firm name" /></label>
              <label class="fld"><span class="lbl">Bank A/C No:</span><input id="trustAccountNo" placeholder="Bank account number" /></label>
              <label class="fld"><span class="lbl">Balance Due $:</span><input id="trustBalanceDue" placeholder="0.00" /></label>
            </div>
            <button id="trustSave" class="miniBtn" style="margin-top:8px">Save</button>
            <span id="trustStatus" class="miniStatus"></span>
          </div>`}` : ""}
          ${d.form?.specialClauses && d.form?.specialClausesText ? `<h3>Special Clauses</h3>
          <p>${esc(d.form.specialClausesText)}</p>` : ""}
          <h3>Commission calculation</h3>
          ${d.deal_type === "lease" ? `
          <table class="tbl">
            <thead><tr><th>Item</th><th>Description</th><th class="r">Amount</th></tr></thead>
            <tbody>
              ${comm.fee ? `<tr><td>Commission (per scale of fees)</td><td>${dash(comm.feeDesc)}</td><td class="r mono">$${fmt(comm.fee)}</td></tr>` : ""}
              ${comm.otherFee ? `<tr><td>Other / consultancy</td><td>${dash(comm.otherDesc)}</td><td class="r mono">$${fmt(comm.otherFee)}</td></tr>` : ""}
              ${comm.adminFee ? `<tr><td>Administration fee</td><td></td><td class="r mono">$${fmt(500)}</td></tr>` : ""}
              ${comm.recoverMarketing ? `<tr><td>Recover marketing costs</td><td></td><td class="r mono">$${fmt(comm.recoverMarketing)}</td></tr>` : ""}
              ${comm.recoverOther ? `<tr><td>Recover other costs</td><td>${dash(comm.recoverOtherDesc)}</td><td class="r mono">$${fmt(comm.recoverOther)}</td></tr>` : ""}
              ${comm.deductMarketing ? `<tr><td>Deduct marketing costs</td><td>${dash(comm.deductMarketingDesc)}</td><td class="r mono">−$${fmt(comm.deductMarketing)}</td></tr>` : ""}
              <tr style="font-weight:700"><td colspan="2">Total to invoice (excl GST)</td><td class="r mono">$${fmt(d.total_invoice_ex_gst)}</td></tr>
            </tbody>
          </table>` : `
          <table class="tbl">
            <thead><tr><th>Item</th><th class="r">%</th><th class="r">Amount</th></tr></thead>
            <tbody>
              ${comm.flatFee
                ? `<tr><td>Commission (flat fee)</td><td class="r"></td><td class="r mono">$${fmt(comm.flatFeeAmount)}</td></tr>`
                : (comm.tiers || []).map((t, i) => t.pct ? `<tr><td>${["Commission","Second tier","Third tier"][i] || ("Tier " + (i+1))}</td><td class="r">${esc(t.pct)}%</td><td class="r mono">$${fmt(tierFees[i])}</td></tr>` : "").join("")}
              ${comm.otherFee ? `<tr><td>Other — ${dash(comm.otherDesc)}</td><td class="r"></td><td class="r mono">$${fmt(comm.otherFee)}</td></tr>` : ""}
              ${comm.adminFee ? `<tr><td>Administration fee</td><td class="r"></td><td class="r mono">$${fmt(500)}</td></tr>` : ""}
              ${comm.recoverMarketing ? `<tr><td>Recover marketing costs</td><td class="r"></td><td class="r mono">$${fmt(comm.recoverMarketing)}</td></tr>` : ""}
              ${comm.recoverOther ? `<tr><td>Recover other — ${dash(comm.recoverOtherDesc)}</td><td class="r"></td><td class="r mono">$${fmt(comm.recoverOther)}</td></tr>` : ""}
              ${comm.deductMarketing ? `<tr><td>Deduct marketing costs${comm.deductMarketingDesc ? " — " + dash(comm.deductMarketingDesc) : ""}</td><td class="r"></td><td class="r mono">−$${fmt(comm.deductMarketing)}</td></tr>` : ""}
              <tr style="font-weight:700"><td>Total to invoice (excl GST)</td><td></td><td class="r mono">$${fmt(d.total_invoice_ex_gst)}</td></tr>
            </tbody>
          </table>`}
          <h3>Commission split — Salespeople</h3>
          <table class="tbl"><tbody>${splits.filter((s) => s.party_type !== "third_party").map((s) =>
            `<tr><td>${esc(s.party_name)}</td><td class="r">${s.split_pct}%</td><td class="r mono">$${fmt(s.split_amount)}</td></tr>`).join("")||`<tr><td class="dim">No splits recorded</td></tr>`}</tbody></table>
          <h3>Commission split — Third parties</h3>
          <table class="tbl"><tbody>${splits.filter((s) => s.party_type === "third_party").map((s) =>
            `<tr><td>${esc(s.party_name)}</td><td class="r">${s.split_pct}%</td><td class="r mono">$${fmt(s.split_amount)}</td></tr>`).join("")||`<tr><td class="dim">None</td></tr>`}</tbody></table>
          <h3>Mandatory checklist</h3>
          ${canEditChecklist ? `
          <ul class="checks editable">${checks.map((c) => `<li class="${c.ok?"":"bad"}">
            <label class="chk"><input type="checkbox" class="checklistToggle" data-key="${c.key}" ${c.ok?"checked":""} /><span>${c.label}</span></label>
            ${!c.ok ? `<span class="checklistUpload">
              <label class="upBtn small">Attach<input type="file" class="checklistUploadInput" data-key="${c.key}" hidden /></label>
              <span class="miniStatus" data-upload-status="${c.key}"></span>
            </span>` : ""}
          </li>`).join("")}</ul>` : `
          <ul class="checks">${checks.map((c) => `<li class="${c.ok?"":"bad"}">${c.label}</li>`).join("")}</ul>`}
          ${optionalChecks.length ? `<h3>Other documents <span class="dim">(not mandatory)</span></h3>
          <ul class="checks optional">${optionalChecks.map((c) => `<li class="${c.ok?"":"muted"}">${c.label}</li>`).join("")}</ul>` : ""}
          ${(checklistAttachments.length) ? `<h3>Attachments</h3>
          <ul class="attachList">${checklistAttachments.map((a) =>
            `<li><span>📎 ${esc(a.file_name)} <span class="dim">(${fmtSize(a.size_bytes)})</span></span>
             <span class="attachBtns">
               <button class="viewBtn" data-slot="${esc(a.slot)}">View</button>
               <button class="dlBtn" data-slot="${esc(a.slot)}">Download</button>
             </span></li>`).join("")}</ul>` : ""}

          <h3>Additional attachments <span class="dim">(for accounts / audit)</span></h3>
          ${extraAttachments.length ? `<ul class="attachList extraList">${extraAttachments.map((a) => `<li>
              <span>📎 <strong>${esc(a.description||"(no description)")}</strong> — ${esc(a.file_name)}
                <span class="dim">(${fmtSize(a.size_bytes)}${a.uploaded_at?" · "+new Date(a.uploaded_at).toLocaleDateString("en-NZ"):""})</span></span>
              <span class="attachBtns">
                <button class="viewBtn" data-slot="${esc(a.slot)}">View</button>
                <button class="dlBtn" data-slot="${esc(a.slot)}">Download</button>
                <button class="rmBtn" data-extra-remove="${esc(a.slot)}">Remove</button>
              </span></li>`).join("")}</ul>` : `<p class="dim" style="margin:4px 0 10px">None added yet.</p>`}
          ${!isDraft ? `<div class="extraUpload" id="extraDropZone">
              <input id="extraDesc" placeholder="Description for the tax auditors (required)" />
              <label class="upBtn">Choose file<input type="file" id="extraFile" hidden /></label>
              <span id="extraFileName" class="dim"></span>
              <button id="extraUploadBtn" class="miniBtn" disabled>Add attachment</button>
              <span id="extraUploadStatus" class="miniStatus"></span>
              <span class="dropHint">or drag &amp; drop a file anywhere in this box</span>
            </div>` : ""}
        </section>

        <section class="panel actions">
          <h3>Process</h3>

          ${d.status==="submitted" ? `
            <button class="primary" id="invoiceClientBtn" ${!checklistOk?"disabled":""}>Invoiced Client</button>
            ${!checklistOk?`<p class="warn">Checklist incomplete — return to broker.</p>`:""}
            <div class="returnBox">
              <textarea id="returnNote" rows="2" placeholder="Reason for returning to broker…">${esc(state.note)}</textarea>
              <button class="ghost" id="returnBtn">Return to broker</button>
            </div>` : ""}

          ${d.status==="invoiced" ? `
            <label class="fld"><span class="lbl">Deal no.</span>
              <input id="dealNo" value="${esc(state.pendingNums.dealNo)}" placeholder="e.g. D-3073" /></label>
            <button class="primary" id="assignDealNoBtn">Assign Deal Number</button>
            <div class="returnBox">
              <textarea id="returnNote" rows="2" placeholder="Reason for returning to broker…">${esc(state.note)}</textarea>
              <button class="ghost" id="returnBtn">Return to broker</button>
            </div>` : ""}

          ${d.status==="deposit_received" ? `
            <label class="fld"><span class="lbl">Comments <span class="dim">(optional — visible to the office admin)</span></span>
              <textarea id="completeComment" rows="3" placeholder="Any notes for the office admin…">${esc(state.completeComment)}</textarea></label>
            <button class="primary" id="completeBtn">Mark as complete</button>` : ""}

          ${d.status==="complete" ? `<p class="doneNote">✓ Complete. Deal ${esc(d.deal_no)}.</p>
            ${d.accounts_comment ? `<p class="note">Comment: ${esc(d.accounts_comment)}</p>` : ""}` : ""}

          ${d.status==="rejected" ? `<p class="warn">Returned to broker — awaiting resubmission.</p>` : ""}

          <h3 style="margin-top:18px">History</h3>
          <ol class="events">${events.map((ev) =>
            `<li><span class="mono dim">${new Date(ev.created_at).toLocaleString("en-NZ")}</span><br />${esc(ev.note||ev.to_status)}</li>`).join("")}</ol>
        </section>
      </div>`;

    const dealNo = $("dealNo");
    if (dealNo) dealNo.oninput = () => {
      state.pendingNums.dealNo = dealNo.value;
      const ab = $("assignDealNoBtn"); if (ab) ab.disabled = !dealNo.value.trim();
    };
    const completeCommentEl = $("completeComment");
    if (completeCommentEl) completeCommentEl.oninput = () => { state.completeComment = completeCommentEl.value; };
    const note = $("returnNote");
    if (note) note.oninput = () => { state.note = note.value; const rb = $("returnBtn"); if (rb) rb.disabled = !note.value.trim(); };

    const prb = $("printDeal");
    if (prb) prb.onclick = () => api.openPrint(state.deal.id);

    el.querySelectorAll(".letterItem").forEach((btn) => {
      btn.onclick = () => {
        const menu = btn.closest("details.lettersMenu");
        if (menu) menu.open = false;
        api.openLetter(state.deal.id, btn.dataset.letter, btn.dataset.label);
      };
    });

    const icb = $("invoiceClientBtn"); if (icb) icb.onclick = doInvoiceClient;
    const ab = $("assignDealNoBtn"); if (ab) { ab.disabled = !state.pendingNums.dealNo.trim(); ab.onclick = doAssignDealNumber; }
    const cb = $("completeBtn"); if (cb) cb.onclick = doComplete;
    const rb = $("returnBtn"); if (rb) { rb.disabled = !state.note.trim(); rb.onclick = doReturn; }

    const addTrustBtn = $("addTrustBtn");
    if (addTrustBtn) addTrustBtn.onclick = () => {
      $("addTrustForm").classList.remove("hidden");
      addTrustBtn.classList.add("hidden");
    };

    const trustSave = $("trustSave");
    if (trustSave) trustSave.onclick = async () => {
      const amount = ($("trustAmount").value || "").trim();
      const receiptNo = ($("trustReceiptNo").value || "").trim();
      const notes = ($("trustNotes")?.value || "").trim();
      const balancePaidTo = ($("trustBalancePaidTo")?.value || "").trim();
      const trustAccountNo = ($("trustAccountNo")?.value || "").trim();
      const balanceDue = ($("trustBalanceDue")?.value || "").trim();
      const tst = $("trustStatus");
      trustSave.disabled = true;
      if (tst) tst.textContent = "Saving…";
      try {
        await api.setTrustDeposit(state.deal.id, { amount, receiptNo, notes, balancePaidTo, trustAccountNo, balanceDue });
        state.deal.form = state.deal.form || {};
        state.deal.form.deposit = { ...(state.deal.form.deposit || {}), amount, receiptNo, notes, balancePaidTo, trustAccountNo, balanceDue };
        state.deal.deposit_to_trust = true;
        if (tst) tst.textContent = "Saved ✓";
        render();
      } catch (e) {
        if (tst) tst.textContent = "Failed — try again";
      } finally {
        trustSave.disabled = false;
      }
    };

    // ---- mandatory checklist: tick or attach an outstanding item ----
    el.querySelectorAll(".checklistToggle").forEach((cb) => {
      cb.onchange = async () => {
        cb.disabled = true;
        try {
          await api.setChecklistItem(state.deal.id, cb.dataset.key, cb.checked);
          state.deal.form = state.deal.form || {};
          state.deal.form.checklist = { ...(state.deal.form.checklist || {}), [cb.dataset.key]: cb.checked };
          render();
        } catch (e) {
          alert("Could not update checklist: " + e.message);
          cb.checked = !cb.checked;
          cb.disabled = false;
        }
      };
    });
    el.querySelectorAll(".checklistUploadInput").forEach((input) => {
      input.onchange = async () => {
        const key = input.dataset.key, file = input.files[0];
        if (!file) return;
        const status = el.querySelector(`[data-upload-status="${key}"]`);
        if (status) status.textContent = "Uploading…";
        try {
          await api.uploadAttachment(state.deal.id, key, file);
          await loadDeal(state.deal.id);
          render();
        } catch (e) {
          if (status) status.textContent = "Failed";
          alert("Upload failed: " + e.message);
        }
      };
    });

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
    el.querySelectorAll(".viewBtn").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Opening…";
        try {
          const { url } = await api.attachmentUrl(state.deal.id, b.dataset.slot, { view: true });
          window.open(url, "_blank");
        } catch (e) { alert("Could not open file: " + e.message); }
        finally { b.disabled = false; b.textContent = "View"; }
      };
    });

    // ---- extra attachments (accounts / audit) ----
    let pendingFile = null;
    const descEl = $("extraDesc"), fileBtn = $("extraFile"),
          fileNameEl = $("extraFileName"), uploadBtn = $("extraUploadBtn"),
          statusEl = $("extraUploadStatus"), dropZone = $("extraDropZone");
    const updateUploadReady = () => {
      if (uploadBtn) uploadBtn.disabled = !(pendingFile && descEl && descEl.value.trim());
    };
    const setPendingFile = (file) => {
      pendingFile = file || null;
      if (fileNameEl) fileNameEl.textContent = pendingFile ? pendingFile.name : "";
      updateUploadReady();
    };
    if (fileBtn) fileBtn.onchange = () => setPendingFile(fileBtn.files[0]);
    if (dropZone) {
      dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("dragover"); };
      dropZone.ondragleave = () => dropZone.classList.remove("dragover");
      dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        setPendingFile(e.dataTransfer.files[0]);
      };
    }
    if (descEl) descEl.oninput = updateUploadReady;
    if (uploadBtn) uploadBtn.onclick = async () => {
      const description = descEl.value.trim();
      if (!description || !pendingFile) return;
      uploadBtn.disabled = true;
      if (statusEl) statusEl.textContent = "Uploading…";
      try {
        await api.uploadExtraAttachment(state.deal.id, description, pendingFile);
        await loadDeal(state.deal.id); // refresh to show the new attachment
        render();
      } catch (e) {
        if (statusEl) statusEl.textContent = "Upload failed";
        uploadBtn.disabled = false;
        alert("Upload failed: " + e.message);
      }
    };
    el.querySelectorAll("[data-extra-remove]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Remove this attachment? This cannot be undone.")) return;
        b.disabled = true; b.textContent = "Removing…";
        try {
          await api.removeAttachment(state.deal.id, b.dataset.extraRemove);
          await loadDeal(state.deal.id);
          render();
        } catch (e) {
          alert("Could not remove: " + e.message);
          b.disabled = false; b.textContent = "Remove";
        }
      };
    });
  }

  async function doInvoiceClient() {
    try { await api.invoiceClient(state.deal.id); await refresh(); }
    catch (e) { alert("Could not invoice: " + e.message); }
  }
  async function doAssignDealNumber() {
    try {
      await api.assignDealNumber(state.deal.id, state.pendingNums.dealNo.trim());
      await refresh();
    } catch (e) { alert("Could not assign deal number: " + e.message); }
  }
  async function doComplete() {
    try {
      await api.markComplete(state.deal.id, state.completeComment.trim());
      await refresh();
    } catch (e) { alert("Could not mark complete: " + e.message); }
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
