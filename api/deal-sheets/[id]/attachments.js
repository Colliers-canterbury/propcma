// /api/deal-sheets/[id]/attachments.js
//
// Uploads use SIGNED UPLOAD URLS so the file bytes go browser →
// Supabase Storage directly and never pass through Vercel (whose
// ~4.5 MB request cap was rejecting larger scans).
//
// POST   /api/deal-sheets/:id/attachments  {action:"sign", slot, fileName, fileType, size}
//          → validates + returns { uploadUrl, path } (one-time signed URL)
// POST   /api/deal-sheets/:id/attachments  {action:"confirm", slot, path, fileName, fileType}
//          → verifies the object landed, records it, replaces any prior file for the slot
// GET    ?slot=…  → signed download URL
// DELETE ?slot=…  → remove
//
// Files live in the private bucket `deal-documents` under
// <dealId>/<slot>/<timestamp>_<filename>. One row per slot in
// `deal_sheet_attachments` (confirm replaces any existing).
//
// Brokers may attach/remove on their OWN draft; accounts/managers may
// on any non-draft deal.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

const BUCKET = "deal-documents";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — also check the bucket's file size limit in Supabase
const ALLOWED = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
  "image/jpeg", "image/png",
]);
const VALID_SLOTS = new Set([
  // Sales deal sheet
  "tenancySchedule", "agencyAgreement", "unconditionalConfirmation",
  "salePriceConfirmation", "marketingReport", "amlComplete", "spAgreement",
  // Leasing deal sheet
  "leaseValueConfirmation", "leaseDeed", "appraisals",
]);

export default async function handler(req, res) {
  try {
    const { id } = req.query;

    if (req.method === "GET") return await signedUrl(req, res, id);

    const deal = await loadDealForWrite(req, id);
    if (req.method === "POST") {
      const body = req.body || {};
      if (body.action === "sign") return await sign(res, deal, body);
      if (body.action === "confirm") return await confirm(res, deal, body);
      throw new HttpError(400, "Unknown action");
    }
    if (req.method === "DELETE") return await remove(req, res, deal);
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).end();
  } catch (e) {
    sendError(res, e);
  }
}

async function signedUrl(req, res, id) {
  const user = await requireUser(req);
  const slot = req.query.slot;
  if (!VALID_SLOTS.has(slot)) throw new HttpError(400, "Invalid slot");

  const { data: deal, error } = await supabase
    .from("deal_sheets").select("id, created_by, status").eq("id", id).single();
  if (error || !deal) throw new HttpError(404, "Deal sheet not found");

  const isOwner = deal.created_by === user.oid;
  const isStaff = ["accounts", "manager"].includes(user.role) && deal.status !== "draft";
  if (!isOwner && !isStaff) throw new HttpError(403, "Not permitted");

  const { data: rows } = await supabase.from("deal_sheet_attachments")
    .select("storage_path, file_name").eq("deal_id", id).eq("slot", slot);
  if (!rows || !rows.length) throw new HttpError(404, "No file for that slot");

  const { data: signed, error: sErr } = await supabase.storage
    .from(BUCKET).createSignedUrl(rows[0].storage_path, 300, { download: rows[0].file_name });
  if (sErr) throw new HttpError(500, "Could not create download link");

  return res.status(200).json({ url: signed.signedUrl, name: rows[0].file_name });
}

async function loadDealForWrite(req, id) {
  const user = await requireUser(req);
  const { data: deal, error } = await supabase
    .from("deal_sheets").select("id, created_by, status").eq("id", id).single();
  if (error || !deal) throw new HttpError(404, "Deal sheet not found");

  const isOwnerDraft = deal.created_by === user.oid && deal.status === "draft";
  const isStaff = ["accounts", "manager"].includes(user.role) && deal.status !== "draft";
  if (!isOwnerDraft && !isStaff)
    throw new HttpError(403, "Not permitted to change attachments on this deal");
  return deal;
}

// Step 1: validate the declared file and hand back a one-time upload URL.
async function sign(res, deal, { slot, fileName, fileType, size }) {
  if (!VALID_SLOTS.has(slot)) throw new HttpError(400, "Invalid attachment slot");
  if (!fileName) throw new HttpError(400, "No file name provided");
  if (!ALLOWED.has(fileType)) throw new HttpError(415, "File type not allowed (PDF, Word, Excel or image only)");
  if (!size || size <= 0) throw new HttpError(400, "No file size provided");
  if (size > MAX_BYTES) throw new HttpError(413, `File exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit`);

  const safeName = String(fileName).replace(/[^\w.\-]+/g, "_").slice(-120);
  // Timestamped path: no upsert needed, and replacing a slot can't
  // collide with the file it replaces.
  const path = `${deal.id}/${slot}/${Date.now()}_${safeName}`;

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw new HttpError(500, `Could not authorise upload: ${error.message}`);

  return res.status(200).json({ uploadUrl: data.signedUrl, path });
}

// Step 2: the browser has PUT the file to storage — verify and record it.
async function confirm(res, deal, { slot, path, fileName, fileType }) {
  if (!VALID_SLOTS.has(slot)) throw new HttpError(400, "Invalid attachment slot");
  if (!path || !String(path).startsWith(`${deal.id}/${slot}/`))
    throw new HttpError(400, "Path does not match this deal and slot");

  // Verify the object actually landed and get its true size.
  const folder = `${deal.id}/${slot}`;
  const leaf = String(path).slice(folder.length + 1);
  const { data: listing, error: listErr } = await supabase.storage
    .from(BUCKET).list(folder, { limit: 100 });
  if (listErr) throw new HttpError(500, "Could not verify upload");
  const obj = (listing || []).find((o) => o.name === leaf);
  if (!obj) throw new HttpError(400, "Upload not found — the file may not have finished uploading");
  const size = obj.metadata?.size ?? 0;

  // Replace semantics: remove any previous file(s) for this slot.
  const { data: oldRows } = await supabase.from("deal_sheet_attachments")
    .select("storage_path").eq("deal_id", deal.id).eq("slot", slot);
  const stale = (oldRows || []).map((r) => r.storage_path).filter((p) => p !== path);
  if (stale.length) await supabase.storage.from(BUCKET).remove(stale);
  await supabase.from("deal_sheet_attachments").delete()
    .eq("deal_id", deal.id).eq("slot", slot);

  const { error: dbErr } = await supabase.from("deal_sheet_attachments").insert({
    deal_id: deal.id, slot, file_name: fileName, storage_path: path,
    content_type: fileType, size_bytes: size,
  });
  if (dbErr) throw new HttpError(500, "Attachment record failed");

  return res.status(200).json({ slot, name: fileName, path, size });
}

async function remove(req, res, deal) {
  const slot = req.query.slot;
  if (!VALID_SLOTS.has(slot)) throw new HttpError(400, "Invalid slot");

  const { data: rows } = await supabase.from("deal_sheet_attachments")
    .select("storage_path").eq("deal_id", deal.id).eq("slot", slot);
  if (rows && rows.length) {
    await supabase.storage.from(BUCKET).remove(rows.map((r) => r.storage_path));
    await supabase.from("deal_sheet_attachments").delete()
      .eq("deal_id", deal.id).eq("slot", slot);
  }
  return res.status(200).json({ ok: true });
}
