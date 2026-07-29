-- Read-only structural verification for 202607290001_site_admin_recovery.sql.
-- Functional browser tests are performed by the aoPIC/aoALB UI branches.

do $verify$
declare
  v_missing text[];
  v_public_execute integer;
  v_plaintext_columns integer;
  v_delete_source text;
  v_claim_source text;
begin
  select array_agg(required.name order by required.name)
  into v_missing
  from (
    values
      ('public.create_site(text,text,text,text,text,text)'),
      ('public.list_my_sites()'),
      ('public.claim_site_admin(text,text,text)'),
      ('public.set_initial_site_admin_code(uuid,bigint,text)'),
      ('public.rotate_site_admin_code(uuid,bigint,text)'),
      ('public.list_site_members_admin(uuid)'),
      ('public.set_site_member_active_v2(uuid,uuid,boolean,bigint)'),
      ('public.delete_empty_site(uuid,bigint,text)'),
      ('private.site_admin_code_is_valid(text)')
  ) as required(name)
  where pg_catalog.to_regprocedure(required.name) is null;
  if v_missing is not null then
    raise exception 'Missing administrator recovery functions: %', v_missing;
  end if;

  if pg_catalog.to_regclass('private.site_admin_codes') is null
     or pg_catalog.to_regclass('private.site_admin_attempts') is null
     or pg_catalog.to_regclass('private.site_admin_access_audit') is null then
    raise exception 'Administrator recovery private tables are missing.';
  end if;

  select count(*) into v_plaintext_columns
  from information_schema.columns
  where table_schema in ('public', 'private')
    and table_name in (
      'site_admin_codes', 'site_admin_attempts', 'site_admin_access_audit'
    )
    and column_name ~* '(plain|password|secret|admin_code$|code_text|raw_code)';
  if v_plaintext_columns <> 0 then
    raise exception 'A possible plaintext administrator-code column exists.';
  end if;

  if exists (
    select 1 from private.site_admin_codes
    where code_hash !~ '^\$2[aby]\$'
  ) then
    raise exception 'A site administrator code is not stored as a bcrypt hash.';
  end if;

  select count(*) into v_public_execute
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname in (
      'claim_site_admin', 'set_initial_site_admin_code',
      'rotate_site_admin_code', 'list_site_members_admin',
      'set_site_member_active_v2', 'site_admin_code_is_valid'
    )
    and pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE');
  if v_public_execute <> 0 then
    raise exception 'PUBLIC EXECUTE remains on administrator recovery functions.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'claim_site_admin', 'set_initial_site_admin_code',
        'rotate_site_admin_code', 'list_site_members_admin',
        'set_site_member_active_v2'
      )
      and (
        not p.prosecdef
        or p.proconfig is null
        or not ('search_path=""' = any (p.proconfig))
      )
  ) then
    raise exception 'A browser RPC is missing SECURITY DEFINER or fixed search_path.';
  end if;

  if pg_catalog.has_function_privilege(
    'anon', 'public.claim_site_admin(text,text,text)', 'EXECUTE'
  ) then
    raise exception 'anon can execute claim_site_admin.';
  end if;
  if not pg_catalog.has_function_privilege(
    'authenticated', 'public.claim_site_admin(text,text,text)', 'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute claim_site_admin.';
  end if;

  if exists (
    select 1 from public.site_join_codes
    where grant_role = 'admin'::public.site_role
  ) then
    raise exception 'A normal participation code can grant administrator access.';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.claim_site_admin(text,text,text)'::regprocedure
  ) into v_claim_source;
  if v_claim_source not like '%failed_count + 1 >= 5%'
     or v_claim_source not like '%interval ''15 minutes''%'
     or v_claim_source not like '%on conflict on constraint site_members_site_id_user_id_key%' then
    raise exception 'claim_site_admin throttling, membership or secret-audit safeguards are incomplete.';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.delete_empty_site(uuid,bigint,text)'::regprocedure
  ) into v_delete_source;
  if v_delete_source like '%created_by is distinct from auth.uid()%' then
    raise exception 'delete_empty_site still depends on the first anonymous creator.';
  end if;
  if v_delete_source not like '%private.has_site_role(p_site_id, ''admin'')%'
     or v_delete_source not like '%site_not_empty%'
     or v_delete_source not like '%v_storage_count%' then
    raise exception 'delete_empty_site safety checks are incomplete.';
  end if;

  if exists (
    select 1
    from public.sites s
    left join private.site_admin_codes c on c.site_id = s.id
    where c.site_id is null
      and not exists (
        select 1 from public.site_members m
        where m.site_id = s.id and m.role = 'admin' and m.active
      )
  ) then
    raise exception 'An existing site lost all active administrators.';
  end if;
end
$verify$;

select
  (select count(*) from public.sites) as sites,
  (select count(*) from private.site_admin_codes) as configured_admin_codes,
  (select count(*) from public.sites s
    where not exists (
      select 1 from private.site_admin_codes c where c.site_id = s.id
    )) as sites_awaiting_initial_admin_code;
