-- Decision journal.
--
-- The point of a journal is that it records what you believed *before* you
-- knew the outcome, so hindsight can't quietly rewrite it. Two consequences
-- show up in this schema:
--
--   1. Nothing here stores points or results. Outcomes are recomputed from
--      live FPL data every time you open the page, so a decision can never
--      drift out of sync with what actually happened.
--   2. There is no update path. A decision is written once, and the API only
--      allows deleting it while its gameweek is still in the future.

create table if not exists public.decisions (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text        not null,
  created_at  timestamptz not null default now(),

  -- What kind of call this was.
  kind        text        not null
              check (kind in ('captain','transfer','bench','chip','hold')),

  -- The gameweek it was made for, and how long it should be judged over.
  gw          integer     not null check (gw between 1 and 38),
  horizon     text        not null check (horizon in ('1','3','5','rest')),

  -- The options you weighed: [{ id, name, short, pos }]
  options     jsonb       not null,
  -- The FPL element id you actually went with. Must appear in options.
  chosen      integer     not null,

  -- The qualitative half.
  confidence  smallint    not null check (confidence between 1 and 5),
  reasons     text[]      not null default '{}',
  note        text        not null default '' check (length(note) <= 600),
  title       text        not null default '' check (length(title) <= 120),

  constraint options_are_a_shortlist
    check (jsonb_typeof(options) = 'array'
           and jsonb_array_length(options) between 1 and 8),
  constraint reasons_are_short
    check (array_length(reasons, 1) is null or array_length(reasons, 1) <= 6)
);

create index if not exists decisions_by_owner
  on public.decisions (token_hash, gw desc, created_at desc);

comment on table public.decisions is
  'Per-user decision diary. Owned by a hashed client token, never a login.';
comment on column public.decisions.token_hash is
  'SHA-256 of the journal token held in the browser. The token itself is never stored.';

-- Locked down: the edge function uses the service role key and scopes every
-- query by token_hash. Nothing reaches this table directly.
alter table public.decisions enable row level security;
