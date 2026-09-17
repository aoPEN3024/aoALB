-- Ledger-only deletion with synchronized tombstones. Apply once after 202608180001.
begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.ledgers') is null
     or pg_catalog.to_regprocedure('public.save_ledger_snapshot(uuid,uuid,uuid,uuid,bigint,text,text,boolean,text,jsonb,jsonb,uuid)') is null then
    raise exception 'Required ledger synchronization objects were not found.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledgers' and column_name = 'deleted_at'
  ) then
    raise exception 'Ledger lifecycle migration was already applied. Do not rerun.';
  end if;
end
$preflight$;

alter table public.ledgers
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id) on delete set null,
  add constraint ledgers_deleted_pair check (deleted_at is not null or deleted_by is null);

create index ledgers_active_project_idx on public.ledgers(project_id, updated_at desc)
where deleted_at is null;

create function private.prevent_deleted_ledger_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'ledger_deleted';
  end if;
  return new;
end;
$$;

create trigger prevent_deleted_ledger_update
before update on public.ledgers
for each row execute function private.prevent_deleted_ledger_update();

create function public.delete_ledger_snapshot(
  p_site_id uuid, p_ledger_id uuid, p_expected_revision bigint, p_event_id uuid
)
returns table(ledger_id uuid, ledger_uid uuid, revision bigint, deleted_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_ledger public.ledgers%rowtype;
begin
  if auth.uid() is null or not private.has_site_role(p_site_id, 'editor') or not private.site_is_active(p_site_id) then
    raise exception using errcode = '42501', message = 'operation_not_allowed';
  end if;
  if p_ledger_id is null or p_expected_revision is null or p_event_id is null then
    raise exception using errcode = '22023', message = 'invalid_ledger_delete';
  end if;

  select * into v_ledger
  from public.ledgers l
  where l.id = p_ledger_id and l.site_id = p_site_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_not_found';
  end if;
  if v_ledger.deleted_at is not null then
    if exists (select 1 from public.sync_events e where e.event_id = p_event_id and e.entity_id = v_ledger.id and e.event_type = 'ledger_deleted') then
      return query select v_ledger.id, v_ledger.ledger_uid, v_ledger.revision, v_ledger.deleted_at;
      return;
    end if;
    raise exception using errcode = '55000', message = 'ledger_deleted';
  end if;
  if p_expected_revision is distinct from v_ledger.revision then
    raise exception using errcode = '40001', message = 'revision_conflict';
  end if;

  update public.ledgers
  set deleted_at = pg_catalog.now(), deleted_by = auth.uid(), updated_by = auth.uid(), updated_at = pg_catalog.now()
  where id = v_ledger.id
  returning * into v_ledger;

  delete from public.ledger_pages p where p.ledger_id = v_ledger.id;
  delete from public.ledger_photo_captions c where c.ledger_id = v_ledger.id;

  insert into public.sync_events(event_id, site_id, actor_user_id, entity_type, entity_id, event_type, payload)
  values (p_event_id, p_site_id, auth.uid(), 'ledger', v_ledger.id, 'ledger_deleted',
    pg_catalog.jsonb_build_object('ledgerUid', v_ledger.ledger_uid, 'revision', v_ledger.revision))
  on conflict (event_id) do nothing;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_site_id, auth.uid(), 'ledger_deleted', 'ledger', v_ledger.id,
    pg_catalog.jsonb_build_object('revision', v_ledger.revision));

  return query select v_ledger.id, v_ledger.ledger_uid, v_ledger.revision, v_ledger.deleted_at;
end;
$$;

create or replace function public.list_site_ledger_snapshots(p_site_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
select case when not private.has_site_role(p_site_id,'viewer') then '[]'::jsonb else coalesce(jsonb_agg(snapshot order by snapshot->>'updatedAt'),'[]'::jsonb) end
from (
  select jsonb_build_object(
    'id',l.id,'ledgerUid',l.ledger_uid,'projectId',l.project_id,'title',l.title,'template',l.template,
    'showCover',l.show_cover,'viewMode',l.view_mode,'revision',l.revision,'updatedAt',l.updated_at,'updatedBy',l.updated_by,
    'pages',coalesce((select jsonb_agg(jsonb_build_object('pageIndex',p.page_index,'slots',
      coalesce((select jsonb_agg(jsonb_build_object('slotIndex',s.slot_index,'type',s.slot_type,'photoId',s.photo_id) order by s.slot_index)
        from public.ledger_slots s where s.page_id=p.id),'[]'::jsonb)) order by p.page_index)
      from public.ledger_pages p where p.ledger_id=l.id),'[]'::jsonb),
    'captions',coalesce((select jsonb_agg(jsonb_build_object('photoId',c.photo_id,'captionOverride',c.caption_override,'revision',c.revision))
      from public.ledger_photo_captions c where c.ledger_id=l.id),'[]'::jsonb)
  ) snapshot from public.ledgers l where l.site_id=p_site_id and l.deleted_at is null
) rows;
$$;

create function public.list_site_ledger_deletions(p_site_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
select case when not private.has_site_role(p_site_id,'viewer') then '[]'::jsonb else coalesce(
  jsonb_agg(jsonb_build_object(
    'id', l.id, 'ledgerUid', l.ledger_uid, 'projectId', l.project_id,
    'revision', l.revision, 'deletedAt', l.deleted_at
  ) order by l.deleted_at), '[]'::jsonb)
end
from public.ledgers l
where l.site_id = p_site_id and l.deleted_at is not null;
$$;

revoke all on function private.prevent_deleted_ledger_update() from public, anon, authenticated;
revoke all on function public.delete_ledger_snapshot(uuid,uuid,bigint,uuid) from public, anon, authenticated;
revoke all on function public.list_site_ledger_deletions(uuid) from public, anon, authenticated;
revoke delete on public.ledgers from authenticated;
grant execute on function public.delete_ledger_snapshot(uuid,uuid,bigint,uuid) to authenticated;
grant execute on function public.list_site_ledger_deletions(uuid) to authenticated;

commit;
