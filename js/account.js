import { loadCloudConfig, loadLocalCloudConfig } from "./cloud/config.js";
import { createSupabaseProvider } from "./cloud/supabase-provider.js?v=20260810-account-auth2";
import { clearSharedDeviceData } from "./storage.js";

const DEVICE_KEY = "aoALB:accountDeviceUid";
const DEVICE_NAME_KEY = "aoALB:accountDeviceName";
const MODE_KEY = "aoALB:sharingMode";
const PENDING_PASSWORD_KEY = "aoALB:pendingPasswordSetup";
const PASSWORD_MODE_UPGRADE = "upgrade";
const PASSWORD_MODE_RECOVERY = "recovery";

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
  url.searchParams.delete("code");
  url.searchParams.delete("authAction");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash || "#sharing"}`);
}

export function initAccountUI() {
  const byId = id => document.getElementById(id);
  const ui = {
    panel: byId("account-panel"), state: byId("account-state"), message: byId("account-message"),
    login: byId("account-login-form"), signup: byId("account-signup-form"),
    upgrade: byId("account-upgrade-form"), reset: byId("account-reset-form"),
    password: byId("account-new-password-form"), signedIn: byId("account-signed-in"),
    email: byId("account-current-email"), devices: byId("account-device-list"),
    logout: byId("account-logout"), clear: byId("account-clear-device")
  };
  if (!ui.panel) return { start: async () => {} };
  let provider = null;
  let unsubscribe = null;
  let busy = false;

  const setMessage = (text = "", error = false) => {
    ui.message.textContent = text;
    ui.message.classList.toggle("error", error);
  };
  const formValue = (form, name) => String(new FormData(form).get(name) || "");
  const validPassword = value => value.length >= 10 && value.length <= 72;

  async function getProvider() {
    if (provider) return provider;
    const config = loadCloudConfig() || await loadLocalCloudConfig();
    if (!config) throw new Error("共有機能の接続設定がありません。端末内モードは引き続き利用できます。");
    provider = await createSupabaseProvider(config);
    const callbackUrl = new URL(location.href);
    if (callbackUrl.searchParams.has("code")) {
      await provider.consumeAuthCallback(location.href);
      if (callbackUrl.searchParams.get("authAction") === PASSWORD_MODE_RECOVERY) {
        localStorage.setItem(PENDING_PASSWORD_KEY, PASSWORD_MODE_RECOVERY);
      }
      clearAuthCallbackUrl();
    }
    unsubscribe ||= provider.onAuthStateChange(() => { render().catch(() => {}); });
    return provider;
  }

  async function render() {
    let session = null;
    try { session = await (await getProvider()).getAccountSession(); }
    catch (error) { setMessage(error.message, true); }
    ui.login.hidden = Boolean(session);
    ui.signup.hidden = Boolean(session);
    ui.reset.hidden = Boolean(session);
    ui.upgrade.hidden = !session?.anonymous;
    ui.signedIn.hidden = !session || session.anonymous;
    const pendingPasswordMode = localStorage.getItem(PENDING_PASSWORD_KEY);
    ui.password.hidden = !(session && !session.anonymous && ["1", PASSWORD_MODE_UPGRADE, PASSWORD_MODE_RECOVERY].includes(pendingPasswordMode));
    if (!session) {
      ui.state.textContent = "ログインしていません。端末内のZIP取込みと台帳はそのまま利用できます。";
      return;
    }
    if (session.anonymous) {
      ui.state.textContent = "この端末だけで共有工事を利用しています。メール登録すると他の端末でも同じ工事を利用できます。";
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
  }

  async function run(action) {
    if (busy) return;
    busy = true; setMessage("処理しています…");
    try { await action(); await render(); }
    catch (error) { setMessage(error?.message || "処理を完了できませんでした。", true); }
    finally { busy = false; }
  }

  ui.login.addEventListener("submit", event => {
    event.preventDefault(); run(async () => {
      const p = await getProvider();
      const signedIn = await p.signInWithPassword({ email: formValue(ui.login, "email"), password: formValue(ui.login, "password") });
      const name = formValue(ui.login, "deviceName") || "この端末";
      localStorage.setItem(DEVICE_NAME_KEY, name);
      await p.ensureAccountProfile({ displayName: signedIn.displayName || name, deviceUid: deviceUid(), deviceName: name });
      localStorage.setItem(MODE_KEY, "cloud");
      ui.login.reset(); setMessage("ログインしました。共有工事を読み込むため画面を更新します。");
      setTimeout(() => location.reload(), 250);
    });
  });
  ui.signup.addEventListener("submit", event => {
    event.preventDefault(); run(async () => {
      const password = formValue(ui.signup, "password");
      if (!validPassword(password) || password !== formValue(ui.signup, "confirmation")) throw new Error("10文字以上の同じパスワードを2回入力してください。");
      const result = await (await getProvider()).signUpWithPassword({
        email: formValue(ui.signup, "email"), password,
        displayName: formValue(ui.signup, "displayName"), redirectTo: redirectUrl()
      });
      ui.signup.reset();
      setMessage(result.confirmationRequired ? "確認メールを送りました。メール内のリンクを開いてください。" : "アカウントを作成しました。");
    });
  });
  ui.upgrade.addEventListener("submit", event => {
    event.preventDefault(); run(async () => {
      await (await getProvider()).beginAnonymousUpgrade({
        email: formValue(ui.upgrade, "email"), displayName: formValue(ui.upgrade, "displayName"), redirectTo: redirectUrl()
      });
      localStorage.setItem(PENDING_PASSWORD_KEY, PASSWORD_MODE_UPGRADE);
      ui.upgrade.reset();
      setMessage("確認メールを送りました。メール内のリンクを開いた後、パスワードを設定してください。現在の工事と権限は維持されます。");
    });
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
      if (!validPassword(password) || password !== formValue(ui.password, "confirmation")) throw new Error("10文字以上の同じパスワードを2回入力してください。");
      const passwordMode = localStorage.getItem(PENDING_PASSWORD_KEY);
      await (await getProvider()).updatePassword(password, {
        allowAlreadySet: passwordMode === PASSWORD_MODE_UPGRADE || passwordMode === "1"
      });
      const name = localStorage.getItem(DEVICE_NAME_KEY) || "この端末";
      const session = await provider.getAccountSession();
      await provider.ensureAccountProfile({ displayName: session?.displayName || name, deviceUid: deviceUid(), deviceName: name });
      localStorage.removeItem(PENDING_PASSWORD_KEY);
      ui.password.reset(); setMessage("パスワードを設定しました。");
    });
  });
  ui.logout.addEventListener("click", () => run(async () => {
    await (await getProvider()).signOut();
    localStorage.setItem(MODE_KEY, "local");
    setMessage("ログアウトしました。端末内データは残っています。");
    setTimeout(() => location.reload(), 250);
  }));
  ui.clear.addEventListener("click", () => run(async () => {
    if (!confirm("共有工事の写真キャッシュと台帳をこの端末から消去します。ZIP取込みデータとクラウド原本は削除されません。よろしいですか？")) return;
    const stats = await clearSharedDeviceData();
    await (await getProvider()).signOut(); localStorage.setItem(MODE_KEY, "local");
    setMessage(`端末データを消去しました（工事${stats.projects}件、写真${stats.photos}件、台帳${stats.ledgers}件）。`);
    setTimeout(() => location.reload(), 400);
  }));

  return { start: render, destroy: () => unsubscribe?.() };
}
