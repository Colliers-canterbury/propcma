// /api/_lib/deals.js
// Server-side mirror of the form's maths and validation, so the
// stored figures are computed from the payload — never trusted
// from the client.

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
};

/** Recompute derived figures from the raw form payload.
 *
 * Commission model (Option B):
 *   - Total invoiced = tiers + other + admin fee + recoveries
 *   - Third parties take their % of the COMMISSION (excl. the $500
 *     administration fee — that's the office's cost recovery, not
 *     commission, so conjunctional parties don't share it).
 *   - Internal brokers split the REMAINDER (total invoiced less the
 *     third-party share). Their % must total 100% of that remainder.
 *   - Everything therefore reconciles: third-party $ + internal $
 *     = total invoiced.
 */
export function computeDerived(form) {
  const salePrice = num(form.sale?.salePrice);

  // Tiered commission: each tier's base is its typed amount, or the
  // remainder of the sale price after the tiers above it. Mirrors the
  // form's derive() so stored totals match what the user saw.
  let remaining = salePrice;
  const tierFees = (form.comm?.tiers || []).map((t) => {
    const typed = t.base !== "" && t.base != null;
    const base = typed ? num(t.base) : Math.max(remaining, 0);
    remaining -= base;
    return (num(t.pct) / 100) * base;
  });

  const adminFee = form.comm?.adminFee ? 500 : 0;
  const recoverMarketing = num(form.comm?.recoverMarketing);
  const recoverOther = num(form.comm?.recoverOther);
  // Deducted from the commission itself (not a pass-through cost
  // recovery like recoverMarketing/recoverOther above), so it comes off
  // before commissionBase is worked out below — third parties and
  // salespeople are paid on the reduced amount.
  const deductMarketing = num(form.comm?.deductMarketing);

  // Flat Fee mode: a single typed dollar figure replaces the whole
  // tiered %-of-sale-price calculation.
  const commissionFee = form.comm?.flatFee ? num(form.comm?.flatFeeAmount) : tierFees.reduce((a, b) => a + b, 0);

  const totalInvoice =
    commissionFee +
    num(form.comm?.otherFee) +
    adminFee +
    recoverMarketing +
    recoverOther -
    deductMarketing;

  // Base the third-party share (and, in turn, the internal pool) is
  // calculated on. The admin fee and cost recoveries are pass-throughs,
  // not commission, so neither third parties nor salespeople take a
  // share of them. The marketing deduction, by contrast, reduces the
  // commission itself, so it stays baked into totalInvoice here rather
  // than being added back.
  const commissionBase = totalInvoice - adminFee - recoverMarketing - recoverOther;

  const thirdPartyRows = (form.thirdParty || [])
    .filter((s) => num(s.pct) > 0)
    .map((s) => ({
      party_type: "third_party",
      party_name: s.name || "(unnamed)",
      split_pct: num(s.pct),
      split_amount: +((num(s.pct) / 100) * commissionBase).toFixed(2),
    }));

  const thirdPartyTotal = thirdPartyRows.reduce((a, s) => a + s.split_amount, 0);
  const thirdPartyPctTotal = thirdPartyRows.reduce((a, s) => a + s.split_pct, 0);

  // What internal brokers divide between them.
  // Salespeople DO split the admin fee between them (third parties
  // still don't) — added back in here, after the third-party share
  // is taken out of the pure commission.
  const internalPool = +((commissionBase - thirdPartyTotal) + adminFee).toFixed(2);

  const internalRows = (form.splits || [])
    .filter((s) => num(s.pct) > 0)
    .map((s) => ({
      party_type: "salesperson",
      party_name: s.person || "(unnamed)",
      split_pct: num(s.pct),
      split_amount: +((num(s.pct) / 100) * internalPool).toFixed(2),
    }));

  const internalPctTotal = internalRows.reduce((a, s) => a + s.split_pct, 0);

  return {
    salePrice: +salePrice.toFixed(2),
    totalInvoice: +totalInvoice.toFixed(2),
    adminFee,
    commissionBase: +commissionBase.toFixed(2),
    thirdPartyTotal: +thirdPartyTotal.toFixed(2),
    thirdPartyPctTotal,
    internalPool,
    internalPctTotal,
    splits: [...internalRows, ...thirdPartyRows],
  };
}

/** Denormalised columns written alongside the jsonb payload. */
export function toRow(form, derived) {
  const p = form.property || {};
  return {
    // Comma-separated broker codes (e.g. "OS,CK,SS"). Per-broker amounts
    // live in deal_sheet_splits — use that table for accurate reporting.
    salesperson: (form.ownership?.salespeople || []).join(",") || null,
    division: form.ownership?.division || null,
    // Single free-text address, matching the PropCMA `Address` column
    // format (no consistent structure to split into parts).
    property_address: (p.address || "").trim() || null,
    suburb: null, // no longer captured separately
    city: p.city || null,
    vendor_name: form.vendor?.name || null,
    purchaser_name: form.purchaser?.name || null,
    date_of_agreement: form.sale?.dateOfAgreement || null,
    unconditional_date: form.sale?.unconditionalDate || null,
    sale_price_ex_gst: derived.salePrice || null,
    total_invoice_ex_gst: derived.totalInvoice || null,
    wale_years: form.sale?.wale ? parseFloat(String(form.sale.wale).replace(/[^\d.]/g, "")) || null : null,
    deposit_to_trust: !!form.depositToTrust,
    confidential: !!form.press?.confidential,
    property_id: form.propertyId || null, // uuid from PropCMA properties table
    form,
  };
}

/** Submit-time validation. Returns [] when ready. */
export function validateForSubmit(form, derived) {
  const missing = [];

  if (!form.ownership?.salespeople?.length) missing.push("Salesperson");
  if (!form.property?.address || !form.property.address.trim()) missing.push("Property address");
  if (!form.vendor?.name) missing.push("Vendor name");
  if (!form.sale?.dateOfAgreement) missing.push("Date of agreement");
  if (!form.sale?.unconditionalDate) missing.push("Unconditional date");
  if (!derived.salePrice) missing.push("Sale price");
  if (!derived.totalInvoice) missing.push("Commission calculation");
  // Same reasoning as the client: a tier with a typed amount but no %
  // silently computes to $0, and the $500 admin fee alone can make
  // totalInvoice look non-zero even when the real commission is $0.
  // Only relevant when NOT using Flat Fee mode.
  if (form.comm?.flatFee) {
    if (!num(form.comm?.flatFeeAmount)) missing.push("Flat fee amount");
  } else {
    (form.comm?.tiers || []).forEach((t, i) => {
      if (t.base !== "" && t.base != null && !num(t.pct)) {
        missing.push(`Commission tier ${i+1} has an amount but no % — it will charge $0`);
      }
    });
  }
  if (derived.salePrice > 0 && derived.commissionBase <= 0) {
    missing.push(form.comm?.flatFee ? "Commission works out to $0 — check the flat fee amount"
                                     : "Commission works out to $0 — check the tier percentages");
  }
  if (derived.internalPctTotal === 0) missing.push("Commission split");
  else if (Math.abs(derived.internalPctTotal - 100) > 0.01)
    missing.push("Salesperson split must total 100%");
  if (derived.thirdPartyPctTotal >= 100)
    missing.push("Third-party share must be under 100% of commission");
  if (!form.buyerSource) missing.push("Buyer source");
  if (!form.listingSource) missing.push("Listing source");

  const c = form.checklist || {};
  if (!c.agencyAgreement) missing.push("Checklist — signed agency agreement");
  if (!c.unconditionalConfirmation) missing.push("Checklist — confirmation of unconditional");
  if (!c.executedAgreement) missing.push("Checklist — executed sale & purchase agreement");
  if (!c.amlComplete) missing.push("Checklist — AML complete");
  if (form.depositToTrust && !c.spAgreement)
    missing.push("Checklist — S&P agreement (trust deal)");

  return missing;
}
