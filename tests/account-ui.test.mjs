import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const provider = readFileSync(new URL("../js/cloud/supabase-provider.js", import.meta.url), "utf8");
const account = readFileSync(new URL("../js/account.js", import.meta.url), "utf8");
const sharing = readFileSync(new URL("../js/sharing.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../js/storage.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const authUrlGuide = readFileSync(new URL("../docs/auth-production-url.md", import.meta.url), "utf8");

assert.match(provider, /persistSession:\s*true/);
assert.match(provider, /flowType:\s*"pkce"/);
assert.match(provider, /updateUser\([\s\S]*email/);
assert.match(provider, /resetPasswordForEmail/);
assert.match(account, /clearSharedDeviceData/);
assert.match(account, /localStorage\.setItem\(MODE_KEY, "local"\)/);
assert.match(provider, /exchangeCodeForSession\(code\)/);
assert.match(provider, /detectSessionInUrl: false/);
assert.match(provider, /data\.session\.user\.is_anonymous === true/);
assert.match(provider, /await client\.auth\.refreshSession\(\)/);
assert.match(provider, /async updatePassword\(password, \{ allowAlreadySet = false \} = \{\}\)[\s\S]*client\.auth\.refreshSession\(\)/);
assert.match(provider, /allowAlreadySet && error\.code === "same_password"/);
assert.match(account, /searchParams\.delete\("code"\)/);
assert.match(account, /redirectUrl\("recovery"\)/);
assert.match(account, /searchParams\.get\("authAction"\) === PASSWORD_MODE_RECOVERY[\s\S]*localStorage\.setItem\(PENDING_PASSWORD_KEY, PASSWORD_MODE_RECOVERY\)/);
assert.match(account, /searchParams\.delete\("authAction"\)/);
assert.match(account, /PASSWORD_MODE_UPGRADE/);
assert.match(account, /PASSWORD_MODE_RECOVERY/);
assert.match(account, /\["1", PASSWORD_MODE_UPGRADE, PASSWORD_MODE_RECOVERY\]\.includes\(pendingPasswordMode\)/);
assert.match(account, /allowAlreadySet: passwordMode === PASSWORD_MODE_UPGRADE \|\| passwordMode === "1"/);
assert.equal(
  account.match(/\.\/cloud\/supabase-provider\.js\?v=[^"']+/)?.[0],
  sharing.match(/\.\/cloud\/supabase-provider\.js\?v=[^"']+/)?.[0]
);
for (const source of [account, sharing, app, html]) {
  assert.doesNotMatch(source, /v=20260731-photo-delete2/);
}
assert.match(account, /supabase-provider\.js\?v=20260805-account-common1/);
assert.match(sharing, /supabase-provider\.js\?v=20260805-account-common1/);
assert.match(app, /sharing\.js\?v=20260805-account-common1/);
assert.match(app, /account\.js\?v=20260805-account-common1/);
assert.match(html, /app\.js\?v=20260805-account-common1/);
assert.match(authUrlGuide, /Site URL: `https:\/\/aopen3024\.github\.io\/aoALB\/`/);
assert.match(authUrlGuide, /Redirect URL: `https:\/\/aopen3024\.github\.io\/aoALB\/`/);
assert.match(storage, /db\.transaction\(stores, "readwrite"\)/);
assert.match(storage, /sources\.has\("zip"\)/);
for (const id of ["account-login-form", "account-signup-form", "account-upgrade-form", "account-reset-form", "account-clear-device"]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.doesNotMatch(account, /service_role|sb_secret_|access_token|refresh_token/i);
console.log("account UI static checks passed");
