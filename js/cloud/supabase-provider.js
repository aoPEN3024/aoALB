const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.106.2/+esm";

export async function createSupabaseProvider(config) {
  const { createClient } = await import(SUPABASE_SDK_URL);
  const client = createClient(config.projectUrl, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "aoALB:supabase-auth" }
  });
  let channel = null;

  return {
    async authenticate() {
      const { data: current, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      if (current.session?.user) return { userId: current.session.user.id, anonymous: current.session.user.is_anonymous === true };
      const { data, error } = await client.auth.signInAnonymously();
      if (error) throw error;
      return { userId: data.user.id, anonymous: true };
    },
    async joinSite({ siteCode, joinCode, deviceName }) {
      const { data, error } = await client.rpc("join_site", { p_site_code: siteCode, p_join_code: joinCode, p_device_name: deviceName });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") throw new Error("参加コードの確認回数が上限に達しました。15分後に再試行してください。");
        if (row?.error_code === "membership_disabled") throw new Error("この端末の現場参加は管理者により無効化されています。管理者へ確認してください。");
        if (row?.error_code === "auth_required") throw new Error("匿名端末認証を確認できません。");
        throw new Error("現場IDまたは参加コードが正しくありません。");
      }
      return { siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name, role: row.member_role, deviceName };
    },
    async pushTestMetadata(event) {
      const { error } = await client.from("sync_events").insert({
        event_id: event.eventId, site_id: event.siteId, entity_type: "connection_test", entity_id: event.entityId,
        event_type: "metadata_test", device_name: event.deviceName, payload: event.payload, created_at: event.createdAt
      });
      if (error && error.code !== "23505") throw error;
      return event;
    },
    subscribe(siteId, callback) {
      channel = client.channel(`site-events:${siteId}`).on("postgres_changes", {
        event: "INSERT", schema: "public", table: "sync_events", filter: `site_id=eq.${siteId}`
      }, payload => callback({
        eventId: payload.new.event_id, siteId: payload.new.site_id, entityId: payload.new.entity_id,
        deviceName: payload.new.device_name, payload: payload.new.payload, createdAt: payload.new.created_at
      })).subscribe();
      return () => { if (channel) client.removeChannel(channel); channel = null; };
    },
    unsubscribe() { if (channel) client.removeChannel(channel); channel = null; }
  };
}
