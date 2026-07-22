-- Non-destructive structural verification for site creation code support.

begin;

create temp table site_creation_verification (
  check_name text primary key,
  passed boolean not null,
  detail text not null
) on commit preserve rows;

insert into site_creation_verification values
  ('private tables exist',
    pg_catalog.to_regclass('private.site_creation_codes') is not null
      and pg_catalog.to_regclass('private.site_creation_attempts') is not null,
    'creation code and attempt history tables'),
  ('create_site exists',
    pg_catalog.to_regprocedure('public.create_site(text,text,text,text,text)') is not null,
    'browser RPC signature'),
  ('tables use RLS',
    (select c.relrowsecurity from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname='site_creation_codes')
    and
    (select c.relrowsecurity from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname='site_creation_attempts'),
    'both private tables have RLS enabled'),
  ('anon cannot read codes',
    not has_table_privilege('anon','private.site_creation_codes','SELECT')
      and not has_table_privilege('anon','private.site_creation_attempts','SELECT'),
    'anon has no SELECT'),
  ('authenticated cannot read codes',
    not has_table_privilege('authenticated','private.site_creation_codes','SELECT')
      and not has_table_privilege('authenticated','private.site_creation_attempts','SELECT'),
    'authenticated has no direct SELECT'),
  ('authenticated cannot mutate private tables',
    not has_table_privilege('authenticated','private.site_creation_codes','INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','private.site_creation_attempts','INSERT,UPDATE,DELETE'),
    'all writes pass through SECURITY DEFINER RPC'),
  ('authenticated can execute create_site',
    has_function_privilege('authenticated','public.create_site(text,text,text,text,text)','EXECUTE'),
    'authenticated EXECUTE'),
  ('anon cannot execute create_site',
    not has_function_privilege('anon','public.create_site(text,text,text,text,text)','EXECUTE'),
    'anon EXECUTE is absent'),
  ('PUBLIC cannot execute create_site',
    not exists (
      select 1 from information_schema.routine_privileges
      where routine_schema = 'public'
        and routine_name = 'create_site'
        and grantee = 'PUBLIC'
        and privilege_type = 'EXECUTE'
    ),
    'PUBLIC EXECUTE is absent'),
  ('security definer and fixed search_path',
    exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='create_site'
        and p.prosecdef
        and 'search_path=""' = any(coalesce(p.proconfig, array[]::text[]))
    ),
    'SECURITY DEFINER with empty search_path'),
  ('no plaintext code column',
    not exists (
      select 1 from information_schema.columns
      where table_schema='private' and table_name='site_creation_codes'
        and column_name in ('code','plaintext','site_creation_code')
    ),
    'only code_hash is stored'),
  ('join code cannot grant admin',
    exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid='public.site_join_codes'::regclass
        and position('grant_role' in lower(pg_catalog.pg_get_constraintdef(oid))) > 0
        and position('admin' in lower(pg_catalog.pg_get_constraintdef(oid))) > 0
    ),
    'site_join_codes keeps admin prohibition');

do $assertions$
declare v_failed text;
begin
  select string_agg(check_name, ', ' order by check_name) into v_failed
  from site_creation_verification where not passed;
  if v_failed is not null then
    raise exception 'Site creation verification failed: %', v_failed;
  end if;
end
$assertions$;

commit;

select check_name, passed, detail
from pg_temp.site_creation_verification
order by check_name;

drop table pg_temp.site_creation_verification;
