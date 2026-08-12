-- Read-only verification after 202608050003_ledger_sync.sql.
select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('photo_classification_overrides','ledger_photo_captions');

select tablename,policyname,cmd,roles from pg_policies
where schemaname='public' and tablename in ('photo_classification_overrides','ledger_photo_captions')
order by tablename,policyname;

select p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('save_photo_classification_override','save_ledger_snapshot','list_site_ledger_snapshots');

select routine_name,grantee from information_schema.routine_privileges
where routine_schema='public' and routine_name in ('save_photo_classification_override','save_ledger_snapshot','list_site_ledger_snapshots')
order by routine_name,grantee;

select count(*) as existing_ledgers_unchanged from public.ledgers;
select count(*) as existing_pages_unchanged from public.ledger_pages;
select count(*) as existing_slots_unchanged from public.ledger_slots;
select count(*) as overrides_created_by_migration from public.photo_classification_overrides;
select count(*) as captions_created_by_migration from public.ledger_photo_captions;
