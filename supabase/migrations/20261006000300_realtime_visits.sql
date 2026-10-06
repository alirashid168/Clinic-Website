-- Live updates for the Aaj ki List: every open screen hears about visit
-- changes the moment they happen. Row-level security still applies, so
-- staff only receive changes for visits they are allowed to see.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.visits;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.visit_staff;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
