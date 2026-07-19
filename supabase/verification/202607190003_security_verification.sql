-- aoALB security verification
-- Run after the foundation migration and first-site bootstrap.
-- This script creates only temporary test rows and rolls every test write back.

begin;

do $structural_checks$
declare
  v_missing text;
begin
  if pg_catalog.to_regprocedure('extensions.crypt(text,text)') is null then
    raise exception 'FAIL: pgcrypto crypt() is missing from extensions.';
  end if;

  select string_agg(t.table_name, ', ' order by t.table_name) into v_missing
  from (values
    ('sites'), ('site_join_codes'), ('site_members'), ('site_join_attempts'),
    ('projects'), ('photos'), ('photo_objects'), ('ledgers'), ('ledger_pages'),
    ('ledger_slots'), ('sync_events'), ('audit_logs')
  ) as t(table_name)
  where pg_catalog.to_regclass('public.' || t.table_name) is null;
  if v_missing is not null then raise exception 'FAIL: missing tables: %', v_missing; end if;

  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('sites','site_join_codes','site_members','site_join_attempts','projects','photos','photo_objects','ledgers','ledger_pages','ledger_slots','sync_events','audit_logs')
    and not c.relrowsecurity;
  if v_missing is not null then raise exception 'FAIL: RLS is disabled on: %', v_missing; end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and p.proname in ('site_role_for','has_site_role','has_site_role_text','join_site','rotate_site_join_code','set_site_member_active','begin_ledger_edit')
      and coalesce(array_to_string(p.proconfig, ','), '') !~ '(^|,)search_path='
  ) then
    raise exception 'FAIL: a SECURITY DEFINER function has no fixed search_path.';
  end if;

  if pg_catalog.to_regprocedure('public.admin_bootstrap_site(text,text,text,uuid,text)') is not null then
    raise exception 'FAIL: persistent bootstrap function still exists.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid in (
      pg_catalog.to_regprocedure('public.join_site(text,text,text)'),
      pg_catalog.to_regprocedure('public.rotate_site_join_code(uuid,text,public.site_role)'),
      pg_catalog.to_regprocedure('public.set_site_member_active(uuid,uuid,boolean)'),
      pg_catalog.to_regprocedure('public.begin_ledger_edit(uuid,bigint)'),
      pg_catalog.to_regprocedure('private.role_rank(public.site_role)'),
      pg_catalog.to_regprocedure('private.site_role_for(uuid)'),
      pg_catalog.to_regprocedure('private.has_site_role(uuid,public.site_role)'),
      pg_catalog.to_regprocedure('private.has_site_role_text(text,public.site_role)'),
      pg_catalog.to_regprocedure('private.bump_revision()')
    )
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) or exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid in (
      pg_catalog.to_regprocedure('public.join_site(text,text,text)'),
      pg_catalog.to_regprocedure('public.rotate_site_join_code(uuid,text,public.site_role)'),
      pg_catalog.to_regprocedure('public.set_site_member_active(uuid,uuid,boolean)'),
      pg_catalog.to_regprocedure('public.begin_ledger_edit(uuid,bigint)'),
      pg_catalog.to_regprocedure('private.role_rank(public.site_role)'),
      pg_catalog.to_regprocedure('private.site_role_for(uuid)'),
      pg_catalog.to_regprocedure('private.has_site_role(uuid,public.site_role)'),
      pg_catalog.to_regprocedure('private.has_site_role_text(text,public.site_role)'),
      pg_catalog.to_regprocedure('private.bump_revision()')
    ) and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'FAIL: an aoALB function is executable by PUBLIC or anon.';
  end if;
  if not has_function_privilege('authenticated', 'public.join_site(text,text,text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated cannot execute join_site.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('sites','site_join_codes','site_members','site_join_attempts','projects','photos','photo_objects','ledgers','ledger_pages','ledger_slots','sync_events','audit_logs')
      and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
  ) or has_table_privilege('authenticated', 'public.site_join_codes', 'SELECT')
     or has_table_privilege('authenticated', 'public.site_join_attempts', 'SELECT') then
    raise exception 'FAIL: a hidden table is readable by a browser role.';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'site-photos' and public = false and file_size_limit = 20971520
      and allowed_mime_types = array['image/jpeg']::text[]
  ) then
    raise exception 'FAIL: private site-photos bucket settings do not match.';
  end if;

  if (select count(*) from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('site_photos_select','site_photos_insert','site_photos_update','site_photos_delete')) <> 4 then
    raise exception 'FAIL: one or more Storage policies are missing.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_events'
  ) then
    raise exception 'FAIL: sync_events is not in supabase_realtime.';
  end if;

  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'photos_project_site_fk')
     or not exists (select 1 from pg_catalog.pg_constraint where conname = 'photo_objects_photo_site_fk')
     or not exists (select 1 from pg_catalog.pg_constraint where conname = 'ledgers_project_site_fk')
     or not exists (select 1 from pg_catalog.pg_constraint where conname = 'ledger_pages_ledger_site_fk')
     or not exists (select 1 from pg_catalog.pg_constraint where conname = 'ledger_slots_page_site_fk')
     or not exists (select 1 from pg_catalog.pg_constraint where conname = 'ledger_slots_photo_site_fk') then
    raise exception 'FAIL: one or more cross-site foreign keys are missing.';
  end if;
end
$structural_checks$;

create temp table security_test_context (
  site_id uuid not null,
  admin_user_id uuid not null,
  project_id uuid not null,
  outsider_user_id uuid not null,
  second_site_id uuid not null,
  photo_id uuid not null,
  ledger_id uuid not null
) on commit drop;

create temp table security_test_results (
  test_name text not null,
  passed boolean not null,
  detail text not null
) on commit drop;
do $temp_grants$
declare
  v_temp_schema text;
begin
  select n.nspname into strict v_temp_schema
  from pg_catalog.pg_namespace n
  where n.oid = pg_catalog.pg_my_temp_schema();

  execute format('grant usage on schema %I to authenticated', v_temp_schema);
  execute format('grant select on %I.security_test_context to authenticated', v_temp_schema);
  execute format('grant select, insert on %I.security_test_results to authenticated', v_temp_schema);
end
$temp_grants$;

do $fixtures$
declare
  v_site_id uuid;
  v_admin_user_id uuid;
  v_project_id uuid := pg_catalog.gen_random_uuid();
  v_second_site_id uuid := pg_catalog.gen_random_uuid();
  v_photo_id uuid := pg_catalog.gen_random_uuid();
  v_ledger_id uuid := pg_catalog.gen_random_uuid();
  v_page_id uuid := pg_catalog.gen_random_uuid();
begin
  select m.site_id, m.user_id into v_site_id, v_admin_user_id
  from public.site_members m
  where m.role = 'admin' and m.active
  order by m.joined_at
  limit 1;
  if v_site_id is null then raise exception 'FAIL: active admin not found. Run bootstrap first.'; end if;

  insert into public.projects(id, site_id, project_uid, name, contractor)
  values (v_project_id, v_site_id, pg_catalog.gen_random_uuid(), 'RLS検証用（一時）', 'RLS検証用');
  insert into public.photos(id, site_id, project_id, photo_uid, sha256, width, height, bytes)
  values (v_photo_id, v_site_id, v_project_id, pg_catalog.gen_random_uuid(), repeat('0', 64), 1, 1, 1);
  insert into public.sites(id, site_code, name, created_by)
  values (v_second_site_id, 'RLS_TEST_' || upper(substr(replace(v_second_site_id::text, '-', ''), 1, 8)), 'RLS別現場（一時）', v_admin_user_id);

  insert into public.ledgers(id, site_id, project_id, ledger_uid, title)
  values (v_ledger_id, v_site_id, v_project_id, pg_catalog.gen_random_uuid(), 'RLS検証用台帳（一時）');
  insert into public.ledger_pages(id, site_id, ledger_id, page_index)
  values (v_page_id, v_site_id, v_ledger_id, 0);
  insert into public.ledger_slots(site_id, page_id, slot_index, slot_type)
  values (v_site_id, v_page_id, 0, 'blank');

  insert into public.sync_events(event_id, site_id, actor_user_id, device_name, entity_type, entity_id, event_type)
  values
    (pg_catalog.gen_random_uuid(), v_site_id, v_admin_user_id, 'RLS検証', 'verification', v_project_id, 'own-site'),
    (pg_catalog.gen_random_uuid(), v_second_site_id, v_admin_user_id, 'RLS検証', 'verification', v_second_site_id, 'other-site');

  insert into pg_temp.security_test_context
  values (v_site_id, v_admin_user_id, v_project_id, pg_catalog.gen_random_uuid(), v_second_site_id, v_photo_id, v_ledger_id);
end
$fixtures$;

-- Admin can see and update only through authenticated + RLS.
select set_config('request.jwt.claim.sub', (select admin_user_id::text from pg_temp.security_test_context), true);
select set_config('request.jwt.claims', json_build_object('sub', (select admin_user_id from pg_temp.security_test_context), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into pg_temp.security_test_results
select 'admin sees own site', count(*) = 1, 'expected 1 row, got ' || count(*)
from public.sites where id = (select site_id from pg_temp.security_test_context);
insert into pg_temp.security_test_results
select 'admin cannot see other site', count(*) = 0, 'visible rows: ' || count(*)
from public.sites where id = (select second_site_id from pg_temp.security_test_context);
insert into pg_temp.security_test_results
select 'admin receives own realtime rows only', count(*) = 1, 'visible rows: ' || count(*)
from public.sync_events;
insert into pg_temp.security_test_results
select 'admin can manage membership', public.set_site_member_active(
  (select site_id from pg_temp.security_test_context),
  (select admin_user_id from pg_temp.security_test_context),
  true
), 'set_site_member_active returned true';
do $admin_role_from_code$
begin
  begin
    perform public.rotate_site_join_code(
      (select site_id from pg_temp.security_test_context),
      'AdminRoleCheck01',
      'admin'
    );
    insert into pg_temp.security_test_results values ('join code cannot grant admin', false, 'admin role was accepted');
  exception when others then
    insert into pg_temp.security_test_results
    values ('join code cannot grant admin', sqlerrm = 'admin_role_not_allowed', sqlerrm);
  end;
end
$admin_role_from_code$;
reset role;

-- Viewer can read its site but cannot update project data.
update public.site_members set role = 'viewer' where user_id = (select admin_user_id from pg_temp.security_test_context)
  and site_id = (select site_id from pg_temp.security_test_context);
set local role authenticated;
insert into pg_temp.security_test_results
select 'viewer sees own site', count(*) = 1, 'expected 1 row, got ' || count(*)
from public.sites where id = (select site_id from pg_temp.security_test_context);
insert into pg_temp.security_test_results
select 'viewer sees own project', count(*) = 1, 'visible rows: ' || count(*)
from public.projects where id = (select project_id from pg_temp.security_test_context);
insert into pg_temp.security_test_results
select 'viewer sees own photo', count(*) = 1, 'visible rows: ' || count(*)
from public.photos where id = (select photo_id from pg_temp.security_test_context);
insert into pg_temp.security_test_results
select 'viewer sees own ledger', count(*) = 1, 'visible rows: ' || count(*)
from public.ledgers where id = (select ledger_id from pg_temp.security_test_context);
insert into pg_temp.security_test_results
select 'viewer receives own realtime rows only', count(*) = 1, 'visible rows: ' || count(*)
from public.sync_events;
with changed as (
  update public.projects set name = name where id = (select project_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'viewer cannot update project', count(*) = 0, 'updated rows: ' || count(*) from changed;
with changed as (
  update public.photos set metadata = metadata where id = (select photo_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'viewer cannot update photo', count(*) = 0, 'updated rows: ' || count(*) from changed;
with changed as (
  delete from public.ledgers where id = (select ledger_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'viewer cannot delete ledger', count(*) = 0, 'deleted rows: ' || count(*) from changed;
do $viewer_admin_rpc$
begin
  begin
    perform public.set_site_member_active(
      (select site_id from pg_temp.security_test_context),
      (select admin_user_id from pg_temp.security_test_context),
      true
    );
    insert into pg_temp.security_test_results values ('viewer cannot use admin RPC', false, 'admin RPC succeeded');
  exception when others then
    insert into pg_temp.security_test_results values ('viewer cannot use admin RPC', sqlerrm = 'not_allowed', sqlerrm);
  end;
end
$viewer_admin_rpc$;
reset role;

-- Editor can update its own site's project.
update public.site_members set role = 'editor' where user_id = (select admin_user_id from pg_temp.security_test_context)
  and site_id = (select site_id from pg_temp.security_test_context);
set local role authenticated;
with changed as (
  update public.projects set name = name where id = (select project_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'editor can update own project', count(*) = 1, 'updated rows: ' || count(*) from changed;
with changed as (
  update public.photos set metadata = jsonb_build_object('verification', true)
  where id = (select photo_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'editor can update own photo', count(*) = 1, 'updated rows: ' || count(*) from changed;
with changed as (
  update public.ledgers set title = title where id = (select ledger_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'editor can update own ledger', count(*) = 1, 'updated rows: ' || count(*) from changed;
with created as (
  insert into public.projects(site_id, project_uid, name, contractor)
  values ((select site_id from pg_temp.security_test_context), pg_catalog.gen_random_uuid(), 'editor追加検証（一時）', '')
  returning 1
)
insert into pg_temp.security_test_results
select 'editor can insert project metadata', count(*) = 1, 'inserted rows: ' || count(*) from created;
with changed as (
  delete from public.photos where id = (select photo_id from pg_temp.security_test_context) returning 1
)
insert into pg_temp.security_test_results
select 'editor cannot delete photo', count(*) = 0, 'deleted rows: ' || count(*) from changed;
do $editor_admin_rpc$
begin
  begin
    perform public.set_site_member_active(
      (select site_id from pg_temp.security_test_context),
      (select admin_user_id from pg_temp.security_test_context),
      true
    );
    insert into pg_temp.security_test_results values ('editor cannot use admin RPC', false, 'admin RPC succeeded');
  exception when others then
    insert into pg_temp.security_test_results values ('editor cannot use admin RPC', sqlerrm = 'not_allowed', sqlerrm);
  end;
end
$editor_admin_rpc$;
reset role;

-- A valid but unaffiliated JWT subject sees zero sites.
select set_config('request.jwt.claim.sub', (select outsider_user_id::text from pg_temp.security_test_context), true);
select set_config('request.jwt.claims', json_build_object('sub', (select outsider_user_id from pg_temp.security_test_context), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into pg_temp.security_test_results
select 'unaffiliated user sees zero sites', count(*) = 0, 'visible rows: ' || count(*) from public.sites;
insert into pg_temp.security_test_results
select 'unaffiliated user sees zero projects', count(*) = 0, 'visible rows: ' || count(*) from public.projects;
insert into pg_temp.security_test_results
select 'unaffiliated user sees zero photos', count(*) = 0, 'visible rows: ' || count(*) from public.photos;
insert into pg_temp.security_test_results
select 'unaffiliated user sees zero ledgers', count(*) = 0, 'visible rows: ' || count(*) from public.ledgers;
insert into pg_temp.security_test_results
select 'unaffiliated user receives zero realtime rows', count(*) = 0, 'visible rows: ' || count(*) from public.sync_events;
reset role;

-- Five invalid join attempts block the user globally, even with an unknown site code.
select set_config('request.jwt.claim.sub', (select admin_user_id::text from pg_temp.security_test_context), true);
select set_config('request.jwt.claims', json_build_object('sub', (select admin_user_id from pg_temp.security_test_context), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into pg_temp.security_test_results select 'join attempt 1', error_code = 'invalid_join', coalesce(error_code, 'success') from public.join_site('NO_SUCH_SITE', 'wrong-code-1', 'test');
insert into pg_temp.security_test_results select 'join attempt 2', error_code = 'invalid_join', coalesce(error_code, 'success') from public.join_site('OTHER_SITE', 'wrong-code-2', 'test');
insert into pg_temp.security_test_results select 'join attempt 3', error_code = 'invalid_join', coalesce(error_code, 'success') from public.join_site('THIRD_SITE', 'wrong-code-3', 'test');
insert into pg_temp.security_test_results select 'join attempt 4', error_code = 'invalid_join', coalesce(error_code, 'success') from public.join_site('FOURTH_SITE', 'wrong-code-4', 'test');
insert into pg_temp.security_test_results select 'join attempt 5 blocks', error_code = 'temporarily_blocked', coalesce(error_code, 'success') from public.join_site('FIFTH_SITE', 'wrong-code-5', 'test');
reset role;

-- Database constraints reject cross-site parent/child and object paths.
do $constraint_tests$
begin
  begin
    insert into public.photos(site_id, project_id, photo_uid, sha256, width, height, bytes)
    values (
      (select second_site_id from pg_temp.security_test_context),
      (select project_id from pg_temp.security_test_context),
      pg_catalog.gen_random_uuid(), repeat('1', 64), 1, 1, 1
    );
    insert into pg_temp.security_test_results values ('cross-site FK rejected', false, 'invalid photo insert succeeded');
  exception when foreign_key_violation then
    insert into pg_temp.security_test_results values ('cross-site FK rejected', true, 'foreign_key_violation');
  end;

  begin
    insert into public.photo_objects(photo_id, site_id, object_path, sha256, bytes)
    values (
      (select photo_id from pg_temp.security_test_context),
      (select site_id from pg_temp.security_test_context),
      (select second_site_id::text from pg_temp.security_test_context) || '/wrong.jpg',
      repeat('0', 64), 1
    );
    insert into pg_temp.security_test_results values ('cross-site Storage path rejected', false, 'invalid object_path insert succeeded');
  exception when check_violation then
    insert into pg_temp.security_test_results values ('cross-site Storage path rejected', true, 'check_violation');
  end;
end
$constraint_tests$;

do $result_check$
declare
  v_failures text;
begin
  select string_agg(test_name || ' (' || detail || ')', '; ' order by test_name)
  into v_failures
  from pg_temp.security_test_results
  where not passed;
  if v_failures is not null then
    raise exception 'FAIL: %', v_failures;
  end if;
end
$result_check$;

select test_name, passed, detail from pg_temp.security_test_results order by test_name;

rollback;
