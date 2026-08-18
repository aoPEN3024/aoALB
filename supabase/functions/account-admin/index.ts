import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type AdminAction =
  | "list_users" | "list_audit" | "list_invitation_recovery"
  | "invite" | "retry_invitation" | "resend_invite"
  | "suspend" | "resume" | "send_password_reset" | "delete_equivalent";

type Json = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_KEY = Deno.env.get("AOALB_SUPABASE_SECRET_KEY") ?? "";
const PUBLISHABLE_KEY = Deno.env.get("AOALB_SUPABASE_PUBLISHABLE_KEY") ?? "";
const AUTH_REDIRECT_URL = Deno.env.get("AOALB_AUTH_REDIRECT_URL") ?? "";
const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("AOALB_ALLOWED_ORIGINS") ?? "https://aopen3024.github.io")
    .split(",").map((value) => value.trim()).filter(Boolean),
);

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const publicAuth = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function response(origin: string | null, status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

function safeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function writeAudit(actorId: string, targetId: string | null, action: string, succeeded: boolean, reason: string) {
  await admin.from("account_management_audit").insert({
    actor_user_id: actorId,
    target_user_id: targetId,
    action,
    succeeded,
    reason_code: reason || null,
  });
}

async function authenticate(request: Request): Promise<{ id: string } | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (!token || token.length > 8192) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.id) return null;
  const [{ data: account }, { data: systemAdmin }] = await Promise.all([
    admin.from("user_profiles").select("status,active").eq("user_id", data.user.id).maybeSingle(),
    admin.from("system_admins").select("active").eq("user_id", data.user.id).maybeSingle(),
  ]);
  return account?.status === "active" && account?.active && systemAdmin?.active
    ? { id: data.user.id }
    : null;
}

async function consumeLimit(actorId: string, action: AdminAction): Promise<{ allowed: boolean; retry: number }> {
  const limit = action.startsWith("list_") ? 60 : 20;
  const { data, error } = await admin.rpc("consume_account_admin_rate_limit", {
    p_actor_user_id: actorId,
    p_action: action,
    p_limit: limit,
    p_window_seconds: 900,
  });
  if (error || !Array.isArray(data) || !data[0]) return { allowed: false, retry: 900 };
  return { allowed: Boolean(data[0].allowed), retry: Number(data[0].retry_after_seconds ?? 0) };
}

async function listUsers() {
  const users = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error("auth_list_failed");
    users.push(...data.users);
    if (data.users.length < 100) break;
  }
  const ids = users.map((user) => user.id);
  if (ids.length === 0) return [];
  const [{ data: profiles }, { data: memberships }, { data: admins }] = await Promise.all([
    admin.from("user_profiles").select("user_id,display_name,status,invited_at,created_at,last_seen_at").in("user_id", ids),
    admin.from("site_members").select("user_id").in("user_id", ids).eq("active", true),
    admin.from("system_admins").select("user_id,active").in("user_id", ids),
  ]);
  const profileMap = new Map((profiles ?? []).map((row) => [row.user_id, row]));
  const siteCounts = new Map<string, number>();
  for (const row of memberships ?? []) siteCounts.set(row.user_id, (siteCounts.get(row.user_id) ?? 0) + 1);
  const adminSet = new Set((admins ?? []).filter((row) => row.active).map((row) => row.user_id));
  return users.filter((user) => profileMap.has(user.id)).map((user) => {
    const profile = profileMap.get(user.id)!;
    return {
      userId: user.id,
      displayName: profile.display_name,
      email: user.email ?? "",
      status: profile.status,
      invitedAt: profile.invited_at,
      lastUsedAt: profile.last_seen_at ?? user.last_sign_in_at ?? null,
      siteCount: siteCounts.get(user.id) ?? 0,
      systemAdmin: adminSet.has(user.id),
    };
  });
}

async function findUserByEmail(email: string) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error("auth_list_failed");
    const match = data.users.find((user) => String(user.email || "").toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 100) return null;
  }
  throw new Error("auth_list_limit_reached");
}

async function findUserByInvitationOperation(operationId: string) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error("auth_list_failed");
    const match = data.users.find((user) =>
      String(user.user_metadata?.aoalb_invitation_operation_id || "") === operationId
    );
    if (match) return match;
    if (data.users.length < 100) return null;
  }
  throw new Error("auth_list_limit_reached");
}

async function completeInvitation(actorId: string, operationId: string) {
  const { data, error } = await admin.rpc("admin_complete_account_invitation", {
    p_actor_user_id: actorId,
    p_operation_id: operationId,
  });
  if (error || !Array.isArray(data) || !data[0]) throw new Error("invite_profile_failed");
  if (data[0].operation_status === "manual_review") throw new Error("invitation_recovery_needs_review");
  return data[0];
}

async function listInvitationRecovery() {
  const { data, error } = await admin.from("account_invitation_operations")
    .select("operation_id,auth_user_id,display_name,status,last_error_code,created_at,updated_at")
    .in("status", ["requested", "auth_created", "recovery_required", "manual_review"])
    .order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error("invitation_recovery_list_failed");
  const rows = [];
  for (const row of data ?? []) {
    const discoveredUser = row.auth_user_id ? null : await findUserByInvitationOperation(row.operation_id);
    if (row.status === "requested" && !discoveredUser) continue;
    const targetUserId = row.auth_user_id || discoveredUser?.id || null;
    let email = "";
    if (targetUserId) {
      const result = discoveredUser ? { data: { user: discoveredUser } } : await admin.auth.admin.getUserById(targetUserId);
      email = result.data.user?.email ?? "";
    }
    rows.push({
      operationId: row.operation_id,
      targetUserId,
      displayName: row.display_name,
      email,
      status: row.status,
      reasonCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      automaticallyRecoverable: row.status !== "manual_review" && Boolean(targetUserId),
    });
  }
  return rows;
}

async function changeStatus(actorId: string, targetId: string, nextStatus: "active" | "suspended" | "deleted") {
  const { data: profile } = await admin.from("user_profiles").select("status").eq("user_id", targetId).maybeSingle();
  if (!profile) throw new Error("account_not_found");
  const wasBanned = profile.status === "suspended" || profile.status === "deleted";
  const shouldBan = nextStatus !== "active";
  const { error: authError } = await admin.auth.admin.updateUserById(targetId, {
    ban_duration: shouldBan ? "876000h" : "none",
  });
  if (authError) throw new Error("auth_state_change_failed");
  const { error: dbError } = await admin.rpc("admin_set_account_status", {
    p_actor_user_id: actorId,
    p_target_user_id: targetId,
    p_new_status: nextStatus,
    p_reason_code: "system_admin_operation",
  });
  if (dbError) {
    await admin.auth.admin.updateUserById(targetId, { ban_duration: wasBanned ? "876000h" : "none" });
    throw new Error(String(dbError.message || "account_state_change_failed").slice(0, 80));
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return response(origin, 403, { ok: false, error: "origin_not_allowed" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return response(origin, 405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !SECRET_KEY || !PUBLISHABLE_KEY || !AUTH_REDIRECT_URL) {
    return response(origin, 503, { ok: false, error: "service_unavailable" });
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > 8192) return response(origin, 413, { ok: false, error: "request_too_large" });

  const actor = await authenticate(request);
  if (!actor) return response(origin, 403, { ok: false, error: "not_allowed" });

  let input: Json;
  let auditTargetId: string | null = null;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 8192) {
      return response(origin, 413, { ok: false, error: "request_too_large" });
    }
    input = JSON.parse(raw);
  } catch { return response(origin, 400, { ok: false, error: "invalid_request" }); }
  const action = safeText(input.action, 40) as AdminAction;
  const actions: AdminAction[] = ["list_users","list_audit","list_invitation_recovery","invite","retry_invitation","resend_invite","suspend","resume","send_password_reset","delete_equivalent"];
  if (!actions.includes(action)) return response(origin, 400, { ok: false, error: "invalid_request" });
  const rate = await consumeLimit(actor.id, action);
  if (!rate.allowed) return response(origin, 429, { ok: false, error: "temporarily_limited", retryAfterSeconds: rate.retry });

  try {
    if (action === "list_users") return response(origin, 200, { ok: true, users: await listUsers() });
    if (action === "list_invitation_recovery") {
      return response(origin, 200, { ok: true, recovery: await listInvitationRecovery() });
    }
    if (action === "list_audit") {
      const { data, error } = await admin.from("account_management_audit")
        .select("id,actor_user_id,target_user_id,action,succeeded,reason_code,occurred_at")
        .order("occurred_at", { ascending: false }).limit(200);
      if (error) throw new Error("audit_list_failed");
      return response(origin, 200, { ok: true, audit: data ?? [] });
    }

    const targetId = safeText(input.targetUserId, 36);
    if (action === "invite") {
      const operationId = safeText(input.operationId, 36);
      const email = safeText(input.email, 254).toLowerCase();
      const displayName = safeText(input.displayName, 80);
      if (!validUuid(operationId) || !validEmail(email) || !displayName || /[\u0000-\u001f\u007f]/.test(displayName)) {
        return response(origin, 400, { ok: false, error: "invalid_input" });
      }
      const begin = await admin.rpc("admin_begin_account_invitation", {
        p_actor_user_id: actor.id,
        p_operation_id: operationId,
        p_email: email,
        p_display_name: displayName,
      });
      if (begin.error || !Array.isArray(begin.data) || !begin.data[0]) throw new Error("invitation_operation_failed");
      const operation = begin.data[0];
      if (operation.operation_status === "completed") return response(origin, 200, { ok: true, idempotent: true });
      if (["auth_created", "recovery_required"].includes(operation.operation_status)) {
        await completeInvitation(actor.id, operationId);
        return response(origin, 200, { ok: true, recovered: true });
      }
      if (operation.operation_status === "manual_review") {
        return response(origin, 409, { ok: false, error: "invitation_recovery_needs_review" });
      }
      const existingUser = await findUserByEmail(email);
      if (existingUser) {
        const existingOperationId = String(existingUser.user_metadata?.aoalb_invitation_operation_id || "");
        if (existingOperationId === operationId) {
          const recorded = await admin.rpc("admin_record_invitation_auth_user", {
            p_actor_user_id: actor.id, p_operation_id: operationId, p_auth_user_id: existingUser.id,
          });
          if (recorded.error) throw new Error("invitation_auth_unverified");
          await completeInvitation(actor.id, operationId);
          return response(origin, 200, { ok: true, recovered: true });
        }
        await admin.from("account_invitation_operations").update({
          status: "manual_review", last_error_code: "email_already_registered", updated_at: new Date().toISOString(),
        }).eq("operation_id", operationId).eq("created_by", actor.id);
        await writeAudit(actor.id, existingUser.id, "account.invite_recovery_required", false, "email_already_registered");
        return response(origin, 409, { ok: false, error: "invitation_recovery_needs_review" });
      }
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: AUTH_REDIRECT_URL,
        data: { display_name: displayName, aoalb_invitation_operation_id: operationId },
      });
      if (error || !data.user?.id) throw new Error("invite_failed");
      auditTargetId = data.user.id;
      const recorded = await admin.rpc("admin_record_invitation_auth_user", {
        p_actor_user_id: actor.id, p_operation_id: operationId, p_auth_user_id: data.user.id,
      });
      if (recorded.error) throw new Error("invitation_auth_unverified");
      try {
        await completeInvitation(actor.id, operationId);
      } catch (completionError) {
        if (!(completionError instanceof Error) || completionError.message !== "invitation_recovery_needs_review") {
          await admin.rpc("admin_mark_invitation_recovery_required", {
            p_actor_user_id: actor.id,
            p_operation_id: operationId,
            p_reason_code: "invite_profile_failed",
          });
        }
        throw completionError;
      }
      return response(origin, 200, { ok: true });
    }
    if (action === "retry_invitation") {
      const operationId = safeText(input.operationId, 36);
      if (!validUuid(operationId)) return response(origin, 400, { ok: false, error: "invalid_input" });
      const { data: operation, error: operationError } = await admin.from("account_invitation_operations")
        .select("auth_user_id,status").eq("operation_id", operationId).maybeSingle();
      if (operationError || !operation) throw new Error("invitation_operation_failed");
      if (!operation.auth_user_id) {
        const discoveredUser = await findUserByInvitationOperation(operationId);
        if (!discoveredUser) throw new Error("invitation_recovery_needs_review");
        const recorded = await admin.rpc("admin_record_invitation_auth_user", {
          p_actor_user_id: actor.id, p_operation_id: operationId, p_auth_user_id: discoveredUser.id,
        });
        if (recorded.error) throw new Error("invitation_auth_unverified");
      }
      const result = await completeInvitation(actor.id, operationId);
      return response(origin, 200, { ok: true, recovered: true, targetUserId: result.target_user_id });
    }
    if (!validUuid(targetId)) return response(origin, 400, { ok: false, error: "invalid_input" });
    auditTargetId = targetId;

    const { data: target, error: targetError } = await admin.auth.admin.getUserById(targetId);
    if (targetError || !target.user) throw new Error("account_not_found");
    if (action === "resend_invite") {
      const { data: profile } = await admin.from("user_profiles").select("status").eq("user_id", targetId).maybeSingle();
      if (profile?.status !== "invited" || !target.user.email) throw new Error("invitation_unavailable");
      const { error } = await admin.auth.admin.inviteUserByEmail(target.user.email, { redirectTo: AUTH_REDIRECT_URL });
      if (error) throw new Error("invite_resend_failed");
      await writeAudit(actor.id, targetId, "account.invite_resend", true, "");
    } else if (action === "send_password_reset") {
      if (!target.user.email) throw new Error("account_unavailable");
      const { error } = await publicAuth.auth.resetPasswordForEmail(target.user.email, { redirectTo: AUTH_REDIRECT_URL });
      if (error) throw new Error("password_reset_failed");
      await writeAudit(actor.id, targetId, "account.password_reset", true, "");
    } else if (action === "suspend") {
      await changeStatus(actor.id, targetId, "suspended");
    } else if (action === "resume") {
      await changeStatus(actor.id, targetId, "active");
    } else if (action === "delete_equivalent") {
      const confirmation = safeText(input.confirmEmail, 254).toLowerCase();
      if (!target.user.email || confirmation !== target.user.email.toLowerCase()) {
        return response(origin, 400, { ok: false, error: "confirmation_mismatch" });
      }
      await changeStatus(actor.id, targetId, "deleted");
    }
    return response(origin, 200, { ok: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "operation_failed";
    const safeCodes = new Set([
      "account_not_found","invitation_unavailable","invite_failed","invite_profile_failed",
      "invitation_operation_failed","invitation_operation_conflict","invitation_auth_unverified",
      "invitation_recovery_needs_review","invitation_recovery_list_failed",
      "email_already_registered","auth_list_limit_reached",
      "invite_resend_failed","password_reset_failed","auth_state_change_failed",
      "self_change_not_allowed","system_admin_delete_not_allowed","last_system_admin",
      "sole_site_admin","storage_owner_exists","deleted_account_cannot_resume",
    ]);
    const safeCode = safeCodes.has(code) ? code : "operation_failed";
    if (!action.startsWith("list_") && !["invite", "retry_invitation"].includes(action)) {
      await writeAudit(actor.id, auditTargetId, action === "delete_equivalent" ? "account.delete_equivalent" :
        action === "send_password_reset" ? "account.password_reset" :
        action === "resend_invite" ? "account.invite_resend" :
        action === "invite" ? "account.invite" :
        action === "suspend" ? "account.suspend" : "account.resume", false, safeCode);
    }
    return response(origin, 400, { ok: false, error: safeCode });
  }
});
