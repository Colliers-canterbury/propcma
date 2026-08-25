// /api/deal-sheets/[id]/[action].js
//
// POST /api/deal-sheets/:id/submit                     (broker, own draft)
// POST /api/deal-sheets/:id/invoice-client              (accounts/manager) — step 1
// POST /api/deal-sheets/:id/assign-deal-number { dealNo }(accounts/manager) — step 2
// POST /api/deal-sheets/:id/complete { comment }         (accounts/manager) — step 3
// POST /api/deal-sheets/:id/return  { note }             (accounts/manager)
// POST /api/deal-sheets/:id/receipt { receiptNo }         (accounts/manager)
//
// Accounts processing is three steps, each its own button on
// accounts.html:
//   1. Invoiced Client   — submitted        -> invoiced          (no deal number yet)
//   2. Assign Deal Number — invoiced        -> deposit_received  (deal number entered)
//   3. Mark as complete  — deposit_received -> complete          (optional comment,
//                          visible to the office admin on admin.html; this is also
//                          where the deal is written into PropCMA/Excel — see complete())
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
      case "submit":            return await submit(req, res, deal);
      case "invoice-client":    return await invoiceClient(req, res, deal);
      case "assign-deal-number":return await assignDealNumber(req, res, deal);
      case "complete":          return await complete(req, res, deal);
      case "return":            return await returnToBroker(req, res, deal);
      case "receipt":           return await setReceiptNo(req, res, deal);
      case "trust-deposit":     return await setTrustDeposit(req, res, deal);
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

// ---------- accounts step 1: Invoiced Client ----------
// No deal number required at this step — that's step 2.
async function invoiceClient(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (deal.status !== "submitted")
    throw new HttpError(409, `Cannot invoice from status '${deal.status}'`);

  await transition(deal, { status: "invoiced" }, user.oid, "Invoiced client");
  return res.status(200).json({ ok: true, status: "invoiced" });
}

// ---------- accounts step 2: Assign Deal Number ----------
async function assignDealNumber(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (deal.status !== "invoiced")
    throw new HttpError(409, `Cannot assign a deal number from status '${deal.status}'`);

  const { dealNo } = req.body || {};
  if (!dealNo) throw new HttpError(400, "dealNo is required");

  await transition(
    deal,
    { status: "deposit_received", deal_no: dealNo, processed_by: user.oid },
    user.oid,
    `Deal ${dealNo} assigned`
  );
  return res.status(200).json({ ok: true, status: "deposit_received" });
}

// ---------- accounts step 3: Mark as complete ----------
// This is also where the deal is written into PropCMA's comparables
// and the Excel workbook — moved here (from the old single "invoice"
// step) because "complete" is now the true terminal, fully-processed
// state under the new workflow.
async function complete(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (deal.status !== "deposit_received")
    throw new HttpError(409, `Cannot complete from status '${deal.status}'`);

  const comment = String(req.body?.comment ?? "").trim();

  const updated = await transition(
    deal,
    { status: "complete", accounts_comment: comment || null },
    user.oid,
    comment ? `Marked complete — ${comment}` : "Marked complete"
  );

  // #10 — Confidential / Private Sale deals are excluded from PropCMA and
  // the Excel comparables sheet entirely. Completion still processes; we
  // simply don't publish the deal as a market comparable.
  const isConfidential = !!(updated.confidential || updated.form?.confidential);

  if (isConfidential) {
    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id,
      actor: user.oid,
      from_status: "complete",
      to_status: "complete",
      note: "Marked Confidential / Private Sale — excluded from PropCMA and Excel comparables",
    });
  }

  // Write the completed sale into PropCMA's comparables data as a NEW
  // row. Deliberately non-fatal: the deal is already marked complete,
  // and a failed comparable write must not roll that back or block
  // accounts. The outcome is recorded in the audit trail either way.
  const pushed = isConfidential
    ? { ok: false, skipped: true }
    : await pushToPropCMA(updated);
  if (!isConfidential) {
    await supabase.from("deal_sheet_events").insert({
      deal_id: deal.id,
      actor: user.oid,
      from_status: "complete",
      to_status: "complete",
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
      from_status: "complete",
      to_status: "complete",
      note: excelResult.ok
        ? `Added to Sales Data Colliers.xlsx (row ${excelResult.row})`
        : `Excel write FAILED — needs manual entry: ${excelResult.error}`,
    });
  }

  return res.status(200).json({ ok: true, status: "complete", propcma: pushed, excel: excelResult });
}

// ---------- accounts: return to broker with a reason ----------
// Scoped to the two earliest post-submission states — once a deal
// number is assigned (deposit_received) it's too far along to bounce
// back this way.
async function returnToBroker(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (!["submitted", "invoiced"].includes(deal.status))
    throw new HttpError(409, `Cannot return from status '${deal.status}'`);

  const note = (req.body?.note || "").trim();
  if (!note) throw new HttpError(400, "A reason (note) is required");

  await transition(deal, { status: "rejected" }, user.oid, `Returned to broker: ${note}`);
  return res.status(200).json({ ok: true, status: "rejected" });
}

/**
 * Accounts updates the Trust Deposit Receipt No. Editable at ANY status.
 * The value lives inside the form JSONB (form.deposit.receiptNo), so we
 * read-modify-write that object rather than a top-level column.
 */
async function setReceiptNo(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  const { receiptNo } = req.body || {};
  const value = String(receiptNo ?? "").trim();

  const form = { ...(deal.form || {}) };
  form.deposit = { ...(form.deposit || {}), receiptNo: value };

  const { error } = await supabase
    .from("deal_sheets")
    .update({ form })
    .eq("id", deal.id);
  if (error) throw new HttpError(500, "Could not save receipt number");

  await supabase.from("deal_sheet_events").insert({
    deal_id: deal.id,
    actor: user.oid,
    from_status: deal.status,
    to_status: deal.status,
    note: value ? `Trust receipt no. set to ${value}` : "Trust receipt no. cleared",
  });

  return res.status(200).json({ ok: true, receiptNo: value });
}

/**
 * Accounts adds or edits a trust deposit — including on a deal the
 * office admin never flagged as a trust deal. This happens: a deposit
 * can land in the trust account without the admin knowing at the time
 * the deal sheet was filed, so accounts spots it later from the bank
 * feed and records it here. Editable at any status after submission.
 *
 * Sets BOTH the top-level deposit_to_trust column AND
 * form.depositToTrust — the column drives what accounts.html shows,
 * but the form is what gets rewritten on every save while a deal is
 * still editable (draft/rejected). If only the column were set and
 * the deal were later returned to the broker and resubmitted, her
 * form (still showing the box unticked) would silently overwrite the
 * column back to false on the next save. Updating both keeps the
 * correction in place regardless of what happens afterward.
 */
async function setTrustDeposit(req, res, deal) {
  const user = await requireUser(req, ["accounts", "manager"]);
  if (deal.status === "draft")
    throw new HttpError(409, "Cannot record a trust deposit on a draft — the office admin is still preparing it");

  const { amount, receiptNo } = req.body || {};
  const amountValue = String(amount ?? "").trim();
  const receiptValue = String(receiptNo ?? "").trim();

  const form = { ...(deal.form || {}) };
  form.deposit = { ...(form.deposit || {}), amount: amountValue, receiptNo: receiptValue };
  form.depositToTrust = true;

  const wasFlagged = !!deal.deposit_to_trust;
  const { error } = await supabase
    .from("deal_sheets")
    .update({ form, deposit_to_trust: true })
    .eq("id", deal.id);
  if (error) throw new HttpError(500, "Could not save trust deposit");

  await supabase.from("deal_sheet_events").insert({
    deal_id: deal.id,
    actor: user.oid,
    from_status: deal.status,
    to_status: deal.status,
    note: wasFlagged
      ? `Trust deposit updated: $${amountValue || "0"}, receipt ${receiptValue || "—"}`
      : `Trust deposit added by accounts (not flagged by office admin): $${amountValue || "0"}, receipt ${receiptValue || "—"}`,
  });

  return res.status(200).json({ ok: true, amount: amountValue, receiptNo: receiptValue });
}
