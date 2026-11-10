// /api/deal-board/sync-rankings.js
//
// Updates public.db_broker_rankings from the master finance report.
//
// TWO WAYS IN, ONE PARSER
// ---------------------------------------------------------------------
//   POST  { text, commit }   rows pasted from Excel by a manager.
//                            Still works - the fallback if Graph fails.
//   GET   cron / ?force=1    reads the workbook over Microsoft Graph.
//                            LIVE since Nov 2026 - see below.
//
// Both feed the same parseMaster() and the same applyParsed(), so the
// figures cannot drift between them.
//
// ---------------------------------------------------------------------
// THE GRAPH PATH (dormant Aug-Nov 2026, live from Nov 2026)
// ---------------------------------------------------------------------
// Sites.Selected is consented on the PropCMA registration, with a
// per-site read grant on https://cjch.sharepoint.com/sites/Admin.
//
// Until Nov 2026 'FF Main Report - DO NOT AMEND.xlsx' carried in-file
// IRM ("Access to this workbook has been restricted to certain
// people"). Graph returned 501 on /workbook/ for it: an app-only token
// has no user identity for the rights service to issue a decryption
// licence to. In Nov 2026 the owners removed the IRM and the file is
// now restricted by SharePoint permissions instead, which the app's
// site grant gets through. If the IRM is ever put back, the sync fails
// with a clear "rights-protected" message and paste still works.
//
// ---------------------------------------------------------------------
// WHY THE MASTER, NOT THE FOUR RANKINGS FILES
// ---------------------------------------------------------------------
// The four "<Unit> rankings.xlsx" files are external-link views onto
// this master - every cell is =[1]Summary!$N$6. Those return the CACHED
// value, i.e. whatever was there when someone last opened the file.
// Checked in Aug 2026, several brokers were behind by about a month of
// fees with no error anywhere. Read the master.
// ---------------------------------------------------------------------

import { supabase } from "../_lib/supabase.js";
import { requireUser, sendError, HttpError } from "../_lib/auth.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

// ── shared parsing ────────────────────────────────────────────────

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  let s = String(v).trim();
  // Excel renders negatives in parentheses in this workbook.
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  s = s.replace(/[$,\s]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
};

// The master Summary sheet holds all four business units in one sheet:
//   column A  broker name        column N  total fees YTD
//   column P  budget             column T  deal count
// Unit blocks are introduced by a row whose column A names the unit,
// and closed by a Sub-total row.
//
// The header is split across two rows ("Total" in row 4, "Budget" in
// row 5), so header-matching does not work here - fixed columns are
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

// Excel puts tab-separated text on the clipboard. Cells containing a
// tab or newline arrive wrapped in quotes with inner quotes doubled.
function parsePaste(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t").map((cell) => {
      const v = cell.trim();
      if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) {
        return v.slice(1, -1).replace(/""/g, '"');
      }
      return v;
    }));
}

// ── writing ───────────────────────────────────────────────────────
// commit=false does everything except the write, so a manager can see
// what would change before it changes. Rankings are upserted per
// broker, never deleted, so a partial paste updates what it covers and
// leaves the rest alone.
async function applyParsed(parsed, depts, nameMap, commit) {
  const year = new Date().getFullYear();
  const results = [];

  for (const dept of depts) {
    const block = parsed[dept.slug];
    if (!block) { results.push({ slug: dept.slug, skipped: "no block found" }); continue; }

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

    if (commit && upserts.length) {
      const { error } = await supabase.from("db_broker_rankings")
        .upsert(upserts, { onConflict: "department_id,broker_code,financial_year" });
      if (error) {
        console.error("rankings upsert failed", {
          slug: dept.slug, code: error.code, message: error.message, details: error.details,
        });
        results.push({ slug: dept.slug, error: "could not save" });
        continue;
      }
    }

    if (commit && unmatched.length) {
      // The sync now runs every morning, so only log a name that is not
      // already sitting there unresolved - otherwise the same names
      // would pile up once a day.
      const reason = `no broker code mapped (${dept.slug})`;
      const { data: open } = await supabase.from("db_ranking_sync_issues")
        .select("ranking_name").eq("resolved", false).eq("reason", reason);
      const already = new Set((open || []).map((o) => o.ranking_name.toLowerCase()));
      const fresh = unmatched.filter((n) => !already.has(n.toLowerCase()));
      if (fresh.length) {
        await supabase.from("db_ranking_sync_issues").insert(
          fresh.map((n) => ({ ranking_name: n, reason }))
        );
      }
    }

    results.push({
      slug: dept.slug,
      updated: upserts.length,
      total_fees: upserts.reduce((a, u) => a + (u.fees_nzd || 0), 0),
      unmatched,
    });
  }
  return results;
}

async function loadRefs() {
  const { data: depts, error } = await supabase.from("db_departments").select("id, slug");
  if (error) throw new HttpError(500, "Could not load departments");

  const { data: names } = await supabase.from("db_broker_ranking_names")
    .select("broker_code, ranking_name");
  const nameMap = Object.fromEntries(
    (names || []).map((n) => [n.ranking_name.toLowerCase(), n.broker_code])
  );
  return { depts: depts || [], nameMap };
}

// ── POST: pasted from Excel ───────────────────────────────────────

async function handlePaste(req, res) {
  await requireUser(req, ["manager"]);

  const { text, commit } = req.body || {};
  if (!text || !String(text).trim()) throw new HttpError(400, "Nothing was pasted");

  const rows = parsePaste(text);
  if (rows.length < 5) {
    throw new HttpError(400,
      `Only ${rows.length} row${rows.length === 1 ? "" : "s"} came through. ` +
      `Select the whole Summary sheet before copying.`);
  }

  // The fee column is N, the fourteenth. A narrower paste means columns
  // were left out of the selection, and every fee would read as blank -
  // which would look like a clean run that changed nothing.
  const width = Math.max(...rows.map((r) => r.length));
  if (width <= COL.fees) {
    throw new HttpError(400,
      `The paste is only ${width} column${width === 1 ? "" : "s"} wide. ` +
      `Fees are in column N, so select at least columns A to P.`);
  }

  const parsed = parseMaster(rows);
  const found = Object.keys(parsed);
  if (!found.length) {
    throw new HttpError(400,
      "No unit headings found in column A. Expected Commercial Sales, " +
      "Industrial, Commercial Leasing or Retail.");
  }

  const { depts, nameMap } = await loadRefs();
  const results = await applyParsed(parsed, depts, nameMap, !!commit);

  return res.status(200).json({
    ran_at: new Date().toISOString(),
    source: "paste",
    committed: !!commit,
    pasted_rows: rows.length,
    pasted_width: width,
    results,
  });
}

// ── GET: Microsoft Graph ────────────────────────────────

async function graphToken() {
  // The same app registration and settings as api/_lib/graph.js (accounts
  // emails) and the Operations Manual roster sync: MS_TENANT_ID /
  // MS_CLIENT_ID / MS_CLIENT_SECRET. The older GRAPH_* names are still
  // honoured if all three are ever set.
  const useGraphNames = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"]
    .every((k) => process.env[k] && String(process.env[k]).trim());
  const env = useGraphNames ? {
    GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
    GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
    GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
  } : {
    GRAPH_TENANT_ID: process.env.MS_TENANT_ID,
    GRAPH_CLIENT_ID: process.env.MS_CLIENT_ID,
    GRAPH_CLIENT_SECRET: process.env.MS_CLIENT_SECRET,
  };
  const missing = Object.entries(env).filter(([, v]) => !v || !String(v).trim())
    .map(([k]) => k.replace("GRAPH_", useGraphNames ? "GRAPH_" : "MS_"));
  if (missing.length) throw new HttpError(500, `Not configured: ${missing.join(", ")}`);

  const res = await fetch(
    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID.trim()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GRAPH_CLIENT_ID.trim(),
        client_secret: env.GRAPH_CLIENT_SECRET.trim(),
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("graph token rejected", { error: data.error, description: data.error_description });
    throw new HttpError(502, `Graph sign-in failed: ${data.error_description || res.status}`);
  }
  return data.access_token;
}

// Where the master lives. It sits on the Admin site, which the PropCMA
// app registration already has a Sites.Selected read grant on. The id
// is the sourcedoc= GUID from the file's SharePoint URL; it survives a
// rename or move. If it does not resolve, the file is looked for by
// name instead. Every value can be overridden in Vercel without a code
// change. RANKINGS_SITE_ID / RANKINGS_ITEM_ID (the old variable names)
// still work if they were ever set.
const MASTER = {
  host: process.env.RANKINGS_SP_HOST || "cjch.sharepoint.com",
  sitePath: process.env.RANKINGS_SP_SITE_PATH || "/sites/Admin",
  siteId: process.env.RANKINGS_SITE_ID || null,
  itemId: process.env.RANKINGS_ITEM_ID || "52A063E9-043C-4D02-AD9C-130403FD4016",
  fileName: process.env.RANKINGS_FILE_NAME || "FF Main Report - DO NOT AMEND.xlsx",
  sheet: process.env.RANKINGS_SHEET || "Summary",
};

// Set RANKINGS_SYNC=off in Vercel to stop the daily read without a
// redeploy of different code. Paste-in keeps working either way.
const SYNC_OFF = /^(off|false|0|no)$/i.test(String(process.env.RANKINGS_SYNC || "").trim());

async function graphGet(token, url, what) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${what}: ${data.error?.message || res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sameName = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// Finds the master and returns { driveId, item }. Tries, in order:
//   (a) the sourcedoc GUID, on each document library of the site
//   (b) the file name, in each library's root and two folder levels down
// Search is not used: it relies on the search index, which is unreliable
// under Sites.Selected (see api/_lib/excel.js).
async function findMaster(token) {
  const siteId = MASTER.siteId || (await graphGet(token,
    `${GRAPH}/sites/${MASTER.host}:${MASTER.sitePath}?$select=id`, "resolve site")).id;

  const drives = (await graphGet(token,
    `${GRAPH}/sites/${siteId}/drives?$select=id,name`, "list libraries")).value || [];
  if (!drives.length) throw new HttpError(502, "No document libraries found on the SharePoint site");

  const sel = "$select=id,name,lastModifiedDateTime,lastModifiedBy";
  const attempts = [];

  if (MASTER.itemId) {
    const id = MASTER.itemId.replace(/[{}]/g, "");
    for (const d of drives) {
      try {
        const item = await graphGet(token, `${GRAPH}/drives/${d.id}/items/${id}?${sel}`, "by id");
        if (item?.id) return { driveId: d.id, item, foundBy: "id" };
      } catch (e) { attempts.push(`${d.name} by id: ${e.status || e.message}`); }
    }
  }

  // Bounded so a large library cannot run the function out of time.
  let budget = 150;
  for (const d of drives) {
    let level = [{ id: "root" }];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const next = [];
      for (const folder of level) {
        if (--budget < 0) break;
        let kids;
        try {
          kids = (await graphGet(token,
            `${GRAPH}/drives/${d.id}/items/${folder.id}/children?$select=id,name,folder,lastModifiedDateTime,lastModifiedBy&$top=500`,
            "list folder")).value || [];
        } catch (e) { attempts.push(`${d.name} list: ${e.status || e.message}`); continue; }
        const hit = kids.find((k) => !k.folder && sameName(k.name, MASTER.fileName));
        if (hit) return { driveId: d.id, item: hit, foundBy: "name" };
        next.push(...kids.filter((k) => k.folder));
      }
      level = next;
    }
  }

  console.error("rankings: master not found", { attempts: attempts.slice(0, 10) });
  throw new HttpError(502,
    `Could not find "${MASTER.fileName}" on the SharePoint site. Use the paste option.`);
}

async function readSheet(token, driveId, itemId) {
  const base = `${GRAPH}/drives/${driveId}/items/${itemId}/workbook`;
  const rangeOf = (name) =>
    `${base}/worksheets/${encodeURIComponent(name)}/usedRange(valuesOnly=true)?$select=values`;

  let sheet = MASTER.sheet;
  let res = await fetch(rangeOf(sheet), { headers: { Authorization: `Bearer ${token}` } });

  // If the tab was renamed (e.g. "Summary 2026"), take the one tab whose
  // name starts with "Summary" rather than failing outright.
  if (res.status === 404) {
    const tabs = (await graphGet(token, `${base}/worksheets?$select=name`, "list sheets")).value || [];
    const matches = tabs.filter((t) => t.name.trim().toLowerCase().startsWith(MASTER.sheet.toLowerCase()));
    if (matches.length !== 1) {
      throw new HttpError(502,
        `No "${MASTER.sheet}" sheet in the master. Sheets found: ${tabs.map((t) => t.name).slice(0, 12).join(", ")}`);
    }
    sheet = matches[0].name;
    res = await fetch(rangeOf(sheet), { headers: { Authorization: `Bearer ${token}` } });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 501 here means the workbook is IRM-protected: the Excel service
    // cannot open an encrypted package for an app-only caller.
    if (res.status === 501) {
      throw new HttpError(502,
        "The master workbook is rights-protected again, so it cannot be read automatically. Use the paste option.");
    }
    throw new HttpError(502, `Could not read ${sheet}: ${data.error?.message || res.status}`);
  }
  return { sheet, rows: data.values || [] };
}

// GET is the daily cron (09:00 NZDT / 08:00 NZST, vercel.json) and the
// manager's "Fetch from SharePoint" button. ?dry=1 previews without
// writing - the button always previews first, exactly like a paste.
async function handleGraph(req, res) {
  const auth = req.headers.authorization || "";
  const isCron = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    if (!req.query.force) throw new HttpError(401, "Not authorised");
    await requireUser(req, ["manager"]);
  }

  if (SYNC_OFF) {
    return res.status(200).json({
      ran_at: new Date().toISOString(),
      skipped: "RANKINGS_SYNC is off in Vercel - rankings are pasted in by hand",
    });
  }

  const commit = isCron || !req.query.dry;
  const { depts, nameMap } = await loadRefs();
  const token = await graphToken();
  const { driveId, item, foundBy } = await findMaster(token);
  const { sheet, rows } = await readSheet(token, driveId, item.id);

  const parsed = parseMaster(rows);
  if (!Object.keys(parsed).length) {
    throw new HttpError(502,
      `Read ${rows.length} rows from ${sheet} but found no unit headings in column A. ` +
      `Has the Summary layout changed?`);
  }

  const results = await applyParsed(parsed, depts, nameMap, commit);
  return res.status(200).json({
    ran_at: new Date().toISOString(),
    source: "graph",
    committed: commit,
    file: item.name,
    sheet,
    file_saved_at: item.lastModifiedDateTime || null,
    file_saved_by: item.lastModifiedBy?.user?.displayName || null,
    // Found by name means the id lookup missed: set RANKINGS_ITEM_ID to
    // item_id in Vercel to skip the folder walk on later runs.
    found_by: foundBy,
    item_id: item.id,
    pasted_rows: rows.length,
    pasted_width: Math.max(0, ...rows.map((r) => r.length)),
    results,
  });
}

// ── entry ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method === "POST") return await handlePaste(req, res);
    return await handleGraph(req, res);
  } catch (e) {
    sendError(res, e);
  }
}
