import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/202609090001_legacy_aopic_photo_sync.sql", import.meta.url), "utf8");
const verification = readFileSync(new URL("../supabase/verification/202609090002_legacy_aopic_photo_sync_verification.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollback/202609090099_rollback_legacy_aopic_photo_sync.sql", import.meta.url), "utf8");

assert.match(migration, /^begin;[\s\S]*commit;\s*$/i);
assert.match(migration, /coalesce\(u\.is_anonymous, false\)/);
assert.match(migration, /m\.active/);
assert.match(migration, /m\.role in \('admin'::public\.site_role, 'editor'::public\.site_role\)/);
assert.match(migration, /tg_op = 'INSERT'/);
assert.match(migration, /array\['projects', 'photos', 'photo_objects', 'sync_events'\]/);
assert.doesNotMatch(migration, /tg_op = '(?:UPDATE|DELETE)'/);
assert.match(migration, /private\.site_is_active\(site_id\)/);
assert.match(migration, /actor_user_id = \(select auth\.uid\(\)\)/);
assert.match(migration, /\(photos\|thumbnails\)/);
assert.match(migration, /bucket_id = 'site-photos'/);
assert.match(migration, /create policy legacy_aopic_storage_select/);
assert.doesNotMatch(migration, /create policy legacy_aopic_[\s\S]{0,180}for delete/i);
assert.doesNotMatch(migration, /create policy legacy_aopic_[\s\S]{0,180}on public\.(ledgers|ledger_pages|ledger_slots)/i);
assert.doesNotMatch(migration, /grant (?:select|insert|update|delete) on/i);
assert.match(verification, /anonymous_users_unchanged/);
assert.match(verification, /storage_objects_unchanged/);
assert.match(rollback, /create or replace function private\.enforce_active_account_write/);
assert.match(rollback, /drop policy if exists legacy_aopic_storage_update/);

console.log("legacy aoPIC anonymous photo sync static checks passed");
