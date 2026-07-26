// /public/js/api.js
// Data layer used by both pages. In DEMO_MODE it runs against an
// in-memory mock backend (below) so the UI is fully clickable
// with zero setup; otherwise it calls /api/deal-sheets/*.

(function () {
  const cfg = window.DealSheetConfig;

  // ───────────────────────── live client ─────────────────────
  async function call(path, { method = "GET", body } = {}) {
    const token = await window.DealSheetAuth.getToken();
    const res = await fetch(`${cfg.apiBase}/api/deal-sheets${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.missing = data?.missing;
      throw err;
    }
    return data;
  }

  const live = {
    listMine: () => call("?scope=mine"),
    saveDraft: (form, id, dealType) =>
      call("", { method: "POST", body: { form, id, dealType } }),
    submit: (id) => call(`/${id}/submit`, { method: "POST" }),
    get: (id) => call(`/${id}`),
    getQueue: (status) => call(`?scope=queue${status ? `&status=${status}` : ""}`),
    getDrafts: () => call(`?scope=drafts`),
    process: (id, nums) => call(`/${id}/process`, { method: "POST", body: nums }),
    setReceipt: (id, receiptNo) => call(`/${id}/receipt`, { method: "POST", body: { receiptNo } }),
    invoice: (id) => call(`/${id}/invoice`, { method: "POST" }),
    returnToBroker: (id, note) => call(`/${id}/return`, { method: "POST", body: { note } }),

    // ---- attachments ----
    async uploadAttachment(id, slot, file) {
      const token = await window.DealSheetAuth.getToken();
      const fd = new FormData();
      fd.append("slot", slot);
      fd.append("file", file);
      const res = await fetch(`${cfg.apiBase}/api/deal-sheets/${id}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }, // no content-type; browser sets multipart boundary
        body: fd,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
      return data; // { slot, name, path, size }
    },
    removeAttachment: (id, slot) => call(`/${id}/attachments?slot=${encodeURIComponent(slot)}`, { method: "DELETE" }),

    // ---- reference data / settings ----
    listBrokers: () => call("/settings?type=brokers"),
    listAllBrokers: () => call("/settings?type=allBrokers"),
    listAdmins: () => call("/settings?type=admins"),
    saveBroker: (b) => call("/settings", { method: "POST", body: { type: "broker", ...b } }),
    saveAdmin: (a) => call("/settings", { method: "POST", body: { type: "admin", ...a } }),
    removeBroker: (code) => call(`/settings?type=broker&code=${encodeURIComponent(code)}`, { method: "DELETE" }),
    removeAdmin: (oid) => call(`/settings?type=admin&oid=${encodeURIComponent(oid)}`, { method: "DELETE" }),

    // ---- print ----
    // Opens the server-rendered printable page in a new tab. The token
    // can't ride in a header for a plain window.open, so the page is
    // fetched and written into the new window instead.
    async openPrint(id) {
      const token = await window.DealSheetAuth.getToken();
      const w = window.open("", "_blank");
      if (!w) { alert("Please allow pop-ups to print."); return; }
      w.document.write("<p style=\"font-family:Segoe UI,Arial,sans-serif;padding:20px\">Preparing print view…</p>");
      const res = await fetch(`${cfg.apiBase}/api/deal-sheets/${id}/print`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { w.document.body.innerHTML = "<p>Could not load the print view.</p>"; return; }
      const html = await res.text();
      w.document.open(); w.document.write(html); w.document.close();
    },
    // returns { url } — a short-lived signed download link
    attachmentUrl: (id, slot) => call(`/${id}/attachments?slot=${encodeURIComponent(slot)}`),
  };

  // ───────────────────────── demo backend ────────────────────
  const demoBrokers = [
    { code:"AS", first_name:"Angus", email:null, active:true },
    { code:"AB", first_name:"Annabelle", email:null, active:true },
    { code:"CK", first_name:"Christian", email:"christian@example.com", active:true },
    { code:"OS", first_name:"Oliver", email:"oliver@example.com", active:true },
    { code:"SS", first_name:"Sam", email:null, active:true },
    { code:"TL", first_name:"Tom", email:null, active:true },
    { code:"WF", first_name:"Will", email:null, active:true },
  ];
  const demoAdmins = [
    { oid:"demo-1", email:"breanna.hodges@collierscanterbury.com", display_name:"Breanna Hodges", role:"office_admin", active:true },
    { oid:"demo-2", email:"anna.small@collierscanterbury.com", display_name:"Anna Small", role:"office_admin", active:true },
    { oid:"demo-3", email:"nishu.singh@collierscanterbury.com", display_name:"Nishu Singh", role:"accounts", active:true },
  ];

  const demoStore = {
    seq: 1043,
    deals: [
      {
        id: "ds-1042", status: "submitted", submitted_at: "2026-07-13T09:12:00",
        salesperson: "OS", division: "Industrial",
        property_address: "76 Columbia Ave", suburb: "Hornby",
        vendor_name: "Kay Margot Hodge and Paget & Associates Trustees Ltd",
        purchaser_name: "Southbase Property Holdings Ltd",
        unconditional_date: "2026-07-08",
        sale_price_ex_gst: 1965000, total_invoice_ex_gst: 136590.27,
        deposit_to_trust: true, confidential: false,
        file_no: "", deal_no: "",
        form: { depositToTrust: true, deposit: { amount: "171766.88", receiptNo: "1436758", method: "Direct credit" },
          checklist: { agencyAgreement: true, unconditionalConfirmation: true, salePriceConfirmation: true, marketingReport: true, spAgreement: true } },
        splits: [
          { party_type: "salesperson", party_name: "Oliver", split_pct: 50, split_amount: 68295.13 },
          { party_type: "salesperson", party_name: "Christian", split_pct: 25, split_amount: 34147.57 },
          { party_type: "salesperson", party_name: "Sam", split_pct: 25, split_amount: 34147.57 },
        ],
        attachments: [
          { slot: "agencyAgreement", file_name: "Agency_Agreement_Columbia_Ave.pdf", content_type: "application/pdf", size_bytes: 284000 },
          { slot: "salePriceConfirmation", file_name: "SP_Agreement_p1.pdf", content_type: "application/pdf", size_bytes: 156000 },
        ],
        events: [{ created_at: "2026-07-13T09:12:00", note: "Submitted by broker", to_status: "submitted" }],
      },
      {
        id: "ds-1041", status: "processing", submitted_at: "2026-07-11T15:40:00",
        salesperson: "CK", division: "Office",
        property_address: "112 Victoria St", suburb: "Christchurch Central",
        vendor_name: "Victoria House Investments Ltd", purchaser_name: null,
        unconditional_date: "2026-07-04",
        sale_price_ex_gst: 3250000, total_invoice_ex_gst: 92500,
        deposit_to_trust: false, confidential: true,
        file_no: "F-26-118", deal_no: "D-3072",
        form: { depositToTrust: false,
          checklist: { agencyAgreement: true, unconditionalConfirmation: true, salePriceConfirmation: true, marketingReport: true } },
        splits: [{ party_type: "salesperson", party_name: "CK", split_pct: 100, split_amount: 92500 }],
        events: [
          { created_at: "2026-07-11T15:40:00", note: "Submitted by broker", to_status: "submitted" },
          { created_at: "2026-07-12T08:55:00", note: "File F-26-118 / Deal D-3072 assigned", to_status: "processing" },
        ],
      },
    ],
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const delay = (v) => new Promise((r) => setTimeout(() => r(clone(v)), 150));
  const findDeal = (id) => demoStore.deals.find((d) => d.id === id);

  const demo = {
    listMine: () => delay(demoStore.deals.map(({ id, status, property_address, vendor_name, total_invoice_ex_gst }) =>
      ({ id, status, property_address, vendor_name, total_invoice_ex_gst }))),
    saveDraft: (form, id, dealType) => {
      let d = id && findDeal(id);
      if (!d) {
        d = { id: `ds-${demoStore.seq++}`, status: "draft", splits: [], events: [] };
        demoStore.deals.unshift(d);
      }
      d.form = clone(form);
      d.property_address = (form.property?.address || "").trim();
      d.vendor_name = form.vendor?.name || "";
      return delay({ id: d.id, status: d.status });
    },
    submit: (id) => {
      const d = findDeal(id);
      d.status = "submitted";
      d.submitted_at = new Date().toISOString();
      d.events.push({ created_at: d.submitted_at, note: "Submitted by broker", to_status: "submitted" });
      return delay({ ok: true, status: "submitted", emailed: true });
    },
    get: (id) => delay(findDeal(id)),
    getQueue: (status) =>
      delay(demoStore.deals.filter((d) => d.status !== "draft" && (!status || d.status === status))),
    getDrafts: () => delay(demoStore.deals.filter((d) => d.status === "draft")),
    setReceipt: (id, receiptNo) => {
      const d = findDeal(id);
      d.form = d.form || {}; d.form.deposit = { ...(d.form.deposit || {}), receiptNo };
      return delay({ ok: true, receiptNo });
    },
    process: (id, { fileNo, dealNo }) => {
      const d = findDeal(id);
      d.status = "processing"; d.file_no = fileNo; d.deal_no = dealNo;
      d.events.push({ created_at: new Date().toISOString(), note: `File ${fileNo} / Deal ${dealNo} assigned`, to_status: "processing" });
      return delay({ ok: true });
    },
    invoice: (id) => {
      const d = findDeal(id);
      d.status = "invoiced";
      d.events.push({ created_at: new Date().toISOString(), note: "Invoice raised — commission approved", to_status: "invoiced" });
      return delay({ ok: true });
    },
    returnToBroker: (id, note) => {
      const d = findDeal(id);
      d.status = "rejected";
      d.events.push({ created_at: new Date().toISOString(), note: `Returned to broker: ${note}`, to_status: "rejected" });
      return delay({ ok: true });
    },

    // ---- attachments (demo: metadata only, no real storage) ----
    uploadAttachment: (id, slot, file) => {
      const d = findDeal(id);
      if (d) { d.form = d.form || {}; d.form.attachments = d.form.attachments || {}; d.form.attachments[slot] = { name: file.name, path: `demo/${id}/${slot}`, size: file.size }; }
      return delay({ slot, name: file.name, path: `demo/${id}/${slot}`, size: file.size });
    },
    removeAttachment: (id, slot) => {
      const d = findDeal(id);
      if (d && d.form && d.form.attachments) delete d.form.attachments[slot];
      return delay({ ok: true });
    },
    attachmentUrl: (id, slot) => delay({ url: "#demo-file-" + slot }),

    listBrokers: () => delay(demoBrokers.filter((b) => b.active)),
    listAllBrokers: () => delay(demoBrokers),
    listAdmins: () => delay(demoAdmins),
    saveBroker: (b) => {
      const i = demoBrokers.findIndex((x) => x.code === b.code.toUpperCase());
      const row = { code: b.code.toUpperCase(), first_name: b.firstName, email: b.email || null, active: true };
      if (i >= 0) demoBrokers[i] = row; else demoBrokers.push(row);
      demoBrokers.sort((a, z) => a.first_name.localeCompare(z.first_name));
      return delay({ ok: true });
    },
    saveAdmin: (a) => {
      const i = demoAdmins.findIndex((x) => x.oid === a.oid);
      const row = { oid: a.oid, email: a.email || null, display_name: a.displayName || null, role: a.role || "office_admin", active: true };
      if (i >= 0) demoAdmins[i] = row; else demoAdmins.push(row);
      return delay({ ok: true });
    },
    removeBroker: (code) => {
      const b = demoBrokers.find((x) => x.code === code); if (b) b.active = false;
      return delay({ ok: true });
    },
    removeAdmin: (oid) => {
      const a = demoAdmins.find((x) => x.oid === oid); if (a) a.active = false;
      return delay({ ok: true });
    },
    openPrint: () => alert("Print preview isn't available in demo mode."),
  };

  window.DealSheetApi = cfg.DEMO_MODE ? demo : live;
})();
