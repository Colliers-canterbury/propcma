// /api/deal-sheets/index.js
//
// GET  /api/deal-sheets?scope=mine            → broker's own sheets
// GET  /api/deal-sheets?scope=queue&status=…  → accounts/manager queue
// POST /api/deal-sheets  { id?, form }        → create or save a draft
//
// All requests require  Authorization: Bearer <MSAL access token>.

import { requireUser, sendError, HttpError } from "../_lib/auth.js";
import { supabase } from "../_lib/supabase.js";
import { computeDerived, toRow } from "../_lib/deals.js";
import { computeLeaseDerived, toLeaseRow } from "../_lib/leases.js";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await list(req, res);
    if (req.method === "POST") return await save(req, res);
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  } catch (e) {
    sendError(res, e);
  }
}

async function list(req, res) {
  const scope = req.query.scope || "mine";

  if (scope === "queue") {
    await requireUser(req, ["accounts", "manager"]);
    let q = supabase
      .from("deal_sheets")
      .select(
        "id, file_no, deal_no, status, deal_type, salesperson, division, property_address, suburb, vendor_name, sale_price_ex_gst, total_invoice_ex_gst, unconditional_date, deposit_to_trust, confidential, submitted_at"
      )
      .neq("status", "draft")
      .order("submitted_at", { ascending: false });
    if (req.query.status) q = q.eq("status", req.query.status);
    const { data, error } = await q;
    if (error) throw new HttpError(500, "Queue query failed");
    return res.status(200).json(data);
  }

  if (scope === "drafts") {
    // Accounts can VIEW (not edit) all drafts entered by office admins,
    // so they can see what's coming. Read-only by design — there is no
    // write path from this scope.
    await requireUser(req, ["accounts", "manager"]);
    const { data, error } = await supabase
      .from("deal_sheets")
      .select(
        "id, status, deal_type, salesperson, division, property_address, suburb, vendor_name, total_invoice_ex_gst, deposit_to_trust, confidential, created_by, updated_at"
      )
      .eq("status", "draft")
      .order("updated_at", { ascending: false });
    if (error) throw new HttpError(500, "Drafts query failed");
    return res.status(200).json(data);
  }

  // scope=mine — the deals this user filed.
  const user = await requireUser(req);
  const { data, error } = await supabase
    .from("deal_sheets")
    .select(
      "id, status, deal_type, property_address, vendor_name, purchaser_name, total_invoice_ex_gst, updated_at, submitted_at"
    )
    .eq("created_by", user.oid)
    .order("updated_at", { ascending: false });
  if (error) throw new HttpError(500, "Query failed");
  return res.status(200).json(data);
}

async function save(req, res) {
  const user = await requireUser(req);
  const { id, form, dealType } = req.body || {};
  if (!form || typeof form !== "object")
    throw new HttpError(400, "Body must include { form }");

  // Sales and leases share this table; the payload shape and the
  // commission model differ, so route to the right module.
  const type = dealType === "lease" ? "lease" : "sale";
  const derived = type === "lease" ? computeLeaseDerived(form) : computeDerived(form);
  const row = type === "lease" ? toLeaseRow(form, derived) : { ...toRow(form, derived), deal_type: "sale" };

  if (id) {
    // Update — must be the creator's own draft
    const { data: existing, error: exErr } = await supabase
      .from("deal_sheets")
      .select("id, created_by, status")
      .eq("id", id)
      .single();
    if (exErr || !existing) throw new HttpError(404, "Deal sheet not found");
    if (existing.created_by !== user.oid)
      throw new HttpError(403, "Not your deal sheet");
    // Drafts and returned deals are editable. Once a deal is with
    // accounts (submitted/processing/invoiced) it's locked.
    if (!["draft", "rejected"].includes(existing.status))
      throw new HttpError(409, "This deal is with accounts and can't be edited. Contact accounts for changes.");

    const { error } = await supabase.from("deal_sheets").update(row).eq("id", id);
    if (error) throw new HttpError(500, "Save failed");
    await replaceSplits(id, derived.splits);
    return res.status(200).json({ id, status: existing.status, ...derived });
  }

  // Create
  const { data, error } = await supabase
    .from("deal_sheets")
    .insert({ ...row, created_by: user.oid, status: "draft" })
    .select("id")
    .single();
  if (error) throw new HttpError(500, "Create failed");
  await replaceSplits(data.id, derived.splits);
  return res.status(201).json({ id: data.id, status: "draft", ...derived });
}

async function replaceSplits(dealId, splits) {
  await supabase.from("deal_sheet_splits").delete().eq("deal_id", dealId);
  if (splits.length) {
    const { error } = await supabase
      .from("deal_sheet_splits")
      .insert(splits.map((s) => ({ ...s, deal_id: dealId })));
    if (error) throw new HttpError(500, "Split save failed");
  }
}
