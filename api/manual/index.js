import { requireUser, sendError } from "../_lib/auth.js";
import { supabase } from "../_lib/supabase.js";
import { MANUAL as FALLBACK_MANUAL, MANUAL_VERSION, MANUAL_UPDATED } from "./content.js";
import { SUPERVISION_PROCESS, REINZ_AWARDS } from "./roster-data.js";

async function loadDashboardTable(table) {
  const { data, error } = await supabase.from(table).select("data").order("id");
  if (error) throw new Error(`Loading ${table} failed: ${error.message}`);
  return (data || []).map((row) => row.data);
}

// ---------------------------------------------------------------------
// Manual content — as of 2026-09-07 this is loaded live from Supabase
// (manual_chapters / manual_sections), NOT from content.js. The web
// page is now the source of truth: edits made via "Edit this page" /
// Save go straight into these tables (api/manual/save-section.js).
//
// content.js is kept only as a FALLBACK — if the tables are empty
// (sql/manual_content_setup.sql + manual_content_seed.sql haven't been
// run yet) or a read fails for any reason, this falls back to the old
// static content so the page never goes fully blank. Once the seed has
// been run, "source" below will read "live" and content.js is no
// longer read from in normal operation — it's kept in the repo purely
// as a last-resort fallback and a point-in-time reference, alongside
// the Word doc backup.
// ---------------------------------------------------------------------
async function loadManual() {
  try {
    const [chaptersRes, sectionsRes] = await Promise.all([
      supabase.from("manual_chapters").select("id, title, sort_order").order("sort_order"),
      supabase
        .from("manual_sections")
        .select("id, chapter_id, num, title, html, text, sort_order, updated_at")
        .order("sort_order"),
    ]);
    if (chaptersRes.error) throw new Error(`Loading manual_chapters failed: ${chaptersRes.error.message}`);
    if (sectionsRes.error) throw new Error(`Loading manual_sections failed: ${sectionsRes.error.message}`);

    const chapters = chaptersRes.data || [];
    const sections = sectionsRes.data || [];
    if (!chapters.length || !sections.length) {
      throw new Error("manual_chapters/manual_sections is empty — has the seed SQL been run yet?");
    }

    const byId = new Map(chapters.map((c) => [c.id, { id: c.id, title: c.title, sections: [] }]));
    for (const s of sections) {
      const chapter = byId.get(s.chapter_id);
      if (!chapter) continue; // orphaned row — skip rather than fail the whole page
      chapter.sections.push({ id: s.id, num: s.num || "", title: s.title, html: s.html, text: s.text });
    }
    const orderedChapters = chapters.map((c) => byId.get(c.id)).filter((c) => c && c.sections.length);
    if (!orderedChapters.length) throw new Error("No chapter has any sections after grouping.");

    // "updated" now reflects the most recently saved edit, not a
    // hand-bumped version string — simpler and always accurate once
    // the page is the source of truth.
    const maxUpdatedMs = sections.reduce((max, s) => {
      const t = s.updated_at ? new Date(s.updated_at).getTime() : 0;
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    const updated = maxUpdatedMs ? new Date(maxUpdatedMs).toISOString().slice(0, 10) : MANUAL_UPDATED;

    return { version: MANUAL_VERSION, updated, chapters: orderedChapters, source: "live" };
  } catch (e) {
    console.error("manual: falling back to static content.js —", e && e.message ? e.message : e);
    return { version: MANUAL_VERSION, updated: MANUAL_UPDATED, chapters: FALLBACK_MANUAL, source: "fallback" };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    await requireUser(req, ["accounts", "manager"]);

    const [manual, roster, brokerContractAudits, openIssuesRegister, suppliersSponsors, meta] =
      await Promise.all([
        loadManual(),
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
        version: manual.version,
        updated: manual.updated,
        chapters: manual.chapters,
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
