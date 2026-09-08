begin;

drop policy if exists legacy_aopic_sites_select on public.sites;
drop policy if exists legacy_aopic_members_select on public.site_members;
drop policy if exists legacy_aopic_projects_select on public.projects;
drop policy if exists legacy_aopic_projects_insert on public.projects;
drop policy if exists legacy_aopic_photos_select on public.photos;
drop policy if exists legacy_aopic_photos_insert on public.photos;
drop policy if exists legacy_aopic_objects_select on public.photo_objects;
drop policy if exists legacy_aopic_objects_insert on public.photo_objects;
drop policy if exists legacy_aopic_events_insert on public.sync_events;
drop policy if exists legacy_aopic_storage_select on storage.objects;
drop policy if exists legacy_aopic_storage_insert on storage.objects;
drop policy if exists legacy_aopic_storage_update on storage.objects;

create or replace function private.enforce_active_account_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return null;
  end if;
  if not private.account_is_active((select auth.uid())) then
    raise exception using errcode = '42501', message = 'account_unavailable';
  end if;
  return null;
end;
$$;

drop function if exists private.current_user_is_legacy_anonymous_photo_sender();
drop function if exists private.legacy_anonymous_photo_sync_has_role_text(text, public.site_role);
drop function if exists private.legacy_anonymous_photo_sync_has_role(uuid, public.site_role);
drop function if exists private.legacy_anonymous_photo_sync_role(uuid);

commit;
