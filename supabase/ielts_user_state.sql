create table public.ielts_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ielts_user_state enable row level security;

revoke all on table public.ielts_user_state from anon;
grant select, insert, update, delete on table public.ielts_user_state to authenticated;

create policy "IELTS users manage their own state"
on public.ielts_user_state
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
