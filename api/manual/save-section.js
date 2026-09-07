// /api/manual/save-section.js
//
// Powers the Operations Manual's "Edit this page" / Save flow. The web
// page is now the source of truth for the manual's content (as of
// 2026-09-07) — this is the only way section content changes; there is
// no sync from the Word doc backup any more.
//
// POST, Authorization: Bearer <token>, role accounts/manager (same as
// the rest of this page) — body { id, num, title, html }.
//
// Every save first copies the section's CURRENT row into
// manual_section_history before overwriting it. There's no git history
// for a non-technical future editor to fall back on, so that table is
// the safety net: if a bad edit gets saved, a person with Supabase
// access can find the previous version there (ordered by edited_at)
// and paste it back in. If recording that history fails, the save is
// aborted rather than risking an unrecoverable overwrite.
import { requireUser, sendError, HttpError } from "../_lib/auth.js";
import { supabase } from "../_lib/supabase.js";

const MAX_TITLE = 300;
const MAX_NUM = 20;
const MAX_HTML = 200000; // generous — the longest existing section is a small fraction of this

function cleanString(v, max) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return max ? t.slice(0, max) : t;
}

// Small HTML→plain-text conversion so manual search (which matches
// against the "text" field, same as content.js always provided
// alongside "html") keeps working on edited sections. Doesn't need to
// be perfect — it only feeds search snippets, not the rendered page.
function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&hellip;/gi, "…")
    .replace(/&middot;/gi, "·")
    .replace(/&rsaquo;/gi, "›")
    .replace(/\s+/g, " ")
    .trim();
}

function actorLabel(user) {
  if (!user) return null;
  return user.email || user.username || user.preferred_username || user.oid || null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).end();
    }
    const user = await requireUser(req, ["accounts", "manager"]);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const id = cleanString(body.id, 100);
    if (!id) throw new HttpError(400, "Missing section id.");

    const title = cleanString(body.title, MAX_TITLE);
    if (!title) throw new HttpError(400, "Title can't be empty.");

    const num = cleanString(body.num, MAX_NUM);

    const html = typeof body.html === "string" ? body.html.trim() : "";
    if (!html) throw new HttpError(400, "Content can't be empty.");
    if (html.length > MAX_HTML) throw new HttpError(400, "Content is too long.");

    const existing = await supabase
      .from("manual_sections")
      .select("id, chapter_id, num, title, html, text, sort_order")
      .eq("id", id)
      .maybeSingle();
    if (existing.error) throw new HttpError(500, `Lookup failed: ${existing.error.message}`);
    if (!existing.data) {
      throw new HttpError(404,
        "That section isn't in the live editor yet — has sql/manual_content_seed.sql been run?");
    }

    const editedBy = actorLabel(user);

    // Record the pre-edit version BEFORE overwriting. If this fails,
    // abort the save rather than risk an edit nobody can undo.
    const hist = await supabase.from("manual_section_history").insert({
      section_id: existing.data.id,
      num: existing.data.num,
      title: existing.data.title,
      html: existing.data.html,
      text: existing.data.text,
      edited_by: editedBy,
    });
    if (hist.error) {
      throw new HttpError(500, `Could not record version history — save aborted (nothing was changed): ${hist.error.message}`);
    }

    const text = htmlToText(html);
    const now = new Date().toISOString();
    const updated = await supabase
      .from("manual_sections")
      .update({ num, title, html, text, updated_at: now, updated_by: editedBy })
      .eq("id", id)
      .select("id, chapter_id, num, title, html, text, updated_at")
      .maybeSingle();
    if (updated.error) throw new HttpError(500, `Save failed: ${updated.error.message}`);

    return res.status(200).json({ section: updated.data });
  } catch (e) {
    sendError(res, e);
  }
}
