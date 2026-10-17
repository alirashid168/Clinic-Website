-- =============================================================================
-- The Photo inbox: every city folder for everyone who uses it.
--
-- The owner (Dr. Ali, 17 Oct 2026, verbatim): "please give the whole photo section to all assistant profiles too and coordinator too",
-- then "just give photos section to assistants too". The Photos menu and the Photo library were open to them already; the Photo inbox
-- showed each login only the city of its own branch (Gulshan and North Nazimabad: Karachi; Lahore: Lahore; Islamabad: Dr. Ali alone),
-- because its checks asked public.can_access_city(). Now a holder of "Use the Photo inbox" (photos.intake: assistants, the coordinator,
-- Dr. Ali) works in all three folders (Karachi, Lahore, Islamabad): upload, match, file, edit. Everything else (patients, visits,
-- billing) keeps the branch limits as they are.
--
-- public.photo_inbox_city_ok(city): photos.intake, or the old branch rule. The six functions and two read rules below are the exact
-- ones from 20261017000200_photo_intake.sql with public.can_access_city( replaced by public.photo_inbox_city_ok( (made by a script,
-- nothing else changed). Safe to run more than once.
-- TO UNDO: run the same blocks from 20261017000200_photo_intake.sql again, then drop function public.photo_inbox_city_ok(smallint).
-- =============================================================================

create or replace function public.photo_inbox_city_ok(p_city smallint)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (public.has_perm('photos.intake') or public.can_access_city(p_city))
$$;
revoke all on function public.photo_inbox_city_ok(smallint) from public, anon;
grant execute on function public.photo_inbox_city_ok(smallint) to authenticated;

drop policy if exists "photo inbox staff read" on public.photo_inbox_sets;
create policy "photo inbox staff read" on public.photo_inbox_sets for select to authenticated
  using (public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.photo_inbox_city_ok(city_id));

drop policy if exists "photo inbox staff read" on public.photo_inbox_items;
create policy "photo inbox staff read" on public.photo_inbox_items for select to authenticated
  using (public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.photo_inbox_city_ok(city_id));

create or replace function private.photo_inbox_require(p_city smallint)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_perm('photos.intake') or not public.has_perm('photos.view_raw')
     or (p_city is not null and (not exists (select 1 from public.cities c where c.id = p_city) or not public.photo_inbox_city_ok(p_city))) then
    raise exception 'NOT_ALLOWED: the Photo inbox needs "Use the Photo inbox" and "View raw clinic photos folder" in the access list, and a branch in this city.'
      using errcode = '42501';
  end if;
end $$;

create or replace function public.photo_inbox_city_folder_ok(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and split_part(p_name, '/', 1) = 'inbox' and split_part(p_name, '/', 4) <> ''
     and split_part(p_name, '/', 3) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     and exists (select 1 from public.cities c
                  where split_part(p_name, '/', 2) = btrim(lower(regexp_replace(c.name, '[^A-Za-z0-9]+', '-', 'g')), '-')
                    and public.photo_inbox_city_ok(c.id))
$$;

create or replace function public.photo_inbox_cities()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'slug', private.photo_inbox_city_slug(c.id),
           'branches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name) order by b.sort_order, b.id), '[]'::jsonb)
                          from public.branches b where b.city_id = c.id and b.active)) order by c.id), '[]'::jsonb)
    from public.cities c
   where auth.uid() is not null and public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.photo_inbox_city_ok(c.id)
     and exists (select 1 from public.branches b where b.city_id = c.id and b.active)
$$;

create or replace function public.photo_inbox_counts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_perm('photos.intake') or not public.has_perm('photos.view_raw') then
    return jsonb_build_object('waiting', 0, 'check', 0);
  end if;
  return (select jsonb_build_object('waiting', count(*) filter (where s.status = 'waiting'),
                                    'check', count(*) filter (where s.status = 'filed' and (s.ai_flag is not null or s.patient_id is null)))
            from public.photo_inbox_sets s
           where (s.status = 'waiting' or (s.status = 'filed' and (s.ai_flag is not null or s.patient_id is null))) and public.photo_inbox_city_ok(s.city_id));
end $$;

create or replace function public.photo_inbox_claim_edits(p_limit integer default 10, p_can_heic boolean default false, p_lease uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_set uuid;
  v_out jsonb;
  v_lease uuid := coalesce(p_lease, auth.uid());
  v_first integer;
  v_ref public.photo_inbox_items;
begin
  perform private.photo_inbox_require(null);
  select i.set_id into v_set
    from public.photo_inbox_items i join public.photo_inbox_sets s on s.id = i.set_id
   where s.status <> 'set_aside' and public.photo_inbox_city_ok(i.city_id)
     and (i.edit_status = 'pending' or (i.edit_status = 'failed' and i.edit_attempts < 3)
          or (coalesce(p_can_heic, false) and i.edit_status = 'needs_safari' and i.edit_attempts < 3))
     and (i.edit_lease_until is null or i.edit_lease_until < now() or i.edit_lease_by = v_lease)
   order by (s.status = 'filed') desc, s.photo_day, s.first_at nulls last, s.id
   limit 1;
  if v_set is null then
    return '[]'::jsonb;
  end if;
  with picked as (
    select i.id from public.photo_inbox_items i
     where i.set_id = v_set
       and (i.edit_status = 'pending' or (i.edit_status = 'failed' and i.edit_attempts < 3)
            or (coalesce(p_can_heic, false) and i.edit_status = 'needs_safari' and i.edit_attempts < 3))
       and (i.edit_lease_until is null or i.edit_lease_until < now() or i.edit_lease_by = v_lease)
     order by i.position nulls last, i.sha256
     limit least(greatest(coalesce(p_limit, 10), 1), 10)
     for update skip locked)
  update public.photo_inbox_items i set edit_lease_until = now() + interval '10 minutes', edit_lease_by = v_lease
    from picked where i.id = picked.id;
  select min(i.position) into v_first from public.photo_inbox_items i
   where i.set_id = v_set and i.edit_lease_by = v_lease and i.edit_lease_until > now() and i.ai_status = 'pending';
  select * into v_ref from public.photo_inbox_items i
   where i.set_id = v_set and i.ai_status = 'done' and coalesce(i.ai_result ->> 'kind', '') <> 'not_clinical'
   order by (coalesce(i.position, 0) < coalesce(v_first, 32767)) desc, abs(coalesce(i.position, 0) - coalesce(v_first, 0)), i.sha256
   limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'set_id', i.set_id, 'set_status', s.status,
           'city_slug', private.photo_inbox_city_slug(i.city_id), 'photo_day', i.photo_day, 'sha256', i.sha256, 'storage_path', i.storage_path,
           'mime_type', i.mime_type, 'orientation', i.orientation, 'width', i.width, 'height', i.height, 'position', i.position,
           'ai_status', i.ai_status, 'ai_result', i.ai_result, 'edit_status', i.edit_status, 'edit_round', i.edit_round,
           'ref_item_id', v_ref.id, 'ref_storage_path', v_ref.storage_path, 'ref_mime_type', v_ref.mime_type) order by i.position nulls last, i.sha256), '[]'::jsonb)
    into v_out
    from public.photo_inbox_items i join public.photo_inbox_sets s on s.id = i.set_id
   where i.set_id = v_set and i.edit_lease_by = v_lease and i.edit_lease_until > now()
     and (i.edit_status = 'pending' or (i.edit_status = 'failed' and i.edit_attempts < 3)
          or (coalesce(p_can_heic, false) and i.edit_status = 'needs_safari' and i.edit_attempts < 3));
  return v_out;
end $$;

create or replace function public.photo_inbox_renew_edits(p_items uuid[], p_lease uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  perform private.photo_inbox_require(null);
  update public.photo_inbox_items i set edit_lease_until = now() + interval '10 minutes'
   where i.id = any (p_items) and i.edit_lease_by = p_lease and i.edit_status <> 'done' and public.photo_inbox_city_ok(i.city_id);
  get diagnostics n = row_count;
  return n;
end $$;

notify pgrst, 'reload schema';
