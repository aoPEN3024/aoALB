-- Per-site administrator recovery and multi-site navigation for aoPIC / aoALB.
-- Apply once after 202607270001_shared_project_lifecycle.sql.
-- Existing sites remain usable and have no administrator code until an active
-- administrator explicitly sets one.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.sites') is null
     or pg_catalog.to_regclass('public.site_members') is null
     or pg_catalog.to_regclass('public.audit_logs') is null
     or pg_catalog.to_regprocedure('public.create_site(text,text,text,text,text)') is null
     or pg_catalog.to_regprocedure('public.delete_empty_site(uuid,bigint,text)') is null
     or pg_catalog.to_regprocedure('extensions.crypt(text,text)') is null then
    raise exception 'Apply the site sharing, creation-code and lifecycle migrations first.';
  end if;
  if pg_catalog.to_regclass('private.site_admin_codes') is not null
     or pg_catalog.to_regclass('private.site_admin_attempts') is not null
     or pg_catalog.to_regprocedure('public.claim_site_admin(text,text,text)') is not null then
    raise exception 'Site administrator recovery objects already exist. Do not rerun this migration.';
  end if;
end
$preflight$;

create table private.site_admin_codes (
  site_id uuid primary key references public.sites(id) on delete cascade,
  code_hash text not null,
  version integer not null default 1 check (version > 0),
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

-- A single row per anonymous user prevents changing the requested site code
-- from bypassing the 15-minute failure window.
create table private.site_admin_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_count integer not null default 0 check (failed_count >= 0),
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  last_site_code text not null default ''
);

-- Access auditing is private because failed requests can come from users who
-- are not yet site members. No secret code or token is stored.
create table private.site_admin_access_audit (
  id bigint generated always as identity primary key,
  site_id uuid,
  actor_user_id uuid not null,
  succeeded boolean not null,
  occurred_at timestamptz not null default now()
);

alter table private.site_admin_codes enable row level security;
alter table private.site_admin_attempts enable row level security;
alter table private.site_admin_access_audit enable row level security;

revoke all on table
  private.site_admin_codes,
  private.site_admin_attempts,
  private.site_admin_access_audit
from public, anon, authenticated;
revoke all on sequence private.site_admin_access_audit_id_seq
from public, anon, authenticated;

create function private.site_admin_code_is_valid(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    char_length(coalesce(p_code, '')) between 8 and 64
    and octet_length(coalesce(p_code, '')) <= 72
    and coalesce(p_code, '') !~ '[[:space:][:cntrl:]]'
    and coalesce(p_code, '') !~* '^(password|admin|administrator|qwerty|letmein|aopen|aoalb|aopic|12345678|87654321)$'
    and coalesce(p_code, '') !~ '^(.)\1{7,}$'
    and (
      (coalesce(p_code, '') ~ '[a-z]')::integer
      + (coalesce(p_code, '') ~ '[A-Z]')::integer
      + (coalesce(p_code, '') ~ '[0-9]')::integer
      + (coalesce(p_code, '') ~ '[^A-Za-z0-9]')::integer
    ) >= 2;
$$;

revoke all on function private.site_admin_code_is_valid(text)
from public, anon, authenticated;

-- New clients use the six-argument overload. The five-argument function stays
-- available so an older deployed client does not stop working while releases
-- are rolled out. Sites created by the old overload simply remain "not set".
create function public.create_site(
  p_site_name text,
  p_site_code text,
  p_site_join_code text,
  p_device_name text,
  p_site_creation_code text,
  p_site_admin_code text
)
returns table(
  site_id uuid,
  site_code text,
  site_name text,
  member_role public.site_role,
  admin_code_configured boolean,
  error_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site_id uuid;
  v_site_code text;
  v_site_name text;
  v_member_role public.site_role;
  v_error_code text;
begin
  if not private.site_admin_code_is_valid(p_site_admin_code) then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, false, 'invalid_input'::text;
    return;
  end if;

  select created.site_id, created.site_code, created.site_name,
         created.member_role, created.error_code
  into v_site_id, v_site_code, v_site_name, v_member_role, v_error_code
  from public.create_site(
    p_site_name,
    p_site_code,
    p_site_join_code,
    p_device_name,
    p_site_creation_code
  ) created;

  if v_site_id is null then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, false, v_error_code;
    return;
  end if;

  insert into private.site_admin_codes(site_id, code_hash, changed_by)
  values (
    v_site_id,
    extensions.crypt(p_site_admin_code, extensions.gen_salt('bf', 10)),
    (select auth.uid())
  );

  insert into public.audit_logs(
    site_id, actor_user_id, action, entity_type, entity_id, details
  )
  values (
    v_site_id, (select auth.uid()), 'admin_code.initial_set', 'site', v_site_id,
    pg_catalog.jsonb_build_object('source', 'site_create')
  );

  return query select v_site_id, v_site_code, v_site_name,
    v_member_role, true, null::text;
end;
$$;

create function public.list_my_sites()
returns table(
  site_id uuid,
  site_code text,
  site_name text,
  member_role public.site_role,
  site_status text,
  site_revision bigint,
  site_updated_at timestamptz,
  device_name text,
  admin_code_configured boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.site_code,
    s.name,
    m.role,
    s.status,
    s.revision,
    s.updated_at,
    m.device_name,
    exists (
      select 1 from private.site_admin_codes c where c.site_id = s.id
    )
  from public.site_members m
  join public.sites s on s.id = m.site_id
  where m.user_id = (select auth.uid())
    and m.active
  order by s.updated_at desc, s.name, s.id;
$$;

create function public.claim_site_admin(
  p_site_code text,
  p_site_admin_code text,
  p_device_name text
)
returns table(
  site_id uuid,
  site_code text,
  site_name text,
  member_role public.site_role,
  site_status text,
  site_revision bigint,
  admin_code_configured boolean,
  error_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_now timestamptz := now();
  v_code text := upper(trim(coalesce(p_site_code, '')));
  v_device text := trim(coalesce(p_device_name, ''));
  v_site public.sites%rowtype;
  v_admin_hash text;
  v_compare_hash text;
  v_code_matches boolean;
  v_attempt private.site_admin_attempts%rowtype;
  v_blocked_until timestamptz;
begin
  if v_user is null then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, null::text, null::bigint, false, 'auth_required'::text;
    return;
  end if;
  if char_length(v_device) not between 1 and 80 or v_device ~ '[[:cntrl:]]' then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, null::text, null::bigint, false, 'invalid_input'::text;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user::text, 290729)
  );

  select a.* into v_attempt
  from private.site_admin_attempts a
  where a.user_id = v_user
  for update;
  if found and v_attempt.blocked_until > v_now then
    insert into private.site_admin_access_audit(site_id, actor_user_id, succeeded)
    values (null, v_user, false);
    return query select null::uuid, null::text, null::text,
      null::public.site_role, null::text, null::bigint, false, 'temporarily_blocked'::text;
    return;
  end if;

  select s.* into v_site
  from public.sites s
  where s.site_code = v_code;
  if found then
    select c.code_hash into v_admin_hash
    from private.site_admin_codes c
    where c.site_id = v_site.id
    for update;
  end if;

  -- Always perform the same two bcrypt operations whether the site/code row
  -- exists or not, so the external generic error is not undermined by an
  -- obvious fast-path timing difference.
  v_compare_hash := extensions.crypt(
    pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
    extensions.gen_salt('bf', 10)
  );
  v_compare_hash := coalesce(v_admin_hash, v_compare_hash);
  v_code_matches :=
    v_compare_hash = extensions.crypt(coalesce(p_site_admin_code, ''), v_compare_hash);

  if v_admin_hash is null
     or not private.site_admin_code_is_valid(p_site_admin_code)
     or not v_code_matches then
    insert into private.site_admin_attempts(
      user_id, failed_count, window_started_at, blocked_until, last_site_code
    )
    values (v_user, 1, v_now, null, left(v_code, 40))
    on conflict (user_id) do update set
      failed_count = case
        when private.site_admin_attempts.window_started_at < v_now - interval '15 minutes'
          then 1
        else private.site_admin_attempts.failed_count + 1
      end,
      window_started_at = case
        when private.site_admin_attempts.window_started_at < v_now - interval '15 minutes'
          then v_now
        else private.site_admin_attempts.window_started_at
      end,
      blocked_until = case
        when private.site_admin_attempts.window_started_at < v_now - interval '15 minutes'
          then null
        when private.site_admin_attempts.failed_count + 1 >= 5
          then v_now + interval '15 minutes'
        else null
      end,
      last_site_code = excluded.last_site_code
    returning private.site_admin_attempts.blocked_until into v_blocked_until;

    insert into private.site_admin_access_audit(site_id, actor_user_id, succeeded)
    values (case when v_site.id is null then null else v_site.id end, v_user, false);

    return query select null::uuid, null::text, null::text,
      null::public.site_role, null::text, null::bigint, false,
      case when v_blocked_until > v_now
        then 'temporarily_blocked'
        else 'invalid_admin_access'
      end;
    return;
  end if;

  delete from private.site_admin_attempts where user_id = v_user;

  insert into public.site_members(
    site_id, user_id, role, device_name, active, last_seen_at
  )
  values (v_site.id, v_user, 'admin', v_device, true, v_now)
  on conflict on constraint site_members_site_id_user_id_key
  do update set
    role = 'admin',
    device_name = excluded.device_name,
    active = true,
    last_seen_at = v_now;

  update public.sites set updated_at = v_now where id = v_site.id
  returning * into v_site;

  insert into public.audit_logs(
    site_id, actor_user_id, action, entity_type, entity_id, details
  )
  values (
    v_site.id, v_user, 'site.admin_claim', 'site_member', v_user,
    pg_catalog.jsonb_build_object('device_name_changed', true)
  );
  insert into private.site_admin_access_audit(site_id, actor_user_id, succeeded)
  values (v_site.id, v_user, true);

  return query select
    v_site.id, v_site.site_code, v_site.name, 'admin'::public.site_role,
    v_site.status, v_site.revision, true, null::text;
end;
$$;

create function public.set_initial_site_admin_code(
  p_site_id uuid,
  p_expected_revision bigint,
  p_new_code text
)
returns table(site_revision bigint, admin_code_configured boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  if not private.site_admin_code_is_valid(p_new_code) then raise exception 'admin_code_invalid'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if exists (select 1 from private.site_admin_codes where site_id = p_site_id) then
    raise exception 'admin_code_already_set';
  end if;

  insert into private.site_admin_codes(site_id, code_hash, changed_by)
  values (
    p_site_id,
    extensions.crypt(p_new_code, extensions.gen_salt('bf', 10)),
    (select auth.uid())
  );
  update public.sites set updated_at = now() where id = p_site_id returning * into v_site;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (p_site_id, (select auth.uid()), 'admin_code.initial_set', 'site', p_site_id);
  return query select v_site.revision, true;
end;
$$;

create function public.rotate_site_admin_code(
  p_site_id uuid,
  p_expected_revision bigint,
  p_new_code text
)
returns table(site_revision bigint, admin_code_configured boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  if not private.site_admin_code_is_valid(p_new_code) then raise exception 'admin_code_invalid'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;

  update private.site_admin_codes
  set code_hash = extensions.crypt(p_new_code, extensions.gen_salt('bf', 10)),
      version = version + 1,
      changed_by = (select auth.uid()),
      changed_at = now()
  where site_id = p_site_id;
  if not found then raise exception 'admin_code_not_set'; end if;

  update public.sites set updated_at = now() where id = p_site_id returning * into v_site;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (p_site_id, (select auth.uid()), 'admin_code.rotate', 'site', p_site_id);
  return query select v_site.revision, true;
end;
$$;

create function public.list_site_members_admin(p_site_id uuid)
returns table(
  member_id uuid,
  device_name text,
  member_role public.site_role,
  last_seen_at timestamptz,
  active boolean,
  is_current_device boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.id, m.device_name, m.role, m.last_seen_at, m.active,
    m.user_id = (select auth.uid())
  from public.site_members m
  where m.site_id = p_site_id
    and private.has_site_role(p_site_id, 'admin')
  order by m.active desc, m.role, m.last_seen_at desc, m.id;
$$;

create function public.set_site_member_active_v2(
  p_site_id uuid,
  p_member_id uuid,
  p_active boolean,
  p_expected_revision bigint
)
returns table(site_revision bigint, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
  v_member public.site_members%rowtype;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  select * into v_member
  from public.site_members
  where id = p_member_id and site_id = p_site_id
  for update;
  if not found then raise exception 'member_not_found'; end if;

  if not p_active
     and v_member.role = 'admin'
     and v_member.active
     and (
       select count(*) from public.site_members
       where site_id = p_site_id and role = 'admin' and active
     ) <= 1 then
    raise exception 'cannot_disable_last_admin';
  end if;

  if v_member.active = p_active then
    return query select v_site.revision, false;
    return;
  end if;

  update public.site_members
  set active = p_active
  where id = p_member_id and site_id = p_site_id;
  update public.sites set updated_at = now() where id = p_site_id returning * into v_site;

  insert into public.audit_logs(
    site_id, actor_user_id, action, entity_type, entity_id, details
  )
  values (
    p_site_id, (select auth.uid()), 'member.active', 'site_member', p_member_id,
    pg_catalog.jsonb_build_object(
      'active', p_active,
      'self', v_member.user_id = (select auth.uid())
    )
  );
  return query select v_site.revision, true;
end;
$$;

-- The first anonymous creator is no longer a permanent recovery dependency.
-- All other deletion safeguards remain, and only other *active* memberships
-- prevent deletion. Inactive membership rows cascade only after the full
-- emptiness check succeeds.
create or replace function public.delete_empty_site(
  p_site_id uuid,
  p_expected_revision bigint,
  p_confirm_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
  v_storage_count bigint;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_site.status <> 'trashed' then raise exception 'trash_required'; end if;
  if trim(coalesce(p_confirm_name, '')) <> v_site.name then
    raise exception 'confirmation_mismatch';
  end if;

  select count(*) into v_storage_count
  from storage.objects o
  where o.bucket_id = 'site-photos'
    and (storage.foldername(o.name))[1] = p_site_id::text;

  if exists (select 1 from public.photos where site_id = p_site_id)
     or exists (select 1 from public.photo_objects where site_id = p_site_id)
     or exists (select 1 from public.ledgers where site_id = p_site_id)
     or exists (select 1 from public.ledger_pages where site_id = p_site_id)
     or exists (select 1 from public.ledger_slots where site_id = p_site_id)
     or exists (select 1 from public.projects where site_id = p_site_id)
     or exists (select 1 from public.sync_events where site_id = p_site_id)
     or exists (
       select 1 from public.site_members
       where site_id = p_site_id
         and active
         and user_id <> (select auth.uid())
     )
     or v_storage_count <> 0 then
    raise exception 'site_not_empty';
  end if;

  insert into private.deleted_site_audit(
    site_id, actor_user_id, site_code, site_name
  )
  values (
    p_site_id, (select auth.uid()), v_site.site_code, v_site.name
  );
  insert into public.audit_logs(
    site_id, actor_user_id, action, entity_type, entity_id, details
  )
  values (
    p_site_id, (select auth.uid()), 'site.delete_empty', 'site', p_site_id,
    pg_catalog.jsonb_build_object('admin_recovery_capable', true)
  );
  delete from public.sites where id = p_site_id;
  return true;
end;
$$;

revoke all on function public.create_site(text,text,text,text,text,text)
from public, anon, authenticated;
revoke all on function public.list_my_sites()
from public, anon, authenticated;
revoke all on function public.claim_site_admin(text,text,text)
from public, anon, authenticated;
revoke all on function public.set_initial_site_admin_code(uuid,bigint,text)
from public, anon, authenticated;
revoke all on function public.rotate_site_admin_code(uuid,bigint,text)
from public, anon, authenticated;
revoke all on function public.list_site_members_admin(uuid)
from public, anon, authenticated;
revoke all on function public.set_site_member_active_v2(uuid,uuid,boolean,bigint)
from public, anon, authenticated;
revoke all on function public.delete_empty_site(uuid,bigint,text)
from public, anon, authenticated;

grant execute on function public.create_site(text,text,text,text,text,text)
to authenticated;
grant execute on function public.list_my_sites()
to authenticated;
grant execute on function public.claim_site_admin(text,text,text)
to authenticated;
grant execute on function public.set_initial_site_admin_code(uuid,bigint,text)
to authenticated;
grant execute on function public.rotate_site_admin_code(uuid,bigint,text)
to authenticated;
grant execute on function public.list_site_members_admin(uuid)
to authenticated;
grant execute on function public.set_site_member_active_v2(uuid,uuid,boolean,bigint)
to authenticated;
grant execute on function public.delete_empty_site(uuid,bigint,text)
to authenticated;

commit;
