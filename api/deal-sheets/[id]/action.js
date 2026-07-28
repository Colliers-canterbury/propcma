// /api/deal-sheets/[id]/[action].js
//
// POST /api/deal-sheets/:id/submit                    (broker, own draft)
// POST /api/deal-sheets/:id/process { fileNo, dealNo }(accounts/manager)
// POST /api/deal-sheets/:id/invoice                   (accounts/manager)
// POST /api/deal-sheets/:id/return  { note }          (accounts/manager)
//
// Every transition writes a deal_sheet_events row with the acting
// user's oid — the audit trail for REAA/AML record-keeping.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";
import { computeDerived, validateForSubmit } from "../../_lib/deals.js";
import { computeLeaseDerived, validateLeaseForSubmit } from "../../_lib/leases.js";
import { notifyAccounts } from "../../_lib/graph.js";
import { pushToPropCMA } from "../../_lib/propcma.js";
import { appendToExcel } from "../../_lib/excel.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).end();
    }
    const { id, action } = req.query;

    const { data: deal, error } = await supabase
      .from("deal_sheets")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !deal) throw new HttpError(404, "Deal sheet not found");

    switch (action) {
      case "submit":  return await submit(req, res, deal);
      case "process": return await process_(req, res, deal);
      case "invoice": return await invoice(req, res, deal);
      case "return":  return await returnToBroker(req, res, deal);
      case "receipt": return await setReceiptNo(req, res, deal);
      default: throw new HttpError(404, `Unknown action: ${action}`);
    }
  } catch (e) {
    sendError(res, e);
  }
}

async function transition(deal, patch, actor, note = null) {
  const { data, error } = await supabase
    .from("deal_sheets")
    .update(patch)
    .eq("id", deal.id)
    .eq("status", deal.status) // optimistic guard against races
    .select("*")
    .single();
  if (error || !data)
    throw new HttpError(409, "Deal sheet changed state — refresh and retry");

  await supabase.from("deal_sheet_events").insert({
    deal_id: deal.id,
    actor,
    from_status: deal.status,
    to_status: patch.status || deal.status,
    note,
  });
  return data;
}

// ---------- broker: submit ----------
async function submit(req, res, deal) {
  const user = await requireUser(req);
  if (deal.created_by !== user.oid) throw new HttpError(403, "Not your deal sheet");
  if (!["draft", "rejected"].includes(deal.status))
    throw new HttpError(409, `Cannot submit from status '${deal.status}'`);

  // Validate with the module matching this deal's type.
  const isLease = deal.deal_type === "lease";
  const derived = isLease ? computeLeaseDerived(deal.form) : computeDerived(deal.form);
  const missing = isLease
    ? validateLeaseForSubmit(deal.form, derived)
    : validateForSubmit(deal.form, derived);
  if (missing.length)
    return res.status(422).json({ error: "Not ready to submit", missing });

  const updated = await transition(
    deal,
    { status: "submitted", submitted_at: new Date().toISOString() },
    user.oid,
    "Submitted by broker"
  );

  // CC the brokers on the deal so they know it's been filed.
  // Brokers with no email on record are skipped, not an error.
  let ccEmails = [];
  const codes = deal.form?.ownership?.salespeople || [];
  if (codes.length) {
    const { data: rows } = await supabase
      .from("brokers").select("email").in("code", codes);
    ccEmails = (rows || []).map((r) => r.email).filter(Boolean);
  }

  const emailed = await notifyAccounts(updated, ccEmails); // logs, never throws
  return res.status(200).json({ ok: true, status: "submitted", emailed });
}

// ---------- accounts: assign numbers, start processing ----------
async function process_(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (deal.status !== "submitted")
    throw new HttpError(409, `Cannot process from status '${deal.status}'`);

  const { dealNo } = req.body || {};
  if (!dealNo)
    throw new HttpError(400, "dealNo is required");

  await transition(
    deal,
    { status: "processing", deal_no: dealNo, processed_by: user.oid },
    user.oid,
    `Deal ${dealNo} assigned`
  );
  return res.status(200).json({ ok: true, status: "processing" });
}

// ---------- accounts: invoiced / commission approved ----------
async function invoice(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (deal.status !== "processing")
    throw new HttpError(409, `Cannot invoice from status '${deal.status}'`);

  const updated = await transition(
    deal,
    { status: "invoiced" },
    user.oid,
    "Invoice raised — commission approved"
  );

  // #10 — Confidential / Private Sale deals are excluded from PropCMA and
  // the Excel comparables sheet entirely. The invoice still processes; we
  // simply don't publish the deal as a market comparable.
  const isConfidential = !!(updated.confidential || updated.form?.confidential);

  if (isConfidential) {
    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id,
      actor: user.oid,
      from_status: "invoiced",
      to_status: "invoiced",
      note: "Marked Confidential / Private Sale — excluded from PropCMA and Excel comparables",
    });
  }

  // Write the completed sale into PropCMA's comparables data as a NEW
  // row. Deliberately non-fatal: the deal is already invoiced, and a
  // failed comparable write must not roll that back or block accounts.
  // The outcome is recorded in the audit trail either way.
  const pushed = isConfidential
    ? { ok: false, skipped: true }
    : await pushToPropCMA(updated);
  if (!isConfidential) {
    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id,
      actor: user.oid,
      from_status: "invoiced",
      to_status: "invoiced",
      note: pushed.ok
        ? `Added to PropCMA comparables (properties id ${pushed.id})`
        : `PropCMA comparable write FAILED — needs manual entry: ${pushed.error}`,
    });
  }

  if (pushed.ok) {
    await supabase.from("deal_sheets")
      .update({ propcma_property_id: pushed.id }).eq("id", deal.id);
  }

  // Also append the sale to the Sales Data Colliers.xlsx workbook.
  // Reuses the same ds_ id and broker names so Excel and Supabase match.
  // Non-fatal for the same reason; recorded in the audit trail.
  let excelResult = { ok: false, skipped: true };
  if (pushed.ok && !isConfidential) {
    const { data: brokerRows } = await supabase.from("brokers").select("code, first_name");
    const brokerNames = Object.fromEntries((brokerRows || []).map((b) => [b.code, b.first_name]));
    excelResult = await appendToExcel(updated, pushed.id, brokerNames);
    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id,
      actor: user.oid,
      from_status: "invoiced",
      to_status: "invoiced",
      note: excelResult.ok
        ? `Added to Sales Data Colliers.xlsx (row ${excelResult.row})`
        : `Excel write FAILED — needs manual entry: ${excelResult.error}`,
    });
  }

  return res.status(200).json({ ok: true, status: "invoiced", propcma: pushed, excel: excelResult });
}

// ---------- accounts: return to broker with a reason ----------
async function returnToBroker(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (!["submitted", "processing"].includes(deal.status))
    throw new HttpError(409, `Cannot return from status '${deal.status}'`);

  const note = (req.body?.note || "").trim();
  if (!note) throw new HttpError(400, "A reason (note) is required");

  await transition(deal, { status: "rejected" }, user.oid, `Returned to broker: ${note}`);
  return res.status(200).json({ ok: true, status: "rejected" });
}

/**
 * Accounts updates the Trust Deposit details — Receipt No. and/or the
 * deposit Amount. Editable at ANY status. The values live inside the
 * form JSONB (form.deposit.*), so we read-modify-write that object
 * rather than a top-level column. Only the fields present in the body
 * are changed, so existing receipt-only calls behave exactly as before.
 */
async function setReceiptNo(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has("receiptNo") && !has("amount"))
    throw new HttpError(400, "Provide receiptNo and/or amount");

  const form = { ...(deal.form || {}) };
  form.deposit = { ...(form.deposit || {}) };
  const notes = [];

  if (has("receiptNo")) {
    const value = String(body.receiptNo ?? "").trim();
    form.deposit.receiptNo = value;
    notes.push(value ? `Trust receipt no. set to ${value}` : "Trust receipt no. cleared");
  }
  if (has("amount")) {
    const value = String(body.amount ?? "").trim().replace(/[$,\s]/g, "");
    form.deposit.amount = value;
    notes.push(value ? `Trust deposit amount set to $${value}` : "Trust deposit amount cleared");
  }

  const { error } = await supabase
    .from("deal_sheets")
    .update({ form })
    .eq("id", deal.id);
  if (error) throw new HttpError(500, "Could not save trust deposit details");

  await supabase.from("deal_sheet_events").insert({
    deal_id: deal.id,
    actor: user.oid,
    from_status: deal.status,
    to_status: deal.status,
    note: notes.join("; "),
  });

  return res.status(200).json({ ok: true, receiptNo: form.deposit.receiptNo ?? null, amount: form.deposit.amount ?? null });
}
