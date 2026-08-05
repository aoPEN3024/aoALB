-- aoALB cloud ledger and classification override synchronization.
-- Apply after 202608050001_account_foundation.sql. Do not rerun.
begin;

do $preflight$
begin
  if to_regclass('public.photo_classification_overrides') is not null
     or to_regclass('public.ledger_photo_captions') is not null then
    raise exception 'aoALB ledger sync objects already exist. Do not rerun this migration.';
  end if;
  if to_regclass('public.ledgers') is null or to_regclass('public.photos') is null then
    raise exception 'Required aoALB ledger/photo objects were not found.';
  end if;
end
$preflight$;

alter table public.ledgers
  add column view_mode text not null default 'single' check (view_mode in ('single','spread')),
  add column updated_by uuid references auth.users(id) on delete set null;

create table public.photo_classification_overrides (
  photo_id uuid primary key,
  site_id uuid not null,
  override_data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  edited_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (photo_id, site_id) references public.photos(id, site_id) on delete cascade,
  check (jsonb_typeof(override_data) = 'object'),
  check ((override_data - array['koushu','shubetsu','saibetsu','sokuten','tekiyo']) = '{}'::jsonb),
  check (octet_length(override_data::text) <= 8192)
);

create table public.ledger_photo_captions (
  ledger_id uuid not null,
  photo_id uuid not null,
  site_id uuid not null,
  caption_override jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  edited_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ledger_id, photo_id),
  foreign key (ledger_id, site_id) references public.ledgers(id, site_id) on delete cascade,
  foreign key (photo_id, site_id) references public.photos(id, site_id) on delete restrict,
  check (jsonb_typeof(caption_override) = 'object'),
  check ((caption_override - array['koushu','sokuten','text']) = '{}'::jsonb),
  check (octet_length(caption_override::text) <= 8192)
);

create index photo_classification_overrides_site_idx on public.photo_classification_overrides(site_id, updated_at desc);
create index ledger_photo_captions_site_idx on public.ledger_photo_captions(site_id, ledger_id);

create trigger photo_classification_overrides_revision before update on public.photo_classification_overrides
for each row execute function private.bump_revision();
create trigger ledger_photo_captions_revision before update on public.ledger_photo_captions
for each row execute function private.bump_revision();

alter table public.photo_classification_overrides enable row level security;
alter table public.ledger_photo_captions enable row level security;

create policy photo_overrides_select on public.photo_classification_overrides for select to authenticated
using (private.has_site_role(site_id, 'viewer'));
create policy photo_overrides_insert on public.photo_classification_overrides for insert to authenticated
with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy photo_overrides_update on public.photo_classification_overrides for update to authenticated
using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));

create policy ledger_captions_select on public.ledger_photo_captions for select to authenticated
using (private.has_site_role(site_id, 'viewer'));
create policy ledger_captions_insert on public.ledger_photo_captions for insert to authenticated
with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy ledger_captions_update on public.ledger_photo_captions for update to authenticated
using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id))
with check (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));
create policy ledger_captions_delete on public.ledger_photo_captions for delete to authenticated
using (private.has_site_role(site_id, 'editor') and private.site_is_active(site_id));

create function public.save_photo_classification_override(
  p_photo_id uuid, p_expected_revision bigint, p_override_data jsonb, p_event_id uuid
)
returns table(photo_id uuid, revision bigint, override_data jsonb, updated_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_photo public.photos%rowtype;
  v_existing public.photo_classification_overrides%rowtype;
begin
  select * into v_photo from public.photos p where p.id = p_photo_id for update;
  if not found or not private.has_site_role(v_photo.site_id, 'editor') or not private.site_is_active(v_photo.site_id) then
    raise exception using errcode = '42501', message = 'operation_not_allowed';
  end if;
  if p_override_data is null or jsonb_typeof(p_override_data) <> 'object'
     or (p_override_data - array['koushu','shubetsu','saibetsu','sokuten','tekiyo']) <> '{}'::jsonb
     or octet_length(p_override_data::text) > 8192 then
    raise exception using errcode = '22023', message = 'invalid_override';
  end if;
  select * into v_existing from public.photo_classification_overrides o where o.photo_id = p_photo_id for update;
  if found and p_expected_revision is distinct from v_existing.revision then
    raise exception using errcode = '40001', message = 'revision_conflict';
  elsif not found and coalesce(p_expected_revision, 0) <> 0 then
    raise exception using errcode = '40001', message = 'revision_conflict';
  end if;
  insert into public.photo_classification_overrides(photo_id, site_id, override_data, edited_by)
    values (p_photo_id, v_photo.site_id, p_override_data, auth.uid())
  on conflict on constraint photo_classification_overrides_pkey do update set override_data = excluded.override_data,
    edited_by = auth.uid(), updated_at = now();
  insert into public.sync_events(event_id, site_id, actor_user_id, entity_type, entity_id, event_type, payload)
    values (p_event_id, v_photo.site_id, auth.uid(), 'photo_classification_override', p_photo_id,
      'classification_override_saved', jsonb_build_object('photoId', p_photo_id))
    on conflict (event_id) do nothing;
  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id)
    values (v_photo.site_id, auth.uid(), 'classification_override_saved', 'photo', p_photo_id);
  return query select o.photo_id, o.revision, o.override_data, o.updated_at
    from public.photo_classification_overrides o where o.photo_id = p_photo_id;
end;
$$;

create function public.save_ledger_snapshot(
  p_site_id uuid, p_project_id uuid, p_ledger_id uuid, p_ledger_uid uuid,
  p_expected_revision bigint, p_title text, p_template text, p_show_cover boolean,
  p_view_mode text, p_pages jsonb, p_captions jsonb, p_event_id uuid
)
returns table(ledger_id uuid, ledger_uid uuid, revision bigint, updated_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_ledger public.ledgers%rowtype;
  v_page jsonb; v_slot jsonb; v_caption jsonb;
  v_page_ord bigint; v_slot_ord bigint; v_page_id uuid; v_photo_id uuid;
begin
  if auth.uid() is null or not private.has_site_role(p_site_id, 'editor') or not private.site_is_active(p_site_id) then
    raise exception using errcode = '42501', message = 'operation_not_allowed';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.site_id = p_site_id) then
    raise exception using errcode = '23503', message = 'project_site_mismatch';
  end if;
  if p_ledger_uid is null or char_length(btrim(p_title)) not between 1 and 200
     or p_template <> 'construction-3' or p_view_mode not in ('single','spread')
     or jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) > 500
     or jsonb_typeof(p_captions) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_ledger_snapshot';
  end if;

  if p_ledger_id is null then
    if coalesce(p_expected_revision, 0) <> 0 then raise exception using errcode='40001', message='revision_conflict'; end if;
    insert into public.ledgers(site_id, project_id, ledger_uid, title, template, show_cover, view_mode, updated_by)
      values (p_site_id, p_project_id, p_ledger_uid, btrim(p_title), p_template, p_show_cover, p_view_mode, auth.uid())
      returning * into v_ledger;
  else
    select * into v_ledger from public.ledgers l
      where l.id = p_ledger_id and l.site_id = p_site_id and l.project_id = p_project_id for update;
    if not found then raise exception using errcode='P0002', message='ledger_not_found'; end if;
    if p_expected_revision is distinct from v_ledger.revision then raise exception using errcode='40001', message='revision_conflict'; end if;
    update public.ledgers set title=btrim(p_title), template=p_template, show_cover=p_show_cover,
      view_mode=p_view_mode, updated_by=auth.uid(), updated_at=now() where id=v_ledger.id returning * into v_ledger;
    delete from public.ledger_pages where public.ledger_pages.ledger_id = v_ledger.id;
    delete from public.ledger_photo_captions where public.ledger_photo_captions.ledger_id = v_ledger.id;
  end if;

  for v_page, v_page_ord in select value, ordinality from jsonb_array_elements(p_pages) with ordinality loop
    if jsonb_typeof(v_page->'slots') <> 'array' or jsonb_array_length(v_page->'slots') <> 3 then
      raise exception using errcode='22023', message='ledger_page_requires_three_slots';
    end if;
    insert into public.ledger_pages(site_id, ledger_id, page_index)
      values (p_site_id, v_ledger.id, v_page_ord - 1) returning id into v_page_id;
    for v_slot, v_slot_ord in select value, ordinality from jsonb_array_elements(v_page->'slots') with ordinality loop
      if v_slot->>'type' = 'photo' then
        begin v_photo_id := (v_slot->>'photoId')::uuid; exception when others then
          raise exception using errcode='22023', message='invalid_photo_id'; end;
        if not exists (select 1 from public.photos p where p.id=v_photo_id and p.site_id=p_site_id and p.lifecycle_status='active') then
          raise exception using errcode='23503', message='photo_site_mismatch_or_trashed';
        end if;
        if exists (select 1 from public.ledger_slots s join public.ledger_pages p on p.id=s.page_id
          where p.ledger_id=v_ledger.id and s.photo_id=v_photo_id) then
          raise exception using errcode='23505', message='duplicate_photo_in_ledger';
        end if;
        insert into public.ledger_slots(site_id,page_id,slot_index,slot_type,photo_id)
          values (p_site_id,v_page_id,v_slot_ord-1,'photo',v_photo_id);
      elsif v_slot->>'type' = 'blank' then
        insert into public.ledger_slots(site_id,page_id,slot_index,slot_type,photo_id)
          values (p_site_id,v_page_id,v_slot_ord-1,'blank',null);
      else raise exception using errcode='22023', message='invalid_slot_type'; end if;
    end loop;
  end loop;

  for v_caption in select value from jsonb_array_elements(p_captions) loop
    begin v_photo_id := (v_caption->>'photoId')::uuid; exception when others then
      raise exception using errcode='22023', message='invalid_caption_photo_id'; end;
    if not exists (select 1 from public.photos p where p.id=v_photo_id and p.site_id=p_site_id) then
      raise exception using errcode='23503', message='caption_photo_site_mismatch';
    end if;
    if jsonb_typeof(v_caption->'captionOverride') <> 'object'
       or ((v_caption->'captionOverride') - array['koushu','sokuten','text']) <> '{}'::jsonb then
      raise exception using errcode='22023', message='invalid_caption_override';
    end if;
    insert into public.ledger_photo_captions(ledger_id,photo_id,site_id,caption_override,edited_by)
      values (v_ledger.id,v_photo_id,p_site_id,v_caption->'captionOverride',auth.uid());
  end loop;

  insert into public.sync_events(event_id,site_id,actor_user_id,entity_type,entity_id,event_type,payload)
    values (p_event_id,p_site_id,auth.uid(),'ledger',v_ledger.id,'ledger_snapshot_saved',
      jsonb_build_object('ledgerUid',v_ledger.ledger_uid,'revision',v_ledger.revision))
    on conflict (event_id) do nothing;
  insert into public.audit_logs(site_id,actor_user_id,action,entity_type,entity_id,details)
    values (p_site_id,auth.uid(),'ledger_snapshot_saved','ledger',v_ledger.id,
      jsonb_build_object('revision',v_ledger.revision));
  return query select v_ledger.id,v_ledger.ledger_uid,v_ledger.revision,v_ledger.updated_at;
end;
$$;

create function public.list_site_ledger_snapshots(p_site_id uuid)
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
  ) snapshot from public.ledgers l where l.site_id=p_site_id
) rows;
$$;

revoke all on table public.photo_classification_overrides, public.ledger_photo_captions from public,anon,authenticated;
grant select on table public.photo_classification_overrides, public.ledger_photo_captions to authenticated;
revoke all on function public.save_photo_classification_override(uuid,bigint,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.save_ledger_snapshot(uuid,uuid,uuid,uuid,bigint,text,text,boolean,text,jsonb,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.list_site_ledger_snapshots(uuid) from public,anon,authenticated;
grant execute on function public.save_photo_classification_override(uuid,bigint,jsonb,uuid) to authenticated;
grant execute on function public.save_ledger_snapshot(uuid,uuid,uuid,uuid,bigint,text,text,boolean,text,jsonb,jsonb,uuid) to authenticated;
grant execute on function public.list_site_ledger_snapshots(uuid) to authenticated;

commit;
