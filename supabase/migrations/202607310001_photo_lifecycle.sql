-- Non-destructive shared-photo lifecycle for aoPIC / aoALB.
-- Apply once after 202607290001_site_admin_recovery.sql.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.photos') is null
     or pg_catalog.to_regclass('public.photo_objects') is null
     or pg_catalog.to_regclass('public.ledger_slots') is null
     or pg_catalog.to_regclass('public.sync_events') is null
     or pg_catalog.to_regclass('public.audit_logs') is null
     or pg_catalog.to_regprocedure('private.has_site_role(uuid,public.site_role)') is null
     or pg_catalog.to_regprocedure('private.site_is_active(uuid)') is null then
    raise exception 'photo lifecycle prerequisites are missing';
  end if;
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'photos'
      and column_name = 'lifecycle_status'
  ) then
    raise exception 'photo lifecycle migration is already applied';
  end if;
end;
$preflight$;

alter table public.photos
  add column lifecycle_status text not null default 'active',
  add column trashed_at timestamptz,
  add column trashed_by uuid references auth.users(id),
  add column trash_revision bigint,
  add column delete_error text;

alter table public.photos
  add constraint photos_lifecycle_status_allowed
    check (lifecycle_status in ('active', 'trashed', 'deleting', 'delete_error')),
  add constraint photos_lifecycle_fields_consistent check (
    (lifecycle_status = 'active'
      and trashed_at is null
      and trashed_by is null
      and trash_revision is null
      and delete_error is null)
    or
    (lifecycle_status = 'trashed'
      and trashed_at is not null
      and trashed_by is not null
      and trash_revision is not null
      and delete_error is null)
    or
    (lifecycle_status = 'deleting'
      and trashed_at is not null
      and trashed_by is not null
      and trash_revision is not null
      and delete_error is null)
    or
    (lifecycle_status = 'delete_error'
      and trashed_at is not null
      and trashed_by is not null
      and trash_revision is not null
      and delete_error is not null)
  );

create index photos_site_lifecycle_idx
  on public.photos(site_id, lifecycle_status, captured_at desc, id);

create function public.photo_ledger_references(p_photo_id uuid)
returns table(
  ledger_id uuid,
  ledger_title text,
  page_index integer,
  slot_index integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.title, lp.page_index, ls.slot_index
  from public.photos p
  join public.ledger_slots ls
    on ls.photo_id = p.id and ls.site_id = p.site_id
  join public.ledger_pages lp
    on lp.id = ls.page_id and lp.site_id = p.site_id
  join public.ledgers l
    on l.id = lp.ledger_id and l.site_id = p.site_id
  where p.id = p_photo_id
    and private.has_site_role(p.site_id, 'viewer')
  order by l.title, l.id, lp.page_index, ls.slot_index;
$$;

create function public.check_photo_upload_state(
  p_site_id uuid,
  p_photo_uid uuid,
  p_sha256 text
)
returns table(
  upload_state text,
  photo_id uuid,
  lifecycle_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_photo public.photos%rowtype;
begin
  if not private.has_site_role(p_site_id, 'editor') then
    raise exception 'not_allowed';
  end if;
  select *
  into v_photo
  from public.photos
  where site_id = p_site_id and photo_uid = p_photo_uid;

  if not found then
    return query select 'missing'::text, null::uuid, null::text;
  elsif v_photo.sha256 <> p_sha256 then
    return query select 'conflict'::text, v_photo.id, v_photo.lifecycle_status;
  elsif v_photo.lifecycle_status <> 'active' then
    return query select 'trashed'::text, v_photo.id, v_photo.lifecycle_status;
  else
    return query select 'active'::text, v_photo.id, v_photo.lifecycle_status;
  end if;
end;
$$;

create function public.trash_photo(
  p_photo_id uuid,
  p_expected_revision bigint
)
returns public.photos
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo public.photos%rowtype;
  v_event_id uuid := pg_catalog.gen_random_uuid();
begin
  select * into v_photo
  from public.photos
  where id = p_photo_id
  for update;

  if not found
     or not private.has_site_role(v_photo.site_id, 'admin') then
    raise exception 'not_allowed';
  end if;
  if not private.site_is_active(v_photo.site_id) then
    raise exception 'site_not_active';
  end if;
  if v_photo.revision <> p_expected_revision then
    raise exception 'revision_conflict';
  end if;
  if v_photo.lifecycle_status = 'trashed' then
    return v_photo;
  end if;
  if v_photo.lifecycle_status <> 'active' then
    raise exception 'photo_state_invalid';
  end if;
  if exists (
    select 1
    from public.ledger_slots
    where photo_id = v_photo.id and site_id = v_photo.site_id
  ) then
    raise exception 'photo_used_by_ledger';
  end if;

  update public.photos
  set lifecycle_status = 'trashed',
      trashed_at = now(),
      trashed_by = auth.uid(),
      trash_revision = revision + 1,
      delete_error = null
  where id = v_photo.id
  returning * into v_photo;

  insert into public.audit_logs(
    site_id, actor_user_id, action, entity_type, entity_id, details
  )
  values (
    v_photo.site_id, auth.uid(), 'photo.trash', 'photo', v_photo.id,
    pg_catalog.jsonb_build_object('photo_uid', v_photo.photo_uid)
  );
  insert into public.sync_events(
    event_id, site_id, entity_type, entity_id, event_type, payload
  )
  values (
    v_event_id, v_photo.site_id, 'photo', v_photo.id, 'photo_trashed',
    pg_catalog.jsonb_build_object(
      'photoUid', v_photo.photo_uid,
      'revision', v_photo.revision
    )
  );
  return v_photo;
end;
$$;

create function public.restore_photo(
  p_photo_id uuid,
  p_expected_revision bigint
)
returns public.photos
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo public.photos%rowtype;
  v_event_id uuid := pg_catalog.gen_random_uuid();
begin
  select * into v_photo
  from public.photos
  where id = p_photo_id
  for update;

  if not found
     or not private.has_site_role(v_photo.site_id, 'admin') then
    raise exception 'not_allowed';
  end if;
  if not private.site_is_active(v_photo.site_id) then
    raise exception 'site_not_active';
  end if;
  if v_photo.revision <> p_expected_revision then
    raise exception 'revision_conflict';
  end if;
  if v_photo.lifecycle_status = 'active' then
    return v_photo;
  end if;
  if v_photo.lifecycle_status <> 'trashed' then
    raise exception 'photo_state_invalid';
  end if;

  update public.photos
  set lifecycle_status = 'active',
      trashed_at = null,
      trashed_by = null,
      trash_revision = null,
      delete_error = null
  where id = v_photo.id
  returning * into v_photo;

  insert into public.audit_logs(
    site_id, actor_user_id, action, entity_type, entity_id, details
  )
  values (
    v_photo.site_id, auth.uid(), 'photo.restore', 'photo', v_photo.id,
    pg_catalog.jsonb_build_object('photo_uid', v_photo.photo_uid)
  );
  insert into public.sync_events(
    event_id, site_id, entity_type, entity_id, event_type, payload
  )
  values (
    v_event_id, v_photo.site_id, 'photo', v_photo.id, 'photo_restored',
    pg_catalog.jsonb_build_object(
      'photoUid', v_photo.photo_uid,
      'revision', v_photo.revision
    )
  );
  return v_photo;
end;
$$;

revoke all on function public.photo_ledger_references(uuid)
from public, anon, authenticated;
revoke all on function public.check_photo_upload_state(uuid, uuid, text)
from public, anon, authenticated;
revoke all on function public.trash_photo(uuid, bigint)
from public, anon, authenticated;
revoke all on function public.restore_photo(uuid, bigint)
from public, anon, authenticated;

grant execute on function public.photo_ledger_references(uuid) to authenticated;
grant execute on function public.check_photo_upload_state(uuid, uuid, text) to authenticated;
grant execute on function public.trash_photo(uuid, bigint) to authenticated;
grant execute on function public.restore_photo(uuid, bigint) to authenticated;

-- Lifecycle columns are changed only through the revision-checked RPCs.
revoke update on public.photos from authenticated;
grant update (
  project_id, captured_at, sha256, mime_type, width, height, bytes, metadata
) on public.photos to authenticated;

-- Members see active photos. Administrators can also inspect the trash.
drop policy photos_select on public.photos;
create policy photos_select on public.photos for select to authenticated
using (
  private.has_site_role(site_id, 'viewer')
  and (
    lifecycle_status = 'active'
    or private.has_site_role(site_id, 'admin')
  )
);

drop policy objects_select on public.photo_objects;
create policy objects_select on public.photo_objects for select to authenticated
using (
  private.has_site_role(site_id, 'viewer')
  and exists (
    select 1
    from public.photos p
    where p.id = photo_id
      and p.site_id = photo_objects.site_id
      and (
        p.lifecycle_status = 'active'
        or private.has_site_role(p.site_id, 'admin')
      )
  )
);

-- This restrictive policy prevents direct Storage reads for trashed photos by
-- non-admin members while preserving the existing private bucket policies.
create policy site_photos_photo_lifecycle_select on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id <> 'site-photos'
    or private.has_site_role_text((storage.foldername(name))[1], 'admin')
    or exists (
      select 1
      from public.photo_objects po
      join public.photos p
        on p.id = po.photo_id and p.site_id = po.site_id
      where po.site_id::text = (storage.foldername(name))[1]
        and p.lifecycle_status = 'active'
        and (po.object_path = name or po.thumbnail_object_path = name)
    )
  );

commit;
