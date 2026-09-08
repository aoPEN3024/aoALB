with expected_policies(policy_name) as (
  values
    ('legacy_aopic_sites_select'),
    ('legacy_aopic_members_select'),
    ('legacy_aopic_projects_select'),
    ('legacy_aopic_projects_insert'),
    ('legacy_aopic_photos_select'),
    ('legacy_aopic_photos_insert'),
    ('legacy_aopic_objects_select'),
    ('legacy_aopic_objects_insert'),
    ('legacy_aopic_events_insert'),
    ('legacy_aopic_storage_select'),
    ('legacy_aopic_storage_insert'),
    ('legacy_aopic_storage_update')
), present_policies as (
  select policyname
  from pg_catalog.pg_policies
  where schemaname in ('public', 'storage')
), helper_functions as (
  select count(*)::integer as count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname in (
      'legacy_anonymous_photo_sync_role',
      'legacy_anonymous_photo_sync_has_role',
      'legacy_anonymous_photo_sync_has_role_text',
      'current_user_is_legacy_anonymous_photo_sender'
    )
), guard_definition as (
  select pg_catalog.pg_get_functiondef(p.oid) as definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'enforce_active_account_write'
)
select jsonb_build_object(
  'helper_function_count', (select count from helper_functions),
  'expected_policy_count', (select count(*) from expected_policies),
  'present_policy_count', (
    select count(*) from expected_policies e join present_policies p on p.policyname = e.policy_name
  ),
  'guard_insert_only', coalesce((select definition ~* $$tg_op\s*=\s*'INSERT'$$ from guard_definition), false),
  'guard_table_scope', coalesce((select definition like '%projects%photos%photo_objects%sync_events%' from guard_definition), false),
  'anonymous_users_unchanged', (select count(*) from auth.users where coalesce(is_anonymous, false)),
  'site_members_unchanged', (select count(*) from public.site_members),
  'photos_unchanged', (select count(*) from public.photos),
  'photo_objects_unchanged', (select count(*) from public.photo_objects),
  'storage_objects_unchanged', (select count(*) from storage.objects where bucket_id = 'site-photos')
) as legacy_aopic_photo_sync_verification;
