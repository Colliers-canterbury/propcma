// /api/deal-sheets/[id]/index.js
//
// GET /api/deal-sheets/:id → full deal sheet with splits + events.
// Brokers may fetch their own; accounts/managers may fetch any
// non-draft sheet.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
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
