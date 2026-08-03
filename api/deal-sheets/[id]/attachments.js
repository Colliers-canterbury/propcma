// /api/deal-sheets/[id]/attachments.js
//
// POST   /api/deal-sheets/:id/attachments   (multipart: slot, file) — upload a checklist item
// POST   /api/deal-sheets/:id/attachments   (multipart: description, file) — accounts: upload an EXTRA attachment
// DELETE /api/deal-sheets/:id/attachments?slot=…                     — remove
//
// Files live in the private Supabase Storage bucket `deal-documents`
// under  <dealId>/<slot>/<filename>. A row per attachment is tracked
// in `deal_sheet_attachments` so the accounts page can list them.
//
// Brokers may attach/remove on their OWN draft; accounts/managers may
// on any non-draft deal.
//
// EXTRA attachments (kind='extra') are a separate concept from the
// fixed checklist slots: accounts can add any number of them, each
// with a required description, at any point after submission —
// including after the deal is invoiced. Each gets a generated slot
// value (extra_<uuid>) so multiple can exist per deal without
// touching the existing one-file-per-named-slot constraint. Only
// accounts/manager can create or remove them — never a broker, and
// never on a draft.

import Busboy from "busboy";
import { randomUUID } from "crypto";
import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

export const config = { api: { bodyParser: false } }; // we parse multipart ourselves

const BUCKET = "deal-documents";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
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
// Extra (accounts-added) attachments each get a generated slot of the
// form extra_<uuid>, so any number can coexist per deal.
const isExtraSlot = (slot) => typeof slot === "string" && slot.startsWith("extra_");

export default async function handler(req, res) {
  try {
    const { id } = req.query;

    // GET returns a signed download URL (read access — broker owner or staff)
    if (req.method === "GET") return await signedUrl(req, res, id);

    const deal = await loadDealForWrite(req, id);
    if (req.method === "POST") return await upload(req, res, deal);
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
  if (!VALID_SLOTS.has(slot) && !isExtraSlot(slot)) throw new HttpError(400, "Invalid slot");

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
  deal._user = user; // carried through so upload()/remove() don't re-fetch it
  return deal;
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1 } });
    const fields = {};
    let fileBuf = null, fileName = null, fileType = null, tooBig = false;

    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (_name, stream, info) => {
      fileName = info.filename; fileType = info.mimeType;
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => { tooBig = true; stream.resume(); });
      stream.on("end", () => { fileBuf = Buffer.concat(chunks); });
    });
    bb.on("close", () => {
      if (tooBig) return reject(new HttpError(413, "File exceeds 20 MB limit"));
      resolve({ fields, fileBuf, fileName, fileType });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

async function upload(req, res, deal) {
  const user = deal._user;
  const { fields, fileBuf, fileName, fileType } = await parseMultipart(req);

  if (!fileBuf || !fileName) throw new HttpError(400, "No file provided");
  if (!ALLOWED.has(fileType)) throw new HttpError(415, "File type not allowed (PDF, Word, Excel or image only)");

  // Two upload shapes share this endpoint:
  //  - a checklist item: { slot } from the fixed VALID_SLOTS list
  //  - an accounts "extra" attachment: { description }, no slot —
  //    accounts/manager only, and never on a draft.
  const isExtra = !fields.slot && fields.description != null;

  if (isExtra) {
    if (!["accounts", "manager"].includes(user.role))
      throw new HttpError(403, "Only accounts or a manager can add extra attachments");
    if (deal.status === "draft")
      throw new HttpError(409, "Cannot attach extra documents to a draft");
    const description = String(fields.description || "").trim();
    if (!description) throw new HttpError(400, "A description is required");

    const slot = `extra_${randomUUID()}`;
    const safeName = fileName.replace(/[^\w.\-]+/g, "_").slice(-120);
    const path = `${deal.id}/${slot}/${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, fileBuf, { contentType: fileType, upsert: true });
    if (upErr) throw new HttpError(500, `Storage upload failed: ${upErr.message}`);

    const { data: row, error: dbErr } = await supabase.from("deal_sheet_attachments").insert({
      deal_id: deal.id, slot, kind: "extra", description,
      file_name: fileName, storage_path: path,
      content_type: fileType, size_bytes: fileBuf.length, uploaded_by: user.oid,
    }).select("id").single();
    if (dbErr) throw new HttpError(500, "Attachment record failed");

    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id, actor: user.oid,
      from_status: deal.status, to_status: deal.status,
      note: `Attachment added: ${description} (${fileName})`,
    });

    return res.status(200).json({ id: row.id, slot, name: fileName, description, path, size: fileBuf.length });
  }

  // ---- checklist slot upload (existing behaviour) ----
  const slot = fields.slot;
  if (!VALID_SLOTS.has(slot)) throw new HttpError(400, "Invalid attachment slot");

  const safeName = fileName.replace(/[^\w.\-]+/g, "_").slice(-120);
  const path = `${deal.id}/${slot}/${safeName}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, fileBuf, { contentType: fileType, upsert: true });
  if (upErr) throw new HttpError(500, `Storage upload failed: ${upErr.message}`);

  // Track it (one row per slot — replace any existing for this slot)
  await supabase.from("deal_sheet_attachments").delete()
    .eq("deal_id", deal.id).eq("slot", slot);
  const { error: dbErr } = await supabase.from("deal_sheet_attachments").insert({
    deal_id: deal.id, slot, kind: "checklist", file_name: fileName, storage_path: path,
    content_type: fileType, size_bytes: fileBuf.length, uploaded_by: user.oid,
  });
  if (dbErr) throw new HttpError(500, "Attachment record failed");

  return res.status(200).json({ slot, name: fileName, path, size: fileBuf.length });
}

async function remove(req, res, deal) {
  const slot = req.query.slot;
  if (!VALID_SLOTS.has(slot) && !isExtraSlot(slot)) throw new HttpError(400, "Invalid slot");

  // Extra attachments can only be removed by accounts/manager — never a
  // broker, even on their own deal.
  if (isExtraSlot(slot) && !["accounts", "manager"].includes(deal._user.role))
    throw new HttpError(403, "Only accounts or a manager can remove an extra attachment");

  const { data: rows } = await supabase.from("deal_sheet_attachments")
    .select("storage_path, file_name, description").eq("deal_id", deal.id).eq("slot", slot);
  if (rows && rows.length) {
    await supabase.storage.from(BUCKET).remove(rows.map((r) => r.storage_path));
    await supabase.from("deal_sheet_attachments").delete()
      .eq("deal_id", deal.id).eq("slot", slot);
    if (isExtraSlot(slot)) {
      await supabase.from("deal_sheet_events").insert({
        deal_id: deal.id, actor: deal._user.oid,
        from_status: deal.status, to_status: deal.status,
        note: `Attachment removed: ${rows[0].description || rows[0].file_name}`,
      });
    }
  }
  return res.status(200).json({ ok: true });
}
