-- Saved squads for the Planner.
--
-- A squad is a named, hand-built 15-player draft. Like the journal, it's owned
-- by a hashed client token rather than a login. Unlike the journal, squads are
-- editable — you draft, tweak, and re-save them as you plan toward a deadline.
--
-- We store only the player IDs and light metadata, never prices or stats:
-- those are always recomputed live from the FPL API, so a saved squad can
-- never show a stale price or a wrong xGI.

create table if not exists public.squads (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  name        text        not null default 'Untitled squad'
              check (length(name) between 1 and 60),

  -- The 15 chosen element ids, plus which slot each sits in. Shape validated
  -- in the edge function before it ever reaches here.
  -- [{ id, slot }] where slot is 1..15 (11 starters, 12-15 bench).
  picks       jsonb       not null default '[]'::jsonb,

  -- Optional captain / vice, stored as element ids (may be null while drafting).
  captain     integer,
  vice        integer,

  -- Free-text note the planner can attach (e.g. "wildcard draft, GW1").
  note        text        not null default '' check (length(note) <= 400),

  constraint picks_is_array
    check (jsonb_typeof(picks) = 'array' and jsonb_array_length(picks) <= 15)
);

create index if not exists squads_by_owner
  on public.squads (token_hash, updated_at desc);

comment on table public.squads is
  'Hand-built Planner squads. Owned by a hashed client token; player IDs only, no cached stats.';

alter table public.squads enable row level security;
