-- Run after 202607310001_photo_lifecycle.sql.
-- This file is read-only and does not create test data.

select
  count(*) filter (where column_name = 'lifecycle_status') = 1 as lifecycle_status_exists,
  count(*) filter (where column_name = 'trashed_at') = 1 as trashed_at_exists,
  count(*) filter (where column_name = 'trashed_by') = 1 as trashed_by_exists,
  count(*) filter (where column_name = 'trash_revision') = 1 as trash_revision_exists,
  count(*) filter (where column_name = 'delete_error') = 1 as delete_error_exists
from information_schema.columns
where table_schema = 'public' and table_name = 'photos';

select
  pg_catalog.to_regprocedure('public.photo_ledger_references(uuid)') is not null
    as photo_ledger_references_exists,
  pg_catalog.to_regprocedure('public.check_photo_upload_state(uuid,uuid,text)') is not null
    as check_photo_upload_state_exists,
  pg_catalog.to_regprocedure('public.trash_photo(uuid,bigint)') is not null
    as trash_photo_exists,
  pg_catalog.to_regprocedure('public.trash_photos(uuid[],bigint[])') is not null
    as trash_photos_exists,
  pg_catalog.to_regprocedure('public.restore_photo(uuid,bigint)') is not null
    as restore_photo_exists;

select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'photo_ledger_references',
    'check_photo_upload_state',
    'trash_photo',
    'trash_photos',
    'restore_photo'
  )
order by routine_name;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name in (
    'photo_ledger_references',
    'check_photo_upload_state',
    'trash_photo',
    'trash_photos',
    'restore_photo'
  )
order by routine_name, grantee;

select schemaname, tablename, policyname, permissive, roles, cmd
from pg_catalog.pg_policies
where (schemaname = 'public' and tablename in ('photos', 'photo_objects'))
   or (schemaname = 'storage' and tablename = 'objects'
       and policyname = 'site_photos_photo_lifecycle_select')
order by schemaname, tablename, policyname;

select lifecycle_status, count(*)
from public.photos
group by lifecycle_status
order by lifecycle_status;

select count(*) as invalid_lifecycle_rows
from public.photos
where not (
  (lifecycle_status = 'active'
    and trashed_at is null and trashed_by is null
    and trash_revision is null and delete_error is null)
  or
  (lifecycle_status = 'trashed'
    and trashed_at is not null and trashed_by is not null
    and trash_revision is not null and delete_error is null)
  or
  (lifecycle_status = 'deleting'
    and trashed_at is not null and trashed_by is not null
    and trash_revision is not null and delete_error is null)
  or
  (lifecycle_status = 'delete_error'
    and trashed_at is not null and trashed_by is not null
    and trash_revision is not null and delete_error is not null)
);
