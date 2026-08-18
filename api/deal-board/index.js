// /api/deal-board/index.js
//
// Tables live in `public` with a db_ prefix — no schema exposure needed.
// Follows the same shape as /api/deal-sheets/*: requireUser() validates
// the Microsoft token and resolves the oid against public.app_users.
//
//   GET    ?dept=industrial                — the board
//   POST   { dept, stageId, ...fields }    — add a deal
//   PATCH  /:id  { ...fields }             — edit a deal
//   POST   /:id/move  { stageId, afterId } — drag to a new stage/position
//   POST   /roll-forward  { dept, nextDate }
//
// Brokers do not sign in. Every route requires an operator role.
//
// If a read-only broker role is added later, change ROLES_READ to
// include it — nothing else in this file needs to move.

import { requireUser, sendError, HttpError } from "../_lib/auth.js";
import { supabase } from "../_lib/supabase.js";

const ROLES_READ  = ["office_admin", "accounts", "manager"];
const ROLES_WRITE = ["office_admin", "accounts", "manager"];
const ROLES_ADMIN = ["manager"];

const EDITABLE = [
  "address", "timing", "timing_date", "fee_nzd", "status_note",
  "method_of_sale", "vendor_contact", "aml",
];

export default async function handler(req, res) {
  try {
    // vercel.json uses legacy `routes`, which passes the sub-path as a
    // single string ("abc123/move"). A `rewrites` config would pass an
    // array. Accept either.
    const raw = req.query.path;
    const seg = Array.isArray(raw)
      ? raw
      : String(raw || "").split("/").filter(Boolean);

    if (req.method === "GET"  && !seg.length) return await getBoard(req, res);
    if (req.method === "POST" && !seg.length) return await addDeal(req, res);
    if (req.method === "PATCH" && seg.length === 1) return await editDeal(req, res, seg[0]);
    if (req.method === "POST" && seg[1] === "move") return await moveDeal(req, res, seg[0]);
    if (req.method === "DELETE" && seg.length === 1) return await removeDeal(req, res, seg[0]);
    if (req.method === "POST" && seg[0] === "roll-forward") return await rollForward(req, res);
    if (req.method === "POST" && seg[0] === "meeting") return await saveMeeting(req, res);
    if (req.method === "POST" && seg[0] === "fine") return await setFine(req, res);
    if (req.method === "GET"  && seg[0] === "brokers") return await listBrokers(req, res);
    if (req.method === "GET"  && seg[0] === "departments") return await listDepartments(req, res);
    if (req.method === "GET"  && seg[0] === "fines-ytd") return await finesYtd(req, res);
    if (req.method === "POST" && seg[0] === "settle-fine") return await settleFine(req, res);
    if (req.method === "GET"  && seg[0] === "rankings") return await rankings(req, res);
    if (seg[0] === "notes") return await notes(req, res, seg[1]);
    if (seg[1] === "outcome") return await setOutcome(req, res, seg[0]);
    if (seg[0] === "weights") return await weights(req, res);
    if (seg[0] === "requirements") return await requirements(req, res, seg[1]);

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).end();
  } catch (e) {
    sendError(res, e);
  }
}

async function deptId(slug) {
  const { data, error } = await supabase
    .from("db_departments").select("id").eq("slug", slug).single();
  if (error || !data) throw new HttpError(404, "Unknown department");
  return data.id;
}

// ── read ──────────────────────────────────────────────────────────
async function getBoard(req, res) {
  await requireUser(req, ROLES_READ);
  const id = await deptId(req.query.dept);

  const today = new Date().toISOString().slice(0, 10);
  const [stages, deals, reqs, mtg, noteSections, weightRows, outcomeRows, noteRows] =
    await Promise.all([
    supabase.from("db_stages")
      .select("id, name, position, is_terminal")
      .eq("department_id", id).order("position"),
    supabase.from("db_v_board")
      .select("*").eq("department_id", id)
      .order("stage_position").order("sort_order"),
    supabase.from("db_requirements")
      .select("*").eq("department_id", id).eq("is_active", true)
      .order("party_name"),
    supabase.from("db_meetings")
      .select("id, meeting_date, apologies, minutes")
      .eq("department_id", id).lte("meeting_date", today)
      .order("meeting_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("db_note_sections")
      .select("name, position").eq("department_id", id).order("position"),
    supabase.from("db_pipeline_weights")
      .select("stage_name, pct").eq("department_id", id),
    supabase.from("db_deals")
      .select("outcome").eq("department_id", id).not("outcome", "is", null),
    supabase.from("db_notes")
      .select("id, section, body, sort_order, timing, timing_date, fee_nzd, status_note, broker_codes, aml")
      .eq("department_id", id).eq("is_done", false).order("sort_order"),
  ]);

  if (stages.error || deals.error || reqs.error)
    throw new HttpError(500, "Could not load the board");

  let fines = [];
  if (mtg.data?.id) {
    const f = await supabase.from("db_fines")
      .select("broker_code, amount_nzd").eq("meeting_id", mtg.data.id);
    fines = f.data || [];
  }

  return res.status(200).json({
    stages: stages.data,
    deals: deals.data,
    requirements: reqs.data,
    meeting: mtg.data || null,
    fines,
    noteSections: noteSections.data || [],
    notes: noteRows.data || [],
    weights: weightRows.data || [],
    outcomes: (outcomeRows.data || []).reduce((a, r) => {
      a[r.outcome] = (a[r.outcome] || 0) + 1;
      return a;
    }, {}),
  });
}

// ── create ────────────────────────────────────────────────────────
async function addDeal(req, res) {
  const user = await requireUser(req, ROLES_WRITE);
  const b = req.body || {};

  const address = (b.address || "").trim();
  if (!address) throw new HttpError(400, "An address is required");
  if (!b.stageId) throw new HttpError(400, "A stage is required");

  const id = await deptId(b.dept);

  // Place at the end of the stage. Fractional sort_order means we never
  // renumber, so two EAs adding at once cannot collide.
  const { data: last } = await supabase.from("db_deals")
    .select("sort_order").eq("stage_id", b.stageId).eq("is_archived", false)
    .order("sort_order", { ascending: false }).limit(1).maybeSingle();

  const { data, error } = await supabase.from("db_deals")
    .insert({
      department_id: id,
      stage_id: b.stageId,
      sort_order: (last?.sort_order ?? 0) + 1000,
      address,
      timing: b.timing || null,
      timing_date: b.timing_date || null,
      fee_nzd: Number(b.fee_nzd) || 0,
      status_note: b.status_note || null,
      created_by_oid: user.oid,
      updated_by_oid: user.oid,
    })
    .select().single();
  if (error) throw new HttpError(500, "Could not add the deal");

  if (Array.isArray(b.brokers) && b.brokers.length) {
    await setBrokers(data.id, b.brokers);
  }
  return res.status(200).json(data);
}

// ── edit ──────────────────────────────────────────────────────────
async function editDeal(req, res, id) {
  const user = await requireUser(req, ROLES_WRITE);
  const b = req.body || {};

  const patch = { updated_by_oid: user.oid };
  for (const k of EDITABLE) if (k in b) patch[k] = b[k];
  if ("address" in patch && !String(patch.address).trim())
    throw new HttpError(400, "An address is required");
  if ("fee_nzd" in patch) patch.fee_nzd = Number(patch.fee_nzd) || 0;
  if ("timing_date" in patch) patch.timing_date = patch.timing_date || null;

  const { data, error } = await supabase.from("db_deals")
    .update(patch).eq("id", id).select().single();
  if (error) throw new HttpError(500, "Could not save the change");

  if (Array.isArray(b.brokers)) await setBrokers(id, b.brokers);
  return res.status(200).json(data);
}

async function setBrokers(dealId, codes) {
  await supabase.from("db_deal_brokers")
    .delete().eq("deal_id", dealId);
  const rows = [...new Set(codes.map((c) => String(c).toUpperCase()))]
    .map((broker_code) => ({ deal_id: dealId, broker_code }));
  if (rows.length) {
    const { error } = await supabase.from("db_deal_brokers").insert(rows);
    // A code not in public.brokers fails the FK — report it rather than
    // silently dropping the broker off the deal.
    if (error) throw new HttpError(400, "One of those broker codes isn't on the list");
  }
}

// ── move (drag) ───────────────────────────────────────────────────
// afterId = the deal it now sits below, or null for top of the stage.
// New sort_order is the midpoint between its neighbours: no renumbering,
// so simultaneous drags by two people don't fight.
async function moveDeal(req, res, id) {
  const user = await requireUser(req, ROLES_WRITE);
  const { stageId, afterId } = req.body || {};
  if (!stageId) throw new HttpError(400, "A stage is required");

  const { data: siblings, error: sErr } = await supabase
    .from("db_deals").select("id, sort_order")
    .eq("stage_id", stageId).eq("is_archived", false)
    .order("sort_order");
  if (sErr) throw new HttpError(500, "Could not move the deal");

  const rows = siblings.filter((r) => r.id !== id);
  const idx = afterId ? rows.findIndex((r) => r.id === afterId) : -1;
  const before = idx >= 0 ? rows[idx].sort_order : 0;
  const after  = rows[idx + 1]?.sort_order ?? before + 2000;

  const { data, error } = await supabase.from("db_deals")
    .update({ stage_id: stageId, sort_order: (before + after) / 2,
              updated_by_oid: user.oid })
    .eq("id", id).select().single();
  if (error) throw new HttpError(500, "Could not move the deal");
  return res.status(200).json(data);
}

// ── delete ────────────────────────────────────────────────────────
// Archives rather than deletes: a deal removed in the meeting is still
// part of the record of what was discussed.
async function removeDeal(req, res, id) {
  const user = await requireUser(req, ROLES_WRITE);
  const { error } = await supabase.from("db_deals")
    .update({ is_archived: true, archived_at: new Date().toISOString(),
              updated_by_oid: user.oid })
    .eq("id", id);
  if (error) throw new HttpError(500, "Could not remove the deal");
  return res.status(200).json({ ok: true });
}

// ── meeting: apologies, minutes ───────────────────────────────────
async function saveMeeting(req, res) {
  const user = await requireUser(req, ROLES_WRITE);
  const { dept, date, apologies, minutes } = req.body || {};
  if (!date) throw new HttpError(400, "A date is required");
  const id = await deptId(dept);

  const patch = { department_id: id, meeting_date: date };
  if (apologies !== undefined) patch.apologies = apologies;
  if (minutes !== undefined) patch.minutes = minutes;

  const { data, error } = await supabase.from("db_meetings")
    .upsert(patch, { onConflict: "department_id,meeting_date" })
    .select().single();
  if (error) throw new HttpError(500, "Could not save the meeting notes");
  return res.status(200).json(data);
}

// ── fines ─────────────────────────────────────────────────────────
async function setFine(req, res) {
  await requireUser(req, ROLES_WRITE);
  const { dept, date, brokerCode, amount } = req.body || {};
  if (!brokerCode) throw new HttpError(400, "A broker is required");
  const id = await deptId(dept);

  // The meeting row may not exist yet if fines are entered first.
  const { data: mtg, error: mErr } = await supabase.from("db_meetings")
    .upsert({ department_id: id, meeting_date: date },
            { onConflict: "department_id,meeting_date" })
    .select().single();
  if (mErr) throw new HttpError(500, "Could not save the fine");

  const { error } = await supabase.from("db_fines")
    .upsert({ meeting_id: mtg.id,
              broker_code: String(brokerCode).toUpperCase(),
              amount_nzd: Number(amount) || 0 },
            { onConflict: "meeting_id,broker_code" });
  if (error) throw new HttpError(400, "That broker code isn't on the list");
  return res.status(200).json({ ok: true });
}

// ── buyer / tenant register ───────────────────────────────────────
async function requirements(req, res, id) {
  if (req.method === "POST" && !id) {
    await requireUser(req, ROLES_WRITE);
    const b = req.body || {};
    const dept = await deptId(b.dept);
    const { data, error } = await supabase.from("db_requirements")
      .insert({ department_id: dept,
                party_name: (b.party_name || "").trim(),
                requirement: (b.requirement || "").trim(),
                broker_code: b.broker_code || null,
                temperature: b.temperature || "motivated" })
      .select().single();
    if (error) throw new HttpError(500, "Could not add the requirement");
    return res.status(200).json(data);
  }

  if (req.method === "PATCH" && id) {
    await requireUser(req, ROLES_WRITE);
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    for (const k of ["party_name", "requirement", "broker_code", "temperature"])
      if (k in b) patch[k] = b[k];
    const { data, error } = await supabase.from("db_requirements")
      .update(patch).eq("id", id).select().single();
    if (error) throw new HttpError(500, "Could not save the change");
    return res.status(200).json(data);
  }

  if (req.method === "DELETE" && id) {
    await requireUser(req, ROLES_WRITE);
    const { error } = await supabase.from("db_requirements")
      .update({ is_active: false }).eq("id", id);
    if (error) throw new HttpError(500, "Could not remove the requirement");
    return res.status(200).json({ ok: true });
  }

  throw new HttpError(405, "Not allowed");
}

// ── business units for the switcher ───────────────────────────────
async function listDepartments(req, res) {
  await requireUser(req, ROLES_READ);
  const { data, error } = await supabase.from("db_departments")
    .select("slug, name").order("name");
  if (error) throw new HttpError(500, "Could not load the business units");
  return res.status(200).json(data);
}

// ── broker list for the dropdown ──────────────────────────────────
async function listBrokers(req, res) {
  await requireUser(req, ROLES_READ);
  const { data, error } = await supabase.from("brokers")
    .select("code, first_name").eq("active", true).order("first_name");
  if (error) throw new HttpError(500, "Broker list failed");
  return res.status(200).json(data);
}

// ── fines, year to date ───────────────────────────────────────────
// Fines are stored per meeting, so the season total is a sum across
// meetings. This is what someone settles up against.
async function finesYtd(req, res) {
  await requireUser(req, ROLES_READ);
  const id = await deptId(req.query.dept);
  const year = Number(req.query.year) || new Date().getFullYear();

  const { data, error } = await supabase.from("db_fines")
    .select("broker_code, amount_nzd, db_meetings!inner(department_id, meeting_date)")
    .eq("db_meetings.department_id", id)
    .gte("db_meetings.meeting_date", `${year}-01-01`)
    .lte("db_meetings.meeting_date", `${year}-12-31`);
  if (error) throw new HttpError(500, "Could not load the fines total");

  const byBroker = {};
  for (const row of data || []) {
    byBroker[row.broker_code] =
      (byBroker[row.broker_code] || 0) + Number(row.amount_nzd || 0);
  }
  // Net off anything already settled.
  const { data: paid } = await supabase.from("db_fine_settlements")
    .select("broker_code, amount_nzd")
    .eq("department_id", id)
    .gte("settled_at", `${year}-01-01`)
    .lte("settled_at", `${year}-12-31T23:59:59`);
  for (const p of paid || []) {
    byBroker[p.broker_code] =
      (byBroker[p.broker_code] || 0) - Number(p.amount_nzd || 0);
  }

  const brokers = Object.entries(byBroker)
    .map(([code, total]) => ({ code, total }))
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total - a.total);

  return res.status(200).json({
    year,
    total: brokers.reduce((a, b) => a + b.total, 0),
    brokers,
  });
}

// ── note lists (Problem Property, Marketing Reports, auctions…) ────
// Free text the EA types in and ticks off. Ticking sets is_done rather
// than deleting, so last week's list is still there if anyone asks.
async function notes(req, res, id) {
  if (req.method === "POST" && !id) {
    const user = await requireUser(req, ROLES_WRITE);
    const b = req.body || {};
    if (!b.section) throw new HttpError(400, "A section is required");
    const dept = await deptId(b.dept);

    const { data: last } = await supabase.from("db_notes")
      .select("sort_order").eq("department_id", dept).eq("section", b.section)
      .eq("is_done", false)
      .order("sort_order", { ascending: false }).limit(1).maybeSingle();

    const { data, error } = await supabase.from("db_notes").insert({
      department_id: dept, section: b.section,
      body: (b.body || "").trim(),
      timing: b.timing || null,
      timing_date: b.timing_date || null,
      fee_nzd: Number(b.fee_nzd) || 0,
      status_note: b.status_note || null,
      broker_codes: b.broker_codes || null,
      aml: b.aml || null,
      sort_order: (last?.sort_order ?? 0) + 1000,
      created_by_oid: user.oid,
    }).select().single();
    if (error) throw new HttpError(500, "Could not add the note");
    return res.status(200).json(data);
  }

  if (req.method === "PATCH" && id) {
    await requireUser(req, ROLES_WRITE);
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if ("body" in b) patch.body = String(b.body).trim();
    for (const k of ["timing","status_note","broker_codes","aml"])
      if (k in b) patch[k] = b[k] || null;
    if ("timing_date" in b) patch.timing_date = b.timing_date || null;
    if ("fee_nzd" in b) patch.fee_nzd = Number(b.fee_nzd) || 0;
    const { data, error } = await supabase.from("db_notes")
      .update(patch).eq("id", id).select().single();
    if (error) throw new HttpError(500, "Could not save the note");
    return res.status(200).json(data);
  }

  if (req.method === "DELETE" && id) {
    await requireUser(req, ROLES_WRITE);
    const { error } = await supabase.from("db_notes")
      .update({ is_done: true, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new HttpError(500, "Could not clear the note");
    return res.status(200).json({ ok: true });
  }

  throw new HttpError(405, "Not allowed");
}

// ── record an outcome (won / lost / withdrawn / sold) ─────────────
// Sets the outcome AND moves the deal, in one call — the two always go
// together, and doing them separately risks a deal that moved but was
// never counted.
async function setOutcome(req, res, id) {
  const user = await requireUser(req, ROLES_WRITE);
  const { outcome, stageId, timing_date } = req.body || {};
  const allowed = ["won", "lost", "withdrawn", "sold"];
  if (!allowed.includes(outcome)) throw new HttpError(400, "Unknown outcome");
  if (!stageId) throw new HttpError(400, "A destination stage is required");

  const patch = {
    outcome,
    outcome_at: new Date().toISOString(),
    stage_id: stageId,
    updated_by_oid: user.oid,
  };
  if (timing_date) patch.timing_date = timing_date;

  const { data, error } = await supabase.from("db_deals")
    .update(patch).eq("id", id).select().single();
  if (error) throw new HttpError(500, "Could not record the outcome");
  return res.status(200).json(data);
}

// ── pipeline weightings ───────────────────────────────────────────
async function weights(req, res) {
  if (req.method === "GET") {
    await requireUser(req, ROLES_READ);
    const id = await deptId(req.query.dept);
    const { data, error } = await supabase.from("db_pipeline_weights")
      .select("stage_name, pct").eq("department_id", id);
    if (error) throw new HttpError(500, "Could not load the weightings");
    return res.status(200).json(data);
  }

  if (req.method === "POST") {
    await requireUser(req, ROLES_WRITE);
    const { dept, stage_name, pct } = req.body || {};
    if (!stage_name) throw new HttpError(400, "A stage is required");
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      throw new HttpError(400, "Percentage must be between 0 and 100");
    const id = await deptId(dept);
    const { error } = await supabase.from("db_pipeline_weights")
      .upsert({ department_id: id, stage_name, pct: n,
                updated_at: new Date().toISOString() },
              { onConflict: "department_id,stage_name" });
    if (error) throw new HttpError(500, "Could not save the weighting");
    return res.status(200).json({ ok: true });
  }

  throw new HttpError(405, "Not allowed");
}

// ── settle a broker's outstanding fines ───────────────────────────
// Records a payment rather than clearing the fines, so the history of
// who owed what in which week stays readable.
async function settleFine(req, res) {
  const user = await requireUser(req, ROLES_WRITE);
  const { dept, brokerCode, amount, note } = req.body || {};
  if (!brokerCode) throw new HttpError(400, "A broker is required");
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new HttpError(400, "An amount is required");

  const id = await deptId(dept);
  const { error } = await supabase.from("db_fine_settlements").insert({
    department_id: id,
    broker_code: String(brokerCode).toUpperCase(),
    amount_nzd: amt,
    settled_by_oid: user.oid,
    note: note || null,
  });
  if (error) throw new HttpError(400, "Could not record the settlement");
  return res.status(200).json({ ok: true });
}

// ── broker rankings (read-only mirror of the commission workbook) ──
async function rankings(req, res) {
  await requireUser(req, ROLES_READ);
  const id = await deptId(req.query.dept);
  const year = Number(req.query.year) || new Date().getFullYear();

  const { data, error } = await supabase.from("db_broker_rankings")
    .select("broker_code, fees_nzd, budget_nzd, synced_at")
    .eq("department_id", id).eq("financial_year", year)
    .order("fees_nzd", { ascending: false });
  if (error) throw new HttpError(500, "Could not load the rankings");

  const { data: dept } = await supabase.from("db_departments")
    .select("rankings_url").eq("id", id).single();
  const { data: names } = await supabase.from("brokers")
    .select("code, first_name");
  const nameBy = Object.fromEntries((names || []).map((b) => [b.code, b.first_name]));

  return res.status(200).json({
    year,
    url: dept?.rankings_url || null,
    synced_at: data?.[0]?.synced_at || null,
    brokers: (data || []).map((r) => ({
      code: r.broker_code,
      name: nameBy[r.broker_code] || r.broker_code,
      fees: Number(r.fees_nzd) || 0,
      budget: Number(r.budget_nzd) || 0,
    })),
  });
}

// ── roll forward ──────────────────────────────────────────────────
async function rollForward(req, res) {
  const user = await requireUser(req, ROLES_ADMIN);
  const { dept, nextDate } = req.body || {};
  if (!nextDate) throw new HttpError(400, "A date is required");

  const id = await deptId(dept);
  const { data, error } = await supabase.rpc("db_roll_forward",
    { dept: id, next_date: nextDate, actor: user.oid });
  if (error) throw new HttpError(500, "Roll forward failed");

  return res.status(200).json(data?.[0] || {});
}
