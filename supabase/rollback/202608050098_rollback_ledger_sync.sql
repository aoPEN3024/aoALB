-- Destructive rollback for the ledger sync migration only. Never run during normal operation.
begin;
drop function if exists public.list_site_ledger_snapshots(uuid);
drop function if exists public.save_ledger_snapshot(uuid,uuid,uuid,uuid,bigint,text,text,boolean,text,jsonb,jsonb,uuid);
drop function if exists public.save_photo_classification_override(uuid,bigint,jsonb,uuid);
drop table if exists public.ledger_photo_captions;
drop table if exists public.photo_classification_overrides;
alter table public.ledgers drop column if exists updated_by, drop column if exists view_mode;
commit;
