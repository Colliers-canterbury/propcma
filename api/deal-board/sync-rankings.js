// /api/deal-board/sync-rankings.js
//
// Reads each department's rankings workbook from SharePoint via Microsoft
// Graph and upserts public.db_broker_rankings.
//
// Runs daily on a Vercel cron (see vercel.json) and can also be called
// by hand with ?force=1 while signed in as a manager.
//
// ---------------------------------------------------------------------
// SETUP — three things before this works
// ---------------------------------------------------------------------
// 1. App registration (the PropCMA one is fine) needs the APPLICATION
//    permission Files.Read.All or Sites.Read.All, with admin consent.
//    This runs without a signed-in user, so delegated permissions will
//    not do.
//
// 2. Environment variables in Vercel:
//      GRAPH_TENANT_ID       your Entra tenant id
//      GRAPH_CLIENT_ID       app registration (client) id
//      GRAPH_CLIENT_SECRET   client secret — server-side only
//      CRON_SECRET           any long random string; Vercel sends it
//
// 3. The MASTER workbook's location, as env vars. Two ways — the path
//    form needs no Graph Explorer lookup:
//
//    (a) By path (easiest). From the SharePoint URL
//        https://cjch.sharepoint.com/sites/Admin/Shared%20Documents/Management/FF%20Main%20Report%20-%20DO%20NOT%20AMEND.xlsx
//        take the site after /sites/ and the path after the document
//        library, un-escaping %20 back to spaces:
//
//          RANKINGS_SITE_PATH = Admin
//          RANKINGS_FILE_PATH = Management/FF Main Report - DO NOT AMEND.xlsx
//
//    (b) By id, if you already have them:
//          RANKINGS_SITE_ID   cjch.sharepoint.com,<guid>,<guid>
//          RANKINGS_ITEM_ID   the drive item id
//
//    Optional in both cases:
//          RANKINGS_HOSTNAME  defaults to cjch.sharepoint.com
//          RANKINGS_SHEET     defaults to 'Summary'
//
//    Without any of these the job exits cleanly and rankings stay
//    manual (scripts/refresh_rankings.sql).
//
// ---------------------------------------------------------------------
// WHY THE MASTER, NOT THE FOUR RANKINGS FILES
// ---------------------------------------------------------------------
// The four "<Unit> rankings.xlsx" files are external-link views onto
// this master — every cell is =[1]Summary!$N$6. Graph returns the
// CACHED value of such a cell, i.e. whatever was there when someone
// last opened the file in Excel. Checked against the master in
// Aug 2026, several brokers were behind by about a month of fees with
// no error anywhere. Read the master.
//
// The master is on a restricted drive. That is fine: this job runs as
// an application, not as a user, so it does not need anyone's access —
// and only the fee/budget figures reach the board, never the workbook.
// ---------------------------------------------------------------------

import { supabase } from "../_lib/supabase.js";
import { requireUser, sendError, HttpError } from "../_lib/auth.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

// Patch for api/deal-board/sync-rankings.js
//
// Replace the top of graphToken() with the version below.
//
// The current message lists all three variables whenever any one of
// them is missing, which is why it cannot tell you which to fix. This
// reports the missing names only.
//
// Names only — never values. A client secret must not reach a browser
// or a log, so this checks presence and stops there.

async function graphToken() {
  const env = {
    GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
    GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
    GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
  };

  // Empty string counts as missing — a var saved with a blank value
  // behaves the same as one that was never added.
  const missing = Object.entries(env)
    .filter(([, v]) => !v || !String(v).trim())
    .map(([k]) => k);

  if (missing.length) {
    // Any GRAPH_-ish names that ARE present, to catch the case where
    // the values were set under a different prefix. Keys only.
    const nearby = Object.keys(process.env)
      .filter((k) => /GRAPH|AZURE|TENANT|CLIENT|MSAL/i.test(k) && !/SECRET/i.test(k))
      .sort();
    console.error("sync-rankings: missing env", { missing, nearby });

    throw new HttpError(500,
      `Not configured: ${missing.join(", ")} ` +
      `(${3 - missing.length} of 3 Graph variables present)`);
  }

  const tenant = env.GRAPH_TENANT_ID.trim();
  const id = env.GRAPH_CLIENT_ID.trim();
  // Secrets are the usual casualty of copy-paste — a trailing newline
  // survives the presence check above and then fails authentication
  // with an unhelpful AADSTS error.
  const secret = env.GRAPH_CLIENT_SECRET.trim();

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("sync-rankings: token request rejected", {
      status: res.status,
      error: data.error,
      // AADSTS codes identify the cause precisely:
      //   AADSTS7000215  invalid secret (wrong value, or the secret ID
      //                  was pasted instead of the value)
      //   AADSTS7000222  secret expired
      //   AADSTS700016   client id not found in this tenant
      //   AADSTS900023   tenant id not recognised
      description: data.error_description,
    });
    throw new HttpError(502, `Graph sign-in failed: ${data.error_description || res.status}`);
  }
  return data.access_token;
}

// Resolve the site by path (cjch.sharepoint.com:/sites/Admin) so no
// pre-looked-up GUID is needed.
async function resolveSite(token, hostname, sitePath) {
  const url = `${GRAPH}/sites/${hostname}:/sites/${sitePath}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    throw new HttpError(502,
      `Could not find site /sites/${sitePath}: ${data.error?.message || res.status}`);
  }
  return data.id;
}

async function readSheet(token, cfg, sheet) {
  const siteId = cfg.site_id ||
    await resolveSite(token, cfg.hostname, cfg.site_path);

  // Either address the file by path within the default document
  // library, or by its item id when one was supplied.
  const base = cfg.item_id
    ? `${GRAPH}/sites/${siteId}/drive/items/${cfg.item_id}`
    : `${GRAPH}/sites/${siteId}/drive/root:/${
        cfg.file_path.split("/").map(encodeURIComponent).join("/")}:`;

  const url = `${base}/workbook/worksheets/${encodeURIComponent(sheet)}` +
              `/usedRange(valuesOnly=true)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    throw new HttpError(502,
      `Could not read ${sheet}: ${data.error?.message || res.status}`);
  }
  return data.values || [];
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// The master Summary sheet holds all four business units in one sheet:
//   column A  broker name        column N  total fees YTD
//   column P  budget             column T  deal count
// Unit blocks are introduced by a row whose column A names the unit,
// and closed by a Sub-total row.
//
// The header is split across two rows ("Total" in row 4, "Budget" in
// row 5), so header-matching does not work here — fixed columns are
// used instead, and verified against the block labels before any row
// is trusted.
const COL = { name: 0, fees: 13, budget: 15, deals: 19 };

const UNIT_BLOCKS = {
  "commercial sales": "investment",
  "industrial": "industrial",
  "commercial leasing": "leasing",
  "retail": "retail",
};

function parseMaster(rows) {
  const out = {};
  let unit = null;
  for (const row of rows) {
    const label = String(row[COL.name] ?? "").trim();
    if (!label) continue;
    const key = label.toLowerCase();

    if (UNIT_BLOCKS[key]) { unit = UNIT_BLOCKS[key]; out[unit] = out[unit] || []; continue; }
    if (/^(sub-?total|total|%|other|ytd)/i.test(label)) continue;
    if (!unit) continue;

    const fees = num(row[COL.fees]);
    if (fees === null) continue;
    out[unit].push({ name: label, fees, budget: num(row[COL.budget]) });
  }
  return out;
}

async function syncMaster(token, cfg, depts, nameMap) {
  const rows = await readSheet(token, cfg, cfg.sheet || "Summary");
  const parsed = parseMaster(rows);
  const year = new Date().getFullYear();
  const results = [];

  for (const dept of depts) {
    const block = parsed[dept.slug];
    if (!block) { results.push({ slug: dept.slug, skipped: "no block in master" }); continue; }

    const upserts = [];
    const unmatched = [];
    for (const r of block) {
      const code = nameMap[r.name.toLowerCase()];
      if (!code) { unmatched.push(r.name); continue; }
      upserts.push({
        department_id: dept.id,
        broker_code: code,
        financial_year: year,
        fees_nzd: r.fees,
        budget_nzd: r.budget || null,
        synced_at: new Date().toISOString(),
      });
    }

    if (upserts.length) {
      const { error } = await supabase.from("db_broker_rankings")
        .upsert(upserts, { onConflict: "department_id,broker_code,financial_year" });
      if (error) { results.push({ slug: dept.slug, error: error.message }); continue; }
    }

    if (unmatched.length) {
      await supabase.from("db_ranking_sync_issues").insert(
        unmatched.map((n) => ({
          ranking_name: n,
          reason: `no broker code mapped (${dept.slug})`,
        }))
      );
    }

    results.push({ slug: dept.slug, updated: upserts.length, unmatched });
  }
  return results;
}

export default async function handler(req, res) {
  try {
    // Vercel cron sends the CRON_SECRET as a bearer token. A manager can
    // also trigger it by hand with ?force=1.
    const auth = req.headers.authorization || "";
    const isCron = process.env.CRON_SECRET &&
                   auth === `Bearer ${process.env.CRON_SECRET}`;
    if (!isCron) {
      if (!req.query.force) throw new HttpError(401, "Not authorised");
      await requireUser(req, ["manager"]);
    }

    // One master workbook covers every unit, so the location lives in
    // env vars rather than per-department rows.
    const cfg = {
      hostname: process.env.RANKINGS_HOSTNAME || "cjch.sharepoint.com",
      site_path: process.env.RANKINGS_SITE_PATH,
      file_path: process.env.RANKINGS_FILE_PATH,
      site_id: process.env.RANKINGS_SITE_ID,
      item_id: process.env.RANKINGS_ITEM_ID,
      sheet: process.env.RANKINGS_SHEET || "Summary",
    };
    const haveById = cfg.site_id && cfg.item_id;
    const haveByPath = cfg.site_path && cfg.file_path;
    if (!haveById && !haveByPath) {
      return res.status(200).json({
        ran_at: new Date().toISOString(),
        skipped: "RANKINGS_SITE_PATH / RANKINGS_FILE_PATH not set — " +
                 "rankings are being maintained by hand",
      });
    }

    const { data: depts, error } = await supabase.from("db_departments")
      .select("id, slug");
    if (error) throw new HttpError(500, "Could not load departments");

    const { data: names } = await supabase.from("db_broker_ranking_names")
      .select("broker_code, ranking_name");
    const nameMap = Object.fromEntries(
      (names || []).map((n) => [n.ranking_name.toLowerCase(), n.broker_code])
    );

    const token = await graphToken();
    const results = await syncMaster(token, cfg, depts || [], nameMap);
    return res.status(200).json({ ran_at: new Date().toISOString(), results });
  } catch (e) {
    sendError(res, e);
  }
}
