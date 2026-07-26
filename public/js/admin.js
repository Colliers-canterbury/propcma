// /public/js/admin.js — Office Administrator: my deal sheets
(function () {
  const cfg = window.DealSheetConfig;
  const api = window.DealSheetApi;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (t) => t ? new Date(t).toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" }) : "—";

  const META = {
    draft:      { label: "Draft",      cls: "" },
    submitted:  { label: "Submitted",  cls: "sub" },
    processing: { label: "Processing", cls: "proc" },
    invoiced:   { label: "Invoiced",   cls: "inv" },
    rejected:   { label: "Returned",   cls: "rej" },
  };

  const state = { deals: [], filter: "all", userName: "" };

  async function load() {
    state.deals = await api.listMine();
    render();
  }

  function render() {
    const returned = state.deals.filter((d) => d.status === "rejected");
    const shown = state.deals.filter((d) =>
      state.filter === "all" ? true :
      state.filter === "open" ? ["draft", "rejected"].includes(d.status) :
      d.status === state.filter);

    $("app").innerHTML = `
      <header class="top">
        <div class="brand"><span class="brandMark">SIC</span>
          <div><h1>My Deal Sheets</h1><p>${esc(state.userName)} · South Island Commercial (2004) Limited</p></div></div>
        <div class="newDeal">
          <span class="newDealLbl">New deal sheet</span>
          <a class="primary" href="deal-sheet.html">Sale</a>
          <a class="primary alt" href="lease-sheet.html">Lease</a>
        </div>
      </header>

      ${returned.length ? `<div class="warnBanner">
        <strong>${returned.length} deal sheet${returned.length===1?"":"s"} returned by accounts.</strong>
        ${returned.length===1?"It needs":"They need"} correcting and resubmitting — see below.</div>` : ""}

      <div class="tabs">
        ${[["all","All"],["open","Needs attention"],["submitted","Submitted"],["processing","Processing"],["invoiced","Invoiced"]]
          .map(([k,label]) => {
            const n = k === "all" ? state.deals.length
              : k === "open" ? state.deals.filter((d)=>["draft","rejected"].includes(d.status)).length
              : state.deals.filter((d)=>d.status===k).length;
            return `<button class="tab ${state.filter===k?"on":""}" data-tab="${k}">${label}${n?`<span class="badge">${n}</span>`:""}</button>`;
          }).join("")}
      </div>

      ${shown.length ? `<table class="compTable">
        <thead><tr><th>Property</th><th>Type</th><th>Vendor / Lessor</th><th>Purchaser / Tenant</th><th class="r">To invoice</th>
          <th>Updated</th><th>Status</th><th></th></tr></thead>
        <tbody>${shown.map((d) => `<tr data-open="${d.id}" data-type="${d.deal_type || "sale"}">
          <td><strong>${esc(d.property_address || "(no address)")}</strong></td>
          <td><span class="typePill ${d.deal_type === "lease" ? "lease" : "sale"}">${d.deal_type === "lease" ? "Lease" : "Sale"}</span></td>
          <td>${esc(d.vendor_name || "—")}</td>
          <td>${esc(d.purchaser_name || "—")}</td>
          <td class="r mono">${d.total_invoice_ex_gst ? "$"+fmt(d.total_invoice_ex_gst) : "—"}</td>
          <td>${when(d.updated_at || d.submitted_at)}</td>
          <td><span class="pill ${META[d.status].cls}">${META[d.status].label}</span></td>
          <td class="r">${["draft","rejected"].includes(d.status)
            ? `<button class="linkBtn" data-edit="${d.id}" data-type="${d.deal_type || "sale"}">${d.status==="rejected"?"Fix &amp; resubmit":"Continue"}</button>`
            : `<button class="linkBtn" data-print="${d.id}">Print</button>`}</td>
        </tr>`).join("")}</tbody></table>`
        : `<p class="empty">No deal sheets here yet.</p>`}`;

    $("app").querySelectorAll("[data-tab]").forEach((b) =>
      b.onclick = () => { state.filter = b.dataset.tab; render(); });
    $("app").querySelectorAll("[data-edit]").forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); location.href = `${b.dataset.type === "lease" ? "lease-sheet.html" : "deal-sheet.html"}?id=${b.dataset.edit}`; });
    $("app").querySelectorAll("[data-print]").forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); api.openPrint(b.dataset.print); });
    $("app").querySelectorAll("[data-open]").forEach((tr) =>
      tr.onclick = () => location.href = `${tr.dataset.type === "lease" ? "lease-sheet.html" : "deal-sheet.html"}?id=${tr.dataset.open}`);
  }

  (async function boot() {
    if (cfg.DEMO_MODE) $("demoBadge").classList.remove("hidden");
    try {
      const account = await window.DealSheetAuth.init();
      if (!account) return;
      state.userName = account.name || account.username || "";
    } catch (e) {
      $("gate").innerHTML = `<div class="inner">Sign-in failed: ${esc(e.message)}</div>`;
      return;
    }
    try {
      await load();
    } catch (e) {
      if (e.status === 403) {
        $("gate").innerHTML = `<div class="inner gateMsg"><h2>Access not set up yet</h2>
          <p>${esc(e.message)}</p>
          <p class="dim">Send the Object ID above to your administrator.</p></div>`;
        return;
      }
      $("gate").innerHTML = `<div class="inner">Couldn't load your deal sheets: ${esc(e.message)}</div>`;
      return;
    }
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
  })();
})();
