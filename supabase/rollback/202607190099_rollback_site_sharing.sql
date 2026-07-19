-- DESTRUCTIVE: removes every aoALB cloud-sharing table and all data in them.
-- Use only before production data is stored, after making any required backup.
-- pgcrypto is intentionally kept because other Supabase features may use it.

begin;

do $preflight$
begin
  if exists (select 1 from storage.objects where bucket_id = 'site-photos') then
    raise exception 'site-photos contains objects. Rollback stopped before changing anything.';
  end if;
end
$preflight$;

do $realtime$
begin
  if exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_events'
  ) then
    execute 'alter publication supabase_realtime drop table public.sync_events';
  end if;
end
$realtime$;

drop policy if exists site_photos_select on storage.objects;
drop policy if exists site_photos_insert on storage.objects;
drop policy if exists site_photos_update on storage.objects;
drop policy if exists site_photos_delete on storage.objects;
delete from storage.buckets where id = 'site-photos';

drop function if exists public.begin_ledger_edit(uuid, bigint);
drop function if exists public.set_site_member_active(uuid, uuid, boolean);
drop function if exists public.rotate_site_join_code(uuid, text, public.site_role);
drop function if exists public.join_site(text, text, text);

drop table if exists public.audit_logs;
drop table if exists public.sync_events;
drop table if exists public.ledger_slots;
drop table if exists public.ledger_pages;
drop table if exists public.ledgers;
drop table if exists public.photo_objects;
drop table if exists public.photos;
drop table if exists public.projects;
drop table if exists public.site_join_attempts;
drop table if exists public.site_members;
drop table if exists public.site_join_codes;
drop table if exists public.sites;

drop function if exists private.bump_revision();
drop function if exists private.has_site_role_text(text, public.site_role);
drop function if exists private.has_site_role(uuid, public.site_role);
drop function if exists private.site_role_for(uuid);
drop function if exists private.role_rank(public.site_role);
drop schema if exists private;
drop type if exists public.site_role;

commit;
