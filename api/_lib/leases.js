// /api/_lib/leases.js
//
// Leasing deal sheets. Sales and leases share the deal_sheets table
// (distinguished by deal_type) and share the commission SPLIT model —
// but a lease captures a rental schedule rather than a sale price, and
// its commission fees are entered manually rather than calculated from
// a percentage of a sale price.

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[$,\s%]/g, ""));
  return isNaN(n) ? 0 : n;
};

/** The rental schedule lines, in display order. */
export const RENTAL_LINES = [
  { key: "retail",    label: "Retail",         unit: "sqm" },
  { key: "office",    label: "Office",         unit: "sqm" },
  { key: "warehouse", label: "Warehouse",      unit: "sqm" },
  { key: "industrial",label: "Industrial",     unit: "sqm" },
  { key: "yard",      label: "Yard",           unit: "sqm" },
  { key: "canopy",    label: "Canopy / Deck",  unit: "sqm" },
  { key: "naming",    label: "Naming Rights",  unit: null  },  // total only
  { key: "carparks",  label: "Carparks",       unit: "cpks" }, // rate is per park per week
  { key: "other1",    label: "Other",          unit: null  },
  { key: "other2",    label: "Other",          unit: null  },
];

/**
 * Recompute derived figures for a lease.
 *
 * Rental schedule:
 *   - Area lines (retail/office/warehouse/canopy): area × rate per sqm
 *   - Carparks: number × rate per park per week × 52
 *   - Naming rights / Other: a total is entered directly
 *   Total Net Rental = sum of the above
 *   Total Gross Rental = Net + Opex
 *
 * Commission (manual entry — no percentage calculation):
 *   Total invoiced = commission fee + other/consultancy + admin fee
 *                    + marketing recovery + other recovery
 *
 * Splits follow the same Option B model as sales:
 *   - Third parties take their % of the COMMISSION (excl. the $500
 *     administration fee)
 *   - Salespeople split the REMAINDER, and must total 100%
 */
export function computeLeaseDerived(form) {
  const r = form.rental || {};

  // ---- rental schedule ----
  const lineTotals = {};
  for (const { key, unit } of RENTAL_LINES) {
    const line = r[key] || {};
    if (key === "carparks") {
      // rate is per park per week
      lineTotals[key] = num(line.qty) * num(line.rate) * 52;
    } else if (unit === "sqm") {
      lineTotals[key] = num(line.qty) * num(line.rate);
    } else {
      lineTotals[key] = num(line.total);
    }
    // An explicitly entered total always wins over the computed one.
    if (line.total !== "" && line.total != null && unit) {
      lineTotals[key] = num(line.total);
    }
  }

  const calcNet = Object.values(lineTotals).reduce((a, b) => a + b, 0);
  const opex = num(r.opex);
  // Manual overrides win over the calculated figures when present.
  const ov = form.rentalOverride || {};
  const netRental = ov.net !== "" && ov.net != null ? num(ov.net) : calcNet;
  const grossRental = ov.gross !== "" && ov.gross != null ? num(ov.gross) : netRental + opex;

  // ---- commission (manual amounts) ----
  const adminFee = form.comm?.adminFee ? 500 : 0;
  const commissionFee = num(form.comm?.fee);
  const recoverMarketing = num(form.comm?.recoverMarketing);
  const recoverOther = num(form.comm?.recoverOther);
  const totalInvoice =
    commissionFee +
    num(form.comm?.otherFee) +
    adminFee +
    recoverMarketing +
    recoverOther;

  // ---- splits (Option B, identical to sales) ----
  // commissionBase is the actual commission-earning amount — the admin
  // fee and cost recoveries are pass-throughs, not commission, so
  // neither third parties nor salespeople take a share of them.
  const commissionBase = totalInvoice - adminFee - recoverMarketing - recoverOther;

  // A split can be a fixed $ amount OR a percentage. Fixed wins when set.
  const splitAmt = (s, base) => num(s.fixed) > 0 ? num(s.fixed) : +((num(s.pct) / 100) * base).toFixed(2);

  const thirdPartyRows = (form.thirdParty || [])
    .filter((s) => num(s.pct) > 0 || num(s.fixed) > 0)
    .map((s) => ({
      party_type: "third_party",
      party_name: s.name || "(unnamed)",
      split_pct: num(s.pct),
      split_amount: splitAmt(s, commissionBase),
    }));

  const thirdPartyTotal = thirdPartyRows.reduce((a, s) => a + s.split_amount, 0);
  const thirdPartyPctTotal = thirdPartyRows.reduce((a, s) => a + s.split_pct, 0);
  const internalPool = +(commissionBase - thirdPartyTotal).toFixed(2);

  const internalRows = (form.splits || [])
    .filter((s) => num(s.pct) > 0 || num(s.fixed) > 0)
    .map((s) => ({
      party_type: "salesperson",
      party_name: s.person || "(unnamed)",
      split_pct: num(s.pct),
      split_amount: splitAmt(s, internalPool),
    }));

  const internalPctTotal = internalRows.reduce((a, s) => a + s.split_pct, 0);
  const internalPaid = internalRows.reduce((a, s) => a + s.split_amount, 0);
  // With fixed amounts in the mix, validate that the paid-out internal
  // total matches the pool, rather than requiring the %s to sum to 100.
  const internalOk = internalRows.length === 0
    || Math.abs(internalPaid - internalPool) < 1;

  // Total area across the sqm lines — used for rate per sqm on the
  // PropCMA comparable.
  const totalArea = RENTAL_LINES
    .filter((l) => l.unit === "sqm")
    .reduce((a, l) => a + num((r[l.key] || {}).qty), 0);

  return {
    lineTotals,
    netRental: +netRental.toFixed(2),
    calcNet: +calcNet.toFixed(2),
    opex,
    grossRental: +grossRental.toFixed(2),
    totalArea,
    adminFee,
    totalInvoice: +totalInvoice.toFixed(2),
    commissionBase: +commissionBase.toFixed(2),
    thirdPartyTotal: +thirdPartyTotal.toFixed(2),
    thirdPartyPctTotal,
    internalPool,
    internalPctTotal,
    internalPaid: +internalPaid.toFixed(2),
    internalOk,
    splits: [...internalRows, ...thirdPartyRows],
  };
}

/** Map a lease form to the deal_sheets row. */
export function toLeaseRow(form, derived) {
  const p = form.property || {};
  const l = form.lease || {};
  return {
    deal_type: "lease",
    salesperson: (form.ownership?.salespeople || []).join(",") || null,
    division: form.ownership?.division || null,
    property_address: (p.address || "").trim() || null,
    suburb: null,
    city: p.city || null,
    // Lessor/Lessee occupy the same workflow role as Vendor/Purchaser.
    vendor_name: form.lessor?.name || null,
    purchaser_name: form.lessee?.name || null,
    date_of_agreement: l.dateOfAgreement || null,
    unconditional_date: l.unconditionalDate || null,
    // Total GROSS annual rental goes to sale_price on the comparable,
    // so leases compare on a consistent annual basis.
    sale_price_ex_gst: derived.grossRental || null,
    total_invoice_ex_gst: derived.totalInvoice || null,
    lease_term_years: num(l.termYears) || null,
    annual_gross_rent: derived.grossRental || null,
    annual_net_rent: derived.netRental || null,
    wale_years: null,
    deposit_to_trust: !!form.depositToTrust,
    confidential: !!form.confidential,
    property_id: form.propertyId || null,
    form,
  };
}

/** Submit-time validation for a lease. Returns [] when ready. */
export function validateLeaseForSubmit(form, derived) {
  const missing = [];
  const l = form.lease || {};

  if (!form.ownership?.salespeople?.length) missing.push("Salesperson");
  if (!form.property?.address || !form.property.address.trim())
    missing.push("Property address");
  if (!form.lessor?.name) missing.push("Lessor name");
  if (!form.lessee?.name) missing.push("Lessee name");
  if (!l.dateOfAgreement) missing.push("Date of agreement");
  if (!l.commencementDate) missing.push("Commencement date");
  if (!l.termYears) missing.push("Lease term");
  if (!derived.grossRental) missing.push("Rental schedule");
  if (!derived.totalInvoice) missing.push("Commission amount");
  if (derived.internalPaid === 0) missing.push("Commission split");
  else if (!derived.internalOk)
    missing.push("Salesperson split must balance to the pool");
  if (derived.thirdPartyTotal >= derived.totalInvoice)
    missing.push("Third-party share can't exceed the commission");
  if (!form.tenantSource) missing.push("Tenant source");

  const c = form.checklist || {};
  if (!c.agencyAgreement) missing.push("Checklist — signed agency agreement");
  if (!c.unconditionalConfirmation) missing.push("Checklist — confirmation of unconditional");
  if (!c.leaseValueConfirmation) missing.push("Checklist — confirmation of lease value");
  if (!c.amlComplete) missing.push("Checklist — AML complete");
  if (!c.leaseDeed) missing.push("Checklist — lease deed");

  return missing;
}
