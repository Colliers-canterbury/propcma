// /api/deal-sheets/[id]/print.js
//
// GET /api/deal-sheets/:id/print — returns a clean, print-styled HTML
// rendering of the deal sheet. The page calls window.print() on load,
// so the browser's own print dialog produces the PDF (Save as PDF).
//
// No PDF library needed: the browser's print engine is consistent,
// handles pagination, and adds no serverless cold-start cost.
//
// Readable by the creator (office admin) or accounts/manager.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => {
  if (n == null || n === "") return "—";
  // Values coming straight from deal.form.* may now be comma-formatted
  // strings (the forms live-format $ fields as the user types) — strip
  // that before parsing, or Number() returns NaN for e.g. "2,000.00".
  const v = typeof n === "number" ? n : parseFloat(String(n).replace(/[$,\s]/g, ""));
  return isNaN(v) ? "—" : "$" + v.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const yn = (b) => b ? "Yes" : "No";
const nzDate = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return esc(String(v));
  return d.toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" });
};
const dash = (v) => (v === null || v === undefined || v === "") ? "—" : esc(v);

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    const user = await requireUser(req);
    const { id } = req.query;

    const { data: deal, error } = await supabase
      .from("deal_sheets").select("*").eq("id", id).single();
    if (error || !deal) throw new HttpError(404, "Deal sheet not found");

    const isOwner = deal.created_by === user.oid;
    const isStaff = ["accounts", "manager"].includes(user.role);
    if (!isOwner && !isStaff) throw new HttpError(403, "Not permitted");

    const [{ data: splits }, { data: attachments }, { data: brokers }] = await Promise.all([
      supabase.from("deal_sheet_splits").select("*").eq("deal_id", id),
      supabase.from("deal_sheet_attachments").select("slot, file_name").eq("deal_id", id),
      supabase.from("brokers").select("code, first_name"),
    ]);

        // Who filed it (office admin)
    const { data: creator } = await supabase.from("app_users")
      .select("display_name, email").eq("oid", deal.created_by).maybeSingle();

    const render = deal.deal_type === "lease" ? renderLeasePrintable : renderPrintable;
    const html = render(deal, splits || [], attachments || [], brokers || [],
      creator?.display_name || creator?.email || "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (e) {
    sendError(res, e);
  }
}

const PRINT_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1A2233; font-size: 11pt; margin: 0; }
  header { border-bottom: 3px solid #25408F; padding-bottom: 10px; margin-bottom: 14px;
           display: flex; justify-content: space-between; align-items: flex-start; }
  h1 { font-size: 16pt; margin: 0; }
  .sub { color: #66708A; font-size: 9.5pt; margin-top: 2px; }
  .nums { text-align: right; font-size: 9.5pt; }
  .nums b { font-size: 11pt; }
  h2 { font-size: 11.5pt; margin: 16px 0 6px; padding-bottom: 3px;
       border-bottom: 1px solid #DCE2EC; color: #25408F; }
  h3 { font-size: 10pt; margin: 10px 0 4px; color: #66708A; text-transform: uppercase; letter-spacing: .4px; }
  table { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; font-weight: 600; color: #66708A; width: 34%;
                padding: 3px 8px 3px 0; vertical-align: top; font-size: 10pt; }
  table.kv td { padding: 3px 0; vertical-align: top; }
  table.grid th { text-align: left; font-size: 9pt; text-transform: uppercase; color: #66708A;
                  border-bottom: 1px solid #DCE2EC; padding: 4px 6px; }
  table.grid td { padding: 4px 6px; border-bottom: 1px solid #EEF1F6; }
  .r { text-align: right; }
  .total td { border-top: 2px solid #25408F; font-weight: 700; padding-top: 6px; }
  ul.checks { list-style: none; padding: 0; margin: 0; font-size: 10pt; }
  ul.checks li { padding: 2px 0; }
  ul.checks li::before { content: "\\2713  "; font-weight: 700; }
  ul.checks li.no::before { content: "\\2717  "; }
  .two { display: flex; gap: 24px; }
  .two > div { flex: 1; }
  footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #DCE2EC;
           color: #66708A; font-size: 8.5pt; display: flex; justify-content: space-between; }
  .avoid { page-break-inside: avoid; }
  @media print { .noprint { display: none; } }
  table.grid td.lbl { color:#66708A; }
  .sub2 { font-size:9pt; color:#66708A; margin:-2px 0 6px; }
`;

const STATUS_LABELS = {
  draft: "Draft", submitted: "Submitted", invoiced: "Invoiced",
  deposit_received: "Deposit Received", complete: "Complete", rejected: "Returned",
};

function renderPrintable(deal, splits, attachments, brokers, preparedBy) {
  const f = deal.form || {};
  const sale = f.sale || {};
  const comm = f.comm || {};
  const chk = f.checklist || {};
  const nameOf = (code) => (brokers.find((b) => b.code === code) || {}).first_name || code;
  const dealBrokers = (f.ownership?.salespeople || []).map(nameOf).join(", ");

  // Comma-safe number parsing — form fields live-format with thousands
  // separators as the user types, so this strips that before parsing.
  const num = (v) => { const x = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return isNaN(x) ? 0 : x; };

  // Tiered commission: mirrors the same calculation used in the form
  // itself (public/js/form.js) and at submit time (api/_lib/deals.js) —
  // each tier's base is whatever's left of the sale price after the
  // tiers above it, unless a tier has an explicit typed amount.
  const salePrice = num(deal.sale_price_ex_gst ?? sale.salePrice);
  const tierBases = [];
  let remaining = salePrice;
  (comm.tiers || []).forEach((t, i) => {
    const typed = t.base !== "" && t.base != null;
    const base = typed ? num(t.base) : Math.max(remaining, 0);
    tierBases[i] = base;
    remaining -= base;
  });
  const tierFees = (comm.tiers || []).map((t, i) => (num(t.pct) / 100) * tierBases[i]);

  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
  const party = (p, title, solicitor) => !p?.name ? "" : `
    <h3>${title}</h3>
    <table class="kv">
      ${row("Name", dash(p.name))}
      ${row("Contact", dash(p.contactName))}
      ${row("Phone", dash(p.phone))}
      ${row("Email", dash(p.email))}
      ${row("Postal address", [p.postalAddress, p.city, p.postcode, p.country].filter(Boolean).map(esc).join(", ") || "—")}
      ${solicitor && p.solicitorName ? row("Solicitor", `${esc(p.solicitorName)}${p.solicitorFirm ? ", " + esc(p.solicitorFirm) : ""}${p.solicitorPhone ? " · " + esc(p.solicitorPhone) : ""}`) : ""}
    </table>`;

  return `<!DOCTYPE html>
<html lang="en-NZ"><head><meta charset="utf-8" />
<title>Deal Sheet — ${esc(deal.property_address || "")}</title>
<style>${PRINT_CSS}</style></head>
<body onload="window.print()">
<header>
  <div><h1>Deal Sheet — Sales Record</h1>
    <div class="sub">South Island Commercial (2004) Limited · Colliers</div></div>
  <div class="nums">
    <div>File No. <b>${dash(deal.file_no)}</b></div>
    <div>Deal No. <b>${dash(deal.deal_no)}</b></div>
    <div class="sub">Status: ${esc(STATUS_LABELS[deal.status] || deal.status)}</div>
  </div>
</header>

<h2>Deal ownership</h2>
<table class="kv">
  ${row("Salespeople", dash(dealBrokers))}
  ${row("Division", dash(f.ownership?.division))}
  ${row("Office", dash(f.ownership?.office))}
</table>

<h2>Property</h2>
<table class="kv">
  ${row("Address", dash(deal.property_address || f.property?.address))}
  ${row("Building name", dash(f.property?.buildingName))}
  ${row("Property type", dash(f.property?.propertyType))}
  ${row("Level", dash(f.property?.level))}
  ${row("City", dash(f.property?.city))}
</table>

<div class="two avoid">
  <div>${party(f.vendor, "Vendor", true)}</div>
  <div>${party(f.purchaser, "Purchaser", true)}</div>
</div>
${f.billingDifferent ? party(f.billing, "Billing entity", false) : ""}

<h2>Sale details</h2>
<table class="kv">
  ${row("Date of agreement", dash(sale.dateOfAgreement))}
  ${row("Unconditional date", dash(sale.unconditionalDate))}
  ${row("Sale price (excl GST)", money(deal.sale_price_ex_gst))}
  ${row(`${esc(sale.rentalBasis || "Net")} rental income`, sale.rentalIncome ? money(sale.rentalIncome) : "—")}
  ${row("Yield", sale.yieldManual ? esc(sale.yieldManual) + " %" : "—")}
  ${row("Title", dash(sale.titleType))}
  ${row("Land area (sqm)", dash(sale.landArea))}
  ${row("Occupied by area (sqm)", dash(sale.occupiedArea))}
  ${row("WALE (years)", dash(sale.wale))}
  ${row("No. of tenancies", dash(sale.tenancies))}
  ${row("Sold at auction", yn(sale.auction))}
  ${row("Tenancy schedule attached", yn(sale.tenancySchedule))}
</table>

${deal.deposit_to_trust ? `
<h2>Trust deposit</h2>
<table class="kv">
  ${row("Amount", money(f.deposit?.amount))}
  ${row("Date received", nzDate(f.deposit?.dateReceived))}
  ${row("Trust receipt no.", dash(f.deposit?.receiptNo))}
  ${row("Early release required", yn(f.deposit?.earlyRelease))}
</table>` : ""}

<h2 class="avoid">Commission</h2>
<table class="grid avoid">
  <thead><tr><th>Item</th><th class="r">%</th><th class="r">Amount</th></tr></thead>
  <tbody>
    ${(comm.tiers || []).map((t, i) => t.pct ? `<tr><td>${["Commission","Second tier","Third tier"][i]}</td>
      <td class="r">${esc(t.pct)}%</td><td class="r">${money(tierFees[i])}</td></tr>` : "").join("")}
    ${comm.otherFee ? `<tr><td>Other — ${dash(comm.otherDesc)}</td><td class="r"></td><td class="r">${money(comm.otherFee)}</td></tr>` : ""}
    ${comm.adminFee ? `<tr><td>Administration fee</td><td class="r"></td><td class="r">${money(500)}</td></tr>` : ""}
    ${comm.recoverMarketing ? `<tr><td>Recover marketing costs</td><td class="r"></td><td class="r">${money(comm.recoverMarketing)}</td></tr>` : ""}
    ${comm.recoverOther ? `<tr><td>Recover other — ${dash(comm.recoverOtherDesc)}</td><td class="r"></td><td class="r">${money(comm.recoverOther)}</td></tr>` : ""}
    <tr class="total"><td>Total to invoice (excl GST)</td><td></td><td class="r">${money(deal.total_invoice_ex_gst)}</td></tr>
  </tbody>
</table>

<h2 class="avoid">Commission split</h2>
<table class="grid avoid">
  <thead><tr><th>Party</th><th class="r">%</th><th class="r">Amount</th></tr></thead>
  <tbody>${splits.map((s) => `<tr><td>${esc(s.party_name)}${s.party_type === "third_party" ? " <em>(third party)</em>" : ""}</td>
    <td class="r">${s.split_pct}%</td><td class="r">${money(s.split_amount)}</td></tr>`).join("") ||
    `<tr><td colspan="3">—</td></tr>`}</tbody>
</table>

<h2 class="avoid">Source</h2>
<table class="kv avoid">
  ${row("Buyer source", dash(f.buyerSource === "Other" ? f.buyerSourceOther : f.buyerSource))}
  ${row("Listing source", dash(f.listingSource === "Other" ? f.listingOther : f.listingSource))}
  ${f.listingSource === "Referral" ? row("Referral from", `${dash(f.listingReferralWho)} (internal: ${dash(f.listingReferralInternal)})`) : ""}
</table>

<h2 class="avoid">Mandatory checklist</h2>
<ul class="checks avoid">
  <li class="${chk.agencyAgreement ? "" : "no"}">Signed agency agreement</li>
  <li class="${chk.unconditionalConfirmation ? "" : "no"}">Confirmation of unconditional</li>
  <li class="${chk.executedAgreement ? "" : "no"}">Executed sale &amp; purchase agreement</li>
  <li class="${chk.marketingReport ? "" : "no"}">Marketing campaign report</li>
  <li class="${chk.amlComplete ? "" : "no"}">AML complete</li>
  ${deal.deposit_to_trust ? `<li class="${chk.spAgreement ? "" : "no"}">S&amp;P agreement (trust deal)</li>` : ""}
</ul>
${attachments.length ? `<h3>Attached documents</h3><ul class="checks">${
  attachments.map((a) => `<li>${esc(a.file_name)}</li>`).join("")}</ul>` : ""}

<h2 class="avoid">Sign-off</h2>
<table class="kv avoid">
  ${row("Prepared by", dash(preparedBy))}
  ${row("Submitted", deal.submitted_at ? new Date(deal.submitted_at).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" }) : "—")}
</table>

<footer>
  <span>Deal sheet ${esc(deal.id)}</span>
  <span>Printed ${new Date().toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" })}</span>
</footer>
</body></html>`;
}

/**
 * Printable Leasing Record. Same visual language as the sales sheet
 * (shared PRINT_CSS) but laid out around the lease: lessor/lessee,
 * lease terms, the rental schedule, and the leasing checklist.
 */
function renderLeasePrintable(deal, splits, attachments, brokers, preparedBy) {
  const f = deal.form || {};
  const lease = f.lease || {};
  const rental = f.rental || {};
  const comm = f.comm || {};
  const chk = f.checklist || {};
  const nameOf = (code) => (brokers.find((b) => b.code === code) || {}).first_name || code;
  const dealBrokers = (f.ownership?.salespeople || []).map(nameOf).join(", ");

  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
  const party = (p, title, solicitor) => !p?.name ? "" : `
    <h3>${title}</h3>
    <table class="kv">
      ${row("Name", dash(p.name))}
      ${row("Contact", dash(p.contactName))}
      ${row("Phone", dash(p.phone))}
      ${row("Email", dash(p.email))}
      ${row("Postal address", [p.postalAddress, p.city, p.postcode, p.country].filter(Boolean).map(esc).join(", ") || "—")}
      ${solicitor && p.solicitorName ? row("Solicitor", `${esc(p.solicitorName)}${p.solicitorFirm ? ", " + esc(p.solicitorFirm) : ""}${p.solicitorPhone ? " · " + esc(p.solicitorPhone) : ""}`) : ""}
    </table>`;

  // ---- rental schedule ----
  const LINES = [
    { key:"retail",    label:"Retail",         unit:"sqm"  },
    { key:"office",    label:"Office",         unit:"sqm"  },
    { key:"warehouse", label:"Warehouse",      unit:"sqm"  },
    { key:"canopy",    label:"Canopy / Deck",  unit:"sqm"  },
    { key:"naming",    label:"Naming Rights",  unit:null   },
    { key:"carparks",  label:"Carparks",       unit:"cpks" },
    { key:"other1",    label:"Other",          unit:null   },
    { key:"other2",    label:"Other",          unit:null   },
  ];
  const n = (v) => { const x = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return isNaN(x) ? 0 : x; };

  let netRental = 0;
  const rentalRows = LINES.map((l) => {
    const line = rental[l.key] || {};
    const isOther = l.key === "other1" || l.key === "other2";
    let total;
    if (l.key === "carparks") total = n(line.qty) * n(line.rate) * 52;
    else if (l.unit === "sqm") total = n(line.qty) * n(line.rate);
    else total = n(line.total);
    if (l.unit && line.total !== "" && line.total != null) total = n(line.total);
    if (!n(line.qty) && !n(line.rate) && !total) return "";   // skip empty lines
    netRental += total;
    // "Other" lines show their description instead of the generic label.
    const label = isOther && line.desc ? esc(line.desc) : l.label;
    return `<tr>
      <td class="lbl">${label}</td>
      <td class="r">${line.qty ? esc(line.qty) + (l.unit === "cpks" ? "" : " m²") : "—"}</td>
      <td class="r">${line.rate ? money(line.rate) + (l.key === "carparks" ? " pppw" : " /m²") : "—"}</td>
      <td class="r">${money(total)}</td></tr>`;
  }).join("");

  const opex = n(rental.opex);
  const grossRental = netRental + opex;

  const adminFee = comm.adminFee ? 500 : 0;
  const totalInvoice = n(comm.fee) + n(comm.otherFee) + adminFee
    + n(comm.recoverMarketing) + n(comm.recoverOther);

  const rorText = lease.rorTimes
    ? `${esc(lease.rorTimes)} × ${dash(lease.rorYears)} year${n(lease.rorYears) === 1 ? "" : "s"}`
    : "—";

  return `<!DOCTYPE html>
<html lang="en-NZ"><head><meta charset="utf-8" />
<title>Deal Sheet (Lease) — ${esc(deal.property_address || "")}</title>
<style>${PRINT_CSS}</style></head>
<body onload="window.print()">
<header>
  <div><h1>Deal Sheet — Leasing Record</h1>
    <div class="sub">South Island Commercial (2004) Limited · Colliers</div></div>
  <div class="nums">
    <div>File No. <b>${dash(deal.file_no)}</b></div>
    <div>Deal No. <b>${dash(deal.deal_no)}</b></div>
    <div class="sub">Status: ${esc(STATUS_LABELS[deal.status] || deal.status)}</div>
  </div>
</header>

<h2>Deal ownership</h2>
<table class="kv">
  ${row("Salespeople", dash(dealBrokers))}
  ${row("Division", dash(f.ownership?.division))}
  ${row("Office", dash(f.ownership?.office))}
</table>

<h2>Property</h2>
<table class="kv">
  ${row("Address", dash(deal.property_address || f.property?.address))}
  ${row("Building name", dash(f.property?.buildingName))}
  ${row("Property type", dash(f.property?.propertyType))}
  ${row("Level / Unit", [f.property?.level, f.property?.unit].filter(Boolean).map(esc).join(" / ") || "—")}
  ${row("City", dash(f.property?.city))}
</table>

<div class="two avoid">
  <div>${party(f.lessor, "Landlord", true)}
    ${f.lessor?.parentCompany ? `<table class="kv">${row("Parent company", dash(f.lessor.parentCompany))}</table>` : ""}</div>
  <div>${party(f.lessee, "Tenant", true)}
    ${f.invoiceToLessee ? `<p class="sub2">Invoice to be raised to the Tenant.</p>` : ""}</div>
</div>
${f.billingDifferent ? party(f.billing, "Billing entity", false) : ""}

<h2>Lease details</h2>
<table class="kv">
  ${row("Date of agreement", nzDate(lease.dateOfAgreement))}
  ${row("Unconditional date", nzDate(lease.unconditionalDate))}
  ${row("Occupancy date", nzDate(lease.occupancyDate))}
  ${row("Commencement date", nzDate(lease.commencementDate))}
  ${row("Expiry date", nzDate(lease.expiryDate))}
  ${row("Lease term", lease.termYears ? esc(lease.termYears) + " years" : "—")}
  ${row("Rights of renewal", rorText)}
  ${row("Rent review period", dash(lease.rentReviewPeriod))}
  ${row("Deal type", dash(lease.dealType))}
  ${row("Lease basis", dash(lease.leaseBasis))}
  ${row("Incentives", dash(lease.incentives))}
</table>

<h2 class="avoid">Rental schedule</h2>
<table class="grid avoid">
  <thead><tr><th>Component</th><th class="r">Area / Number</th><th class="r">Rate</th><th class="r">Total p.a.</th></tr></thead>
  <tbody>
    ${rentalRows || `<tr><td colspan="4">—</td></tr>`}
    <tr><td class="lbl" colspan="3"><strong>Total Net Rental (excl GST)</strong></td>
      <td class="r"><strong>${money(netRental)}</strong></td></tr>
    ${opex ? `<tr><td class="lbl" colspan="3">Plus Opex</td><td class="r">${money(opex)}</td></tr>` : ""}
    <tr class="total"><td colspan="3">Total Gross Rental (excl GST) p.a.</td>
      <td class="r">${money(grossRental)}</td></tr>
  </tbody>
</table>

${deal.deposit_to_trust ? `
<h2>Trust deposit</h2>
<table class="kv">
  ${row("Amount", money(f.deposit?.amount))}
  ${row("Date received", nzDate(f.deposit?.dateReceived))}
  ${row("Trust receipt no.", dash(f.deposit?.receiptNo))}
  ${row("Early release required", yn(f.deposit?.earlyRelease))}
</table>` : ""}

<h2 class="avoid">Commission</h2>
<table class="grid avoid">
  <thead><tr><th>Item</th><th>Description</th><th class="r">Amount</th></tr></thead>
  <tbody>
    ${comm.fee ? `<tr><td>Commission (per scale of fees)</td><td>${dash(comm.feeDesc)}</td><td class="r">${money(comm.fee)}</td></tr>` : ""}
    ${comm.otherFee ? `<tr><td>Other / consultancy</td><td>${dash(comm.otherDesc)}</td><td class="r">${money(comm.otherFee)}</td></tr>` : ""}
    ${adminFee ? `<tr><td>Administration fee</td><td></td><td class="r">${money(500)}</td></tr>` : ""}
    ${comm.recoverMarketing ? `<tr><td>Recover marketing costs</td><td></td><td class="r">${money(comm.recoverMarketing)}</td></tr>` : ""}
    ${comm.recoverOther ? `<tr><td>Recover other costs</td><td>${dash(comm.recoverOtherDesc)}</td><td class="r">${money(comm.recoverOther)}</td></tr>` : ""}
    <tr class="total"><td colspan="2">Total to invoice (excl GST)</td><td class="r">${money(totalInvoice)}</td></tr>
  </tbody>
</table>

<h2 class="avoid">Commission split</h2>
<table class="grid avoid">
  <thead><tr><th>Party</th><th class="r">%</th><th class="r">Amount</th></tr></thead>
  <tbody>${splits.map((s) => `<tr><td>${esc(s.party_name)}${s.party_type === "third_party" ? " <em>(third party)</em>" : ""}</td>
    <td class="r">${s.split_pct}%</td><td class="r">${money(s.split_amount)}</td></tr>`).join("") ||
    `<tr><td colspan="3">—</td></tr>`}</tbody>
</table>

<h2 class="avoid">Tenant source</h2>
<table class="kv avoid">
  ${row("Source", dash(f.tenantSource === "Other" ? f.tenantSourceOther : f.tenantSource))}
  ${f.tenantSource === "Referral" ? row("Referral from", dash(f.tenantReferralWho)) : ""}
</table>

<h2 class="avoid">Mandatory checklist</h2>
<ul class="checks avoid">
  <li class="${chk.agencyAgreement ? "" : "no"}">Signed agency agreement</li>
  <li class="${chk.unconditionalConfirmation ? "" : "no"}">Confirmation of unconditional</li>
  <li class="${chk.leaseValueConfirmation ? "" : "no"}">Confirmation of lease value</li>
  <li class="${chk.marketingReport ? "" : "no"}">Marketing campaign report</li>
  <li class="${chk.amlComplete ? "" : "no"}">AML complete</li>
  <li class="${chk.leaseDeed ? "" : "no"}">Lease deed</li>
  ${deal.deposit_to_trust ? `<li class="${chk.appraisals ? "" : "no"}">Appraisals (trust deal)</li>` : ""}
</ul>
${attachments.length ? `<h3>Attached documents</h3><ul class="checks">${
  attachments.map((a) => `<li>${esc(a.file_name)}</li>`).join("")}</ul>` : ""}

<h2 class="avoid">Sign-off</h2>
<table class="kv avoid">
  ${row("Prepared by", dash(preparedBy))}
  ${row("Submitted", deal.submitted_at ? new Date(deal.submitted_at).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" }) : "—")}
</table>

<footer>
  <span>Leasing deal sheet ${esc(deal.id)}</span>
  <span>Printed ${new Date().toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" })}</span>
</footer>
</body></html>`;
}
