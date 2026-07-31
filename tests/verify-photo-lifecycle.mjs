import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../supabase/migrations/202607310001_photo_lifecycle.sql", import.meta.url),
  "utf8"
);
const rollback = await readFile(
  new URL("../supabase/rollback/202607310099_rollback_photo_lifecycle.sql", import.meta.url),
  "utf8"
);

for (const column of [
  "lifecycle_status",
  "trashed_at",
  "trashed_by",
  "trash_revision",
  "delete_error"
]) {
  assert.match(migration, new RegExp(`add column ${column}\\b`));
}

for (const rpc of [
  "photo_ledger_references",
  "check_photo_upload_state",
  "trash_photo",
  "restore_photo"
]) {
  assert.match(migration, new RegExp(`create function public\\.${rpc}\\b`));
  assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}`));
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}`));
}

assert.equal(
  (migration.match(/security definer\s+set search_path = ''/g) || []).length,
  4,
  "Every public lifecycle RPC must fix search_path"
);
assert.match(migration, /private\.has_site_role\(v_photo\.site_id, 'admin'\)/);
assert.match(migration, /private\.site_is_active\(v_photo\.site_id\)/);
assert.match(migration, /from public\.ledger_slots[\s\S]*photo_id = v_photo\.id/);
assert.match(migration, /event_type, payload[\s\S]*'photo_trashed'/);
assert.match(migration, /event_type, payload[\s\S]*'photo_restored'/);
assert.doesNotMatch(migration, /service_role|secret key|database password/i);
assert.match(rollback, /rollback refused: non-active photos exist/);

console.log("photo lifecycle SQL static verification: OK");
