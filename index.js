// /api/manual/index.js
// GET /api/manual → the Operations Manual content and the Team Dashboard
// data (roster, supervision, broker audits, open issues, suppliers, REINZ).
//
// Gated the same way as the rest of PropCMA: requires a valid Microsoft
// (Entra ID) bearer token AND the caller's app_users role must be
// "accounts" or "manager" — i.e. the Finance Manager (Accounts) and the
// Operations Manager (Manager). Nobody else, and no unauthenticated
// request, can read this data. This is deliberate: the roster below
// includes staff dates of birth, personal mobiles and home addresses,
// and the manual itself covers AML, insurance and franchise terms —
// none of that should ever be served as a plain static file.

import { requireUser, sendError } from "../_lib/auth.js";
import { MANUAL, MANUAL_VERSION, MANUAL_UPDATED } from "./content.js";
import {
  DASHBOARD_SNAPSHOT_DATE,
  ROSTER,
  BROKER_CONTRACT_AUDITS,
  OPEN_ISSUES_REGISTER,
  SUPPLIERS_SPONSORS,
  REINZ_AWARDS,
  SUPERVISION_PROCESS,
} from "./roster-data.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    await requireUser(req, ["accounts", "manager"]);

    return res.status(200).json({
      manual: {
        version: MANUAL_VERSION,
        updated: MANUAL_UPDATED,
        chapters: MANUAL,
      },
      dashboard: {
        snapshotDate: DASHBOARD_SNAPSHOT_DATE,
        roster: ROSTER,
        supervisionProcess: SUPERVISION_PROCESS,
        brokerContractAudits: BROKER_CONTRACT_AUDITS,
        openIssuesRegister: OPEN_ISSUES_REGISTER,
        suppliersSponsors: SUPPLIERS_SPONSORS,
        reinzAwards: REINZ_AWARDS,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
}
