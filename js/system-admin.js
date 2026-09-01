import { loadCloudConfig, loadLocalCloudConfig } from "./cloud/config.js";
import { createSupabaseProvider } from "./cloud/supabase-provider.js?v=20260901-invite-callback2";

const STATUS_LABELS = {
  invited: "招待中",
  active: "利用中",
  suspended: "停止中",
  deleted: "削除済み"
};

const ACTION_LABELS = {
  "account.invite": "利用者を招待",
  "account.invite_auth_created": "招待アカウントを作成",
  "account.invite_recovery_required": "招待の復旧が必要",
  "account.invite_recovered": "招待を復旧",
  "account.invite_resend": "招待メールを再送",
  "account.password_reset": "再設定メールを送信",
  "account.suspend": "利用を停止",
  "account.resume": "利用を再開",
  "account.delete_equivalent": "アカウントを削除扱いに変更"
};

function formatDate(value) {
  if (!value) return "―";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "―" : date.toLocaleString("ja-JP");
}

function safeAdminMessage(error) {
  const code = String(error?.code || "");
  const messages = {
    temporarily_limited: "操作が続いたため一時的に制限されています。しばらく待ってからお試しください。",
    invalid_input: "入力内容を確認してください。",
    email_already_registered: "このメールアドレスは登録済みです。利用者一覧を確認してください。",
    account_not_found: "対象の利用者を確認できませんでした。最新の一覧を読み込んでください。",
    invitation_unavailable: "この利用者へ招待メールを再送できません。",
    invitation_recovery_needs_review: "自動復旧できない招待があります。復旧対象を確認してください。既存利用者へ自動統合はしません。",
    confirmation_mismatch: "確認入力が一致しません。",
    self_change_not_allowed: "自分自身にはこの操作を実行できません。",
    system_admin_delete_not_allowed: "システム管理者は削除扱いにできません。",
    last_system_admin: "最後のシステム管理者は停止または削除できません。",
    sole_site_admin: "この利用者だけが管理している工事があります。別の管理者を用意してください。",
    storage_owner_exists: "この利用者が管理する写真データがあるため削除扱いにできません。",
    deleted_account_cannot_resume: "削除扱いのアカウントは再開できません。"
  };
  return messages[code] || "操作を完了できませんでした。時間をおいてもう一度お試しください。";
}

export function initSystemAdminUI() {
  const panel = document.getElementById("system-admin-panel");
  if (!panel) return { destroy() {} };
  const inviteForm = document.getElementById("system-admin-invite-form");
  const refreshButton = document.getElementById("system-admin-refresh");
  const message = document.getElementById("system-admin-message");
  const usersRoot = document.getElementById("system-admin-users");
  const auditRoot = document.getElementById("system-admin-audit");
  const recoveryRoot = document.getElementById("system-admin-invitation-recovery");
  let provider = null;
  let busy = false;
  let currentUserId = "";
  let pendingInviteOperationId = "";
  let pendingInviteSignature = "";

  const setMessage = (value = "", error = false) => {
    message.textContent = value;
    message.classList.toggle("error", error);
  };

  function setBusy(value) {
    busy = value;
    panel.querySelectorAll("button, input").forEach(control => { control.disabled = value; });
  }

  async function getProvider() {
    if (provider) return provider;
    const config = loadCloudConfig() || await loadLocalCloudConfig();
    if (!config) throw new Error("cloud_unavailable");
    provider = await createSupabaseProvider(config);
    return provider;
  }

  async function invoke(payload) {
    return (await getProvider()).invokeAccountAdmin(payload);
  }

  function actionButton(label, action, className = "secondary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  async function run(label, action) {
    if (busy) return false;
    setBusy(true);
    setMessage(`${label}しています…`);
    try {
      await action();
      setMessage(`${label}しました。`);
      await loadAll();
      return true;
    } catch (error) {
      setMessage(safeAdminMessage(error), true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function renderUsers(users) {
    usersRoot.replaceChildren(...users.map(user => {
      const card = document.createElement("article");
      card.className = "system-admin-user";
      const heading = document.createElement("div");
      heading.className = "system-admin-user-heading";
      const name = document.createElement("h3");
      name.textContent = user.status === "deleted" ? "削除済み利用者" : (user.displayName || "名称未設定");
      const badge = document.createElement("span");
      badge.className = `account-status account-status-${user.status}`;
      badge.textContent = STATUS_LABELS[user.status] || "確認できません";
      heading.append(name, badge);
      const email = document.createElement("p");
      email.className = "system-admin-email";
      email.textContent = user.email || "メールアドレスなし";
      const meta = document.createElement("p");
      meta.className = "limit-note";
      meta.textContent = `所属工事 ${Number(user.siteCount || 0)}件／最終利用 ${formatDate(user.lastUsedAt)}${user.systemAdmin ? "／システム管理者" : ""}`;
      const actions = document.createElement("div");
      actions.className = "sharing-actions system-admin-user-actions";
      if (user.status === "invited") {
        actions.append(actionButton("招待メールを再送", () => run("招待メールを再送", () => invoke({ action: "resend_invite", targetUserId: user.userId }))));
      }
      if (user.status === "active" && !user.systemAdmin && user.userId !== currentUserId) {
        actions.append(actionButton("利用を停止", () => {
          if (confirm(`${user.displayName || "この利用者"}の利用を停止しますか？`)) run("利用を停止", () => invoke({ action: "suspend", targetUserId: user.userId }));
        }, "danger-outline"));
      }
      if (user.status === "suspended") {
        actions.append(actionButton("利用を再開", () => run("利用を再開", () => invoke({ action: "resume", targetUserId: user.userId }))));
      }
      if (user.status === "active" || user.status === "suspended") {
        actions.append(actionButton("再設定メールを送る", () => run("再設定メールを送信", () => invoke({ action: "send_password_reset", targetUserId: user.userId }))));
      }
      if (!user.systemAdmin && user.userId !== currentUserId && user.status !== "deleted") {
        actions.append(actionButton("削除扱いにする", () => {
          const entered = prompt(`写真・台帳・監査記録は保持したまま、この利用者を削除扱いにします。通常画面からは再開できません。確認のためメールアドレスを入力してください。\n${user.email}`);
          if (entered === null) return;
          run("アカウントを削除扱いに変更", () => invoke({ action: "delete_equivalent", targetUserId: user.userId, confirmEmail: entered }));
        }, "danger-outline"));
      }
      card.append(heading, email, meta, actions);
      return card;
    }));
  }

  function renderRecovery(rows) {
    recoveryRoot.replaceChildren(...rows.map(row => {
      const card = document.createElement("article");
      card.className = "system-admin-user system-admin-recovery-item";
      const heading = document.createElement("h3");
      heading.textContent = row.displayName || "名称未設定";
      const email = document.createElement("p");
      email.className = "system-admin-email";
      email.textContent = row.email || "メールアドレスを確認できません";
      const note = document.createElement("p");
      note.className = "limit-note";
      note.textContent = row.automaticallyRecoverable
        ? "今回の招待操作で作成された利用者と確認できました。プロフィール保存だけを安全に再実行できます。"
        : "今回の招待操作で作成された利用者と確認できないため、自動修復しません。システム保守で確認してください。";
      card.append(heading, email, note);
      if (row.automaticallyRecoverable) {
        card.append(actionButton("招待処理を復旧", () => run("招待処理を復旧", () => invoke({
          action: "retry_invitation", operationId: row.operationId
        }))));
      }
      return card;
    }));
    recoveryRoot.closest("details").hidden = rows.length === 0;
  }

  function renderAudit(rows) {
    auditRoot.replaceChildren(...rows.map(row => {
      const item = document.createElement("p");
      item.className = "system-admin-audit-item";
      item.textContent = `${formatDate(row.occurred_at)}／${ACTION_LABELS[row.action] || "管理操作"}／${row.succeeded ? "成功" : "失敗"}`;
      return item;
    }));
  }

  async function loadAll() {
    const [userResult, auditResult, recoveryResult] = await Promise.all([
      invoke({ action: "list_users" }), invoke({ action: "list_audit" }),
      invoke({ action: "list_invitation_recovery" })
    ]);
    renderUsers(Array.isArray(userResult.users) ? userResult.users : []);
    renderAudit(Array.isArray(auditResult.audit) ? auditResult.audit : []);
    renderRecovery(Array.isArray(recoveryResult.recovery) ? recoveryResult.recovery : []);
  }

  inviteForm.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(inviteForm);
    const displayName = String(data.get("displayName") || "").trim();
    const email = String(data.get("email") || "").trim();
    const signature = `${displayName}\u0000${email.toLowerCase()}`;
    if (!pendingInviteOperationId || pendingInviteSignature !== signature) {
      pendingInviteOperationId = crypto.randomUUID();
      pendingInviteSignature = signature;
    }
    const completed = await run("招待メールを送信", async () => {
      await invoke({ action: "invite", operationId: pendingInviteOperationId, displayName, email });
    });
    if (completed) {
      inviteForm.reset();
      pendingInviteOperationId = "";
      pendingInviteSignature = "";
    }
  });
  refreshButton.addEventListener("click", () => run("一覧を更新", async () => {}));

  const onContext = async event => {
    const context = event.detail || {};
    currentUserId = context.userId || "";
    panel.hidden = !(context.active && context.systemAdmin);
    if (panel.hidden) {
      usersRoot.replaceChildren();
      auditRoot.replaceChildren();
      recoveryRoot.replaceChildren();
      return;
    }
    setBusy(true);
    setMessage("利用者を確認しています…");
    try { await loadAll(); setMessage(""); }
    catch (error) { setMessage(safeAdminMessage(error), true); }
    finally { setBusy(false); }
  };
  window.addEventListener("aoalb:account-context", onContext);
  return { destroy: () => window.removeEventListener("aoalb:account-context", onContext) };
}
