// /api/deal-sheets/[id]/letter.js
//
// GET /api/deal-sheets/:id/letter?type=vendor|purchaser|disbursement
//
// Returns an editable .docx — the matching accounts letter template
// (see api/_lib/letter-templates.js) merged with this deal's data (see
// api/_lib/letters.js). Finance downloads it, opens it in Word, checks
// the merged fields and fills in anything not sourced from the deal
// sheet (REF number, lawyer's postal address, trust account number),
// then sends it themselves — same as the manual process today, just
// starting from a filled-in draft instead of a blank template.
//
// accounts/manager only, same as the rest of accounts.html's actions.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";
import { buildLetter, letterFilename, availableLetters } from "../../_lib/letters.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    await requireUser(req, ["accounts", "manager"]);
    const { id, type } = req.query;

    const { data: deal, error } = await supabase
      .from("deal_sheets").select("*").eq("id", id).single();
    if (error || !deal) throw new HttpError(404, "Deal sheet not found");

    if (!availableLetters(deal.deal_type).includes(type)) {
      throw new HttpError(400, `"${type}" isn't available for a ${deal.deal_type || "sale"} deal`);
    }

    const buf = buildLetter(deal, type);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${letterFilename(deal, type).replace(/"/g, "")}"`);
    return res.status(200).send(buf);
  } catch (e) {
    sendError(res, e);
  }
}
