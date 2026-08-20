import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/202608180001_system_account_foundation.sql", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../supabase/bootstrap/202608180002_bootstrap_system_admin.sql", import.meta.url), "utf8");
const verification = readFileSync(new URL("../supabase/verification/202608180003_system_account_verification.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollback/202608180099_rollback_system_account_foundation.sql", import.meta.url), "utf8");
const accountBase = readFileSync(new URL("../supabase/migrations/202608050001_account_foundation.sql", import.meta.url), "utf8");

assert.match(migration, /begin;[\s\S]*commit;/i);
assert.match(migration, /create type public\.account_status as enum \('invited', 'active', 'suspended', 'deleted'\)/);
assert.match(migration, /create table public\.system_admins/);
assert.match(migration, /create table public\.account_management_audit/);
assert.match(migration, /create table public\.account_invitation_operations/);
assert.match(migration, /aoalb_invitation_operation_id/);
assert.match(migration, /email_fingerprint/);
assert.doesNotMatch(migration, /account_invitation_operations[\s\S]{0,500}\bemail\s+text/i);
assert.match(migration, /admin_begin_account_invitation/);
assert.match(migration, /admin_record_invitation_auth_user/);
assert.match(migration, /admin_complete_account_invitation/);
assert.match(migration, /admin_mark_invitation_recovery_required/);
assert.match(migration, /not coalesce\(u\.is_anonymous, false\)[\s\S]*p\.status = 'active'/);
assert.match(migration, /private\.is_system_admin/);
assert.match(migration, /create function public\.create_site_for_account/);
assert.match(migration, /extensions\.crypt\(p_site_join_code[\s\S]*extensions\.crypt\(p_site_admin_code/);
assert.doesNotMatch(migration, /create table[\s\S]{0,400}\b(?:join_code|admin_code|site_creation_code)\s+text/i);
assert.match(migration, /foreach v_table in array array\[[\s\S]*ledger_photo_captions/);
assert.match(migration, /grant execute on function public\.consume_account_admin_rate_limit[\s\S]*to service_role/);
assert.match(migration, /revoke all on function public\.consume_account_admin_rate_limit[\s\S]*from public, anon, authenticated, service_role/);
assert.match(accountBase, /create or replace function private\.site_role_for[\s\S]*private\.account_is_active/);

assert.match(bootstrap, /CHANGE_ME_AUTH_UUID/);
assert.match(bootstrap, /CHANGE_ME_EMAIL/);
assert.match(bootstrap, /email_confirmed_at is not null/);
assert.match(bootstrap, /if exists \(select 1 from public\.system_admins\)/);
assert.deepEqual([...bootstrap.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(match => match[0]), ["CHANGE_ME@example.invalid", "CHANGE_ME@example.invalid"]);

assert.match(verification, /plaintext_email_columns/);
assert.match(verification, /authenticated_table_grants/);
assert.match(verification, /public_function_grants/);
assert.match(verification, /write_guard_count/);
assert.match(rollback, /Rollback refused: operational account\/admin state exists/);
assert.match(rollback, /drop trigger if exists account_state_write_guard/);
assert.match(rollback, /drop table public\.account_invitation_operations/);

console.log("system account foundation static checks passed");
