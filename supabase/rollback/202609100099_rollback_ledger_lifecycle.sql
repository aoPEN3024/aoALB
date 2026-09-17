begin;

do $safety$
begin
  if exists (select 1 from public.ledgers where deleted_at is not null) then
    raise exception 'Rollback refused: deleted ledger tombstones exist and their page content cannot be restored automatically.';
  end if;
end
$safety$;

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
  ) snapshot from public.ledgers l where l.site_id=p_site_id
) rows;
$$;

drop function public.list_site_ledger_deletions(uuid);
drop function public.delete_ledger_snapshot(uuid,uuid,bigint,uuid);
drop trigger prevent_deleted_ledger_update on public.ledgers;
drop function private.prevent_deleted_ledger_update();
drop index public.ledgers_active_project_idx;
alter table public.ledgers drop constraint ledgers_deleted_pair, drop column deleted_by, drop column deleted_at;

commit;
