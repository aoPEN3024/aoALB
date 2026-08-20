-- Read-only verification after migration/bootstrap. It does not expose email addresses.
select pg_catalog.jsonb_build_object(
  'account_status_type', pg_catalog.to_regtype('public.account_status') is not null,
  'system_admins_table', pg_catalog.to_regclass('public.system_admins') is not null,
  'management_audit_table', pg_catalog.to_regclass('public.account_management_audit') is not null,
  'rate_limit_table', pg_catalog.to_regclass('public.account_management_rate_limits') is not null,
  'invitation_operations_table', pg_catalog.to_regclass('public.account_invitation_operations') is not null,
  'invitation_recovery_required', (select count(*) from public.account_invitation_operations
    where status in ('recovery_required','manual_review')),
  'active_system_admins', (select count(*) from public.system_admins where active),
  'status_counts', (select coalesce(jsonb_object_agg(status, amount), '{}'::jsonb)
    from (select status::text, count(*) amount from public.user_profiles group by status) q),
  'plaintext_email_columns', (select count(*) from information_schema.columns
    where table_schema in ('public','private') and table_name in
      ('system_admins','account_management_audit','account_management_rate_limits','account_invitation_operations')
      and column_name ilike '%email%'
      and column_name not ilike '%fingerprint%'
      and column_name not ilike '%hash%'
      and column_name not ilike '%digest%'),
  'authenticated_table_grants', (select count(*) from information_schema.role_table_grants
    where grantee in ('anon','authenticated') and table_schema = 'public'
      and table_name in ('system_admins','account_management_audit','account_management_rate_limits','account_invitation_operations')),
  'public_function_grants', (select count(*) from information_schema.routine_privileges
    where grantee in ('PUBLIC','anon') and specific_schema in ('public','private')
      and routine_name in ('get_my_account_context','activate_my_invited_account','is_system_admin',
        'admin_begin_account_invitation','admin_record_invitation_auth_user',
        'admin_complete_account_invitation','admin_mark_invitation_recovery_required')),
  'write_guard_count', (select count(*) from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where not t.tgisinternal and p.proname = 'enforce_active_account_write' and n.nspname = 'private'),
  'system_admin_site_membership_is_separate', not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.system_admins'::regclass
      and c.confrelid = 'public.site_members'::regclass
  )
) as verification;

-- Expected: no anonymous/permanent Auth user lacking an invited/active profile gains cloud access.
select
  count(*) filter (where coalesce(u.is_anonymous, false)) as anonymous_auth_users,
  count(*) filter (where not coalesce(u.is_anonymous, false) and p.user_id is null) as permanent_without_profile,
  count(*) filter (where p.status = 'invited') as invited,
  count(*) filter (where p.status = 'active') as active,
  count(*) filter (where p.status = 'suspended') as suspended,
  count(*) filter (where p.status = 'deleted') as deleted_equivalent
from auth.users u
left join public.user_profiles p on p.user_id = u.id;
