import assert from "node:assert/strict";
import { classifyAuthFailure } from "../js/account.js";

const callback = value => new URL(`https://example.invalid/aoALB/${value}`);

assert.deepEqual(
  classifyAuthFailure(Object.assign(new Error("PKCE code verifier not found in storage"), { code: "flow_state_not_found" }), callback("?code=x&authAction=signup"), "signup"),
  {
    code: "pkce_missing",
    action: "signup",
    message: "このメールを送ったブラウザで、最新のメールにあるリンクを開いてください。\n別のブラウザやホーム画面のアプリで開くと、確認できない場合があります。もう一度メールを送信し、そのまま同じブラウザでリンクを開いてください。"
  }
);
assert.equal(classifyAuthFailure({ code: "otp_expired" }, callback("?error=access_denied"), "recovery").code, "link_expired");
assert.equal(classifyAuthFailure(new TypeError("Failed to fetch")).code, "network");
assert.equal(classifyAuthFailure(new Error("Invalid login credentials")).code, "invalid_credentials");
assert.equal(classifyAuthFailure(new Error("unexpected"), callback("?code=invalid"), "signup").code, "invalid_link");
assert.equal(classifyAuthFailure({ code: "otp_expired" }, callback("#error=access_denied&error_code=otp_expired"), "signup").code, "link_expired");
assert.equal(classifyAuthFailure(new Error("unexpected")).code, "auth_failed");

console.log("auth guidance classification checks passed");
