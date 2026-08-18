-- One-time bootstrap. Run only after 202608180001_system_account_foundation.sql.
-- Replace both values below in SQL Editor. Never commit or share the real values.
begin;

do $bootstrap$
declare
  v_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- CHANGE_ME_AUTH_UUID
  v_email text := 'CHANGE_ME@example.invalid';               -- CHANGE_ME_EMAIL
  v_actual_email text;
begin
  if v_user_id = '00000000-0000-0000-0000-000000000000'::uuid
     or v_email = 'CHANGE_ME@example.invalid' then
    raise exception 'Replace CHANGE_ME values before running.';
  end if;

  select lower(u.email) into v_actual_email
  from auth.users u
  where u.id = v_user_id
    and not coalesce(u.is_anonymous, false)
    and u.email_confirmed_at is not null;

  if v_actual_email is null or v_actual_email <> lower(v_email) then
    raise exception 'Auth UUID/email confirmation did not match. Nothing changed.';
  end if;
  if not exists (
    select 1 from public.user_profiles p
    where p.user_id = v_user_id and p.status = 'active' and p.active
  ) then
    raise exception 'Target account is not an active aoALB account. Nothing changed.';
  end if;
  if exists (select 1 from public.system_admins) then
    raise exception 'A system administrator already exists. Bootstrap was not applied.';
  end if;

  insert into public.system_admins(user_id, active, granted_by)
  values (v_user_id, true, v_user_id);
  insert into public.account_management_audit(
    actor_user_id, target_user_id, action, succeeded, details
  ) values (
    v_user_id, v_user_id, 'system_admin.grant', true,
    pg_catalog.jsonb_build_object('method', 'one_time_bootstrap')
  );
end
$bootstrap$;

commit;
