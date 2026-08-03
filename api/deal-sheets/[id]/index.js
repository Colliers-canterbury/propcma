// /api/deal-sheets/[id]/index.js
//
// GET    /api/deal-sheets/:id → full deal sheet with splits + events.
// Brokers may fetch their own; accounts/managers may fetch any
// non-draft sheet.
//
// DELETE /api/deal-sheets/:id → permanently remove a DRAFT.
// Only the broker who created it may delete it, and only while it's
// still a draft — once submitted, a deal sheet is never deleted, only
// returned/rejected, so the record stays intact for accounts and the
// audit trail.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

const BUCKET = "deal-documents";

export default async function handler(req, res) {
  try {
    if (req.method === "DELETE") return await remove(req, res);
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, DELETE");
      return res.status(405).end();
    }
    const user = await requireUser(req);
    const { id } = req.query;

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
        .select("id, slot, kind, description, file_name, content_type, size_bytes, uploaded_by, uploaded_at").eq("deal_id", id),
    ]);

    return res.status(200).json({ ...deal, splits: splits || [], events: events || [], attachments: attachments || [] });
  } catch (e) {
    sendError(res, e);
  }
}

async function remove(req, res) {
  const user = await requireUser(req);
  const { id } = req.query;

  const { data: deal, error } = await supabase
    .from("deal_sheets").select("id, created_by, status").eq("id", id).single();
  if (error || !deal) throw new HttpError(404, "Deal sheet not found");

  if (deal.created_by !== user.oid)
    throw new HttpError(403, "You can only delete your own deal sheets");
  if (deal.status !== "draft")
    throw new HttpError(409, "Only a draft can be deleted — this deal has already been submitted");

  // Best-effort cleanup of any files already attached to the draft.
  // Not fatal if it fails — the row delete (below) is what matters, and
  // deal_sheet_splits / deal_sheet_attachments cascade on it regardless.
  const { data: files } = await supabase
    .from("deal_sheet_attachments").select("storage_path").eq("deal_id", id);
  if (files && files.length) {
    await supabase.storage.from(BUCKET).remove(files.map((f) => f.storage_path)).catch(() => {});
  }

  const { error: delErr } = await supabase.from("deal_sheets").delete().eq("id", id);
  if (delErr) throw new HttpError(500, "Could not delete deal sheet");

  return res.status(200).json({ ok: true });
}
