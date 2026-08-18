-- Destructive schema rollback for a non-production validation environment only.
-- Refuses to run after invitations, suspensions, deletions or admin bootstrap.
begin;

do $preflight$
begin
  if pg_catalog.to_regtype('public.account_status') is null then
    raise exception 'System account foundation is not installed.';
  end if;
  if exists (select 1 from public.system_admins)
     or exists (select 1 from public.account_management_audit)
     or exists (select 1 from public.user_profiles where status <> 'active') then
    raise exception 'Rollback refused: operational account/admin state exists.';
  end if;
end
$preflight$;

do $drop_guards$
declare v_table text;
begin
  foreach v_table in array array[
    'sites','site_join_codes','site_members','projects','photos','photo_objects',
    'ledgers','ledger_pages','ledger_slots','sync_events','audit_logs',
    'photo_classification_overrides','ledger_photo_captions'
  ] loop
    if pg_catalog.to_regclass('public.' || v_table) is not null then
      execute pg_catalog.format('drop trigger if exists account_state_write_guard on public.%I', v_table);
    end if;
  end loop;
end
$drop_guards$;

drop function if exists public.activate_my_invited_account(text);
drop function if exists public.get_my_account_context();
drop function if exists public.create_site_for_account(text,text,text,text,text);
drop function if exists private.is_system_admin(uuid);
drop function if exists private.enforce_active_account_write();

create or replace function private.account_is_active(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select case
  when p_user_id is null then false
  when exists (select 1 from public.user_profiles p where p.user_id = p_user_id)
    then coalesce((select p.active from public.user_profiles p where p.user_id = p_user_id), false)
  else true end $$;
revoke all on function private.account_is_active(uuid) from public, anon, authenticated;

drop table public.account_management_rate_limits;
drop table public.account_management_audit;
drop table public.system_admins;

alter table public.user_profiles
  drop constraint user_profiles_status_dates_check,
  drop column status_changed_by,
  drop column status_changed_at,
  drop column deleted_at,
  drop column suspended_at,
  drop column activated_at,
  drop column invited_at,
  drop column status;
drop type public.account_status;

commit;
