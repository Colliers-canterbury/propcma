-- sql/manual_content_setup.sql
--
-- One-time setup for the Operations Manual's new "web page is the
-- source of truth" in-place editing feature (2026-09-07).
--
-- Run this ONCE in the Supabase SQL editor, BEFORE deploying the new
-- api/manual/index.js and api/manual/save-section.js. Then run
-- sql/manual_content_seed.sql straight after it, in the same editor
-- session, to load the manual's current content into these tables.
--
-- Same posture as sql/manual_dashboard_setup.sql (the Team Dashboard
-- tables): RLS is turned ON but NO POLICIES are added. That's
-- deliberate, not an oversight — with RLS on and zero policies,
-- Postgres denies ALL access by default to anon/authenticated keys,
-- and the only thing that can read or write these tables is server
-- code running with the Supabase SERVICE ROLE key (api/_lib/supabase.js).
-- Authorization (who's allowed to view/edit the manual) is enforced in
-- the API layer via requireUser(req, ["accounts","manager"]), exactly
-- like every other endpoint on this page — RLS policies are not used
-- as the authorization mechanism anywhere in this project.
--
-- manual_chapters   — the 8 chapters, in menu order. Chapter titles
--                     aren't editable from the web page yet (v1 of
--                     in-place editing covers section content only —
--                     adding/removing/reordering chapters or sections
--                     is a listed future enhancement), so this table
--                     exists mainly so chapter titles/order live in
--                     the database alongside sections rather than
--                     splitting the source of truth across a DB table
--                     and a hardcoded list in index.js.
--
-- manual_sections   — one row per section (id matches the existing
--                     scheme exactly, e.g. "1-4", "doc-control-main")
--                     PLUS a "num" column ("1.4", or "" for
--                     numberless intro/closing sections) — the web
--                     page owns this table once seeded; content.js is
--                     kept only as an offline fallback (see
--                     api/manual/index.js) and is no longer the
--                     source of truth after this migration.
--
-- manual_section_history — a full copy of a section's previous
--                     title/num/html/text is recorded here every time
--                     someone saves an edit, BEFORE the new content
--                     overwrites it. There's no git history for a
--                     future non-technical editor to fall back on, so
--                     this is the safety net: if a bad edit gets
--                     saved, the previous version can always be found
--                     here (browse the table in the Supabase editor,
--                     ordered by edited_at) and pasted back in.

create table if not exists manual_chapters (
  id text primary key,
  title text not null,
  sort_order integer not null
);

create table if not exists manual_sections (
  id text primary key,
  chapter_id text not null references manual_chapters(id),
  num text not null default '',
  title text not null,
  html text not null default '',
  text text not null default '',
  sort_order integer not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists manual_sections_chapter_idx on manual_sections(chapter_id, sort_order);

create table if not exists manual_section_history (
  id bigint generated always as identity primary key,
  section_id text not null,
  num text,
  title text,
  html text,
  text text,
  edited_at timestamptz not null default now(),
  edited_by text
);
create index if not exists manual_section_history_section_idx on manual_section_history(section_id, edited_at desc);

alter table manual_chapters enable row level security;
alter table manual_sections enable row level security;
alter table manual_section_history enable row level security;
