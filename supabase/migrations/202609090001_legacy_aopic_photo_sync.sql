begin;

-- aoPIC still uses an anonymous Supabase Auth session.  The account-state
-- foundation intentionally blocks anonymous users from general aoALB writes.
-- This compatibility helper restores only the existing photo-ingress path for
-- an anonymous user who is already an active editor/admin of the target site.
create function private.legacy_anonymous_photo_sync_role(p_site_id uuid)
returns public.site_role
language sql stable security definer set search_path = ''
as $$
  select m.role
  from auth.users u
  join public.site_members m on m.user_id = u.id
  where u.id = (select auth.uid())
    and coalesce(u.is_anonymous, false)
    and m.site_id = p_site_id
    and m.active
  limit 1;
$$;

create function private.legacy_anonymous_photo_sync_has_role(
  p_site_id uuid,
  p_minimum public.site_role default 'viewer'
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    private.role_rank(private.legacy_anonymous_photo_sync_role(p_site_id))
      >= private.role_rank(p_minimum),
    false
  );
$$;

create function private.legacy_anonymous_photo_sync_has_role_text(
  p_site_id text,
  p_minimum public.site_role default 'viewer'
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_site_id is null
     or p_site_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  return private.legacy_anonymous_photo_sync_has_role(p_site_id::uuid, p_minimum);
end;
$$;

create function private.current_user_is_legacy_anonymous_photo_sender()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.site_members m on m.user_id = u.id
    where u.id = (select auth.uid())
      and coalesce(u.is_anonymous, false)
      and m.active
      and m.role in ('admin'::public.site_role, 'editor'::public.site_role)
  );
$$;

-- Keep the permanent-account guard for every other operation.  An existing
-- anonymous aoPIC member may only INSERT the four rows used by photo upload;
-- row-level policies below still bind every inserted row to its own active site.
create or replace function private.enforce_active_account_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return null;
  end if;
  if private.account_is_active((select auth.uid())) then
    return null;
  end if;
  if tg_op = 'INSERT'
     and tg_table_schema = 'public'
     and tg_table_name = any (array['projects', 'photos', 'photo_objects', 'sync_events'])
     and private.current_user_is_legacy_anonymous_photo_sender() then
    return null;
  end if;
  raise exception using errcode = '42501', message = 'account_unavailable';
end;
$$;

create policy legacy_aopic_sites_select on public.sites
  for select to authenticated
  using (private.legacy_anonymous_photo_sync_has_role(id, 'viewer'));

create policy legacy_aopic_members_select on public.site_members
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and private.legacy_anonymous_photo_sync_has_role(site_id, 'viewer')
  );

create policy legacy_aopic_projects_select on public.projects
  for select to authenticated
  using (private.legacy_anonymous_photo_sync_has_role(site_id, 'viewer'));

create policy legacy_aopic_projects_insert on public.projects
  for insert to authenticated
  with check (
    private.legacy_anonymous_photo_sync_has_role(site_id, 'editor')
    and private.site_is_active(site_id)
  );

create policy legacy_aopic_photos_select on public.photos
  for select to authenticated
  using (
    private.legacy_anonymous_photo_sync_has_role(site_id, 'viewer')
    and lifecycle_status = 'active'
  );

create policy legacy_aopic_photos_insert on public.photos
  for insert to authenticated
  with check (
    private.legacy_anonymous_photo_sync_has_role(site_id, 'editor')
    and private.site_is_active(site_id)
    and lifecycle_status = 'active'
  );

create policy legacy_aopic_objects_select on public.photo_objects
  for select to authenticated
  using (
    private.legacy_anonymous_photo_sync_has_role(site_id, 'viewer')
    and exists (
      select 1
      from public.photos p
      where p.id = photo_id
        and p.site_id = photo_objects.site_id
        and p.lifecycle_status = 'active'
    )
  );

create policy legacy_aopic_objects_insert on public.photo_objects
  for insert to authenticated
  with check (
    private.legacy_anonymous_photo_sync_has_role(site_id, 'editor')
    and private.site_is_active(site_id)
  );

create policy legacy_aopic_events_insert on public.sync_events
  for insert to authenticated
  with check (
    private.legacy_anonymous_photo_sync_has_role(site_id, 'editor')
    and private.site_is_active(site_id)
    and actor_user_id = (select auth.uid())
  );

create policy legacy_aopic_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'site-photos'
    and private.legacy_anonymous_photo_sync_has_role_text((storage.foldername(name))[1], 'viewer')
  );

create policy legacy_aopic_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'site-photos'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(photos|thumbnails)/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
    and private.legacy_anonymous_photo_sync_has_role_text((storage.foldername(name))[1], 'editor')
    and private.site_is_active_text((storage.foldername(name))[1])
  );

create policy legacy_aopic_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'site-photos'
    and private.legacy_anonymous_photo_sync_has_role_text((storage.foldername(name))[1], 'editor')
    and private.site_is_active_text((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'site-photos'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(photos|thumbnails)/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
    and private.legacy_anonymous_photo_sync_has_role_text((storage.foldername(name))[1], 'editor')
    and private.site_is_active_text((storage.foldername(name))[1])
  );

revoke all on function private.legacy_anonymous_photo_sync_role(uuid) from public, anon, authenticated;
revoke all on function private.legacy_anonymous_photo_sync_has_role(uuid, public.site_role) from public, anon, authenticated;
revoke all on function private.legacy_anonymous_photo_sync_has_role_text(text, public.site_role) from public, anon, authenticated;
revoke all on function private.current_user_is_legacy_anonymous_photo_sender() from public, anon, authenticated;

-- Policy expressions need callable helpers, but they reveal only the caller's
-- own membership.  No table grants or secret-bearing functions are exposed.
grant execute on function private.legacy_anonymous_photo_sync_has_role(uuid, public.site_role) to authenticated;
grant execute on function private.legacy_anonymous_photo_sync_has_role_text(text, public.site_role) to authenticated;

commit;
