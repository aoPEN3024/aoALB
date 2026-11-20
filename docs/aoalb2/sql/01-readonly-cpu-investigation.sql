-- aoALB 2 第1段階：現行Supabaseの高CPU調査（読取り専用）
-- 目的：01-current-state.md の候補A〜Gを実測で確定する。
-- 全てSELECT／EXPLAIN（ANALYZEなし）のみ。本番の停止・設定変更・インデックス追加は行わない。
-- 実行はSQL Editor等で、結果を個人情報（メール・完全UUID）を伏せて共有する。
-- 先頭で読取り専用トランザクションにする。
begin transaction read only;
set local statement_timeout = '15s';

-- Q1. 合計実行時間の大きいSQL（pg_stat_statements）
select left(regexp_replace(query, '\s+', ' ', 'g'), 160) as query_head,
       calls, round(total_exec_time::numeric, 0) as total_ms,
       round(mean_exec_time::numeric, 2) as mean_ms, rows,
       round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1) as pct
from pg_stat_statements
order by total_exec_time desc
limit 30;

-- Q2. 呼出回数の多いSQL
select left(regexp_replace(query, '\s+', ' ', 'g'), 160) as query_head, calls,
       round(mean_exec_time::numeric, 2) as mean_ms
from pg_stat_statements order by calls desc limit 30;

-- Q3. aoALBのRPC別（候補A・B）
select left(regexp_replace(query, '\s+', ' ', 'g'), 120) as query_head, calls,
       round(total_exec_time::numeric, 0) as total_ms, round(mean_exec_time::numeric, 2) as mean_ms
from pg_stat_statements
where query ~* '(save_ledger_snapshot|list_site_ledger_snapshots|list_site_ledger_deletions|save_photo_classification_override|photo_ledger_references|check_photo_upload_state|list_my_sites|get_my_account_context|join_site)'
order by total_exec_time desc;

-- Q4. Realtime関連（候補A・G）：list_changes等
select left(regexp_replace(query, '\s+', ' ', 'g'), 120) as query_head, calls,
       round(total_exec_time::numeric, 0) as total_ms
from pg_stat_statements
where query ~* '(realtime\.|list_changes|wal2json|pg_logical_slot)'
order by total_exec_time desc limit 20;

-- Q5. Storageポリシー経由の読取り（候補E）
select left(regexp_replace(query, '\s+', ' ', 'g'), 120) as query_head, calls,
       round(total_exec_time::numeric, 0) as total_ms, round(mean_exec_time::numeric, 2) as mean_ms
from pg_stat_statements
where query ~* 'storage\.objects'
order by total_exec_time desc limit 20;

-- Q6. 実行中・待機中のセッション
select pid, usename, application_name, state, wait_event_type, wait_event,
       now() - xact_start as xact_age, now() - query_start as query_age,
       left(regexp_replace(query, '\s+', ' ', 'g'), 120) as query_head
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
order by query_start nulls last;

-- Q7. idle in transaction
select count(*) as idle_in_tx, max(now() - state_change) as longest
from pg_stat_activity where state = 'idle in transaction';

-- Q8. ロック待ち
select blocked.pid as blocked_pid, blocking.pid as blocking_pid,
       left(blocked.query, 80) as blocked_query, left(blocking.query, 80) as blocking_query
from pg_stat_activity blocked
join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid));

-- Q9. 表ごとの読書き・シーケンシャルスキャン・デッドタプル（候補B・F）
select relname, n_live_tup, n_dead_tup, seq_scan, seq_tup_read, idx_scan,
       n_tup_ins, n_tup_upd, n_tup_del, last_autovacuum, autovacuum_count
from pg_stat_user_tables
where schemaname in ('public', 'private', 'storage')
order by seq_tup_read desc;

-- Q10. 表サイズ（sync_events・audit_logsの増加）
select n.nspname || '.' || c.relname as table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size, c.reltuples::bigint as approx_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname in ('public', 'private', 'storage', 'auth')
order by pg_total_relation_size(c.oid) desc limit 25;

-- Q11. sync_eventsの増え方（日別・種類別、直近14日）
select date_trunc('day', created_at) as day, event_type, count(*)
from public.sync_events
where created_at > now() - interval '14 days'
group by 1, 2 order by 1 desc, 3 desc;

-- Q12. 同じ台帳の保存頻度（候補B・C）：1分あたり最大保存回数
select entity_id as ledger_id_masked_later, date_trunc('minute', created_at) as minute, count(*) as saves
from public.sync_events
where event_type = 'ledger_snapshot_saved' and created_at > now() - interval '14 days'
group by 1, 2 having count(*) >= 5
order by saves desc limit 30;

-- Q13. 台帳規模（候補B：O(枠数²)の影響）
select l.id as ledger_id_masked_later, count(distinct p.id) as pages, count(s.id) as slots
from public.ledgers l
left join public.ledger_pages p on p.ledger_id = l.id
left join public.ledger_slots s on s.page_id = p.id
group by l.id order by slots desc limit 20;

-- Q14. 使われていない／存在しないインデックスの確認
select relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes where schemaname = 'public' order by idx_scan asc;

-- Q15. Storageオブジェクト数・容量
select bucket_id, count(*) as objects,
       pg_size_pretty(sum(coalesce((metadata->>'size')::bigint, 0))) as total_size
from storage.objects group by bucket_id;

-- Q16. 実行計画（ANALYZEなし＝実行しない）
-- 候補E：Storage読取りポリシーが使う検索
explain
select 1 from public.photo_objects po
join public.photos p on p.id = po.photo_id and p.site_id = po.site_id
where po.site_id::text = '00000000-0000-4000-8000-000000000000'
  and p.lifecycle_status = 'active'
  and (po.object_path = 'x' or po.thumbnail_object_path = 'x');

-- 候補B：重複写真チェック
explain
select 1 from public.ledger_slots s join public.ledger_pages p on p.id = s.page_id
where p.ledger_id = '00000000-0000-4000-8000-000000000000'
  and s.photo_id = '00000000-0000-4000-8000-000000000000';

-- 候補F：送信時のsha256検索
explain
select id from public.photos
where site_id = '00000000-0000-4000-8000-000000000000' and sha256 = repeat('0', 64);

rollback;

-- Realtime接続数・重複購読は、Supabase Dashboard の Realtime > Inspector／Reports と
-- PostgRESTログ（Logs Explorer）の時間帯別リクエスト数で確認する。
-- EXPLAIN ANALYZE（実際に実行）とIndex Advisorは、結果を見て必要な文だけ別途許可を得て実施する。
