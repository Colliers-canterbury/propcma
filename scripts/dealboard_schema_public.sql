-- =====================================================================
-- Deal Board — v4 schema (public schema, db_ prefix)
-- South Island Commercial (2004) Ltd
--
-- Design notes
-- ------------
-- * Every object is created in `public` with a `db_` prefix, so no
--   Supabase API setting has to change and nothing existing is touched.
--   Verified against your table list: no collision with app_settings,
--   app_users, broker_profiles, brokers, cma_*, deal_sheet*, properties.
--
--   To remove everything this file creates, see the teardown block
--   commented out at the foot of this file.
--
-- * NO row-level security. Authorisation is enforced in the API layer
--   by requireUser(req, [roles]) against public.app_users, exactly as
--   /api/deal-sheets/* already does. The service role key must never
--   reach the browser.
--
-- * NO roster tables. Brokers come from public.brokers (reference data
--   only — brokers do not sign in). Operators come from public.app_users
--   keyed on the Entra object ID.
--
-- Run order: this file first, then seed brokers if any codes used by the
-- meeting workbooks are missing from public.brokers, then the importer.
--
-- Have your PropCMA developer review before running.

-- ---------------------------------------------------------------------
-- 1. Departments = the separate weekly meetings
-- ---------------------------------------------------------------------
create table public.db_departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,          -- 'Industrial', 'Investment'
  slug        text not null unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Stages — per department, reorderable, not hardcoded
-- ---------------------------------------------------------------------
create table public.db_stages (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.db_departments on delete cascade,
  name          text not null,
  position      int  not null,
  is_terminal   boolean not null default false,  -- archives on roll-forward
  unique (department_id, name)
);
create index db_stages_dept_pos on public.db_stages(department_id, position);

-- ---------------------------------------------------------------------
-- 3. Deals
--
--    address is free text. public.properties is comparable-sales
--    evidence for CMAs, not a property register — there is nothing
--    to link a live campaign to.
--
--    actor columns store the Entra oid (text) to match app_users.oid.
--    No FK: app_users rows deactivate rather than delete, but an oid
--    in history must stay readable regardless.
-- ---------------------------------------------------------------------
create type public.db_aml_status as enum
  ('not_started','wip','complete','not_required');

create table public.db_deals (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references public.db_departments on delete restrict,
  stage_id       uuid not null references public.db_stages on delete restrict,
  sort_order     numeric not null default 1000,  -- fractional: insert at the
                                                 -- midpoint between neighbours,
                                                 -- never renumber the column
  address        text not null,
  timing         text,                           -- 'Late June', 'Deadline 5 Oct'
  fee_nzd        numeric(12,2) not null default 0,
  status_note    text,                           -- 'Live', 'PBN', 'Auction 30 Nov'
  method_of_sale text,
  vendor_contact text,
  aml            public.db_aml_status not null default 'not_started',
  is_archived    boolean not null default false,
  archived_at    timestamptz,
  created_by_oid text,
  created_at     timestamptz not null default now(),
  updated_by_oid text,
  updated_at     timestamptz not null default now()
);
create index db_deals_dept_stage on public.db_deals(department_id, stage_id)
  where not is_archived;
create index db_deals_sort on public.db_deals(stage_id, sort_order)
  where not is_archived;

-- Which brokers are working the deal. Replaces the 'CD/LW' string.
-- No fee_share — commission attribution lives in the commission
-- workbook and stays there.
create table public.db_deal_brokers (
  deal_id     uuid not null references public.db_deals on delete cascade,
  broker_code text not null references public.brokers(code) on delete restrict,
  primary key (deal_id, broker_code)
);
create index db_deal_brokers_code on public.db_deal_brokers(broker_code);

-- ---------------------------------------------------------------------
-- 4. Audit trail
--    Distinct from public.deal_sheet_events — different system.
--    Written by trigger only; the API never inserts here directly.
-- ---------------------------------------------------------------------
create table public.db_deal_events (
  id          bigserial primary key,
  deal_id     uuid not null references public.db_deals on delete cascade,
  actor_oid   text,
  event_type  text not null,   -- created | stage_changed | fee_changed
                               -- | aml_changed | archived
  from_value  jsonb,
  to_value    jsonb,
  occurred_at timestamptz not null default now()
);
create index db_deal_events_deal on public.db_deal_events(deal_id, occurred_at desc);
create index db_deal_events_type on public.db_deal_events(event_type, occurred_at desc);

create or replace function public.db_log_deal_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.db_deal_events(deal_id, actor_oid, event_type, to_value)
    values (new.id, new.created_by_oid, 'created',
            jsonb_build_object('address', new.address, 'stage_id', new.stage_id));
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    insert into public.db_deal_events(deal_id, actor_oid, event_type, from_value, to_value)
    values (new.id, new.updated_by_oid, 'stage_changed',
            jsonb_build_object('stage_id', old.stage_id),
            jsonb_build_object('stage_id', new.stage_id));
  end if;

  if new.fee_nzd is distinct from old.fee_nzd then
    insert into public.db_deal_events(deal_id, actor_oid, event_type, from_value, to_value)
    values (new.id, new.updated_by_oid, 'fee_changed',
            jsonb_build_object('fee', old.fee_nzd),
            jsonb_build_object('fee', new.fee_nzd));
  end if;

  if new.aml is distinct from old.aml then
    insert into public.db_deal_events(deal_id, actor_oid, event_type, from_value, to_value)
    values (new.id, new.updated_by_oid, 'aml_changed',
            jsonb_build_object('aml', old.aml),
            jsonb_build_object('aml', new.aml));
  end if;

  if new.is_archived and not old.is_archived then
    insert into public.db_deal_events(deal_id, actor_oid, event_type, to_value)
    values (new.id, new.updated_by_oid, 'archived',
            jsonb_build_object('at', now()));
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger db_deals_audit before insert or update on public.db_deals
for each row execute function public.db_log_deal_change();

-- ---------------------------------------------------------------------
-- 5. Meetings, fines, minutes
-- ---------------------------------------------------------------------
create table public.db_meetings (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.db_departments on delete cascade,
  meeting_date  date not null,
  apologies     text,
  minutes       text,
  locked_at     timestamptz,   -- set when Present opens: freezes the agenda
                               -- so an edit mid-meeting doesn't move the
                               -- numbers on the screen everyone is watching
  created_at    timestamptz not null default now(),
  unique (department_id, meeting_date)
);

create table public.db_fines (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.db_meetings on delete cascade,
  broker_code text not null references public.brokers(code) on delete cascade,
  amount_nzd  numeric(8,2) not null default 0,
  reason      text,
  unique (meeting_id, broker_code)
);

-- ---------------------------------------------------------------------
-- 6. Buyer / tenant register
-- ---------------------------------------------------------------------
create type public.db_heat as enum ('motivated','luke_warm','slow');

create table public.db_requirements (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.db_departments on delete cascade,
  party_name    text not null,
  requirement   text not null,
  broker_code   text references public.brokers(code) on delete set null,
  temperature   public.db_heat not null default 'motivated',
  last_reviewed date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index db_requirements_active on public.db_requirements(department_id)
  where is_active;

-- ---------------------------------------------------------------------
-- 7. Rankings — read-only mirror of the commission workbook
--
--    IMPORTANT: Investment_rankings.xlsx and Industrial_rankings.xlsx
--    are NOT sources. Every cell is an external link of the form
--        =[1]Summary!$N$6
--    pointing at a master workbook. The values they show are cached and
--    go stale silently. Point the sync at that master's Summary sheet:
--    broker name in column A, fees in N, budget in P.
--    Investment occupies rows 6-16, Industrial rows 19-27.
--
--    ranking_name is explicit and never derived. Industrial has two
--    Marshalls; Macauley, Ogg and Lough all reduce to 'M'.
-- ---------------------------------------------------------------------
create table public.db_broker_ranking_names (
  broker_code  text primary key references public.brokers(code) on delete cascade,
  ranking_name text not null unique      -- exactly as spelled in the workbook
);

create table public.db_broker_rankings (
  department_id  uuid not null references public.db_departments on delete cascade,
  broker_code    text not null references public.brokers(code) on delete cascade,
  financial_year int  not null,
  fees_nzd       numeric(12,2),
  budget_nzd     numeric(12,2),
  synced_at      timestamptz not null default now(),
  primary key (department_id, broker_code, financial_year)
);

-- Names the sync could not match. Surface these in the UI — a silent
-- mismatch is how a scoreboard goes quietly wrong.
create table public.db_ranking_sync_issues (
  id           bigserial primary key,
  ranking_name text not null,
  reason       text not null,
  resolved     boolean not null default false,
  seen_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 8. Roll forward
--    Called by the API after requireUser(req, ['manager']).
--    Not security definer: the API is already the trust boundary, and
--    nothing else holds a connection.
-- ---------------------------------------------------------------------
create or replace function public.db_roll_forward(
  dept uuid, next_date date, actor text
) returns table (archived_count int, meeting_id uuid)
language plpgsql set search_path = public as $$
declare a_count int; m_id uuid;
begin
  update public.db_deals d
     set is_archived = true,
         archived_at = now(),
         updated_by_oid = actor
    from public.db_stages s
   where s.id = d.stage_id
     and d.department_id = dept
     and s.is_terminal
     and not d.is_archived;
  get diagnostics a_count = row_count;

  insert into public.db_meetings(department_id, meeting_date)
  values (dept, next_date)
  on conflict (department_id, meeting_date) do nothing
  returning id into m_id;

  if m_id is null then
    select id into m_id from public.db_meetings
     where department_id = dept and meeting_date = next_date;
  end if;

  return query select a_count, m_id;
end $$;

-- ---------------------------------------------------------------------
-- 9. Convenience view for the board — one query per department
-- ---------------------------------------------------------------------
create view public.db_v_board as
select d.id, d.department_id, d.stage_id, s.name as stage_name,
       s.position as stage_position, s.is_terminal,
       d.sort_order, d.address, d.timing, d.fee_nzd, d.status_note,
       d.method_of_sale, d.vendor_contact, d.aml, d.updated_at,
       coalesce(
         (select string_agg(db.broker_code, '/' order by db.broker_code)
            from public.db_deal_brokers db where db.deal_id = d.id),
         ''
       ) as brokers
from public.db_deals d
join public.db_stages s on s.id = d.stage_id
where not d.is_archived;

-- ---------------------------------------------------------------------
-- 10. Seed: departments and stages
-- ---------------------------------------------------------------------
insert into public.db_departments (name, slug) values
  ('Industrial','industrial'), ('Investment','investment');

insert into public.db_stages (department_id, name, position, is_terminal)
select d.id, s.name, s.pos, s.term
from public.db_departments d
cross join (values
  ('Submissions',1,false), ('Campaigns',2,false), ('Advanced',3,false),
  ('Under contract',4,false), ('Unconditional',5,true)
) as s(name,pos,term)
where d.slug = 'industrial';

insert into public.db_stages (department_id, name, position, is_terminal)
select d.id, s.name, s.pos, s.term
from public.db_departments d
cross join (values
  ('Submissions',1,false), ('Campaigns / sole agency',2,false),
  ('Advanced',3,false), ('Conditional',4,false),
  ('Unconditional',5,true), ('Tracking / WIP',6,false)
) as s(name,pos,term)
where d.slug = 'investment';


-- ---------------------------------------------------------------------
-- Teardown (uncomment to remove everything this file created)
-- ---------------------------------------------------------------------
-- drop view  if exists public.db_v_board;
-- drop function if exists public.db_roll_forward(uuid, date, text);
-- drop trigger if exists db_deals_audit on public.db_deals;
-- drop function if exists public.db_log_deal_change();
-- drop table if exists public.db_ranking_sync_issues;
-- drop table if exists public.db_broker_rankings;
-- drop table if exists public.db_broker_ranking_names;
-- drop table if exists public.db_requirements;
-- drop table if exists public.db_fines;
-- drop table if exists public.db_meetings;
-- drop table if exists public.db_deal_events;
-- drop table if exists public.db_deal_brokers;
-- drop table if exists public.db_deals;
-- drop table if exists public.db_stages;
-- drop table if exists public.db_departments;
-- drop type  if exists public.db_heat;
-- drop type  if exists public.db_aml_status;
