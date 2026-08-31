// /api/deal-board/sync-rankings.js
//
// Updates public.db_broker_rankings from the master finance report.
//
// TWO WAYS IN, ONE PARSER
// ---------------------------------------------------------------------
//   POST  { text, commit }   rows pasted from Excel by a manager.
//                            This is the live path.
//   GET   ?force=1 / cron    reads the workbook over Microsoft Graph.
//                            DORMANT - see below.
//
// Both feed the same parseMaster() and the same applyParsed(), so the
// figures cannot drift between them.
//
// ---------------------------------------------------------------------
// WHY THE GRAPH PATH IS DORMANT (Aug 2026)
// ---------------------------------------------------------------------
// The permissions work is DONE and verified: Sites.Selected is consented
// on the PropCMA registration, and a per-site read grant on
// https://cjch.sharepoint.com/sites/Admin resolves. The app can list the
// library and read most workbooks in it.
//
// The master itself cannot be read. 'FF Main Report - DO NOT AMEND.xlsx'
// carries in-file IRM ("Access to this workbook has been restricted to
// certain people"). Graph returns 501 on /workbook/ for it while
// returning 200 on the same call for unprotected siblings, and metadata
// reads fine throughout - so this is encryption, not permissions. An
// app-only token has no user identity for the rights service to issue a
// decryption licence to, so no amount of SharePoint permission work
// fixes it. Excel for the web refuses the same file interactively.
//
// It is left in place because it is a few env vars from working if the
// protection is ever lifted or an unprotected extract is published.
// Leaving RANKINGS_ITEM_ID unset keeps it switched off cleanly.
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
      await supabase.from("db_ranking_sync_issues").insert(
        unmatched.map((n) => ({
          ranking_name: n,
          reason: `no broker code mapped (${dept.slug})`,
        }))
      );
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

// ── GET: Microsoft Graph (dormant) ────────────────────────────────

async function graphToken() {
  const env = {
    GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
    GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
    GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
  };
  const missing = Object.entries(env).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
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

async function readSheet(token, siteId, itemId, sheet) {
  const url = `${GRAPH}/sites/${siteId}/drive/items/${itemId}` +
              `/workbook/worksheets/${encodeURIComponent(sheet)}/usedRange(valuesOnly=true)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    // 501 here means the workbook is IRM-protected: the Excel service
    // cannot open an encrypted package for an app-only caller.
    if (res.status === 501) {
      throw new HttpError(502,
        "The master workbook is rights-protected, so it cannot be read automatically. Use the paste option.");
    }
    throw new HttpError(502, `Could not read ${sheet}: ${data.error?.message || res.status}`);
  }
  return data.values || [];
}

async function handleGraph(req, res) {
  const auth = req.headers.authorization || "";
  const isCron = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    if (!req.query.force) throw new HttpError(401, "Not authorised");
    await requireUser(req, ["manager"]);
  }

  const cfg = {
    site_id: process.env.RANKINGS_SITE_ID,
    item_id: process.env.RANKINGS_ITEM_ID,
    sheet: process.env.RANKINGS_SHEET || "Summary",
  };
  if (!cfg.site_id || !cfg.item_id) {
    return res.status(200).json({
      ran_at: new Date().toISOString(),
      skipped: "RANKINGS_ITEM_ID not set - the master is rights-protected, rankings are pasted in by hand",
    });
  }

  const { depts, nameMap } = await loadRefs();
  const token = await graphToken();
  const rows = await readSheet(token, cfg.site_id, cfg.item_id, cfg.sheet);
  const results = await applyParsed(parseMaster(rows), depts, nameMap, true);
  return res.status(200).json({ ran_at: new Date().toISOString(), source: "graph", results });
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
