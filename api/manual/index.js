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
//
// The four spreadsheet-driven datasets (roster, broker contract audits,
// open issues register, suppliers & sponsors) are read live from
// Supabase, refreshed every Friday by api/manual/sync-roster.js from
// "Real Estate Agent Management Dashboard.xlsx" on SharePoint — see
// that file and sql/manual_dashboard_setup.sql. Supervision process
// text and the REINZ awards note are narrative, not tabular, so they
// stay as hand-edited constants in roster-data.js, same as before.

import { requireUser, sendError } from "../_lib/auth.js";
import { supabase } from "../_lib/supabase.js";
import { MANUAL, MANUAL_VERSION, MANUAL_UPDATED } from "./content.js";
import { SUPERVISION_PROCESS, REINZ_AWARDS } from "./roster-data.js";

async function loadDashboardTable(table) {
  const { data, error } = await supabase.from(table).select("data").order("id");
  if (error) throw new Error(`Loading ${table} failed: ${error.message}`);
  return (data || []).map((row) => row.data);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    await requireUser(req, ["accounts", "manager"]);

    const [roster, brokerContractAudits, openIssuesRegister, suppliersSponsors, meta] =
      await Promise.all([
        loadDashboardTable("manual_dashboard_roster"),
        loadDashboardTable("manual_dashboard_broker_audits"),
        loadDashboardTable("manual_dashboard_open_issues"),
        loadDashboardTable("manual_dashboard_suppliers"),
        supabase
          .from("manual_dashboard_meta")
          .select("snapshot_date, synced_at, status, last_error")
          .eq("id", "singleton")
          .maybeSingle(),
      ]);

    return res.status(200).json({
      manual: {
        version: MANUAL_VERSION,
        updated: MANUAL_UPDATED,
        chapters: MANUAL,
      },
      dashboard: {
        snapshotDate: meta.data?.snapshot_date || null,
        syncedAt: meta.data?.synced_at || null,
        syncStatus: meta.data?.status || null,
        syncError: meta.data?.status === "error" ? meta.data?.last_error : null,
        roster,
        supervisionProcess: SUPERVISION_PROCESS,
        brokerContractAudits,
        openIssuesRegister,
        suppliersSponsors,
        reinzAwards: REINZ_AWARDS,
      },
    });
  } catch (e) {
    sendError(res, e);
  }
}
