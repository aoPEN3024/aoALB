-- Read-only structural verification for 202607270001_shared_project_lifecycle.sql.

do $verify$
declare
  v_missing text[];
  v_public_execute integer;
  v_policy_count integer;
begin
  select array_agg(required.name order by required.name)
  into v_missing
  from (
    values
      ('public.update_site(uuid,bigint,text,text)'),
      ('public.close_site(uuid,bigint)'),
      ('public.reopen_site(uuid,bigint)'),
      ('public.trash_site(uuid,bigint)'),
      ('public.restore_site(uuid,bigint)'),
      ('public.delete_empty_site(uuid,bigint,text)'),
      ('private.site_is_active(uuid)'),
      ('private.site_is_active_text(text)')
  ) as required(name)
  where pg_catalog.to_regprocedure(required.name) is null;
  if v_missing is not null then
    raise exception 'Missing lifecycle functions: %', v_missing;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sites'
      and column_name = 'status' and column_default = '''active''::text'
  ) then
    raise exception 'sites.status is missing or does not default to active.';
  end if;

  select count(*) into v_public_execute
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname in (
      'update_site', 'close_site', 'reopen_site', 'trash_site',
      'restore_site', 'delete_empty_site', 'site_is_active', 'site_is_active_text'
    )
    and pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE');
  if v_public_execute <> 0 then
    raise exception 'PUBLIC EXECUTE remains on lifecycle functions.';
  end if;

  select count(*) into v_policy_count
  from pg_catalog.pg_policies
  where (
    schemaname = 'public'
    and policyname in (
      'projects_insert','projects_update','projects_delete',
      'photos_insert','photos_update','photos_delete',
      'objects_insert','objects_update','objects_delete',
      'ledgers_insert','ledgers_update','ledgers_delete',
      'pages_insert','pages_update','pages_delete',
      'slots_insert','slots_update','slots_delete',
      'events_insert','events_delete'
    )
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%site_is_active%'
  ) or (
    schemaname = 'storage'
    and policyname in ('site_photos_insert','site_photos_update','site_photos_delete')
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%site_is_active%'
  );
  if v_policy_count <> 23 then
    raise exception 'Expected 23 active-site write policies, found %.', v_policy_count;
  end if;

  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'sites' and policyname = 'sites_update'
  ) then
    raise exception 'Direct sites_update policy still exists.';
  end if;

  if not exists (
    select 1 from public.sites
    where status = 'active'
  ) and exists (select 1 from public.sites) then
    raise exception 'Existing sites were not treated as active.';
  end if;
end
$verify$;

select
  count(*) filter (where status = 'active') as active_sites,
  count(*) filter (where status = 'closed') as closed_sites,
  count(*) filter (where status = 'trashed') as trashed_sites
from public.sites;
