-- Fix PL/pgSQL output-column ambiguity in account setup RPCs.
-- Apply once after 202608050001_account_foundation.sql.
begin;

do $preflight$
begin
  if to_regclass('public.user_profiles') is null
     or to_regclass('public.account_devices') is null
     or to_regprocedure('public.ensure_my_profile(text)') is null
     or to_regprocedure('public.touch_my_account_device(uuid,text)') is null then
    raise exception 'Account foundation objects were not found. Apply 202608050001 first.';
  end if;
end
$preflight$;

create or replace function public.ensure_my_profile(p_display_name text)
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
  on conflict on constraint user_profiles_pkey do update
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

create or replace function public.touch_my_account_device(p_device_uid uuid, p_device_name text)
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
  select exists(
    select 1 from public.account_devices d
    where d.user_id = v_user and d.device_uid = p_device_uid
  ) into v_exists;
  insert into public.account_devices(user_id, device_uid, display_name, active, last_seen_at)
  values (v_user, p_device_uid, v_name, true, now())
  on conflict on constraint account_devices_user_id_device_uid_key do update
    set display_name = excluded.display_name, active = true, updated_at = now(), last_seen_at = now();
  update public.user_profiles
    set last_seen_at = now(), updated_at = now()
    where public.user_profiles.user_id = v_user and public.user_profiles.active;
  insert into private.account_security_audit(actor_user_id, action, device_uid)
    values (v_user, case when v_exists then 'signed_in' else 'device_registered' end, p_device_uid);
  return query select d.device_uid, d.display_name, d.active, d.last_seen_at
    from public.account_devices d where d.user_id = v_user and d.device_uid = p_device_uid;
end;
$$;

revoke all on function public.ensure_my_profile(text) from public, anon, authenticated;
revoke all on function public.touch_my_account_device(uuid,text) from public, anon, authenticated;
grant execute on function public.ensure_my_profile(text) to authenticated;
grant execute on function public.touch_my_account_device(uuid,text) to authenticated;

commit;
