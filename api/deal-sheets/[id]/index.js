// /api/deal-sheets/[id]/index.js
//
// GET    /api/deal-sheets/:id → full deal sheet with splits + events.
//        Brokers may fetch their own; accounts/managers may fetch any
//        non-draft sheet.
// DELETE /api/deal-sheets/:id → permanently remove a deal sheet.
//        Only the creator, and only while it is a draft or has been
//        returned by accounts ("rejected"). Submitted / processing /
//        invoiced deals are part of the accounts audit trail and
//        cannot be deleted.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

const BUCKET = "deal-documents";

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    if (req.method === "GET") return await getDeal(req, res, id);
    if (req.method === "DELETE") return await deleteDeal(req, res, id);
    res.setHeader("Allow", "GET, DELETE");
    return res.status(405).end();
  } catch (e) {
    sendError(res, e);
  }
}

async function getDeal(req, res, id) {
  const user = await requireUser(req);

  const { data: deal, error } = await supabase
    .from("deal_sheets")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !deal) throw new HttpError(404, "Deal sheet not found");

  const isOwner = deal.created_by === user.oid;
  const isStaff = ["accounts", "manager"].includes(user.role);
  if (!isOwner && !(isStaff && deal.status !== "draft"))
    throw new HttpError(403, "Not permitted");

  const [{ data: splits }, { data: events }, { data: attachments }] = await Promise.all([
    supabase.from("deal_sheet_splits").select("*").eq("deal_id", id),
    supabase
      .from("deal_sheet_events")
      .select("actor, from_status, to_status, note, created_at")
      .eq("deal_id", id)
      .order("created_at", { ascending: true }),
    supabase.from("deal_sheet_attachments")
      .select("slot, file_name, content_type, size_bytes").eq("deal_id", id),
  ]);

  return res.status(200).json({ ...deal, splits: splits || [], events: events || [], attachments: attachments || [] });
}

async function deleteDeal(req, res, id) {
  const user = await requireUser(req);

  const { data: deal, error } = await supabase
    .from("deal_sheets")
    .select("id, created_by, status")
    .eq("id", id)
    .single();
  if (error || !deal) throw new HttpError(404, "Deal sheet not found");

  const canDelete =
    deal.created_by === user.oid && ["draft", "rejected"].includes(deal.status);
  if (!canDelete)
    throw new HttpError(403, "Only your own draft or returned deal sheets can be deleted");

  // Remove attachment files from storage first, then the related rows,
  // then the deal itself.
  const { data: atts } = await supabase
    .from("deal_sheet_attachments")
    .select("storage_path")
    .eq("deal_id", id);
  if (atts && atts.length)
    await supabase.storage.from(BUCKET).remove(atts.map((a) => a.storage_path));

  await supabase.from("deal_sheet_attachments").delete().eq("deal_id", id);
  await supabase.from("deal_sheet_splits").delete().eq("deal_id", id);
  await supabase.from("deal_sheet_events").delete().eq("deal_id", id);

  const { error: delErr } = await supabase.from("deal_sheets").delete().eq("id", id);
  if (delErr) throw new HttpError(500, "Delete failed: " + delErr.message);

  return res.status(200).json({ ok: true });
}
