create table if not exists public.ielts_shared_state (
  id text primary key default 'primary' check (id = 'primary'),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ielts_shared_state enable row level security;

revoke all on table public.ielts_shared_state from anon, authenticated;
grant select, insert, update on table public.ielts_shared_state to anon, authenticated;

drop policy if exists "Anyone can read the shared IELTS state" on public.ielts_shared_state;
drop policy if exists "Anyone can create the shared IELTS state" on public.ielts_shared_state;
drop policy if exists "Anyone can update the shared IELTS state" on public.ielts_shared_state;

create policy "Anyone can read the shared IELTS state"
on public.ielts_shared_state
for select
to anon, authenticated
using (id = 'primary');

create policy "Anyone can create the shared IELTS state"
on public.ielts_shared_state
for insert
to anon, authenticated
with check (id = 'primary');

create policy "Anyone can update the shared IELTS state"
on public.ielts_shared_state
for update
to anon, authenticated
using (id = 'primary')
with check (id = 'primary');

do $$
begin
  if to_regclass('public.ielts_user_state') is not null then
    execute $migration$
      insert into public.ielts_shared_state (id, state, updated_at)
      select 'primary', state, updated_at
      from public.ielts_user_state
      order by updated_at desc
      limit 1
      on conflict (id) do nothing
    $migration$;
  end if;
end
$$;

insert into public.ielts_shared_state (id)
values ('primary')
on conflict (id) do nothing;
