-- Roll back 202607310001_photo_lifecycle.sql.
-- Refuses to run while any photo is outside the active state because removing
-- lifecycle columns would otherwise silently expose trashed data.

begin;

do $safety$
begin
  if exists (
    select 1 from public.photos where lifecycle_status <> 'active'
  ) then
    raise exception 'rollback refused: non-active photos exist';
  end if;
end;
$safety$;

drop policy if exists site_photos_photo_lifecycle_select on storage.objects;

drop policy if exists objects_select on public.photo_objects;
create policy objects_select on public.photo_objects for select to authenticated
using (private.has_site_role(site_id, 'viewer'));

drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos for select to authenticated
using (private.has_site_role(site_id, 'viewer'));

revoke update on public.photos from authenticated;
grant update on public.photos to authenticated;

drop function if exists public.restore_photo(uuid, bigint);
drop function if exists public.trash_photo(uuid, bigint);
drop function if exists public.check_photo_upload_state(uuid, uuid, text);
drop function if exists public.photo_ledger_references(uuid);

drop index if exists public.photos_site_lifecycle_idx;

alter table public.photos
  drop constraint if exists photos_lifecycle_fields_consistent,
  drop constraint if exists photos_lifecycle_status_allowed,
  drop column if exists delete_error,
  drop column if exists trash_revision,
  drop column if exists trashed_by,
  drop column if exists trashed_at,
  drop column if exists lifecycle_status;

commit;
