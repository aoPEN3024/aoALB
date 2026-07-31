-- Forward fix for projects where 202607190001_site_sharing.sql was already applied.
-- Replaces only join_site; no table or user data is changed.

begin;

do $preflight$
begin
  if pg_catalog.to_regprocedure('public.join_site(text,text,text)') is null then
    raise exception 'public.join_site(text,text,text) was not found. Apply 202607190001_site_sharing.sql first.';
  end if;
end
$preflight$;

create or replace function public.join_site(p_site_code text, p_join_code text, p_device_name text)
returns table(site_id uuid, site_code text, site_name text, member_role public.site_role, error_code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_site public.sites%rowtype;
  v_code public.site_join_codes%rowtype;
  v_attempt public.site_join_attempts%rowtype;
  v_existing public.site_members%rowtype;
  v_now timestamptz := now();
  v_blocked_until timestamptz;
  v_valid boolean := false;
begin
  if v_user is null then
    return query select null::uuid, null::text, null::text, null::public.site_role, 'auth_required'::text;
    return;
  end if;

  select a.* into v_attempt from public.site_join_attempts a where a.user_id = v_user for update;
  if found and v_attempt.blocked_until > v_now then
    return query select null::uuid, null::text, null::text, null::public.site_role, 'temporarily_blocked'::text;
    return;
  end if;

  select s.* into v_site from public.sites s where s.site_code = upper(trim(coalesce(p_site_code, '')));
  if found then
    select c.* into v_code from public.site_join_codes c where c.site_id = v_site.id for update;
    if found
       and char_length(coalesce(p_join_code, '')) between 8 and 64
       and octet_length(coalesce(p_join_code, '')) <= 72
       and p_join_code !~ '[[:space:][:cntrl:]]' then
      v_valid := v_code.code_hash = extensions.crypt(p_join_code, v_code.code_hash);
    end if;
  end if;

  if v_valid is not true then
    insert into public.site_join_attempts(user_id, failed_count, window_started_at, blocked_until, last_site_code)
    values (v_user, 1, v_now, null, left(upper(trim(coalesce(p_site_code, ''))), 40))
    on conflict (user_id) do update set
      failed_count = case
        when public.site_join_attempts.window_started_at < v_now - interval '15 minutes' then 1
        else public.site_join_attempts.failed_count + 1
      end,
      window_started_at = case
        when public.site_join_attempts.window_started_at < v_now - interval '15 minutes' then v_now
        else public.site_join_attempts.window_started_at
      end,
      blocked_until = case
        when public.site_join_attempts.window_started_at < v_now - interval '15 minutes' then null
        when public.site_join_attempts.failed_count + 1 >= 5 then v_now + interval '15 minutes'
        else null
      end,
      last_site_code = excluded.last_site_code
    returning public.site_join_attempts.blocked_until into v_blocked_until;
    return query select null::uuid, null::text, null::text, null::public.site_role,
      case when v_blocked_until > v_now then 'temporarily_blocked' else 'invalid_join' end;
    return;
  end if;

  select m.* into v_existing from public.site_members m where m.site_id = v_site.id and m.user_id = v_user for update;
  if found and not v_existing.active then
    return query select null::uuid, null::text, null::text, null::public.site_role, 'membership_disabled'::text;
    return;
  end if;

  delete from public.site_join_attempts where user_id = v_user;
  insert into public.site_members(site_id, user_id, role, device_name, active, last_seen_at)
  values (v_site.id, v_user, v_code.grant_role, left(coalesce(nullif(trim(p_device_name), ''), '名称未設定端末'), 80), true, v_now)
  on conflict on constraint site_members_site_id_user_id_key
  do update set device_name = excluded.device_name, last_seen_at = v_now;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (v_site.id, v_user, 'site.join', 'site_member', v_user);
  return query select v_site.id, v_site.site_code, v_site.name,
    (select m.role from public.site_members m where m.site_id = v_site.id and m.user_id = v_user), null::text;
end;
$$;

revoke all on function public.join_site(text, text, text) from public, anon, authenticated;
grant execute on function public.join_site(text, text, text) to authenticated;

commit;
