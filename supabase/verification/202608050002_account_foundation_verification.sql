-- Read-only checks. Run after the account foundation migration.
select table_schema, table_name, is_insertable_into
from information_schema.tables
where (table_schema, table_name) in (
  ('public','user_profiles'), ('public','account_devices'), ('private','account_security_audit')
order by table_schema, table_name;

select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('user_profiles','account_devices');

select n.nspname, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'public' and p.proname in (
  'ensure_my_profile','touch_my_account_device','list_my_account_devices','set_my_account_device_active'
)) or (n.nspname = 'private' and p.proname in (
  'account_is_active','shares_site_with','current_user_is_permanent','site_role_for'
)) order by n.nspname, p.proname;

select routine_schema, routine_name, grantee
from information_schema.routine_privileges
where routine_schema in ('public','private')
  and routine_name in (
    'ensure_my_profile','touch_my_account_device','list_my_account_devices','set_my_account_device_active',
    'account_is_active','shares_site_with','current_user_is_permanent','site_role_for'
  ) order by routine_schema, routine_name, grantee;

-- Expected: only the four public browser RPCs are executable by authenticated.
-- private helpers must not be executable by PUBLIC or anon.
select count(*) as existing_members_unchanged from public.site_members;
select count(*) as existing_sites_unchanged from public.sites;
select count(*) as profiles_created_by_migration from public.user_profiles;
select count(*) as devices_created_by_migration from public.account_devices;
