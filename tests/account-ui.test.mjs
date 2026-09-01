import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const provider = readFileSync(new URL("../js/cloud/supabase-provider.js", import.meta.url), "utf8");
const account = readFileSync(new URL("../js/account.js", import.meta.url), "utf8");
const sharing = readFileSync(new URL("../js/sharing.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../js/storage.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const systemAdmin = readFileSync(new URL("../js/system-admin.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const authUrlGuide = readFileSync(new URL("../docs/auth-production-url.md", import.meta.url), "utf8");

assert.match(provider, /persistSession:\s*true/);
assert.match(provider, /flowType:\s*"pkce"/);
assert.doesNotMatch(provider, /signUpWithPassword|beginAnonymousUpgrade/);
assert.match(provider, /resetPasswordForEmail/);
assert.match(account, /clearSharedDeviceData/);
assert.match(account, /localStorage\.setItem\(MODE_KEY, "local"\)/);
assert.match(provider, /exchangeCodeForSession\(code\)/);
assert.match(provider, /client\.auth\.setSession\(\{[\s\S]*access_token: accessToken,[\s\S]*refresh_token: refreshToken/);
assert.match(provider, /inviteUserByEmail cannot use PKCE/);
const callbackFunction = provider.slice(provider.indexOf("async consumeAuthCallback"), provider.indexOf("async getAccountSession"));
assert.doesNotMatch(callbackFunction, /current\.session|refreshSession/);
assert.match(provider, /detectSessionInUrl: false/);
assert.match(provider, /data\.session\.user\.is_anonymous === true/);
assert.match(provider, /await client\.auth\.refreshSession\(\)/);
assert.match(provider, /async updatePassword\(password, \{ allowAlreadySet = false \} = \{\}\)[\s\S]*client\.auth\.refreshSession\(\)/);
assert.match(provider, /allowAlreadySet && error\.code === "same_password"/);
assert.match(sharing, /async function ensureMembershipAuth\(\)[\s\S]*authenticate\(\{ allowAnonymous: false \}\)/);
assert.equal((sharing.match(/await ensureMembershipAuth\(\);/g) || []).length, 3);
assert.match(account, /AUTH_CALLBACK_PARAMS\.forEach\(name => url\.searchParams\.delete\(name\)\)/);
assert.match(account, /redirectUrl\("recovery"\)/);
assert.match(account, /new URL\(location\.pathname \|\| "\/", location\.origin\)/);
const redirectFunction = account.slice(account.indexOf("function redirectUrl"), account.indexOf("function clearAuthCallbackUrl"));
assert.doesNotMatch(redirectFunction, /new URL\(location\.href\)/);
assert.doesNotMatch(redirectFunction, /\.hash\s*=/);
assert.match(redirectFunction, /searchParams\.set\("authAction", authAction\)/);
assert.match(account, /const authAction = callbackParam\(callbackUrl, "authAction"\)[\s\S]*PASSWORD_MODE_RECOVERY, PASSWORD_MODE_SIGNUP[\s\S]*localStorage\.setItem\(PENDING_PASSWORD_KEY, authAction\)/);
assert.match(account, /"error_description"[\s\S]*"authAction"/);
assert.match(account, /PASSWORD_MODE_RECOVERY/);
assert.match(account, /activateInvitedAccount/);
assert.match(account, /getAccountContext/);
assert.match(account, /allowAlreadySet: passwordMode === "1"/);
assert.equal(
  account.match(/\.\/cloud\/supabase-provider\.js\?v=[^"']+/)?.[0],
  sharing.match(/\.\/cloud\/supabase-provider\.js\?v=[^"']+/)?.[0]
);
for (const source of [account, sharing, app, html]) {
  assert.doesNotMatch(source, /v=20260731-photo-delete2/);
}
assert.match(account, /supabase-provider\.js\?v=20260901-invite-callback2/);
assert.match(sharing, /supabase-provider\.js\?v=20260901-invite-callback2/);
assert.match(app, /sharing\.js\?v=20260901-invite-callback2/);
assert.match(app, /account\.js\?v=20260901-invite-callback2/);
assert.match(app, /system-admin\.js\?v=20260901-invite-callback2/);
assert.match(html, /app\.js\?v=20260901-invite-callback2/);
assert.match(account, /AUTH_FRAGMENT_PARAMS[\s\S]*access_token[\s\S]*refresh_token/);
assert.match(account, /isAuthFragment \? "#sharing"/);
assert.match(html, /id="sharing-admin-claim-message"/);
assert.match(sharing, /管理者として接続しました。工事：\$\{membership\.siteName\}／権限：\$\{roleLabel\(membership\.role\)\}/);
assert.match(sharing, /const safeMessage = \/15分\|しばらく待って\/i/);
assert.match(authUrlGuide, /Site URL: `https:\/\/aopen3024\.github\.io\/aoALB\/`/);
assert.match(authUrlGuide, /Redirect URL: `https:\/\/aopen3024\.github\.io\/aoALB\/`/);
assert.match(storage, /db\.transaction\(stores, "readwrite"\)/);
assert.match(storage, /sources\.has\("zip"\)/);
for (const id of ["account-login-form", "account-invite-note", "account-reset-form", "account-clear-device", "account-auth-recovery", "system-admin-panel", "system-admin-invitation-recovery", "sharing-create-form"]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.doesNotMatch(html, /id="account-signup-form"|id="account-upgrade-form"/);
assert.match(html, /利用者アカウントは管理者が招待します/);
assert.match(provider, /invokeAccountAdmin/);
assert.match(provider, /createSiteForAccount/);
assert.match(systemAdmin, /textContent/);
assert.match(systemAdmin, /crypto\.randomUUID\(\)/);
assert.match(systemAdmin, /pendingInviteOperationId/);
assert.match(systemAdmin, /retry_invitation/);
assert.match(systemAdmin, /自動修復しません/);
assert.match(systemAdmin, /通常画面からは再開できません/);
assert.doesNotMatch(systemAdmin, /innerHTML|console\.(log|error|warn)|service_role|sb_secret_/i);
assert.match(account, /classifyAuthFailure/);
assert.match(account, /AUTH_CALLBACK_PARAMS\.forEach/);
assert.match(account, /このメールを送ったブラウザで、最新のメールにあるリンクを開いてください/);
assert.match(account, /このリンクは使用済み、または有効期限が切れています/);
assert.match(account, /このブラウザには、引き継げる利用情報がありません/);
assert.doesNotMatch(account, /同じ利用者のままアカウントへ変更/);
assert.match(account, /querySelectorAll\('input\[type="password"\]'\)/);
assert.match(sharing, /clearSharingSecrets/);
assert.match(sharing, /finally \{[\s\S]*clearSharingSecrets\(ui\.adminJoinCode, ui\.adminJoinConfirm\)/);
assert.doesNotMatch(account, /console\.(log|error|warn)/);
assert.doesNotMatch(account, /service_role|sb_secret_/i);
assert.doesNotMatch(account, /localStorage\.setItem\([^\n]*(access_token|refresh_token)|console\.[^(]+\([^\n]*(access_token|refresh_token)/i);
console.log("account UI static checks passed");
