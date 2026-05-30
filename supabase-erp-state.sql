-- Option B: single JSONB ERP state table used by the React app.
-- Run this once in Supabase SQL Editor.

create table if not exists public.erp_state (
  id text primary key,
  created_at timestamptz not null default now(),
  data jsonb not null
);

alter table public.erp_state enable row level security;

-- For a demo/client-only app using the anon key. Tighten this before production.
drop policy if exists "Allow anon ERP state read" on public.erp_state;
create policy "Allow anon ERP state read"
on public.erp_state for select
to anon
using (true);

drop policy if exists "Allow anon ERP state write" on public.erp_state;
create policy "Allow anon ERP state write"
on public.erp_state for insert
to anon
with check (true);

drop policy if exists "Allow anon ERP state update" on public.erp_state;
create policy "Allow anon ERP state update"
on public.erp_state for update
to anon
using (true)
with check (true);