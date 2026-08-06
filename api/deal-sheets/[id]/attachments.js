// /api/deal-sheets/[id]/attachments.js
//
// File uploads go DIRECTLY from the browser to Supabase Storage, not
// through this function. Vercel Functions have a hard 4.5 MB request
// body limit enforced at the platform level — it cannot be raised by
// any application-level config, and it applies regardless of what
// limit our own code sets. Routing file bytes through this function
// silently capped every upload at ~4.5 MB even though the code said
// "20 MB". The fix is the standard one for serverless platforms:
// this function only ever issues a short-lived signed upload URL and
// later records the result — the file itself never touches it.
//
// Flow:
//   1. GET  /api/deal-sheets/:id/attachments?op=init&slot=…&fileName=…
//        (or &description=…&fileName=… for an accounts "extra")
//      → { slot, kind, path, uploadUrl, token }
//   2. Browser PUTs the file directly to `uploadUrl` (Supabase Storage).
//   3. POST /api/deal-sheets/:id/attachments   (JSON body — see confirmUpload)
//      → records the attachment row now that the file is in place.
//   4. GET  /api/deal-sheets/:id/attachments?slot=…            — download URL
//   5. DELETE /api/deal-sheets/:id/attachments?slot=…          — remove
//
// Brokers may attach/remove checklist items on their OWN deal while it's
// a draft, or rejected and being fixed up for resubmission — the same
// edit window as the rest of the form. Accounts/managers may
// on any non-draft deal.
//
// EXTRA attachments (kind='extra') are a separate concept from the
// fixed checklist slots: accounts can add any number of them, each
// with a required description, at any point after submission —
// including after the deal is invoiced. Each gets a generated slot
// value (extra_<uuid>) so multiple can coexist per deal without
// touching the existing one-file-per-named-slot constraint. Only
// accounts/manager can create or remove them — never a broker, and
// never on a draft.

import { randomUUID } from "crypto";
import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";

const BUCKET = "deal-documents";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — advisory now (see confirmUpload).
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
  // Shared — Other Documents section (both forms)
  "executedAgreement",
]);
// Extra (accounts-added) attachments each get a generated slot of the
// form extra_<uuid>, so any number can coexist per deal.
const isExtraSlot = (slot) => typeof slot === "string" && slot.startsWith("extra_");

const safeName = (name) => String(name || "file").replace(/[^\w.\-]+/g, "_").slice(-120);

export default async function handler(req, res) {
  try {
    const { id } = req.query;

    if (req.method === "GET" && req.query.op === "init") return await initUpload(req, res, id);
    if (req.method === "GET") return await signedUrl(req, res, id); // download link

    const deal = await loadDealForWrite(req, id);
    if (req.method === "POST") return await confirmUpload(req, res, deal);
    if (req.method === "DELETE") return await remove(req, res, deal);
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).end();
  } catch (e) {
    sendError(res, e);
  }
}

// ---- step 1: mint a signed upload URL (no file bytes involved) ----
async function initUpload(req, res, id) {
  const deal = await loadDealForWrite(req, id);
  const user = deal._user;
  const { slot: rawSlot, description, fileName } = req.query;

  let slot, kind;
  if (rawSlot) {
    if (!VALID_SLOTS.has(rawSlot)) throw new HttpError(400, "Invalid attachment slot");
    slot = rawSlot; kind = "checklist";
  } else if (description != null) {
    // "Other Documents": the deal's own creator may add these while it's
    // still a draft; accounts/manager may add them any time after
    // submission (including after completion) — see confirmUpload() for
    // the matching check applied again at record-time.
    const isOwnerOnDraft = deal.created_by === user.oid && deal.status === "draft";
    const isStaffPostSubmit = ["accounts", "manager"].includes(user.role) && deal.status !== "draft";
    if (!isOwnerOnDraft && !isStaffPostSubmit)
      throw new HttpError(403, "Not permitted to add an extra attachment on this deal");
    if (!String(description).trim()) throw new HttpError(400, "A description is required");
    slot = `extra_${randomUUID()}`; kind = "extra";
  } else {
    throw new HttpError(400, "slot or description is required");
  }

  const path = `${deal.id}/${slot}/${safeName(fileName)}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) throw new HttpError(500, `Could not prepare upload: ${error.message}`);

  return res.status(200).json({ slot, kind, path, uploadUrl: data.signedUrl, token: data.token });
}

// ---- step 3: the file is now in storage — record it ----
async function confirmUpload(req, res, deal) {
  const user = deal._user;
  const { slot, kind, description, path, fileName, contentType, sizeBytes } = req.body || {};

  if (!slot || !path || !fileName) throw new HttpError(400, "Missing upload details");
  if (!ALLOWED.has(contentType)) throw new HttpError(415, "File type not allowed (PDF, Word, Excel or image only)");
  if (Number(sizeBytes) > MAX_BYTES) throw new HttpError(413, "File exceeds the 20 MB limit");

  if (kind === "extra" || isExtraSlot(slot)) {
    const isOwnerOnDraft = deal.created_by === user.oid && deal.status === "draft";
    const isStaffPostSubmit = ["accounts", "manager"].includes(user.role) && deal.status !== "draft";
    if (!isOwnerOnDraft && !isStaffPostSubmit)
      throw new HttpError(403, "Not permitted to add an extra attachment on this deal");
    const desc = String(description || "").trim();
    if (!desc) throw new HttpError(400, "A description is required");

    const { data: row, error: dbErr } = await supabase.from("deal_sheet_attachments").insert({
      deal_id: deal.id, slot, kind: "extra", description: desc,
      file_name: fileName, storage_path: path,
      content_type: contentType, size_bytes: sizeBytes, uploaded_by: user.oid,
    }).select("id").single();
    if (dbErr) throw new HttpError(500, "Attachment record failed");

    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id, actor: user.oid,
      from_status: deal.status, to_status: deal.status,
      note: `Attachment added: ${desc} (${fileName})`,
    });

    return res.status(200).json({ id: row.id, slot, name: fileName, description: desc, path, size: sizeBytes });
  }

  // ---- checklist slot (existing behaviour: one row per slot, replaced) ----
  if (!VALID_SLOTS.has(slot)) throw new HttpError(400, "Invalid attachment slot");

  await supabase.from("deal_sheet_attachments").delete()
    .eq("deal_id", deal.id).eq("slot", slot);
  const { error: dbErr } = await supabase.from("deal_sheet_attachments").insert({
    deal_id: deal.id, slot, kind: "checklist", file_name: fileName, storage_path: path,
    content_type: contentType, size_bytes: sizeBytes, uploaded_by: user.oid,
  });
  if (dbErr) throw new HttpError(500, "Attachment record failed");

  return res.status(200).json({ slot, name: fileName, path, size: sizeBytes });
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

  // The deal's own creator can manage checklist attachments whenever
  // they can otherwise edit the form — draft, or rejected and being
  // fixed up for resubmission. (The "Other Documents" free-form
  // uploader is intentionally narrower than this — draft only — and
  // enforces that separately in initUpload()/confirmUpload().)
  const isOwnerEditable = deal.created_by === user.oid && ["draft", "rejected"].includes(deal.status);
  const isStaff = ["accounts", "manager"].includes(user.role) && deal.status !== "draft";
  if (!isOwnerEditable && !isStaff)
    throw new HttpError(403, "Not permitted to change attachments on this deal");
  deal._user = user; // carried through so confirmUpload()/remove() don't re-fetch it
  return deal;
}

async function remove(req, res, deal) {
  const slot = req.query.slot;
  if (!VALID_SLOTS.has(slot) && !isExtraSlot(slot)) throw new HttpError(400, "Invalid slot");
  // No further check needed here: loadDealForWrite() already scoped entry
  // to either the deal's own creator while it's a draft, or accounts/
  // manager once it's been submitted — exactly the same rule that
  // governs adding an extra attachment in the first place.

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
