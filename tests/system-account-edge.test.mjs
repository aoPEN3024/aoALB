import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const edge = readFileSync(new URL("../supabase/functions/account-admin/index.ts", import.meta.url), "utf8");

assert.match(edge, /@supabase\/supabase-js@2\.57\.4/);
assert.match(edge, /ALLOWED_ORIGINS\.has\(origin\)/);
assert.match(edge, /admin\.auth\.getUser\(token\)/);
assert.match(edge, /account\?\.status === "active"[\s\S]*systemAdmin\?\.active/);
assert.match(edge, /consume_account_admin_rate_limit/);
assert.match(edge, /findUserByEmail\(email\)[\s\S]*email_already_registered/);
assert.doesNotMatch(edge, /admin\.auth\.admin\.deleteUser/);
assert.match(edge, /invite_profile_failed/);
assert.match(edge, /auditTargetId/);
assert.match(edge, /ban_duration: shouldBan \? "876000h" : "none"/);
assert.match(edge, /AOALB_SUPABASE_SECRET_KEY/);
assert.doesNotMatch(edge, /sb_secret_[A-Za-z0-9_-]+|service_role\s*[:=]\s*["'][^"']+/i);
assert.doesNotMatch(edge, /console\.(log|warn|error)/);

console.log("system account edge static checks passed");
