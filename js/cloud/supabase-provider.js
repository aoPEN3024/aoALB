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
    async uploadPhotoPackage(photoPackage) {
      const { siteId, project, photo, originalBlob, thumbnail, eventId, deviceName } = photoPackage;
      let { data: projectRow, error: projectReadError } = await client.from("projects")
        .select("id,project_uid").eq("site_id", siteId).eq("project_uid", project.projectUid).maybeSingle();
      if (projectReadError) throw projectReadError;
      if (!projectRow) {
        const { data, error } = await client.from("projects").insert({
          site_id: siteId, project_uid: project.projectUid, kouji_id: project.koujiId,
          name: project.name, contractor: project.contractor
        }).select("id,project_uid").single();
        if (error?.code === "23505") {
          const retry = await client.from("projects").select("id,project_uid")
            .eq("site_id", siteId).eq("project_uid", project.projectUid).single();
          if (retry.error) throw retry.error;
          projectRow = retry.data;
        } else {
          if (error) throw error;
          projectRow = data;
        }
      }

      let { data: photoRow, error: photoReadError } = await client.from("photos")
        .select("id,project_id,photo_uid,sha256,bytes,width,height").eq("site_id", siteId).eq("photo_uid", photo.photoUid).maybeSingle();
      if (photoReadError) throw photoReadError;
      if (photoRow && (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== Number(photo.bytes))) {
        throw new Error("クラウド上の同じphotoUidが異なるJPEGを参照しています。");
      }
      if (!photoRow) {
        const { data, error } = await client.from("photos").insert({
          site_id: siteId, project_id: projectRow.id, photo_uid: photo.photoUid, captured_at: photo.capturedAt,
          sha256: photo.sha256, mime_type: photo.mimeType, width: photo.width, height: photo.height,
          bytes: photo.bytes, metadata: photo.metadata
        }).select("id,project_id,photo_uid,sha256,bytes,width,height").single();
        if (error?.code === "23505") {
          const retry = await client.from("photos").select("id,project_id,photo_uid,sha256,bytes,width,height")
            .eq("site_id", siteId).eq("photo_uid", photo.photoUid).single();
          if (retry.error) throw retry.error;
          photoRow = retry.data;
          if (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== Number(photo.bytes)) {
            throw new Error("クラウド上の同じphotoUidが異なるJPEGを参照しています。");
          }
        } else {
          if (error) throw error;
          photoRow = data;
        }
      }

      const originalPath = `${siteId}/photos/${photo.photoUid}.jpg`;
      const thumbnailPath = `${siteId}/thumbnails/${photo.photoUid}.jpg`;
      const bucket = client.storage.from("site-photos");
      const { error: originalError } = await bucket.upload(originalPath, originalBlob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (originalError) throw originalError;
      const { error: thumbnailError } = await bucket.upload(thumbnailPath, thumbnail.blob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (thumbnailError) throw thumbnailError;

      const completedAt = new Date().toISOString();
      const { error: objectError } = await client.from("photo_objects").upsert({
        photo_id: photoRow.id, site_id: siteId, bucket_id: "site-photos", object_path: originalPath,
        sha256: photo.sha256, bytes: photo.bytes, upload_completed_at: completedAt,
        thumbnail_object_path: thumbnailPath, thumbnail_sha256: thumbnail.sha256,
        thumbnail_bytes: thumbnail.bytes, thumbnail_width: thumbnail.width, thumbnail_height: thumbnail.height
      }, { onConflict: "photo_id" });
      if (objectError) throw objectError;

      const { data: stored, error: verifyError } = await client.from("photo_objects")
        .select("object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes")
        .eq("photo_id", photoRow.id).single();
      if (verifyError) throw verifyError;
      if (stored.object_path !== originalPath || stored.sha256 !== photo.sha256 || Number(stored.bytes) !== Number(photo.bytes)
        || stored.thumbnail_object_path !== thumbnailPath || stored.thumbnail_sha256 !== thumbnail.sha256
        || Number(stored.thumbnail_bytes) !== Number(thumbnail.bytes) || !stored.upload_completed_at) {
        throw new Error("Supabase側の写真保存確認に失敗しました。");
      }

      const { error: eventError } = await client.from("sync_events").insert({
        event_id: eventId, site_id: siteId, entity_type: "photo", entity_id: photoRow.id,
        event_type: "photo_synced", device_name: deviceName, payload: { photoUid: photo.photoUid, sha256: photo.sha256 },
        created_at: completedAt
      });
      if (eventError && eventError.code !== "23505") throw eventError;
      return { photoUid: photo.photoUid, storedAt: completedAt };
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
