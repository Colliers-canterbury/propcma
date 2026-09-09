// /api/_lib/letters.js
//
// Generates the three accounts "Letters" (Early Release — Vendor,
// Early Release — Purchaser, Disbursement) as editable .docx files by
// merging deal-sheet data into the letterhead templates in
// letter-templates.js. Finance opens the result in Word and edits it —
// filling in anything that isn't sourced from the deal sheet (the file
// REF number and the lawyer's postal address) — before sending, exactly
// as they do today typing these by hand.
//
// The Disbursement letter's "paid to" firm and Trust A/C No. merge from
// the trust deposit fields accounts records on accounts.html
// (form.deposit.balancePaidTo / .trustAccountNo) once Nishu has filled
// them in there — see buildContext() below. Until then they fall back
// to the vendor/landlord solicitor's own firm and a blank, same as
// before that feature existed.
//
// The two Early Release letters use Vendor/Purchaser wording and only
// make sense for sale deals. The Disbursement letter supports both
// sale and lease (Sale/Lease, Purchaser/Tenant wording is chosen here
// from deal_type) — see availableLetters().

import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { TEMPLATES } from "./letter-templates.js";

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
};
const money = (n) => num(n).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nzDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
};
const firstName = (fullName) => String(fullName ?? "").trim().split(/\s+/)[0] || "";

// NZ GST rate — the disbursement letter's "Plus GST" line is calculated
// from this. Update here if the rate ever changes.
const GST_RATE = 0.15;

export const LETTER_LABELS = {
  vendor: "Early Release (Vendor)",
  purchaser: "Early Release (Purchaser)",
  disbursement: "Disbursement letter",
};

export function availableLetters(dealType) {
  return dealType === "lease" ? ["disbursement"] : ["vendor", "purchaser", "disbursement"];
}

function buildContext(deal, type) {
  const f = deal.form || {};
  const isLease = deal.deal_type === "lease";
  const today = nzDate(new Date().toISOString());

  if (type === "vendor") {
    if (isLease) throw new Error("Early release (Vendor) is only available for sale deals");
    const party = f.vendor || {};
    return {
      solicitorName: party.solicitorName || "",
      solicitorFirm: party.solicitorFirm || "",
      solicitorEmail: party.solicitorEmail || "",
      solicitorFirstName: firstName(party.solicitorName),
      letterDate: today,
      propertyAddress: deal.property_address || "",
      vendorName: party.name || deal.vendor_name || "",
    };
  }

  if (type === "purchaser") {
    if (isLease) throw new Error("Early release (Purchaser) is only available for sale deals");
    const party = f.purchaser || {};
    return {
      solicitorName: party.solicitorName || "",
      solicitorFirm: party.solicitorFirm || "",
      solicitorEmail: party.solicitorEmail || "",
      solicitorFirstName: firstName(party.solicitorName),
      letterDate: today,
      propertyAddress: deal.property_address || "",
      purchaserName: party.name || deal.purchaser_name || "",
    };
  }

  if (type === "disbursement") {
    // Vendor for a sale, Landlord for a lease — either way this is the
    // party toRow()/toLeaseRow() already normalised into vendor_name.
    const vendorParty = isLease ? (f.lessor || {}) : (f.vendor || {});
    const deposit = f.deposit || {};
    const commissionAmount = num(deal.total_invoice_ex_gst);
    const gstAmount = commissionAmount * GST_RATE;
    const commissionInclGst = commissionAmount + gstAmount;
    const depositAmount = num(deposit.amount);
    const balanceDueComputed = depositAmount - commissionInclGst;
    // Once accounts has recorded her own Balance Due $ against the trust
    // deposit (accounts.html, after the bank transfer's actually gone
    // through), that recorded figure is the source of truth for the
    // letter — it can differ slightly from the computed figure (bank
    // fees, rounding, a partial deposit). Falls back to the computed
    // figure until she's filled it in.
    const balanceDue = deposit.balanceDue ? num(deposit.balanceDue) : balanceDueComputed;

    return {
      letterDate: today,
      vendorLandlordName: deal.vendor_name || vendorParty.name || "",
      vendorSolicitorFirm: vendorParty.solicitorFirm || "",
      vendorSolicitorEmail: vendorParty.solicitorEmail || "",
      vendorSolicitorName: vendorParty.solicitorName || "",
      vendorSolicitorFirstName: firstName(vendorParty.solicitorName),
      saleOrLease: isLease ? "Lease" : "Sale",
      propertyAddress: deal.property_address || "",
      purchaserOrTenant: isLease ? "Tenant" : "Purchaser",
      purchaserTenantName: deal.purchaser_name || "",
      depositDate: nzDate(deposit.dateReceived),
      depositAmount: money(depositAmount),
      commissionAmount: money(commissionAmount),
      gstAmount: money(gstAmount),
      commissionInclGst: money(commissionInclGst),
      balanceDue: money(balanceDue),
      // Deliberately blank until accounts fills them in on accounts.html
      // (form.deposit.balancePaidTo / .trustAccountNo) — falls back to
      // the vendor/landlord solicitor's own firm for "paid to" so the
      // letter still reads sensibly before that happens.
      balancePaidTo: deposit.balancePaidTo || vendorParty.solicitorFirm || "",
      trustAccountNo: deposit.trustAccountNo || "",
    };
  }

  throw new Error(`Unknown letter type: ${type}`);
}

/** Merge `deal` into the named letter template. Returns a Buffer (.docx). */
export function buildLetter(deal, type) {
  const b64 = TEMPLATES[type];
  if (!b64) throw new Error(`Unknown letter type: ${type}`);
  const context = buildContext(deal, type);

  const zip = new PizZip(Buffer.from(b64, "base64"));
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // A field the broker never filled in (e.g. an older deal submitted
    // before "Solicitor email" existed) should merge as blank, not blow
    // up the whole letter — finance fills the gap in Word same as always.
    nullGetter: () => "",
  });
  doc.render(context);
  return doc.getZip().generate({ type: "nodebuffer" });
}

export function letterFilename(deal, type) {
  const label = LETTER_LABELS[type] || type;
  const addr = (deal.property_address || "Deal").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "Deal";
  return `${label} - ${addr}.docx`;
}
