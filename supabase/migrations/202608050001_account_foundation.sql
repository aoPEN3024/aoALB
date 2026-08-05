-- aoALB account foundation
-- Apply after 202607310001_photo_lifecycle.sql. Do not run this file twice.
begin;

do $preflight$
begin
  if to_regclass('public.user_profiles') is not null
     or to_regclass('public.account_devices') is not null
     or to_regclass('private.account_security_audit') is not null then
    raise exception 'aoALB account foundation already exists. Do not rerun this migration.';
  end if;
  if to_regclass('public.site_members') is null
     or to_regclass('auth.users') is null then
    raise exception 'Required aoALB sharing/auth objects were not found.';
  end if;
end
$preflight$;

create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]')
);

create table public.account_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_uid uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, device_uid),
  check (display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]')
);

create table private.account_security_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'profile_created', 'profile_updated', 'device_registered',
    'device_enabled', 'device_disabled', 'account_upgraded',
    'password_reset_requested', 'signed_in', 'signed_out'
  )),
  device_uid uuid,
  occurred_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  check (not (details ?| array['email','password','access_token','refresh_token','authorization','join_code','admin_code']))
);

create index account_devices_user_idx on public.account_devices(user_id, last_seen_at desc);
create index account_security_audit_actor_idx on private.account_security_audit(actor_user_id, occurred_at desc);

revoke all on table private.account_security_audit from public, anon, authenticated;
revoke all on sequence private.account_security_audit_id_seq from public, anon, authenticated;

create function private.account_is_active(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  -- A missing profile is an existing anonymous user. Preserve its current access
  -- until it explicitly upgrades; a stored inactive profile is always denied.
  select case
    when p_user_id is null then false
    when exists (select 1 from public.user_profiles p where p.user_id = p_user_id)
      then coalesce((select p.active from public.user_profiles p where p.user_id = p_user_id), false)
    else true
  end;
$$;

create or replace function private.site_role_for(p_site_id uuid)
returns public.site_role
language sql stable security definer set search_path = ''
as $$
  select m.role
  from public.site_members m
  where m.site_id = p_site_id
    and m.user_id = (select auth.uid())
    and m.active
    and private.account_is_active((select auth.uid()))
  limit 1;
$$;

create function private.shares_site_with(p_other_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.account_is_active((select auth.uid())) and exists (
    select 1
    from public.site_members mine
    join public.site_members theirs on theirs.site_id = mine.site_id
    where mine.user_id = (select auth.uid()) and mine.active
      and theirs.user_id = p_other_user and theirs.active
  );
$$;

create function private.current_user_is_permanent()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select (auth.jwt() ->> 'is_anonymous')::boolean), true) = false;
$$;

create function public.ensure_my_profile(p_display_name text)
returns table(user_id uuid, display_name text, active boolean, created_at timestamptz, last_seen_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(p_display_name);
  v_action text;
begin
  if v_user is null or not private.current_user_is_permanent() then
    raise exception using errcode = '42501', message = 'permanent_account_required';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_display_name';
  end if;
  v_action := case when exists (select 1 from public.user_profiles p where p.user_id = v_user)
    then 'profile_updated' else 'profile_created' end;
  insert into public.user_profiles(user_id, display_name, active, last_seen_at)
  values (v_user, v_name, true, now())
  on conflict (user_id) do update
    set display_name = excluded.display_name, updated_at = now(), last_seen_at = now()
    where public.user_profiles.active;
  if not found then
    raise exception using errcode = '42501', message = 'account_inactive';
  end if;
  insert into private.account_security_audit(actor_user_id, action) values (v_user, v_action);
  return query select p.user_id, p.display_name, p.active, p.created_at, p.last_seen_at
    from public.user_profiles p where p.user_id = v_user;
end;
$$;

create function public.touch_my_account_device(p_device_uid uuid, p_device_name text)
returns table(device_uid uuid, display_name text, active boolean, last_seen_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(p_device_name);
  v_exists boolean;
begin
  if v_user is null or not private.current_user_is_permanent() or not private.account_is_active(v_user) then
    raise exception using errcode = '42501', message = 'account_unavailable';
  end if;
  if p_device_uid is null or v_name is null or char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_device';
  end if;
  select exists(select 1 from public.account_devices d where d.user_id = v_user and d.device_uid = p_device_uid) into v_exists;
  insert into public.account_devices(user_id, device_uid, display_name, active, last_seen_at)
  values (v_user, p_device_uid, v_name, true, now())
  on conflict (user_id, device_uid) do update
    set display_name = excluded.display_name, active = true, updated_at = now(), last_seen_at = now();
  update public.user_profiles set last_seen_at = now(), updated_at = now() where user_id = v_user and active;
  insert into private.account_security_audit(actor_user_id, action, device_uid)
    values (v_user, case when v_exists then 'signed_in' else 'device_registered' end, p_device_uid);
  return query select d.device_uid, d.display_name, d.active, d.last_seen_at
    from public.account_devices d where d.user_id = v_user and d.device_uid = p_device_uid;
end;
$$;

create function public.list_my_account_devices()
returns table(device_uid uuid, display_name text, active boolean, created_at timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select d.device_uid, d.display_name, d.active, d.created_at, d.last_seen_at
  from public.account_devices d
  where d.user_id = (select auth.uid()) and private.account_is_active((select auth.uid()))
  order by d.last_seen_at desc;
$$;

create function public.set_my_account_device_active(p_device_uid uuid, p_active boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or not private.current_user_is_permanent() or not private.account_is_active(v_user) then
    raise exception using errcode = '42501', message = 'account_unavailable';
  end if;
  update public.account_devices set active = p_active, updated_at = now()
    where user_id = v_user and device_uid = p_device_uid;
  if not found then raise exception using errcode = 'P0002', message = 'device_not_found'; end if;
  insert into private.account_security_audit(actor_user_id, action, device_uid)
    values (v_user, case when p_active then 'device_enabled' else 'device_disabled' end, p_device_uid);
  return p_active;
end;
$$;

alter table public.user_profiles enable row level security;
alter table public.account_devices enable row level security;

create policy user_profiles_select_shared on public.user_profiles for select to authenticated
using (user_id = (select auth.uid()) or private.shares_site_with(user_id));
create policy account_devices_select_own on public.account_devices for select to authenticated
using (user_id = (select auth.uid()) and private.account_is_active((select auth.uid())));

revoke all on table public.user_profiles, public.account_devices from public, anon, authenticated;
grant select on table public.user_profiles, public.account_devices to authenticated;

revoke all on function private.account_is_active(uuid) from public, anon, authenticated;
revoke all on function private.shares_site_with(uuid) from public, anon, authenticated;
revoke all on function private.current_user_is_permanent() from public, anon, authenticated;
revoke all on function private.site_role_for(uuid) from public, anon, authenticated;
revoke all on function public.ensure_my_profile(text) from public, anon, authenticated;
revoke all on function public.touch_my_account_device(uuid,text) from public, anon, authenticated;
revoke all on function public.list_my_account_devices() from public, anon, authenticated;
revoke all on function public.set_my_account_device_active(uuid,boolean) from public, anon, authenticated;
grant execute on function public.ensure_my_profile(text) to authenticated;
grant execute on function public.touch_my_account_device(uuid,text) to authenticated;
grant execute on function public.list_my_account_devices() to authenticated;
grant execute on function public.set_my_account_device_active(uuid,boolean) to authenticated;

commit;
