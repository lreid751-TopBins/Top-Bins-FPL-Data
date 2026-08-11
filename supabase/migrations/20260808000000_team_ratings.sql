-- Team Rater submissions.
--
-- Unlike squads and decisions, this isn't owned by a hashed client token —
-- the whole point is a public nickname and a score that gets announced.
-- Nothing here is editable or private: it's a snapshot of what was
-- submitted and how it scored, written once.
--
-- Scoring itself (the 2/5/5/3 split, £100m budget, max 3 per club, the
-- optimal-squad ceiling) is validated and computed server-side in the edge
-- function before a row ever reaches here — see rating.ts. This table only
-- stores the outcome.

create table if not exists public.team_ratings (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  nickname          text        not null check (length(nickname) between 1 and 40),

  -- The 15 submitted element ids. A snapshot, not a foreign key — like
  -- squads.picks, prices and stats are always recomputed live, never stored.
  picks             jsonb       not null,
  captain           integer,

  window_gws        smallint    not null check (window_gws between 1 and 10),
  pct               numeric(5,2) not null check (pct >= 0 and pct <= 100),
  submitted_total   numeric     not null,
  ceiling_total     numeric     not null,

  constraint picks_are_fifteen
    check (jsonb_typeof(picks) = 'array' and jsonb_array_length(picks) = 15)
);

create index if not exists team_ratings_recent
  on public.team_ratings (created_at desc);

comment on table public.team_ratings is
  'Team Rater submissions - public nickname, squad snapshot, and score. Written once, never edited.';

-- Locked down, same as decisions/squads: the edge function uses the service
-- role key. Nothing else reads or writes this directly.
alter table public.team_ratings enable row level security;
