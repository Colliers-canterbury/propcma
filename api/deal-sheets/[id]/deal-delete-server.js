// DELETE handler for /api/deal-sheets/[id] — paste this branch into the
// serverless function that currently handles GET for a single deal
// (likely api/deal-sheets/[id]/index.js), alongside the existing methods.
//
// Rules: a broker may delete their OWN deal sheet only while it is a
// draft or has been returned by accounts ("rejected"). Submitted /
// processing / invoiced deals cannot be deleted — they are part of the
// accounts audit trail.
//
// NOTE: verify the three related table names against your schema —
// deal_sheet_attachments is confirmed; deal_sheet_splits and
// deal_sheet_events are educated guesses from the data shapes.

if (req.method === "DELETE") {
  const user = await requireUser(req);
  const { data: deal, error } = await supabase
    .from("deal_sheets").select("id, created_by, status").eq("id", id).single();
  if (error || !deal) throw new HttpError(404, "Deal sheet not found");

  const canDelete = deal.created_by === user.oid && ["draft", "rejected"].includes(deal.status);
  if (!canDelete)
    throw new HttpError(403, "Only your own draft or returned deal sheets can be deleted");

  // Remove attachment files from storage, then the related rows, then the deal.
  const { data: atts } = await supabase.from("deal_sheet_attachments")
    .select("storage_path").eq("deal_id", id);
  if (atts && atts.length)
    await supabase.storage.from("deal-documents").remove(atts.map((a) => a.storage_path));

  await supabase.from("deal_sheet_attachments").delete().eq("deal_id", id);
  await supabase.from("deal_sheet_splits").delete().eq("deal_id", id);
  await supabase.from("deal_sheet_events").delete().eq("deal_id", id);
  const { error: delErr } = await supabase.from("deal_sheets").delete().eq("id", id);
  if (delErr) throw new HttpError(500, "Delete failed: " + delErr.message);

  return res.status(200).json({ ok: true });
}
