# 匿名ユーザーの確認と整理

自動削除は有効化しません。候補は「一定期間より古い」「`site_members`所属なし」「写真、監査、同期データ等から参照されていない」のすべてを満たすユーザーだけです。先にSELECT結果を保存・確認し、対象UUIDを人が確定してから別トランザクションで削除します。

## 1. 候補の確認だけを行う

次のSQLは変更を行いません。保持期間は例として90日です。

```sql
select u.id, u.created_at, u.last_sign_in_at
from auth.users u
where u.is_anonymous is true
  and u.created_at < now() - interval '90 days'
  and not exists (select 1 from public.site_members m where m.user_id = u.id)
  and not exists (select 1 from public.sites s where s.created_by = u.id)
  and not exists (select 1 from public.site_join_codes c where c.changed_by = u.id)
  and not exists (select 1 from public.ledgers l where l.editing_by = u.id)
  and not exists (select 1 from public.sync_events e where e.actor_user_id = u.id)
  and not exists (select 1 from public.audit_logs a where a.actor_user_id = u.id)
order by u.created_at;
```

件数とUUIDを確認し、現場端末として必要な利用者が含まれないことを確認します。結果が不明なら削除しません。

## 2. 確定したUUIDだけを削除する

`CONFIRMED_USER_UUID`は前段で確認したUUIDへ置き換えます。再度すべての参照なし条件を検査し、1件だけ削除されたことを確認します。

```sql
begin;

with deleted as (
  delete from auth.users u
  where u.id = 'CONFIRMED_USER_UUID'::uuid
    and u.is_anonymous is true
    and not exists (select 1 from public.site_members m where m.user_id = u.id)
    and not exists (select 1 from public.sites s where s.created_by = u.id)
    and not exists (select 1 from public.site_join_codes c where c.changed_by = u.id)
    and not exists (select 1 from public.ledgers l where l.editing_by = u.id)
    and not exists (select 1 from public.sync_events e where e.actor_user_id = u.id)
    and not exists (select 1 from public.audit_logs a where a.actor_user_id = u.id)
  returning id
)
select * from deleted;

commit;
```

0件なら条件が変化したため削除されていません。複数UUIDを一括削除せず、1件ずつ照合します。
