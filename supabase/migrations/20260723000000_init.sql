-- Top Bins FPL data room — initial schema.
--
-- Two tables. api_cache exists because Edge Functions are stateless, so the
-- in-process cache dies with each cold start; Postgres gives every region a
-- shared one. price_history exists because the FPL API only ever reports the
-- current price, so history has to be recorded as it happens.

create table if not exists public.api_cache (
  key         text primary key,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);

comment on table public.api_cache is
  'Shared response cache for the FPL proxy. Rows are overwritten, never appended.';

create table if not exists public.price_history (
  captured_on date not null,
  element     integer not null,
  now_cost    integer not null,
  web_name    text,
  primary key (captured_on, element)
);

create index if not exists price_history_element_day
  on public.price_history (element, captured_on desc);

comment on table public.price_history is
  'Nightly snapshot of every player price, in tenths of a million.';

-- Price movement over a window. Returns only players whose price actually
-- moved, which keeps the payload small enough to send to the browser.
create or replace function public.price_moves(days integer default 14)
returns table (element integer, change integer, latest integer)
language sql
stable
security definer
set search_path = public
as $$
  with window_rows as (
    select *
    from public.price_history
    where captured_on >= current_date - days
  ),
  bounds as (
    select element,
           max(captured_on) as newest,
           min(captured_on) as oldest
    from window_rows
    group by element
  )
  select b.element,
         (n.now_cost - o.now_cost)::integer as change,
         n.now_cost::integer as latest
  from bounds b
  join window_rows n on n.element = b.element and n.captured_on = b.newest
  join window_rows o on o.element = b.element and o.captured_on = b.oldest
  where n.now_cost is distinct from o.now_cost;
$$;

-- Lock both tables down. The Edge Function uses the service role key, which
-- bypasses RLS; nothing else should be reading these directly.
alter table public.api_cache enable row level security;
alter table public.price_history enable row level security;

revoke all on function public.price_moves(integer) from anon, authenticated;

-- Housekeeping: cache rows for finished gameweeks are never read again.
create or replace function public.prune_api_cache(older_than interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.api_cache where fetched_at < now() - older_than;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_api_cache(interval) from anon, authenticated;
