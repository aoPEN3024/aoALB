-- Destructive rollback for this migration only. Never run during normal operation.
-- Confirm no production profiles/devices depend on these objects before executing.
begin;

create or replace function private.site_role_for(p_site_id uuid)
returns public.site_role language sql stable security definer set search_path = '' as $$
  select m.role from public.site_members m
  where m.site_id = p_site_id and m.user_id = (select auth.uid()) and m.active
  limit 1;
$$;
revoke all on function private.site_role_for(uuid) from public, anon, authenticated;

drop policy if exists account_devices_select_own on public.account_devices;
drop policy if exists user_profiles_select_shared on public.user_profiles;
drop function if exists public.set_my_account_device_active(uuid,boolean);
drop function if exists public.list_my_account_devices();
drop function if exists public.touch_my_account_device(uuid,text);
drop function if exists public.ensure_my_profile(text);
drop function if exists private.current_user_is_permanent();
drop function if exists private.shares_site_with(uuid);
drop function if exists private.account_is_active(uuid);
drop table if exists private.account_security_audit;
drop table if exists public.account_devices;
drop table if exists public.user_profiles;

commit;
