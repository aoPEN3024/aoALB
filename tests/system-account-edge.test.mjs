import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const edge = readFileSync(new URL("../supabase/functions/account-admin/index.ts", import.meta.url), "utf8");

assert.match(edge, /@supabase\/supabase-js@2\.57\.4/);
assert.match(edge, /ALLOWED_ORIGINS\.has\(origin\)/);
assert.match(edge, /admin\.auth\.getUser\(token\)/);
assert.match(edge, /account\?\.status === "active"[\s\S]*systemAdmin\?\.active/);
assert.match(edge, /consume_account_admin_rate_limit/);
assert.match(edge, /admin_begin_account_invitation/);
assert.match(edge, /admin_record_invitation_auth_user/);
assert.match(edge, /admin_complete_account_invitation/);
assert.match(edge, /aoalb_invitation_operation_id/);
assert.match(edge, /list_invitation_recovery/);
assert.match(edge, /retry_invitation/);
assert.match(edge, /existingOperationId === operationId/);
assert.match(edge, /invitation_recovery_needs_review/);
assert.doesNotMatch(edge, /admin\.auth\.admin\.deleteUser/);
assert.match(edge, /invite_profile_failed/);
assert.match(edge, /auditTargetId/);
assert.match(edge, /ban_duration: shouldBan \? "876000h" : "none"/);
assert.match(edge, /AOALB_SUPABASE_SECRET_KEY/);
assert.doesNotMatch(edge, /sb_secret_[A-Za-z0-9_-]+|service_role\s*[:=]\s*["'][^"']+/i);
assert.doesNotMatch(edge, /console\.(log|warn|error)/);
assert.doesNotMatch(edge, /from\("account_invitation_operations"\)\.insert/);

console.log("system account edge static checks passed");
