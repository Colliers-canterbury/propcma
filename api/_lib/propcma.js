// /api/_lib/propcma.js
//
// When accounts marks a deal INVOICED, the completed sale is written
// into PropCMA's `properties` table (the Summary All Years comparables
// data) as a NEW row. Existing rows are never modified — a deal sheet
// may be *linked* to a past comparable, but that comparable is
// reference data and must not be overwritten.
//
// Excel (`Sales Data Colliers.xlsx`) is NOT written directly here —
// the existing PropCMA Graph sync carries Supabase changes through.
//
// Broker code -> first name, for the "Broker" column.

import { supabase } from "./supabase.js";

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
};

/**
 * Build the properties row from a deal_sheets record.
 * `newId` comes from next_ds_property_id() — e.g. 'ds_2313'.
 * Existing Excel-imported rows use the 'xl_' prefix; the 'ds_'
 * prefix marks rows created by the deal sheet.
 *
 * Column names/types match the live PropCMA `properties` table
 * (snake_case; `auction` is boolean; there is no conjunction column).
 */
export function toPropertyRow(deal, newId, brokerNames = {}) {
  // Leases map differently: the lease term/rental replaces sale details,
  // and the total GROSS ANNUAL rental goes into sale_price so leasing
  // rates compare on a consistent annual basis.
  if (deal.deal_type === "lease") return toLeasePropertyRow(deal, newId, brokerNames);

  const form = deal.form || {};
  const sale = form.sale || {};

  const salePrice = num(deal.sale_price_ex_gst) ?? num(sale.salePrice);
  const sqm = num(sale.landArea);              // form "Land area" -> sqm
  const landArea = num(sale.occupiedArea);     // form "Occupied by area" -> land_area
  const annualRent = num(sale.rentalIncome);

  // Yield: use the broker's entered/pre-filled value, else compute it.
  const yieldPct = sale.yieldManual !== "" && sale.yieldManual != null
    ? num(sale.yieldManual)
    : (salePrice && annualRent ? +((annualRent / salePrice) * 100).toFixed(2) : null);

  // Category comes from the Division dropdown (a controlled list),
  // not the free-text property type. "Investment Sales" is recorded
  // as "Investment" in PropCMA.
  const divisionToCategory = (div) =>
    div === "Investment Sales" ? "Investment" : (div || null);
  const brokers = (form.ownership?.salespeople || [])
    .map((code) => brokerNames[code] || code)
    .join(", ");

  // Sale date: unconditional date preferred, else agreement date.
  // Stored as text (matching existing rows) plus an epoch-ms timestamp
  // in sale_date_ts for sorting.
  const saleDateIso = sale.unconditionalDate || sale.dateOfAgreement || null;
  const saleDateTs = saleDateIso ? Date.parse(saleDateIso) : null;

  return {
    id: newId,
    address: deal.property_address || form.property?.address || null,
    sale_date: saleDateIso,
    sale_date_ts: Number.isFinite(saleDateTs) ? saleDateTs : null,
    lease_or_sale: "Sale",          // deal sheet is the Sales Record
    auction: !!sale.auction,        // boolean column
    category: divisionToCategory(form.ownership?.division),
    sqm: sqm,
    sale_price: salePrice,
    price_per_sqm: salePrice && sqm ? +(salePrice / sqm).toFixed(2) : null,
    purchaser: deal.purchaser_name || null,
    vendor: deal.vendor_name || null,
    initial_yield: yieldPct,
    annual_rent: annualRent,
    land_area: landArea,
    notes: null,   // press release paragraph removed from the form
    broker: brokers || null,
    wale: num(sale.wale),
    // `photos` left unset — PropCMA's own workflow owns it.
    // NOTE: there is no conjunction column in `properties`, so the
    // third-party/conjunctional flag is not written here. It remains
    // captured on the deal sheet itself (deal_sheet_splits).
  };
}

/**
 * Insert the invoiced deal into `properties`.
 * Returns { ok, id } — never throws into the caller's transition,
 * because invoicing must not fail over a comparables write.
 */
export async function pushToPropCMA(deal) {
  // properties.id is text with no database default, so we supply one.
  // next_ds_property_id() is backed by a Postgres sequence (atomic —
  // concurrent invoices cannot collide) and yields e.g. 'ds_2313'.
  const { data: idData, error: idErr } = await supabase.rpc("next_ds_property_id");
  if (idErr || !idData) {
    console.error("PropCMA id generation failed", { dealId: deal.id, error: idErr });
    return { ok: false, error: idErr?.message || "Could not generate property id" };
  }
  const newId = idData;

  // Broker codes -> first names, from the brokers reference table.
  const { data: brokerRows } = await supabase.from("brokers").select("code, first_name");
  const brokerNames = Object.fromEntries((brokerRows || []).map((b) => [b.code, b.first_name]));

  const row = toPropertyRow(deal, newId, brokerNames);

  const { error } = await supabase.from("properties").insert(row);
  if (error) {
    console.error("PropCMA insert failed", { dealId: deal.id, error });
    return { ok: false, error: error.message };
  }
  return { ok: true, id: newId };
}

/**
 * Build the properties row for an invoiced LEASE.
 *
 * Key differences from a sale:
 *   - lease_or_sale = "Lease"
 *   - sale_price    = total GROSS annual rental (not a capital value),
 *                     so leasing rates compare across different terms
 *   - price_per_sqm = rent per m² per year (the standard leasing metric)
 *   - annual_rent   = the same gross annual figure
 *   - auction       = false; a lease is never an auction
 */
export function toLeasePropertyRow(deal, newId, brokerNames = {}) {
  const form = deal.form || {};
  const lease = form.lease || {};

  const grossAnnual = num(deal.annual_gross_rent) ?? num(deal.sale_price_ex_gst);
  // Total leased area across the sqm lines.
  const r = form.rental || {};
  const area = ["retail", "office", "warehouse", "canopy"]
    .reduce((a, k) => a + (num((r[k] || {}).qty) || 0), 0);

  const brokers = (form.ownership?.salespeople || [])
    .map((code) => brokerNames[code] || code)
    .join(", ");

  const divisionToCategory = (div) =>
    div === "Investment Sales" ? "Investment" : (div || null);

  // commencementDate is a free-text field now (office admins add notes
  // beyond just a date, e.g. "1 August 2026, subject to fit-out") — only
  // use it here if it actually parses as a date, so PropCMA's date
  // columns never end up holding a note instead of a date. Falls back
  // to the date of agreement, which stays a real date picker.
  const commencementParses = lease.commencementDate && !isNaN(Date.parse(lease.commencementDate));
  const dateIso = commencementParses ? lease.commencementDate : (lease.dateOfAgreement || null);
  const dateTs = dateIso ? Date.parse(dateIso) : null;

  return {
    id: newId,
    address: deal.property_address || form.property?.address || null,
    sale_date: dateIso,
    sale_date_ts: Number.isFinite(dateTs) ? dateTs : null,
    lease_or_sale: "Lease",
    auction: false,
    category: divisionToCategory(form.ownership?.division),
    sqm: area || null,
    sale_price: grossAnnual,
    price_per_sqm: grossAnnual && area ? +(grossAnnual / area).toFixed(2) : null,
    purchaser: deal.purchaser_name || null,   // Lessee
    vendor: deal.vendor_name || null,         // Lessor
    initial_yield: null,                      // not meaningful for a lease
    annual_rent: grossAnnual,
    land_area: null,
    notes: null,
    broker: brokers || null,
    wale: num(lease.termYears) || null,       // lease term as the WALE
  };
}
