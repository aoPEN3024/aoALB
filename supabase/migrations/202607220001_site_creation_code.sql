-- aoALB / aoPIC site creation code foundation
-- Apply once after 202607190001_site_sharing.sql and 202607190004_fix_join_site_ambiguity.sql.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.sites') is null
     or pg_catalog.to_regclass('public.site_join_codes') is null
     or pg_catalog.to_regclass('public.site_members') is null
     or pg_catalog.to_regclass('public.audit_logs') is null
     or pg_catalog.to_regprocedure('extensions.crypt(text,text)') is null then
    raise exception 'Apply the aoALB site sharing foundation before this migration.';
  end if;
  if pg_catalog.to_regclass('private.site_creation_codes') is not null
     or pg_catalog.to_regclass('private.site_creation_attempts') is not null
     or pg_catalog.to_regprocedure('public.create_site(text,text,text,text,text)') is not null then
    raise exception 'Site creation code objects already exist. Do not rerun this migration.';
  end if;
end
$preflight$;

create table private.site_creation_codes (
  singleton boolean primary key default true check (singleton),
  code_hash text not null,
  version integer not null default 1 check (version > 0),
  changed_at timestamptz not null default now()
);

create table private.site_creation_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null,
  outcome text not null check (outcome in (
    'invalid_creation_code', 'site_code_exists', 'created'
  ))
);

create index site_creation_attempts_user_time_idx
  on private.site_creation_attempts(user_id, attempted_at desc);

alter table private.site_creation_codes enable row level security;
alter table private.site_creation_attempts enable row level security;

revoke all on table private.site_creation_codes, private.site_creation_attempts
  from public, anon, authenticated;
revoke all on sequence private.site_creation_attempts_id_seq
  from public, anon, authenticated;

create function public.create_site(
  p_site_name text,
  p_site_code text,
  p_site_join_code text,
  p_device_name text,
  p_site_creation_code text
)
returns table(
  site_id uuid,
  site_code text,
  site_name text,
  member_role public.site_role,
  error_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := now();
  v_site_id uuid := pg_catalog.gen_random_uuid();
  v_site_code text := upper(trim(coalesce(p_site_code, '')));
  v_site_name text := trim(coalesce(p_site_name, ''));
  v_device_name text := trim(coalesce(p_device_name, ''));
  v_creation_hash text;
  v_failed_count integer := 0;
  v_success_count integer := 0;
begin
  if v_user is null then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'auth_required'::text;
    return;
  end if;

  -- Serialize attempts per anonymous Auth user so concurrent calls cannot bypass
  -- either the failure window or the successful-creation limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user::text, 94731)
  );

  if char_length(v_site_name) not between 1 and 160
     or v_site_name ~ '[[:cntrl:]]'
     or v_site_code !~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'
     or char_length(coalesce(p_site_join_code, '')) not between 8 and 64
     or octet_length(coalesce(p_site_join_code, '')) > 72
     or coalesce(p_site_join_code, '') ~ '[[:space:][:cntrl:]]'
     or char_length(v_device_name) not between 1 and 80
     or v_device_name ~ '[[:cntrl:]]'
     or char_length(coalesce(p_site_creation_code, '')) not between 16 and 64
     or octet_length(coalesce(p_site_creation_code, '')) > 72
     or coalesce(p_site_creation_code, '') ~ '[[:space:][:cntrl:]]' then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'invalid_input'::text;
    return;
  end if;

  select count(*)::integer into v_failed_count
  from private.site_creation_attempts a
  where a.user_id = v_user
    and not a.succeeded
    and a.outcome = 'invalid_creation_code'
    and a.attempted_at >= v_now - interval '15 minutes';

  if v_failed_count >= 5 then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'temporarily_blocked'::text;
    return;
  end if;

  select c.code_hash into v_creation_hash
  from private.site_creation_codes c
  where c.singleton;

  if v_creation_hash is null then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'creation_unavailable'::text;
    return;
  end if;

  if v_creation_hash <> extensions.crypt(p_site_creation_code, v_creation_hash) then
    insert into private.site_creation_attempts(user_id, attempted_at, succeeded, outcome)
    values (v_user, v_now, false, 'invalid_creation_code');
    v_failed_count := v_failed_count + 1;
    return query select null::uuid, null::text, null::text,
      null::public.site_role,
      case when v_failed_count >= 5 then 'temporarily_blocked' else 'invalid_creation' end;
    return;
  end if;

  select count(*)::integer into v_success_count
  from private.site_creation_attempts a
  where a.user_id = v_user
    and a.succeeded
    and a.outcome = 'created'
    and a.attempted_at >= v_now - interval '1 hour';

  if v_success_count >= 3 then
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'temporarily_blocked'::text;
    return;
  end if;

  if exists (select 1 from public.sites s where s.site_code = v_site_code) then
    insert into private.site_creation_attempts(user_id, attempted_at, succeeded, outcome)
    values (v_user, v_now, false, 'site_code_exists');
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'site_code_exists'::text;
    return;
  end if;

  begin
    insert into public.sites(id, site_code, name, created_by)
    values (v_site_id, v_site_code, v_site_name, v_user);

    insert into public.site_join_codes(site_id, code_hash, grant_role, changed_by)
    values (
      v_site_id,
      extensions.crypt(p_site_join_code, extensions.gen_salt('bf', 10)),
      'editor',
      v_user
    );

    insert into public.site_members(site_id, user_id, role, device_name)
    values (v_site_id, v_user, 'admin', v_device_name);

    insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
    values (
      v_site_id,
      v_user,
      'site.create',
      'site',
      v_site_id,
      pg_catalog.jsonb_build_object('method', 'site_creation_code')
    );
  exception when unique_violation then
    insert into private.site_creation_attempts(user_id, attempted_at, succeeded, outcome)
    values (v_user, v_now, false, 'site_code_exists');
    return query select null::uuid, null::text, null::text,
      null::public.site_role, 'site_code_exists'::text;
    return;
  end;

  insert into private.site_creation_attempts(user_id, attempted_at, succeeded, outcome)
  values (v_user, v_now, true, 'created');

  return query select v_site_id, v_site_code, v_site_name,
    'admin'::public.site_role, null::text;
end;
$$;

revoke all on function public.create_site(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_site(text, text, text, text, text)
  to authenticated;

commit;
