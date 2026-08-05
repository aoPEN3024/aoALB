import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/202608050001_account_foundation.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollback/202608050099_rollback_account_foundation.sql", import.meta.url), "utf8");

for (const table of ["user_profiles", "account_devices", "account_security_audit"]) {
  assert.match(migration, new RegExp(`create table (?:public|private)\\.${table}`));
}
for (const fn of ["ensure_my_profile", "touch_my_account_device", "list_my_account_devices", "set_my_account_device_active"]) {
  assert.match(migration, new RegExp(`security definer set search_path = ''[\\s\\S]+${fn}|${fn}[\\s\\S]+security definer set search_path = ''`, "i"));
  assert.match(migration, new RegExp(`revoke all on function public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
}
assert.doesNotMatch(migration, /service_role|secret key|password\s*text|email\s*text/i);
assert.match(migration, /when exists[\s\S]+user_profiles[\s\S]+else true/);
assert.match(rollback, /create or replace function private\.site_role_for/);
assert.match(rollback, /drop table if exists public\.user_profiles/);
console.log("account foundation static checks passed");
