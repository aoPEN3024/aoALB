import { loadCloudConfig, loadLocalCloudConfig } from "./cloud/config.js";
import { createSupabaseProvider } from "./cloud/supabase-provider.js?v=20260901-invite-callback1";
import { clearSharedDeviceData, getCloudChanges } from "./storage.js";

const DEVICE_KEY = "aoALB:accountDeviceUid";
const DEVICE_NAME_KEY = "aoALB:accountDeviceName";
const MODE_KEY = "aoALB:sharingMode";
const PENDING_PASSWORD_KEY = "aoALB:pendingPasswordSetup";
const PASSWORD_MODE_UPGRADE = "upgrade";
const PASSWORD_MODE_RECOVERY = "recovery";
const PASSWORD_MODE_SIGNUP = "signup";

const AUTH_CALLBACK_PARAMS = ["code", "state", "error", "error_code", "error_description", "token", "token_hash", "type", "authAction"];
const AUTH_FRAGMENT_PARAMS = ["access_token", "refresh_token", "expires_at", "expires_in", "provider_token", "provider_refresh_token", "token_type", "type", "error", "error_code", "error_description"];

function authFragment(url) {
  return new URLSearchParams(String(url?.hash || "").replace(/^#/, ""));
}

function callbackParam(url, name) {
  return url?.searchParams?.get(name) || authFragment(url).get(name) || "";
}

function safeError(message) {
  const error = new Error(message);
  error.userSafe = true;
  return error;
}

export function classifyAuthFailure(error, callbackUrl = null, authAction = "") {
  const code = String(error?.code || callbackParam(callbackUrl, "error_code") || "").toLowerCase();
  const name = String(error?.name || "").toLowerCase();
  const detail = String(error?.message || callbackParam(callbackUrl, "error_description") || "").toLowerCase();
  const action = [PASSWORD_MODE_RECOVERY, PASSWORD_MODE_UPGRADE, PASSWORD_MODE_SIGNUP].includes(authAction) ? authAction : "";
  if (name === "typeerror" || /failed to fetch|network|offline|load failed/.test(detail)) {
    return { code: "network", action, message: "通信できませんでした。接続を確認して、もう一度お試しください。" };
  }
  if (code === "flow_state_not_found" || code === "bad_code_verifier" || /pkce|code verifier|flow state/.test(detail)) {
    return {
      code: "pkce_missing", action,
      message: "このメールを送ったブラウザで、最新のメールにあるリンクを開いてください。\n別のブラウザやホーム画面のアプリで開くと、確認できない場合があります。もう一度メールを送信し、そのまま同じブラウザでリンクを開いてください。"
    };
  }
  if (code === "otp_expired" || /expired|already used|has been used|one-time/.test(detail)) {
    return { code: "link_expired", action, message: "このリンクは使用済み、または有効期限が切れています。最新のメールからやり直してください。" };
  }
  if (callbackParam(callbackUrl, "code") || callbackParam(callbackUrl, "error") || /invalid.*(code|link|token)|access denied/.test(detail)) {
    return { code: "invalid_link", action, message: "この認証リンクを確認できませんでした。最新のメールからやり直してください。" };
  }
  if (code === "invalid_credentials" || /invalid login credentials/.test(detail)) {
    return { code: "invalid_credentials", action, message: "メールアドレスまたはパスワードを確認してください。" };
  }
  if (/refresh token|session.*(expired|missing|invalid)|jwt/.test(detail)) {
    return { code: "session_expired", action, message: "ログイン情報の有効期限を確認できません。もう一度ログインしてください。" };
  }
  return { code: "auth_failed", action, message: "認証を完了できませんでした。入力内容を確認して、もう一度お試しください。" };
}

function deviceUid() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, value); }
  return value;
}

function redirectUrl(authAction = "") {
  // Keep authentication callbacks on the current app origin and path. The
  // fragment is restored after the callback instead of being included in the
  // Supabase allow-list comparison.
  const url = new URL(location.pathname || "/", location.origin);
  if (authAction) url.searchParams.set("authAction", authAction);
  return url.href;
}

function clearAuthCallbackUrl() {
  const url = new URL(location.href);
  AUTH_CALLBACK_PARAMS.forEach(name => url.searchParams.delete(name));
  const fragment = authFragment(url);
  const isAuthFragment = AUTH_FRAGMENT_PARAMS.some(name => fragment.has(name));
  history.replaceState(history.state, "", `${url.pathname}${url.search}${isAuthFragment ? "#sharing" : (url.hash || "#sharing")}`);
}

export function initAccountUI() {
  const byId = id => document.getElementById(id);
  const ui = {
    panel: byId("account-panel"), state: byId("account-state"), message: byId("account-message"),
    login: byId("account-login-form"), reset: byId("account-reset-form"),
    password: byId("account-new-password-form"), signedIn: byId("account-signed-in"),
    email: byId("account-current-email"), devices: byId("account-device-list"),
    logout: byId("account-logout"), clear: byId("account-clear-device"),
    guide: byId("account-session-guide"), inviteNote: byId("account-invite-note"),
    authRecovery: byId("account-auth-recovery"), authRecoveryMessage: byId("account-auth-recovery-message"),
    resendConfirmation: byId("account-resend-confirmation"), resendPassword: byId("account-resend-password"),
    backToLogin: byId("account-back-to-login")
  };
  if (!ui.panel) return { start: async () => {} };
  let provider = null;
  let unsubscribe = null;
  let busy = false;
  let authNotice = null;

  const setMessage = (text = "", error = false) => {
    ui.message.textContent = text;
    ui.message.classList.toggle("error", error);
  };
  const formValue = (form, name) => String(new FormData(form).get(name) || "");
  const validPassword = value => value.length >= 10 && value.length <= 72;
  const accountForms = [ui.login, ui.reset, ui.password].filter(Boolean);
  const clearSecrets = (...roots) => roots.flat().filter(Boolean).forEach(root => {
    root.querySelectorAll('input[type="password"]').forEach(input => { input.value = ""; });
  });
  const setBusy = value => ui.panel.querySelectorAll("button").forEach(button => { button.disabled = value; });
  const safeMessage = error => error?.userSafe ? error.message : classifyAuthFailure(error).message;

  function renderAuthNotice() {
    ui.authRecovery.hidden = !authNotice;
    if (!authNotice) return;
    ui.authRecoveryMessage.textContent = authNotice.message;
    ui.resendConfirmation.hidden = ![PASSWORD_MODE_SIGNUP, PASSWORD_MODE_UPGRADE].includes(authNotice.action);
    ui.resendPassword.hidden = authNotice.action !== PASSWORD_MODE_RECOVERY;
  }

  async function getProvider() {
    if (provider) return provider;
    const config = loadCloudConfig() || await loadLocalCloudConfig();
    if (!config) throw safeError("共有機能の接続設定がありません。端末内モードは引き続き利用できます。");
    provider = await createSupabaseProvider(config);
    const callbackUrl = new URL(location.href);
    const callbackFragment = authFragment(callbackUrl);
    const hasCallback = AUTH_CALLBACK_PARAMS.some(name => callbackUrl.searchParams.has(name))
      || AUTH_FRAGMENT_PARAMS.some(name => callbackFragment.has(name));
    if (hasCallback) {
      const authAction = callbackParam(callbackUrl, "authAction");
      try {
        if (callbackParam(callbackUrl, "error")) {
          const callbackError = new Error("Authentication callback rejected");
          callbackError.code = callbackParam(callbackUrl, "error_code") || "callback_rejected";
          throw callbackError;
        }
        await provider.consumeAuthCallback(location.href);
        if ([PASSWORD_MODE_RECOVERY, PASSWORD_MODE_SIGNUP].includes(authAction)) {
          localStorage.setItem(PENDING_PASSWORD_KEY, authAction);
        }
      } catch (error) {
        authNotice = classifyAuthFailure(error, callbackUrl, authAction);
      } finally {
        clearAuthCallbackUrl();
      }
    }
    unsubscribe ||= provider.onAuthStateChange(() => { render().catch(() => {}); });
    return provider;
  }

  async function render() {
    let session = null;
    let sessionFailure = null;
    try { session = await (await getProvider()).getAccountSession(); }
    catch (error) {
      sessionFailure = error?.userSafe ? { code: "local_only", message: error.message } : classifyAuthFailure(error);
      setMessage(sessionFailure.message, true);
    }
    ui.login.hidden = Boolean(session);
    ui.reset.hidden = Boolean(session);
    ui.signedIn.hidden = !session || session.anonymous;
    ui.inviteNote.hidden = Boolean(session);
    ui.guide.hidden = true;
    const pendingPasswordMode = localStorage.getItem(PENDING_PASSWORD_KEY);
    ui.password.hidden = !(session && !session.anonymous && ["1", PASSWORD_MODE_UPGRADE, PASSWORD_MODE_RECOVERY].includes(pendingPasswordMode));
    if (!session) {
      ui.state.textContent = sessionFailure
        ? "このブラウザのログイン情報を確認できません。"
        : "このブラウザには、引き継げる利用情報がありません。";
      ui.guide.hidden = false;
      ui.guide.textContent = "共有工事を使うアカウントは管理者から招待を受けてください。以前の端末で作成済みのアカウントがある場合は、そのアカウントでログインしてください。ZIP取込みと端末内台帳はログインなしでも利用できます。";
      window.dispatchEvent(new CustomEvent("aoalb:account-context", { detail: { active: false, status: "signed_out", systemAdmin: false } }));
      renderAuthNotice();
      return;
    }
    if (session.anonymous) {
      ui.state.textContent = "共有工事を利用するには、管理者から招待されたアカウントでログインしてください。";
      ui.guide.hidden = false;
      ui.guide.textContent = "以前の匿名利用情報は自動統合しません。ログアウト後、招待済みアカウントでログインし、工事IDと工事PASSまたは管理者PASSで入り直してください。";
      ui.signedIn.hidden = false;
      ui.email.textContent = "以前の匿名利用状態";
      ui.devices.replaceChildren();
      window.dispatchEvent(new CustomEvent("aoalb:account-context", { detail: { active: false, status: "anonymous", systemAdmin: false } }));
      renderAuthNotice();
      return;
    }
    const context = await provider.getAccountContext().catch(() => null);
    const status = context?.status || "unregistered";
    const isInvited = status === "invited";
    ui.password.hidden = !isInvited && !(session && ["1", PASSWORD_MODE_RECOVERY].includes(pendingPasswordMode));
    if (isInvited) {
      ui.state.textContent = "招待を確認しました。パスワードを設定すると共有工事を利用できます。";
      ui.signedIn.hidden = true;
      ui.inviteNote.hidden = true;
      window.dispatchEvent(new CustomEvent("aoalb:account-context", { detail: { active: false, status, systemAdmin: false } }));
      renderAuthNotice();
      return;
    }
    if (status !== "active") {
      ui.state.textContent = status === "suspended" ? "このアカウントは利用停止中です。管理者へ確認してください。" : "このアカウントは共有工事を利用できません。管理者へ確認してください。";
      ui.guide.hidden = false;
      ui.guide.textContent = "ZIP取込みと端末内台帳は引き続き利用できます。";
      window.dispatchEvent(new CustomEvent("aoalb:account-context", { detail: { active: false, status, systemAdmin: false } }));
      renderAuthNotice();
      return;
    }
    ui.state.textContent = "アカウントで共有工事を利用しています。";
    ui.email.textContent = session.email;
    const rows = await provider.listAccountDevices().catch(() => []);
    ui.devices.replaceChildren(...rows.map(row => {
      const li = document.createElement("li");
      li.textContent = `${row.display_name}（最終利用 ${new Date(row.last_seen_at).toLocaleString("ja-JP")}）`;
      return li;
    }));
    window.dispatchEvent(new CustomEvent("aoalb:account-context", { detail: {
      active: true, status, systemAdmin: context.systemAdmin === true,
      displayName: context.displayName, userId: context.userId
    } }));
    renderAuthNotice();
  }

  async function run(action, { clear = [] } = {}) {
    if (busy) return;
    busy = true; setBusy(true); setMessage("処理しています…");
    try { await action(); await render(); }
    catch (error) { setMessage(safeMessage(error), true); }
    finally { clearSecrets(clear); busy = false; setBusy(false); }
  }

  ui.login.addEventListener("submit", event => {
    event.preventDefault(); run(async () => {
      const p = await getProvider();
      const signedIn = await p.signInWithPassword({ email: formValue(ui.login, "email"), password: formValue(ui.login, "password") });
      const context = await p.getAccountContext();
      if (!context || context.status !== "active") throw safeError(context?.status === "suspended" ? "このアカウントは利用停止中です。" : "管理者から招待された有効なアカウントを確認できません。");
      const name = formValue(ui.login, "deviceName") || "この端末";
      localStorage.setItem(DEVICE_NAME_KEY, name);
      await p.ensureAccountProfile({ displayName: signedIn.displayName || name, deviceUid: deviceUid(), deviceName: name });
      localStorage.setItem(MODE_KEY, "cloud");
      ui.login.reset(); setMessage("ログインしました。共有工事を読み込むため画面を更新します。");
      setTimeout(() => location.reload(), 250);
    }, { clear: [ui.login] });
  });
  ui.reset.addEventListener("submit", event => {
    event.preventDefault(); run(async () => {
      await (await getProvider()).requestPasswordReset({ email: formValue(ui.reset, "email"), redirectTo: redirectUrl("recovery") });
      ui.reset.reset(); setMessage("パスワード再設定メールを送りました。");
    });
  });
  ui.password.addEventListener("submit", event => {
    event.preventDefault(); run(async () => {
      const password = formValue(ui.password, "password");
      if (!validPassword(password) || password !== formValue(ui.password, "confirmation")) throw safeError("10文字以上の同じパスワードを2回入力してください。");
      const passwordMode = localStorage.getItem(PENDING_PASSWORD_KEY);
      await (await getProvider()).updatePassword(password, {
        allowAlreadySet: passwordMode === "1"
      });
      const name = localStorage.getItem(DEVICE_NAME_KEY) || "この端末";
      const session = await provider.getAccountSession();
      const context = await provider.getAccountContext();
      if (context?.status === "invited") await provider.activateInvitedAccount(session?.displayName || context.displayName || name);
      await provider.ensureAccountProfile({ displayName: session?.displayName || name, deviceUid: deviceUid(), deviceName: name });
      localStorage.removeItem(PENDING_PASSWORD_KEY);
      localStorage.setItem(MODE_KEY, "cloud");
      ui.password.reset(); setMessage("パスワードを設定しました。共有工事を読み込むため画面を更新します。");
      setTimeout(() => location.reload(), 250);
    }, { clear: [ui.password] });
  });
  ui.logout.addEventListener("click", () => run(async () => {
    await (await getProvider()).signOut();
    localStorage.setItem(MODE_KEY, "local");
    setMessage("ログアウトしました。端末内データは残っています。");
    setTimeout(() => location.reload(), 250);
  }, { clear: accountForms }));
  ui.clear.addEventListener("click", () => run(async () => {
    const pending = (await getCloudChanges()).filter(item => item.status !== "synced");
    const warning = pending.length ? `\n\n未送信の台帳・分類変更が${pending.length}件あります。消去すると送信できません。` : "";
    if (!confirm(`共有工事の写真キャッシュと台帳をこの端末から消去します。ZIP取込みデータとクラウド原本は削除されません。${warning}\n\nよろしいですか？`)) return;
    const stats = await clearSharedDeviceData();
    await (await getProvider()).signOut(); localStorage.setItem(MODE_KEY, "local");
    setMessage(`端末データを消去しました（工事${stats.projects}件、写真${stats.photos}件、台帳${stats.ledgers}件）。`);
    setTimeout(() => location.reload(), 400);
  }));

  ui.resendConfirmation.addEventListener("click", () => {
    authNotice = null; renderAuthNotice(); clearSecrets(accountForms);
    ui.login.querySelector('input[type="email"]')?.focus();
    setMessage("招待メールを再送する場合は、システム管理者へ依頼してください。");
  });
  ui.resendPassword.addEventListener("click", () => {
    authNotice = null; renderAuthNotice(); clearSecrets(accountForms);
    ui.reset.querySelector('input[type="email"]')?.focus();
    setMessage("メールアドレスを入力して、パスワード再設定メールをもう一度送ってください。");
  });
  ui.backToLogin.addEventListener("click", () => {
    authNotice = null; renderAuthNotice(); clearSecrets(accountForms);
    ui.login.querySelector('input[type="email"]')?.focus(); setMessage("");
  });
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => clearSecrets(accountForms)));
  window.addEventListener("pagehide", () => clearSecrets(accountForms));

  return { start: render, destroy: () => unsubscribe?.() };
}
