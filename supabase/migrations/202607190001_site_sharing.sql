-- aoALB site sharing foundation (one-shot migration)
-- Run this file once in a new Supabase project's SQL Editor.
-- A second run intentionally stops before changing anything.

begin;

do $preflight$
begin
  if pg_catalog.to_regtype('public.site_role') is not null
     or pg_catalog.to_regclass('public.sites') is not null
     or pg_catalog.to_regclass('public.site_members') is not null then
    raise exception 'aoALB site sharing objects already exist. Do not rerun this migration.';
  end if;
  if pg_catalog.to_regclass('auth.users') is null
     or pg_catalog.to_regclass('storage.objects') is null
     or pg_catalog.to_regclass('storage.buckets') is null then
    raise exception 'Required Supabase auth/storage schemas were not found.';
  end if;
  if exists (select 1 from storage.buckets where id = 'site-photos') then
    raise exception 'Storage bucket site-photos already exists. Migration stopped before changing it.';
  end if;
  if exists (
    select 1 from pg_catalog.pg_namespace n
    where n.nspname = 'private'
      and (exists (select 1 from pg_catalog.pg_class c where c.relnamespace = n.oid)
           or exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = n.oid))
  ) then
    raise exception 'Schema private already contains objects. Migration stopped to avoid changing unrelated objects.';
  end if;
end
$preflight$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $extension_check$
begin
  if pg_catalog.to_regprocedure('extensions.crypt(text,text)') is null
     or pg_catalog.to_regprocedure('extensions.gen_salt(text,integer)') is null then
    raise exception 'pgcrypto was not installed in the extensions schema.';
  end if;
end
$extension_check$;

create type public.site_role as enum ('admin', 'editor', 'viewer');

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.sites (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_code text not null unique check (site_code = upper(site_code) and site_code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  name text not null check (char_length(name) between 1 and 160),
  created_by uuid references auth.users(id),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.site_join_codes (
  site_id uuid primary key references public.sites(id) on delete cascade,
  code_hash text not null,
  grant_role public.site_role not null default 'editor',
  version integer not null default 1 check (version > 0),
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  check (grant_role <> 'admin'::public.site_role)
);

create table public.site_members (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.site_role not null default 'viewer',
  device_name text not null check (char_length(device_name) between 1 and 80),
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (site_id, user_id)
);

-- One counter per authenticated user prevents changing the site code to bypass throttling.
create table public.site_join_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_count integer not null default 0 check (failed_count >= 0),
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  last_site_code text not null default ''
);

create table public.projects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  project_uid uuid not null,
  kouji_id text,
  name text not null,
  contractor text not null default '',
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, project_uid)
);

create table public.photos (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  photo_uid uuid not null,
  captured_at timestamptz,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null default 'image/jpeg' check (mime_type = 'image/jpeg'),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  bytes bigint not null check (bytes > 0),
  metadata jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, photo_uid)
);

create table public.photo_objects (
  photo_id uuid primary key references public.photos(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  bucket_id text not null default 'site-photos' check (bucket_id = 'site-photos'),
  object_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes > 0),
  upload_completed_at timestamptz,
  unique (bucket_id, object_path),
  check (object_path like site_id::text || '/%'),
  check (position(E'\\' in object_path) = 0 and object_path !~ '[[:cntrl:]]' and object_path !~ '(^|/)\.\.?(/|$)')
);

create table public.ledgers (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  ledger_uid uuid not null,
  title text not null,
  template text not null default 'construction-3',
  show_cover boolean not null default true,
  editing_by uuid references auth.users(id),
  editing_started_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, ledger_uid)
);

create table public.ledger_pages (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, page_index)
);

create table public.ledger_slots (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  page_id uuid not null references public.ledger_pages(id) on delete cascade,
  slot_index integer not null check (slot_index between 0 and 2),
  slot_type text not null check (slot_type in ('photo', 'blank')),
  photo_id uuid references public.photos(id) on delete restrict,
  caption_override jsonb,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (page_id, slot_index),
  check ((slot_type = 'photo' and photo_id is not null) or (slot_type = 'blank' and photo_id is null))
);

create table public.sync_events (
  event_id uuid primary key,
  site_id uuid not null references public.sites(id) on delete cascade,
  actor_user_id uuid not null default auth.uid() references auth.users(id),
  device_name text not null default '',
  entity_type text not null,
  entity_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  site_id uuid not null references public.sites(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.projects add constraint projects_id_site_unique unique (id, site_id);
alter table public.photos add constraint photos_id_site_unique unique (id, site_id);
alter table public.photos add constraint photos_project_site_fk foreign key (project_id, site_id) references public.projects(id, site_id) on delete cascade;
alter table public.photo_objects add constraint photo_objects_photo_site_fk foreign key (photo_id, site_id) references public.photos(id, site_id) on delete cascade;
alter table public.ledgers add constraint ledgers_id_site_unique unique (id, site_id);
alter table public.ledgers add constraint ledgers_project_site_fk foreign key (project_id, site_id) references public.projects(id, site_id) on delete cascade;
alter table public.ledger_pages add constraint ledger_pages_id_site_unique unique (id, site_id);
alter table public.ledger_pages add constraint ledger_pages_ledger_site_fk foreign key (ledger_id, site_id) references public.ledgers(id, site_id) on delete cascade;
alter table public.ledger_slots add constraint ledger_slots_page_site_fk foreign key (page_id, site_id) references public.ledger_pages(id, site_id) on delete cascade;
alter table public.ledger_slots add constraint ledger_slots_photo_site_fk foreign key (photo_id, site_id) references public.photos(id, site_id) on delete restrict;

create index site_members_user_idx on public.site_members(user_id) where active;
create index projects_site_idx on public.projects(site_id);
create index photos_project_idx on public.photos(project_id, captured_at);
create index ledgers_project_idx on public.ledgers(project_id);
create index sync_events_site_idx on public.sync_events(site_id, created_at desc);
create index audit_logs_site_idx on public.audit_logs(site_id, created_at desc);

create function private.role_rank(p_role public.site_role)
returns integer language sql immutable set search_path = '' as $$
  select case p_role when 'admin' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end;
$$;

create function private.site_role_for(p_site_id uuid)
returns public.site_role language sql stable security definer set search_path = '' as $$
  select m.role from public.site_members m
  where m.site_id = p_site_id and m.user_id = (select auth.uid()) and m.active
  limit 1;
$$;

create function private.has_site_role(p_site_id uuid, p_minimum public.site_role default 'viewer')
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.role_rank(private.site_role_for(p_site_id)) >= private.role_rank(p_minimum), false);
$$;

create function private.has_site_role_text(p_site_id text, p_minimum public.site_role default 'viewer')
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if p_site_id is null or p_site_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  return private.has_site_role(p_site_id::uuid, p_minimum);
end;
$$;

create function private.bump_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;

create trigger sites_revision before update on public.sites for each row execute function private.bump_revision();
create trigger projects_revision before update on public.projects for each row execute function private.bump_revision();
create trigger photos_revision before update on public.photos for each row execute function private.bump_revision();
create trigger ledgers_revision before update on public.ledgers for each row execute function private.bump_revision();
create trigger ledger_pages_revision before update on public.ledger_pages for each row execute function private.bump_revision();
create trigger ledger_slots_revision before update on public.ledger_slots for each row execute function private.bump_revision();

create function public.join_site(p_site_code text, p_join_code text, p_device_name text)
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
  on conflict (site_id, user_id) do update set device_name = excluded.device_name, last_seen_at = v_now;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (v_site.id, v_user, 'site.join', 'site_member', v_user);
  return query select v_site.id, v_site.site_code, v_site.name,
    (select m.role from public.site_members m where m.site_id = v_site.id and m.user_id = v_user), null::text;
end;
$$;

create function public.rotate_site_join_code(p_site_id uuid, p_new_code text, p_grant_role public.site_role default 'editor')
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  if char_length(coalesce(p_new_code, '')) not between 8 and 64
     or octet_length(coalesce(p_new_code, '')) > 72
     or p_new_code ~ '[[:space:][:cntrl:]]' then
    raise exception 'join_code_invalid';
  end if;
  if p_grant_role = 'admin'::public.site_role then raise exception 'admin_role_not_allowed'; end if;
  update public.site_join_codes
  set code_hash = extensions.crypt(p_new_code, extensions.gen_salt('bf', 10)), grant_role = p_grant_role,
      version = version + 1, changed_by = auth.uid(), changed_at = now()
  where site_id = p_site_id;
  if not found then raise exception 'site_not_found'; end if;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
  values (p_site_id, auth.uid(), 'join_code.rotate', 'site', p_site_id);
  return true;
end;
$$;

create function public.set_site_member_active(p_site_id uuid, p_user_id uuid, p_active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_changed boolean;
begin
  if not private.has_site_role(p_site_id, 'admin') then raise exception 'not_allowed'; end if;
  if p_user_id = auth.uid() and not p_active then raise exception 'cannot_disable_self'; end if;
  if not p_active
     and exists (select 1 from public.site_members where site_id = p_site_id and user_id = p_user_id and role = 'admin' and active)
     and (select count(*) from public.site_members where site_id = p_site_id and role = 'admin' and active) <= 1 then
    raise exception 'cannot_disable_last_admin';
  end if;
  update public.site_members set active = p_active where site_id = p_site_id and user_id = p_user_id;
  v_changed := found;
  if v_changed then
    insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
    values (p_site_id, auth.uid(), 'member.active', 'site_member', p_user_id, jsonb_build_object('active', p_active));
  end if;
  return v_changed;
end;
$$;

create function public.begin_ledger_edit(p_ledger_id uuid, p_expected_revision bigint)
returns public.ledgers language plpgsql security definer set search_path = '' as $$
declare v_ledger public.ledgers%rowtype;
begin
  select * into v_ledger from public.ledgers where id = p_ledger_id for update;
  if not found or not private.has_site_role(v_ledger.site_id, 'editor') then raise exception 'not_allowed'; end if;
  if v_ledger.revision <> p_expected_revision then raise exception 'revision_conflict'; end if;
  if v_ledger.editing_by is not null and v_ledger.editing_by <> auth.uid()
     and v_ledger.editing_started_at > now() - interval '10 minutes' then
    raise exception 'already_editing';
  end if;
  update public.ledgers set editing_by = auth.uid(), editing_started_at = now()
  where id = p_ledger_id returning * into v_ledger;
  return v_ledger;
end;
$$;

revoke all on function public.join_site(text, text, text) from public, anon, authenticated;
revoke all on function public.rotate_site_join_code(uuid, text, public.site_role) from public, anon, authenticated;
revoke all on function public.set_site_member_active(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.begin_ledger_edit(uuid, bigint) from public, anon, authenticated;
revoke all on function private.role_rank(public.site_role) from public, anon, authenticated;
revoke all on function private.site_role_for(uuid) from public, anon, authenticated;
revoke all on function private.has_site_role(uuid, public.site_role) from public, anon, authenticated;
revoke all on function private.has_site_role_text(text, public.site_role) from public, anon, authenticated;
revoke all on function private.bump_revision() from public, anon, authenticated;
grant execute on function public.join_site(text, text, text) to authenticated;
grant execute on function public.rotate_site_join_code(uuid, text, public.site_role) to authenticated;
grant execute on function public.set_site_member_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.begin_ledger_edit(uuid, bigint) to authenticated;
grant execute on function private.has_site_role(uuid, public.site_role) to authenticated;
grant execute on function private.has_site_role_text(text, public.site_role) to authenticated;

alter table public.sites enable row level security;
alter table public.site_join_codes enable row level security;
alter table public.site_members enable row level security;
alter table public.site_join_attempts enable row level security;
alter table public.projects enable row level security;
alter table public.photos enable row level security;
alter table public.photo_objects enable row level security;
alter table public.ledgers enable row level security;
alter table public.ledger_pages enable row level security;
alter table public.ledger_slots enable row level security;
alter table public.sync_events enable row level security;
alter table public.audit_logs enable row level security;

create policy sites_select on public.sites for select to authenticated using (private.has_site_role(id, 'viewer'));
create policy sites_update on public.sites for update to authenticated using (private.has_site_role(id, 'admin')) with check (private.has_site_role(id, 'admin'));
create policy members_select on public.site_members for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy projects_select on public.projects for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy projects_insert on public.projects for insert to authenticated with check (private.has_site_role(site_id, 'editor'));
create policy projects_update on public.projects for update to authenticated using (private.has_site_role(site_id, 'editor')) with check (private.has_site_role(site_id, 'editor'));
create policy projects_delete on public.projects for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy photos_select on public.photos for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy photos_insert on public.photos for insert to authenticated with check (private.has_site_role(site_id, 'editor'));
create policy photos_update on public.photos for update to authenticated using (private.has_site_role(site_id, 'editor')) with check (private.has_site_role(site_id, 'editor'));
create policy photos_delete on public.photos for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy objects_select on public.photo_objects for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy objects_insert on public.photo_objects for insert to authenticated with check (private.has_site_role(site_id, 'editor'));
create policy objects_update on public.photo_objects for update to authenticated using (private.has_site_role(site_id, 'editor')) with check (private.has_site_role(site_id, 'editor'));
create policy objects_delete on public.photo_objects for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy ledgers_select on public.ledgers for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy ledgers_insert on public.ledgers for insert to authenticated with check (private.has_site_role(site_id, 'editor'));
create policy ledgers_update on public.ledgers for update to authenticated using (private.has_site_role(site_id, 'editor')) with check (private.has_site_role(site_id, 'editor'));
create policy ledgers_delete on public.ledgers for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy pages_select on public.ledger_pages for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy pages_insert on public.ledger_pages for insert to authenticated with check (private.has_site_role(site_id, 'editor'));
create policy pages_update on public.ledger_pages for update to authenticated using (private.has_site_role(site_id, 'editor')) with check (private.has_site_role(site_id, 'editor'));
create policy pages_delete on public.ledger_pages for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy slots_select on public.ledger_slots for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy slots_insert on public.ledger_slots for insert to authenticated with check (private.has_site_role(site_id, 'editor'));
create policy slots_update on public.ledger_slots for update to authenticated using (private.has_site_role(site_id, 'editor')) with check (private.has_site_role(site_id, 'editor'));
create policy slots_delete on public.ledger_slots for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy events_select on public.sync_events for select to authenticated using (private.has_site_role(site_id, 'viewer'));
create policy events_insert on public.sync_events for insert to authenticated with check (private.has_site_role(site_id, 'editor') and actor_user_id = auth.uid());
create policy events_delete on public.sync_events for delete to authenticated using (private.has_site_role(site_id, 'admin'));
create policy audit_select on public.audit_logs for select to authenticated using (private.has_site_role(site_id, 'admin'));

revoke all on table public.sites, public.site_join_codes, public.site_members, public.site_join_attempts,
  public.projects, public.photos, public.photo_objects, public.ledgers, public.ledger_pages,
  public.ledger_slots, public.sync_events, public.audit_logs from public, anon, authenticated;
grant select on public.sites to authenticated;
grant update (site_code, name) on public.sites to authenticated;
grant select on public.site_members to authenticated;
grant select, insert, update, delete on public.projects, public.photos, public.photo_objects,
  public.ledgers, public.ledger_pages, public.ledger_slots to authenticated;
grant select, insert, delete on public.sync_events to authenticated;
grant select on public.audit_logs to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('site-photos', 'site-photos', false, 20971520, array['image/jpeg']);

create policy site_photos_select on storage.objects for select to authenticated
using (bucket_id = 'site-photos' and private.has_site_role_text((storage.foldername(name))[1], 'viewer'));
create policy site_photos_insert on storage.objects for insert to authenticated
with check (bucket_id = 'site-photos' and private.has_site_role_text((storage.foldername(name))[1], 'editor'));
create policy site_photos_update on storage.objects for update to authenticated
using (bucket_id = 'site-photos' and private.has_site_role_text((storage.foldername(name))[1], 'editor'))
with check (bucket_id = 'site-photos' and private.has_site_role_text((storage.foldername(name))[1], 'editor'));
create policy site_photos_delete on storage.objects for delete to authenticated
using (bucket_id = 'site-photos' and private.has_site_role_text((storage.foldername(name))[1], 'admin'));

do $realtime$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'supabase_realtime publication was not found.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_events'
  ) then
    execute 'alter publication supabase_realtime add table public.sync_events';
  end if;
end
$realtime$;

commit;
