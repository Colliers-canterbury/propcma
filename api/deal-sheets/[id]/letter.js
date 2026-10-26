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
// accounts/manager can generate any letter. The office admin who filed
// the deal (admin.html) can generate the two Early Release letters once
// the deal has been submitted — not while it's a draft or returned.

import { requireUser, sendError, HttpError } from "../../_lib/auth.js";
import { supabase } from "../../_lib/supabase.js";
import { buildLetter, letterFilename, availableLetters } from "../../_lib/letters.js";

const EARLY_RELEASE = ["vendor", "purchaser"];

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    const user = await requireUser(req);
    const { id, type } = req.query;

    const { data: deal, error } = await supabase
      .from("deal_sheets").select("*").eq("id", id).single();
    if (error || !deal) throw new HttpError(404, "Deal sheet not found");

    const isStaff = ["accounts", "manager"].includes(user.role);
    if (!isStaff) {
      const isOwner = deal.created_by === user.oid;
      if (!isOwner) throw new HttpError(403, "Not permitted");
      if (!EARLY_RELEASE.includes(type))
        throw new HttpError(403, "Only the Early Release letters are available here");
      if (["draft", "rejected"].includes(deal.status))
        throw new HttpError(400, "Early Release letters are available once the deal sheet has been submitted");
    }

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
