-- =============================================================================
-- Staff accounts: nobody but admin can move a staff row to another login id.
--
-- The staff guard (20261005000600) stops a non-admin from changing their OWN role, branches or
-- active flag, but it only looked at the id the row has after the update. A user manager (anyone
-- given "users.manage" by the role grid or a personal override) could change the id of their own
-- row first and so slip past that check. Nobody has a reason to change a staff id: it is the login's
-- id. This closes it. The Branches button on Admin -> Staff accounts does not need this file.
--
-- HOW TO APPLY
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--   It is safe to run more than once (create or replace). With the Supabase CLI, keep the file
--   name as it is: 20261009000100 sorts after the last migration (20261007002000_audit_fixes.sql).
-- =============================================================================

create or replace function public.guard_staff_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if new.role = 'admin' then raise exception 'Only admin can create or promote admin accounts'; end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then raise exception 'The account id cannot be changed'; end if;
    if old.role = 'admin' then raise exception 'Only admin can change an admin account'; end if;
    if old.id = auth.uid() and (new.role, new.active, new.restrict_to_branches, new.branch_ids)
       is distinct from (old.role, old.active, old.restrict_to_branches, old.branch_ids) then
      raise exception 'You cannot change your own role, branches or active flag';
    end if;
  end if;
  return new;
end $$;
