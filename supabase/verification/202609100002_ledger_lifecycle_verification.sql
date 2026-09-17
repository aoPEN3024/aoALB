select jsonb_build_object(
  'deleted_at_column', exists (select 1 from information_schema.columns where table_schema='public' and table_name='ledgers' and column_name='deleted_at'),
  'deleted_by_column', exists (select 1 from information_schema.columns where table_schema='public' and table_name='ledgers' and column_name='deleted_by'),
  'delete_rpc', pg_catalog.to_regprocedure('public.delete_ledger_snapshot(uuid,uuid,bigint,uuid)') is not null,
  'deletion_list_rpc', pg_catalog.to_regprocedure('public.list_site_ledger_deletions(uuid)') is not null,
  'public_delete_execute', has_function_privilege('public', 'public.delete_ledger_snapshot(uuid,uuid,bigint,uuid)', 'EXECUTE'),
  'anon_delete_execute', has_function_privilege('anon', 'public.delete_ledger_snapshot(uuid,uuid,bigint,uuid)', 'EXECUTE'),
  'authenticated_delete_execute', has_function_privilege('authenticated', 'public.delete_ledger_snapshot(uuid,uuid,bigint,uuid)', 'EXECUTE'),
  'photos', (select count(*) from public.photos),
  'photo_objects', (select count(*) from public.photo_objects),
  'storage_objects', (select count(*) from storage.objects where bucket_id='site-photos'),
  'active_ledgers', (select count(*) from public.ledgers where deleted_at is null),
  'deleted_ledgers', (select count(*) from public.ledgers where deleted_at is not null)
);
