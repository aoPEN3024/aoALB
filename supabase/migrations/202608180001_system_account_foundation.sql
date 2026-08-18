-- aoALB system-account foundation (one-shot migration)
-- Apply after 202608050003_ledger_sync.sql. Do not run this file twice.
begin;

do $preflight$
begin
  if pg_catalog.to_regtype('public.account_status') is not null
     or pg_catalog.to_regclass('public.system_admins') is not null
     or pg_catalog.to_regclass('public.account_management_audit') is not null then
    raise exception 'aoALB system account foundation already exists. Do not rerun this migration.';
  end if;
  if pg_catalog.to_regclass('public.user_profiles') is null
     or pg_catalog.to_regclass('public.account_devices') is null
     or pg_catalog.to_regclass('public.site_members') is null
     or pg_catalog.to_regclass('auth.users') is null then
    raise exception 'Required aoALB account/sharing objects were not found.';
  end if;
end
$preflight$;

create type public.account_status as enum ('invited', 'active', 'suspended', 'deleted');

alter table public.user_profiles
  add column status public.account_status not null default 'active',
  add column invited_at timestamptz,
  add column activated_at timestamptz,
  add column suspended_at timestamptz,
  add column deleted_at timestamptz,
  add column status_changed_at timestamptz not null default now(),
  add column status_changed_by uuid references auth.users(id) on delete set null;

update public.user_profiles
set status = case when active then 'active'::public.account_status else 'suspended'::public.account_status end,
    activated_at = case when active then coalesce(created_at, now()) else null end,
    suspended_at = case when active then null else now() end,
    status_changed_at = now();

alter table public.user_profiles
  add constraint user_profiles_status_dates_check check (
    (status = 'invited' and not active and invited_at is not null and activated_at is null and suspended_at is null and deleted_at is null)
    or (status = 'active' and active and activated_at is not null and suspended_at is null and deleted_at is null)
    or (status = 'suspended' and not active and suspended_at is not null and deleted_at is null)
    or (status = 'deleted' and not active and deleted_at is not null)
  );

create table public.system_admins (
  user_id uuid primary key references auth.users(id) on delete restrict,
  active boolean not null default true,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  check ((active and revoked_at is null) or (not active and revoked_at is not null))
);

create table public.account_management_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  target_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'account.invite', 'account.invite_resend', 'account.activate',
    'account.suspend', 'account.resume', 'account.password_reset',
    'account.delete_equivalent', 'system_admin.grant', 'system_admin.revoke'
  )),
  succeeded boolean not null,
  reason_code text,
  occurred_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  check (not (details ?| array[
    'email','password','access_token','refresh_token','authorization',
    'service_role','secret_key','join_code','admin_code','site_creation_code'
  ]))
);

create table public.account_management_rate_limits (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  blocked_until timestamptz,
  primary key (actor_user_id, action)
);

create index user_profiles_status_idx on public.user_profiles(status, last_seen_at desc);
create index account_management_audit_time_idx on public.account_management_audit(occurred_at desc);
create index account_management_audit_target_idx on public.account_management_audit(target_user_id, occurred_at desc);

alter table public.system_admins enable row level security;
alter table public.account_management_audit enable row level security;
alter table public.account_management_rate_limits enable row level security;

revoke all on table public.system_admins, public.account_management_audit,
  public.account_management_rate_limits from public, anon, authenticated;
revoke all on sequence public.account_management_audit_id_seq from public, anon, authenticated;

create or replace function private.account_is_active(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_user_id is not null
    and exists (
      select 1
      from auth.users u
      join public.user_profiles p on p.user_id = u.id
      where u.id = p_user_id
        and not coalesce(u.is_anonymous, false)
        and p.status = 'active'::public.account_status
        and p.active
        and p.deleted_at is null
    );
$$;

create function private.is_system_admin(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.account_is_active(p_user_id)
    and exists (
      select 1 from public.system_admins a
      where a.user_id = p_user_id and a.active and a.revoked_at is null
    );
$$;

create function public.get_my_account_context()
returns table(
  user_id uuid,
  display_name text,
  account_status public.account_status,
  system_admin boolean,
  last_seen_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select p.user_id, p.display_name, p.status,
    private.is_system_admin(p.user_id), p.last_seen_at
  from public.user_profiles p
  where p.user_id = (select auth.uid());
$$;

create function public.consume_account_admin_rate_limit(
  p_actor_user_id uuid,
  p_action text,
  p_limit integer default 20,
  p_window_seconds integer default 900
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.account_management_rate_limits%rowtype;
  v_now timestamptz := now();
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_actor_user_id is null
     or p_action is null
     or p_limit not between 1 and 100
     or p_window_seconds not between 60 and 86400 then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_user_id::text || ':' || p_action, 180019));
  select * into v_row from public.account_management_rate_limits
  where actor_user_id = p_actor_user_id and action = p_action;
  if not found or v_row.window_started_at + pg_catalog.make_interval(secs => p_window_seconds) <= v_now then
    insert into public.account_management_rate_limits(actor_user_id, action, window_started_at, attempt_count, blocked_until)
    values (p_actor_user_id, p_action, v_now, 1, null)
    on conflict (actor_user_id, action) do update
      set window_started_at = excluded.window_started_at, attempt_count = 1, blocked_until = null;
    return query select true, 0;
    return;
  end if;
  if v_row.attempt_count >= p_limit then
    update public.account_management_rate_limits
    set blocked_until = v_row.window_started_at + pg_catalog.make_interval(secs => p_window_seconds)
    where actor_user_id = p_actor_user_id and action = p_action;
    return query select false, greatest(1, extract(epoch from (v_row.window_started_at
      + pg_catalog.make_interval(secs => p_window_seconds) - v_now))::integer);
    return;
  end if;
  update public.account_management_rate_limits set attempt_count = attempt_count + 1
  where actor_user_id = p_actor_user_id and action = p_action;
  return query select true, 0;
end;
$$;

create function public.admin_set_account_status(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_new_status public.account_status,
  p_reason_code text default null
)
returns public.account_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_current public.account_status;
  v_is_target_admin boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or not private.is_system_admin(p_actor_user_id)
     or p_target_user_id is null
     or p_new_status not in ('active'::public.account_status, 'suspended'::public.account_status, 'deleted'::public.account_status) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  select p.status into v_current from public.user_profiles p
  where p.user_id = p_target_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'account_not_found'; end if;
  if v_current = 'deleted' and p_new_status <> 'deleted' then
    raise exception using errcode = '42501', message = 'deleted_account_cannot_resume';
  end if;
  if p_target_user_id = p_actor_user_id and p_new_status <> 'active' then
    raise exception using errcode = '42501', message = 'self_change_not_allowed';
  end if;

  select exists(select 1 from public.system_admins a where a.user_id = p_target_user_id and a.active)
  into v_is_target_admin;
  if p_new_status = 'deleted' and v_is_target_admin then
    raise exception using errcode = '42501', message = 'system_admin_delete_not_allowed';
  end if;
  if p_new_status = 'suspended' and v_is_target_admin and (
    select count(*) from public.system_admins a
    join public.user_profiles p on p.user_id = a.user_id
    where a.active and p.status = 'active' and p.active
  ) <= 1 then
    raise exception using errcode = '42501', message = 'last_system_admin';
  end if;

  if p_new_status = 'deleted' then
    if exists (
      select 1 from public.site_members mine
      where mine.user_id = p_target_user_id and mine.active and mine.role = 'admin'
        and not exists (
          select 1 from public.site_members other
          where other.site_id = mine.site_id and other.user_id <> mine.user_id
            and other.active and other.role = 'admin'
            and private.account_is_active(other.user_id)
        )
    ) then
      raise exception using errcode = '42501', message = 'sole_site_admin';
    end if;
    if exists (select 1 from storage.objects o where o.owner_id = p_target_user_id::text) then
      raise exception using errcode = '42501', message = 'storage_owner_exists';
    end if;
  end if;

  update public.user_profiles p
  set status = p_new_status,
      active = p_new_status = 'active',
      suspended_at = case when p_new_status = 'suspended' then now() else null end,
      deleted_at = case when p_new_status = 'deleted' then now() else null end,
      status_changed_at = now(), status_changed_by = p_actor_user_id,
      updated_at = now()
  where p.user_id = p_target_user_id;
  if p_new_status = 'deleted' then
    update public.account_devices set active = false, updated_at = now() where user_id = p_target_user_id;
    update public.site_members set active = false, last_seen_at = now() where user_id = p_target_user_id;
  end if;
  insert into public.account_management_audit(actor_user_id, target_user_id, action, succeeded, reason_code)
  values (p_actor_user_id, p_target_user_id,
    case p_new_status when 'active' then 'account.resume'
      when 'suspended' then 'account.suspend' else 'account.delete_equivalent' end,
    true, nullif(p_reason_code, ''));
  return p_new_status;
end;
$$;

create function public.activate_my_invited_account(p_display_name text)
returns table(user_id uuid, display_name text, account_status public.account_status)
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := pg_catalog.btrim(p_display_name);
begin
  if v_user is null
     or coalesce((select (auth.jwt() ->> 'is_anonymous')::boolean), true)
     or not exists (
       select 1 from auth.users u
       where u.id = v_user and u.email_confirmed_at is not null
     ) then
    raise exception using errcode = '42501', message = 'invited_account_required';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_display_name';
  end if;

  update public.user_profiles p
  set display_name = v_name,
      status = 'active', active = true,
      activated_at = coalesce(p.activated_at, now()),
      suspended_at = null, deleted_at = null,
      status_changed_at = now(), status_changed_by = v_user,
      last_seen_at = now(), updated_at = now()
  where p.user_id = v_user and p.status = 'invited';

  if not found then
    raise exception using errcode = '42501', message = 'invitation_unavailable';
  end if;

  insert into public.account_management_audit(actor_user_id, target_user_id, action, succeeded)
  values (v_user, v_user, 'account.activate', true);

  return query select p.user_id, p.display_name, p.status
  from public.user_profiles p where p.user_id = v_user;
end;
$$;

-- Existing clients may still call this RPC. It may update an existing active
-- profile, but it can no longer create a freely self-registered profile.
create or replace function public.ensure_my_profile(p_display_name text)
returns table(user_id uuid, display_name text, active boolean, created_at timestamptz, last_seen_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := pg_catalog.btrim(p_display_name);
begin
  if v_user is null or not private.account_is_active(v_user) then
    raise exception using errcode = '42501', message = 'invited_account_required';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_display_name';
  end if;
  update public.user_profiles p
  set display_name = v_name, last_seen_at = now(), updated_at = now()
  where p.user_id = v_user and p.status = 'active' and p.active;
  return query select p.user_id, p.display_name, p.active, p.created_at, p.last_seen_at
  from public.user_profiles p where p.user_id = v_user;
end;
$$;

create function private.enforce_active_account_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return null;
  end if;
  if not private.account_is_active((select auth.uid())) then
    raise exception using errcode = '42501', message = 'account_unavailable';
  end if;
  return null;
end;
$$;

-- Invited, active accounts do not need the legacy company-wide site-creation
-- code. The site PASS and administrator PASS remain separate and hashed.
create function public.create_site_for_account(
  p_site_name text,
  p_site_code text,
  p_site_join_code text,
  p_site_admin_code text,
  p_device_name text
)
returns table(
  site_id uuid,
  site_code text,
  site_name text,
  member_role public.site_role,
  admin_code_configured boolean,
  error_code text
)
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_site_id uuid := pg_catalog.gen_random_uuid();
  v_site_code text := upper(pg_catalog.btrim(coalesce(p_site_code, '')));
  v_site_name text := pg_catalog.btrim(coalesce(p_site_name, ''));
  v_device_name text := pg_catalog.btrim(coalesce(p_device_name, ''));
  v_success_count integer;
begin
  if not private.account_is_active(v_user) then
    return query select null::uuid, null::text, null::text, null::public.site_role, false, 'account_unavailable'::text;
    return;
  end if;
  if char_length(v_site_name) not between 1 and 160
     or v_site_name ~ '[[:cntrl:]]'
     or v_site_code !~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'
     or char_length(coalesce(p_site_join_code, '')) not between 8 and 64
     or octet_length(coalesce(p_site_join_code, '')) > 72
     or coalesce(p_site_join_code, '') ~ '[[:space:][:cntrl:]]'
     or not private.site_admin_code_is_valid(p_site_admin_code)
     or char_length(v_device_name) not between 1 and 80
     or v_device_name ~ '[[:cntrl:]]' then
    return query select null::uuid, null::text, null::text, null::public.site_role, false, 'invalid_input'::text;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 180018));
  select count(*)::integer into v_success_count
  from private.site_creation_attempts a
  where a.user_id = v_user and a.succeeded and a.attempted_at >= now() - interval '1 hour';
  if v_success_count >= 3 then
    return query select null::uuid, null::text, null::text, null::public.site_role, false, 'temporarily_blocked'::text;
    return;
  end if;
  if exists (select 1 from public.sites s where s.site_code = v_site_code) then
    return query select null::uuid, null::text, null::text, null::public.site_role, false, 'site_code_exists'::text;
    return;
  end if;

  begin
    insert into public.sites(id, site_code, name, created_by)
    values (v_site_id, v_site_code, v_site_name, v_user);
    insert into public.site_join_codes(site_id, code_hash, grant_role, changed_by)
    values (v_site_id, extensions.crypt(p_site_join_code, extensions.gen_salt('bf', 10)), 'editor', v_user);
    insert into private.site_admin_codes(site_id, code_hash, changed_by)
    values (v_site_id, extensions.crypt(p_site_admin_code, extensions.gen_salt('bf', 10)), v_user);
    insert into public.site_members(site_id, user_id, role, device_name)
    values (v_site_id, v_user, 'admin', v_device_name);
    insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
    values (v_site_id, v_user, 'site.create', 'site', v_site_id,
      pg_catalog.jsonb_build_object('method', 'active_account'));
    insert into private.site_creation_attempts(user_id, attempted_at, succeeded, outcome)
    values (v_user, now(), true, 'created');
  exception when unique_violation then
    return query select null::uuid, null::text, null::text, null::public.site_role, false, 'site_code_exists'::text;
    return;
  end;

  return query select v_site_id, v_site_code, v_site_name, 'admin'::public.site_role, true, null::text;
end;
$$;

do $write_guards$
declare
  v_table text;
begin
  foreach v_table in array array[
    'sites','site_join_codes','site_members','projects','photos','photo_objects',
    'ledgers','ledger_pages','ledger_slots','sync_events','audit_logs',
    'photo_classification_overrides','ledger_photo_captions'
  ] loop
    if pg_catalog.to_regclass('public.' || v_table) is not null then
      execute pg_catalog.format(
        'create trigger account_state_write_guard before insert or update or delete on public.%I for each statement execute function private.enforce_active_account_write()',
        v_table
      );
    end if;
  end loop;
end
$write_guards$;

revoke all on function private.account_is_active(uuid) from public, anon, authenticated;
revoke all on function private.is_system_admin(uuid) from public, anon, authenticated;
revoke all on function private.enforce_active_account_write() from public, anon, authenticated;
revoke all on function public.create_site_for_account(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.consume_account_admin_rate_limit(uuid,text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_account_status(uuid,uuid,public.account_status,text) from public, anon, authenticated, service_role;
revoke all on function public.get_my_account_context() from public, anon, authenticated;
revoke all on function public.activate_my_invited_account(text) from public, anon, authenticated;
revoke all on function public.ensure_my_profile(text) from public, anon, authenticated;
grant execute on function public.get_my_account_context() to authenticated;
grant execute on function public.activate_my_invited_account(text) to authenticated;
grant execute on function public.ensure_my_profile(text) to authenticated;
grant execute on function public.create_site_for_account(text,text,text,text,text) to authenticated;
grant execute on function public.consume_account_admin_rate_limit(uuid,text,integer,integer) to service_role;
grant execute on function public.admin_set_account_status(uuid,uuid,public.account_status,text) to service_role;

comment on table public.system_admins is
  'aoALB account administrators. This role never grants site membership.';
comment on column public.user_profiles.status is
  'Invitation/account lifecycle. deleted is a history-preserving deletion equivalent.';

commit;
