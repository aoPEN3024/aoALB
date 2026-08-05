import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const provider = readFileSync(new URL("../js/cloud/supabase-provider.js", import.meta.url), "utf8");
const account = readFileSync(new URL("../js/account.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../js/storage.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(provider, /persistSession:\s*true/);
assert.match(provider, /flowType:\s*"pkce"/);
assert.match(provider, /updateUser\([\s\S]*email/);
assert.match(provider, /resetPasswordForEmail/);
assert.match(account, /clearSharedDeviceData/);
assert.match(account, /localStorage\.setItem\(MODE_KEY, "local"\)/);
assert.match(storage, /db\.transaction\(stores, "readwrite"\)/);
assert.match(storage, /sources\.has\("zip"\)/);
for (const id of ["account-login-form", "account-signup-form", "account-upgrade-form", "account-reset-form", "account-clear-device"]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.doesNotMatch(account, /service_role|sb_secret_|access_token|refresh_token/i);
console.log("account UI static checks passed");
