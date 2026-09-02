// /api/manual/sync-roster.js
//
// Weekly refresh of the Operations Manual Team Dashboard data from
// "Real Estate Agent Management Dashboard.xlsx" on SharePoint
// (Admin - Documents / OPERATIONS / DASHBOARDS), over Microsoft
// Graph — reusing the same app-registration client-credentials flow
// as api/_lib/graph.js (accounts notification emails), which the
// deal-board rankings sync already proved has a working Sites.Selected
// grant on https://cjch.sharepoint.com/sites/Admin.
//
// TWO WAYS IN, same as api/deal-board/sync-rankings.js:
//   GET, Authorization: Bearer $CRON_SECRET   — Vercel Cron (vercel.json)
//   GET ?force=1, signed in as accounts/manager — manual re-sync
//
// Reads four sheets, converts each row to the same JSON shape the
// frontend has always received from roster-data.js, and — only after
// ALL four sheets have been read and parsed successfully — replaces
// the four manual_dashboard_* tables in one pass. If anything fails
// partway (Graph error, wrong sheet name, an unexpectedly near-empty
// roster), nothing is written and the previous data stays live; the
// failure is recorded on manual_dashboard_meta so it's visible on
// the dashboard rather than failing silently.
//
// Run sql/manual_dashboard_setup.sql in Supabase once before this
// is used. See the Operations Manual build log for the rest of the
// one-time setup checklist.

import { supabase } from "../_lib/supabase.js";
import { graphToken } from "../_lib/graph.js";
import { requireUser, sendError, HttpError } from "../_lib/auth.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

// Overridable via env in case the file or site ever moves — no code
// change or redeploy needed, just a new value in Vercel.
const SP_HOST = process.env.MANUAL_ROSTER_SP_HOST || "cjch.sharepoint.com";
const SP_SITE_PATH = process.env.MANUAL_ROSTER_SP_SITE_PATH || "/sites/Admin";
const FILE_PATH =
  process.env.MANUAL_ROSTER_FILE_PATH ||
  "OPERATIONS/DASHBOARDS/Real Estate Agent Management Dashboard.xlsx";
// Optional: a driveItem id (from the SharePoint URL's sourcedoc=, minus
// braces) is faster and survives the file being renamed or moved. Falls
// back to the path above when unset.
const FILE_ITEM_ID = process.env.MANUAL_ROSTER_FILE_ITEM_ID || null;

const SHEETS = {
  roster: "Real Estate Agent Management Da", // Excel's 31-char sheet-name limit truncates this
  audits: "Broker Contract Audits",
  issues: "Project - Open Issues Register",
  suppliers: "Suppliers & Sponsors",
};

// ── Graph helpers ────────────────────────────────────────────────

async function graphGet(url, token, step) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 501) {
      throw new HttpError(502,
        `[${step}] the workbook could not be opened (501) — it may be rights-protected.`);
    }
    throw new HttpError(502, `Graph GET failed at [${step}] ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function resolveWorkbookItem(token) {
  const site = await graphGet(
    `${GRAPH}/sites/${SP_HOST}:${SP_SITE_PATH}`, token, "resolve site");
  const drive = await graphGet(
    `${GRAPH}/sites/${site.id}/drive`, token, "resolve drive");

  if (FILE_ITEM_ID) {
    const item = await graphGet(
      `${GRAPH}/drives/${drive.id}/items/${FILE_ITEM_ID}?$select=id,name`,
      token, "find workbook by item id");
    return { driveId: drive.id, itemId: item.id, name: item.name };
  }

  const encodedPath = FILE_PATH.split("/").map(encodeURIComponent).join("/");
  const item = await graphGet(
    `${GRAPH}/drives/${drive.id}/root:/${encodedPath}?$select=id,name`,
    token, "find workbook by path");
  return { driveId: drive.id, itemId: item.id, name: item.name };
}

async function readSheetRows(token, driveId, itemId, sheetName) {
  const url = `${GRAPH}/drives/${driveId}/items/${itemId}` +
    `/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange(valuesOnly=true)?$select=values`;
  const data = await graphGet(url, token, `read sheet "${sheetName}"`);
  return data.values || [];
}

// ── value conversion ─────────────────────────────────────────────
// Graph returns a date cell as its Excel serial number (days since
// 1899-12-30), matching api/_lib/excel.js's toExcelSerial elsewhere
// in this codebase. Converts back to an ISO (yyyy-mm-dd) date string;
// leaves anything else (including already-text dates) as-is.
function excelValueToISODate(v) {
  if (v === null || v === undefined || v === "" || v === 0) return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const ms = Date.UTC(1899, 11, 30) + v * 86400000;
    const iso = new Date(ms).toISOString().slice(0, 10);
    return iso;
  }
  return v;
}

function trimOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  return String(v).trim();
}

// ── row parsing — mirrors scripts/build-manual-roster.py exactly ──

function parseRoster(rows) {
  if (!rows.length) return [];
  const headers = rows[0];
  const idx = (name) => headers.indexOf(name);
  const col = {
    firstName: idx("Agent First Name"),
    surname: idx("Surname"),
    email: idx("Email Address"),
    mobile: idx("Mobile Number"),
    dob: idx("Date of Birth"),
    workAnniversary: idx("Work Anniversary"),
    yearsWithColliers: idx("Years with Colliers"),
    yearStartedRE: idx("Year Started in RE"),
    experience: idx("Experience"),
    supervisionLevel: idx("Supervision Level"),
    supervisionFrequency: idx("Frequency of Supervision Meeting"),
    jobTitle: idx("Job Title"),
    licenceNumber: idx("Licence Number"),
    supervisionPlanStart: idx("Supervision_Plan_Start"),
    reviewDate: idx("Review_Date"),
    verifiableHours: idx("Verifiable Training Hours (Y/N)"),
    nonVerifiableHours: idx("Non-Verifiable Training Hours"),
    totalCpdHours: idx("Total CPD Hours"),
    licenseExpiry: idx("License Expiry"),
    activeListings: idx("Active Listings"),
    address: idx("Address"),
  };
  if (col.firstName === -1) {
    throw new HttpError(502,
      `Roster sheet header row is missing "Agent First Name" — sheet layout may have changed. ` +
      `Headers found: ${headers.join(" | ")}`);
  }

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const firstName = row[col.firstName];
    if (!firstName) continue;
    const licence = row[col.licenceNumber];
    out.push({
      firstName,
      surname: row[col.surname] ?? null,
      email: row[col.email] ?? null,
      mobile: row[col.mobile] ?? null,
      dob: excelValueToISODate(row[col.dob]),
      workAnniversary: excelValueToISODate(row[col.workAnniversary]),
      yearsWithColliers: row[col.yearsWithColliers] ?? null,
      yearStartedRE: excelValueToISODate(row[col.yearStartedRE]),
      experience: row[col.experience] ?? null,
      supervisionLevel: row[col.supervisionLevel] ?? null,
      supervisionFrequency: row[col.supervisionFrequency] ?? null,
      jobTitle: row[col.jobTitle] ?? null,
      licenceNumber: trimOrNull(licence),
      supervisionPlanStart: excelValueToISODate(row[col.supervisionPlanStart]),
      reviewDate: excelValueToISODate(row[col.reviewDate]),
      verifiableHours: row[col.verifiableHours] ?? null,
      nonVerifiableHours: row[col.nonVerifiableHours] ?? null,
      totalCpdHours: row[col.totalCpdHours] ?? null,
      licenseExpiry: excelValueToISODate(row[col.licenseExpiry]),
      activeListings: row[col.activeListings] ?? null,
      address: row[col.address] || null,
    });
  }
  return out;
}

// Broker Contract Audits: fixed columns A–E, no header matching
// (mirrors build-manual-roster.py, which reads this sheet positionally).
function parseAudits(rows) {
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row[0]) continue;
    out.push({
      firstName: row[0] ?? null,
      surname: row[1] ?? null,
      issuesIdentified: row[2] ?? null,
      trainingGiven: row[3] ?? null,
      comments: row[4] ?? null,
    });
  }
  return out;
}

// Open Issues Register / Suppliers & Sponsors: zip the header row
// straight onto each data row (mirrors build-manual-roster.py).
function parseByHeader(rows) {
  if (!rows.length) return [];
  const headers = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some((v) => v !== null && v !== undefined && v !== "")) continue;
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i] ?? null; });
    out.push(obj);
  }
  return out;
}

// ── writing (only after every sheet has parsed cleanly) ───────────

async function replaceTable(table, rows) {
  const del = await supabase.from(table).delete().gt("id", 0);
  if (del.error) throw new HttpError(500, `Clearing ${table} failed: ${del.error.message}`);
  if (!rows.length) return 0;
  const ins = await supabase.from(table).insert(rows.map((data) => ({ data })));
  if (ins.error) throw new HttpError(500, `Writing ${table} failed: ${ins.error.message}`);
  return rows.length;
}

async function runSync() {
  const token = await graphToken();
  const item = await resolveWorkbookItem(token);

  const [rosterRows, auditRows, issueRows, supplierRows] = await Promise.all([
    readSheetRows(token, item.driveId, item.itemId, SHEETS.roster),
    readSheetRows(token, item.driveId, item.itemId, SHEETS.audits),
    readSheetRows(token, item.driveId, item.itemId, SHEETS.issues),
    readSheetRows(token, item.driveId, item.itemId, SHEETS.suppliers),
  ]);

  const roster = parseRoster(rosterRows);
  const audits = parseAudits(auditRows);
  const issues = parseByHeader(issueRows);
  const suppliers = parseByHeader(supplierRows);

  // Guard against writing a near-empty roster over good data — a
  // sheet-name typo or a Graph hiccup should fail loudly, not quietly
  // wipe the dashboard down to a handful of rows.
  if (roster.length < 3) {
    throw new HttpError(502,
      `Only ${roster.length} roster row(s) parsed from "${SHEETS.roster}" — ` +
      `refusing to overwrite the dashboard. Check the sheet name and header row.`);
  }

  const counts = {
    roster: await replaceTable("manual_dashboard_roster", roster),
    brokerContractAudits: await replaceTable("manual_dashboard_broker_audits", audits),
    openIssuesRegister: await replaceTable("manual_dashboard_open_issues", issues),
    suppliersSponsors: await replaceTable("manual_dashboard_suppliers", suppliers),
  };

  const snapshotDate = new Date().toISOString().slice(0, 10);
  await supabase.from("manual_dashboard_meta").upsert({
    id: "singleton",
    snapshot_date: snapshotDate,
    synced_at: new Date().toISOString(),
    status: "ok",
    last_error: null,
    source_file: item.name,
    updated_at: new Date().toISOString(),
  });

  return { ran_at: new Date().toISOString(), source_file: item.name, counts };
}

// ── entry ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }

    const auth = req.headers.authorization || "";
    const isCron = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
    if (!isCron) {
      if (!req.query.force) throw new HttpError(401, "Not authorised");
      await requireUser(req, ["accounts", "manager"]);
    }

    const result = await runSync();
    return res.status(200).json(result);
  } catch (e) {
    // Record the failure so it shows on the dashboard even though
    // nothing else about the data changed.
    try {
      await supabase.from("manual_dashboard_meta").upsert({
        id: "singleton",
        status: "error",
        last_error: e instanceof HttpError ? e.message : String(e && e.message || e),
        updated_at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    sendError(res, e);
  }
}
