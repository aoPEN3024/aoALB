-- GUARDED FEATURE ROLLBACK.
-- Run only after explicit approval. This script refuses to run after an
-- administrator code has been configured or used, because automatically
-- demoting recovered administrator memberships would be unsafe.
-- It does not delete sites, memberships, photos, ledgers or Storage objects.

begin;

do $$
begin
  if exists (select 1 from private.site_admin_codes)
     or exists (select 1 from private.site_admin_access_audit) then
    raise exception
      'site_admin_recovery_in_use: review memberships and recovery audit before rollback';
  end if;
end;
$$;

drop function if exists public.create_site(text,text,text,text,text,text);
drop function if exists public.list_my_sites();
drop function if exists public.claim_site_admin(text,text,text);
drop function if exists public.set_initial_site_admin_code(uuid,bigint,text);
drop function if exists public.rotate_site_admin_code(uuid,bigint,text);
drop function if exists public.list_site_members_admin(uuid);
drop function if exists public.set_site_member_active_v2(uuid,uuid,boolean,bigint);
drop function if exists private.site_admin_code_is_valid(text);

drop table if exists private.site_admin_access_audit;
drop table if exists private.site_admin_attempts;
drop table if exists private.site_admin_codes;

-- Restore the creator-bound delete rule from
-- 202607270001_shared_project_lifecycle.sql.
create or replace function public.delete_empty_site(
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

revoke all on function public.delete_empty_site(uuid,bigint,text)
  from public, anon, authenticated;
grant execute on function public.delete_empty_site(uuid,bigint,text)
  to authenticated;

commit;
