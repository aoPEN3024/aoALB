-- Shared project lifecycle for aoPIC / aoALB.
-- Apply once after 202607220001_site_creation_code.sql.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.sites') is null
     or pg_catalog.to_regclass('public.photos') is null
     or pg_catalog.to_regclass('public.ledgers') is null
     or pg_catalog.to_regclass('public.photo_objects') is null
     or pg_catalog.to_regprocedure('public.join_site(text,text,text)') is null
     or pg_catalog.to_regprocedure('public.rotate_site_join_code(uuid,text,public.site_role)') is null then
    raise exception 'Apply the site sharing foundation before this migration.';
  end if;
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'sites' and column_name = 'status'
  ) or pg_catalog.to_regprocedure('public.update_site(uuid,bigint,text,text)') is not null then
    raise exception 'Shared project lifecycle objects already exist. Do not rerun this migration.';
  end if;
end
$preflight$;

alter table public.sites
  add column status text not null default 'active',
  add column closed_at timestamptz,
  add column closed_by uuid references auth.users(id),
  add column trashed_at timestamptz,
  add column trashed_by uuid references auth.users(id),
  add column status_before_trash text;

alter table public.sites
  add constraint sites_status_allowed
    check (status in ('active', 'closed', 'trashed')),
  add constraint sites_status_before_trash_allowed
    check (status_before_trash is null or status_before_trash in ('active', 'closed')),
  add constraint sites_lifecycle_consistent check (
    (status = 'active'
      and closed_at is null and closed_by is null
      and trashed_at is null and trashed_by is null and status_before_trash is null)
    or
    (status = 'closed'
      and closed_at is not null and closed_by is not null
      and trashed_at is null and trashed_by is null and status_before_trash is null)
    or
    (status = 'trashed'
      and trashed_at is not null and trashed_by is not null
      and status_before_trash in ('active', 'closed'))
  );

create index sites_status_idx on public.sites(status, updated_at desc);

create table private.deleted_site_audit (
  id bigint generated always as identity primary key,
  site_id uuid not null,
  -- Keep the deletion record even if the anonymous Auth user is later removed.
  actor_user_id uuid not null,
  site_code text not null,
  site_name text not null,
  deleted_at timestamptz not null default now()
);

alter table private.deleted_site_audit enable row level security;
revoke all on table private.deleted_site_audit from public, anon, authenticated;
revoke all on sequence private.deleted_site_audit_id_seq from public, anon, authenticated;

create function private.site_is_active(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sites s
    where s.id = p_site_id and s.status = 'active'
  );
$$;

create function private.site_is_active_text(p_site_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_site_id is null
     or p_site_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  return private.site_is_active(p_site_id::uuid);
end;
$$;

revoke all on function private.site_is_active(uuid)
  from public, anon, authenticated;
revoke all on function private.site_is_active_text(text)
  from public, anon, authenticated;
grant execute on function private.site_is_active(uuid) to authenticated;
grant execute on function private.site_is_active_text(text) to authenticated;

create function public.update_site(
  p_site_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_site_code text
)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_code text := upper(trim(coalesce(p_site_code, '')));
  v_name_changed boolean;
  v_code_changed boolean;
begin
  if not private.has_site_role(p_site_id, 'admin') then
    raise exception 'not_allowed';
  end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.status = 'trashed' then raise exception 'site_trashed'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if char_length(v_name) not between 1 and 160 or v_name ~ '[[:cntrl:]]' then
    raise exception 'site_name_invalid';
  end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,39}$' then
    raise exception 'site_code_invalid';
  end if;
  if exists (select 1 from public.sites where site_code = v_code and id <> p_site_id) then
    raise exception 'site_code_exists';
  end if;
  v_name_changed := v_site.name <> v_name;
  v_code_changed := v_site.site_code <> v_code;

  update public.sites
  set name = v_name, site_code = v_code
  where id = p_site_id
  returning * into v_site;

  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    p_site_id, auth.uid(), 'site.update', 'site', p_site_id,
    pg_catalog.jsonb_build_object('name_changed', v_name_changed, 'site_code_changed', v_code_changed)
  );
  return v_site;
exception
  when unique_violation then raise exception 'site_code_exists';
end;
$$;

create function public.close_site(p_site_id uuid, p_expected_revision bigint)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare v_site public.sites%rowtype;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_site.status <> 'active' then raise exception 'site_not_active'; end if;
  update public.sites
  set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = p_site_id returning * into v_site;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (p_site_id, auth.uid(), 'site.close', 'site', p_site_id);
  return v_site;
end;
$$;

create function public.reopen_site(p_site_id uuid, p_expected_revision bigint)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare v_site public.sites%rowtype;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_site.status <> 'closed' then raise exception 'site_not_closed'; end if;
  update public.sites
  set status = 'active', closed_at = null, closed_by = null
  where id = p_site_id returning * into v_site;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (p_site_id, auth.uid(), 'site.reopen', 'site', p_site_id);
  return v_site;
end;
$$;

create function public.trash_site(p_site_id uuid, p_expected_revision bigint)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare v_site public.sites%rowtype;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_site.status not in ('active', 'closed') then raise exception 'site_already_trashed'; end if;
  update public.sites
  set status_before_trash = v_site.status,
      status = 'trashed', trashed_at = now(), trashed_by = auth.uid()
  where id = p_site_id returning * into v_site;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    p_site_id, auth.uid(), 'site.trash', 'site', p_site_id,
    pg_catalog.jsonb_build_object('previous_status', v_site.status_before_trash)
  );
  return v_site;
end;
$$;

create function public.restore_site(p_site_id uuid, p_expected_revision bigint)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
  v_restore_status text;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  select * into v_site from public.sites where id = p_site_id for update;
  if not found then raise exception 'site_not_found'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_site.status <> 'trashed' then raise exception 'site_not_trashed'; end if;
  if exists (select 1 from public.sites where site_code = v_site.site_code and id <> p_site_id) then
    raise exception 'site_code_exists';
  end if;
  v_restore_status := coalesce(v_site.status_before_trash, 'active');
  update public.sites
  set status = v_restore_status,
      closed_at = case when v_restore_status = 'closed' then closed_at else null end,
      closed_by = case when v_restore_status = 'closed' then closed_by else null end,
      trashed_at = null, trashed_by = null, status_before_trash = null
  where id = p_site_id returning * into v_site;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    p_site_id, auth.uid(), 'site.restore', 'site', p_site_id,
    pg_catalog.jsonb_build_object('restored_status', v_restore_status)
  );
  return v_site;
end;
$$;

create function public.delete_empty_site(
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
  if v_site.created_by is distinct from auth.uid() then raise exception 'creator_required'; end if;
  if v_site.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_site.status <> 'trashed' then raise exception 'trash_required'; end if;
  if trim(coalesce(p_confirm_name, '')) <> v_site.name then raise exception 'confirmation_mismatch'; end if;

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
       where site_id = p_site_id and user_id <> auth.uid()
     )
     or v_storage_count <> 0 then
    raise exception 'site_not_empty';
  end if;

  insert into private.deleted_site_audit(
    site_id, actor_user_id, site_code, site_name
  ) values (
    p_site_id, auth.uid(), v_site.site_code, v_site.name
  );
  delete from public.sites where id = p_site_id;
  if not found then raise exception 'site_not_found'; end if;
  return true;
end;
$$;

revoke all on function public.update_site(uuid, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.close_site(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.reopen_site(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.trash_site(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.restore_site(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.delete_empty_site(uuid, bigint, text)
  from public, anon, authenticated;

grant execute on function public.update_site(uuid, bigint, text, text) to authenticated;
grant execute on function public.close_site(uuid, bigint) to authenticated;
grant execute on function public.reopen_site(uuid, bigint) to authenticated;
grant execute on function public.trash_site(uuid, bigint) to authenticated;
grant execute on function public.restore_site(uuid, bigint) to authenticated;
grant execute on function public.delete_empty_site(uuid, bigint, text) to authenticated;

-- Site changes must go through audited, revision-checked RPCs.
drop policy sites_update on public.sites;
revoke update (site_code, name) on public.sites from authenticated;

-- Existing rows remain readable, but writes are accepted only for active sites.
drop policy projects_insert on public.projects;
drop policy projects_update on public.projects;
drop policy projects_delete on public.projects;
create policy projects_insert on public.projects for insert to authenticated
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy projects_update on public.projects for update to authenticated
  using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy projects_delete on public.projects for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy photos_insert on public.photos;
drop policy photos_update on public.photos;
drop policy photos_delete on public.photos;
create policy photos_insert on public.photos for insert to authenticated
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy photos_update on public.photos for update to authenticated
  using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy photos_delete on public.photos for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy objects_insert on public.photo_objects;
drop policy objects_update on public.photo_objects;
drop policy objects_delete on public.photo_objects;
create policy objects_insert on public.photo_objects for insert to authenticated
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy objects_update on public.photo_objects for update to authenticated
  using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy objects_delete on public.photo_objects for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy ledgers_insert on public.ledgers;
drop policy ledgers_update on public.ledgers;
drop policy ledgers_delete on public.ledgers;
create policy ledgers_insert on public.ledgers for insert to authenticated
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy ledgers_update on public.ledgers for update to authenticated
  using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy ledgers_delete on public.ledgers for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy pages_insert on public.ledger_pages;
drop policy pages_update on public.ledger_pages;
drop policy pages_delete on public.ledger_pages;
create policy pages_insert on public.ledger_pages for insert to authenticated
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy pages_update on public.ledger_pages for update to authenticated
  using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy pages_delete on public.ledger_pages for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy slots_insert on public.ledger_slots;
drop policy slots_update on public.ledger_slots;
drop policy slots_delete on public.ledger_slots;
create policy slots_insert on public.ledger_slots for insert to authenticated
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy slots_update on public.ledger_slots for update to authenticated
  using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
  with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy slots_delete on public.ledger_slots for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy events_insert on public.sync_events;
drop policy events_delete on public.sync_events;
create policy events_insert on public.sync_events for insert to authenticated
  with check (
    private.has_site_role(site_id, 'editor')
    and private.site_is_active(site_id)
    and actor_user_id = auth.uid()
  );
create policy events_delete on public.sync_events for delete to authenticated
  using (private.has_site_role(site_id, 'admin') and private.site_is_active(site_id));

drop policy site_photos_insert on storage.objects;
drop policy site_photos_update on storage.objects;
drop policy site_photos_delete on storage.objects;
create policy site_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'site-photos'
    and private.has_site_role_text((storage.foldername(name))[1], 'editor')
    and private.site_is_active_text((storage.foldername(name))[1])
  );
create policy site_photos_update on storage.objects for update to authenticated
  using (
    bucket_id = 'site-photos'
    and private.has_site_role_text((storage.foldername(name))[1], 'editor')
    and private.site_is_active_text((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'site-photos'
    and private.has_site_role_text((storage.foldername(name))[1], 'editor')
    and private.site_is_active_text((storage.foldername(name))[1])
  );
create policy site_photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'site-photos'
    and private.has_site_role_text((storage.foldername(name))[1], 'admin')
    and private.site_is_active_text((storage.foldername(name))[1])
  );

-- Existing join RPC with lifecycle gating. The code is checked before status is
-- disclosed, so a site code alone cannot be used to enumerate closed sites.
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
      failed_count = case when public.site_join_attempts.window_started_at < v_now - interval '15 minutes'
        then 1 else public.site_join_attempts.failed_count + 1 end,
      window_started_at = case when public.site_join_attempts.window_started_at < v_now - interval '15 minutes'
        then v_now else public.site_join_attempts.window_started_at end,
      blocked_until = case
        when public.site_join_attempts.window_started_at < v_now - interval '15 minutes' then null
        when public.site_join_attempts.failed_count + 1 >= 5 then v_now + interval '15 minutes'
        else null end,
      last_site_code = excluded.last_site_code
    returning public.site_join_attempts.blocked_until into v_blocked_until;
    return query select null::uuid, null::text, null::text, null::public.site_role,
      case when v_blocked_until > v_now then 'temporarily_blocked' else 'invalid_join' end;
    return;
  end if;
  if v_site.status <> 'active' then
    return query select null::uuid, null::text, null::text, null::public.site_role,
      case when v_site.status = 'closed' then 'site_closed' else 'site_trashed' end;
    return;
  end if;
  select m.* into v_existing
  from public.site_members m where m.site_id = v_site.id and m.user_id = v_user for update;
  if found and not v_existing.active then
    return query select null::uuid, null::text, null::text, null::public.site_role, 'membership_disabled'::text;
    return;
  end if;
  delete from public.site_join_attempts where user_id = v_user;
  insert into public.site_members(site_id, user_id, role, device_name, active, last_seen_at)
  values (
    v_site.id, v_user, v_code.grant_role,
    left(coalesce(nullif(trim(p_device_name), ''), '名称未設定端末'), 80), true, v_now
  )
  on conflict on constraint site_members_site_id_user_id_key
  do update set device_name = excluded.device_name, last_seen_at = v_now;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (v_site.id, v_user, 'site.join', 'site_member', v_user);
  return query select v_site.id, v_site.site_code, v_site.name,
    (select m.role from public.site_members m where m.site_id = v_site.id and m.user_id = v_user),
    null::text;
end;
$$;

revoke all on function public.join_site(text, text, text)
  from public, anon, authenticated;
grant execute on function public.join_site(text, text, text) to authenticated;

commit;
