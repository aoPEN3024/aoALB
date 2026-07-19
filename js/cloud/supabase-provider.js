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
    async restoreMembership() {
      const { data, error } = await client.from("site_members")
        .select("site_id,role,device_name,sites!inner(site_code,name)")
        .eq("active", true).order("last_seen_at", { ascending: false }).limit(2);
      if (error) throw error;
      if (!Array.isArray(data) || data.length !== 1) return null;
      const row = data[0];
      return {
        siteId: row.site_id, siteCode: row.sites?.site_code, siteName: row.sites?.name,
        role: row.role, deviceName: row.device_name || "名称未設定端末"
      };
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
      async function recordSyncEvent(photoRow, completedAt) {
        const { error } = await client.from("sync_events").insert({
          event_id: eventId, site_id: siteId, entity_type: "photo", entity_id: photoRow.id,
          event_type: "photo_synced", device_name: deviceName, payload: { photoUid: photo.photoUid, sha256: photo.sha256 },
          created_at: completedAt
        });
        if (error && error.code !== "23505") throw error;
      }

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
        const sameHash = await client.from("photos")
          .select("id,photo_uid").eq("site_id", siteId).eq("sha256", photo.sha256).maybeSingle();
        if (sameHash.error) throw sameHash.error;
        if (sameHash.data) throw new Error("同じSHA-256のJPEGが別のphotoUidで登録されています。");
        const { data, error } = await client.from("photos").insert({
          site_id: siteId, project_id: projectRow.id, photo_uid: photo.photoUid, captured_at: photo.capturedAt,
          sha256: photo.sha256, mime_type: photo.mimeType, width: photo.width, height: photo.height,
          bytes: photo.bytes, metadata: photo.metadata
        }).select("id,project_id,photo_uid,sha256,bytes,width,height").single();
        if (error?.code === "23505") {
          const retry = await client.from("photos").select("id,project_id,photo_uid,sha256,bytes,width,height")
            .eq("site_id", siteId).eq("photo_uid", photo.photoUid).maybeSingle();
          if (retry.error) throw retry.error;
          photoRow = retry.data;
          if (!photoRow) {
            const sameHashAfterConflict = await client.from("photos")
              .select("id,photo_uid").eq("site_id", siteId).eq("sha256", photo.sha256).maybeSingle();
            if (sameHashAfterConflict.error) throw sameHashAfterConflict.error;
            if (sameHashAfterConflict.data) throw new Error("同じSHA-256のJPEGが別のphotoUidで登録されています。");
            throw error;
          }
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
      const { data: existingObject, error: existingObjectError } = await client.from("photo_objects")
        .select("status,object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes")
        .eq("photo_id", photoRow.id).maybeSingle();
      if (existingObjectError) throw existingObjectError;
      if (existingObject?.status === "complete") {
        const matches = existingObject.object_path === originalPath && existingObject.sha256 === photo.sha256
          && Number(existingObject.bytes) === Number(photo.bytes) && existingObject.thumbnail_object_path === thumbnailPath
          && existingObject.thumbnail_sha256 === thumbnail.sha256 && Number(existingObject.thumbnail_bytes) === Number(thumbnail.bytes)
          && Boolean(existingObject.upload_completed_at);
        if (!matches) throw new Error("クラウド上の完成済み写真が端末内の写真情報と一致しません。");
        await recordSyncEvent(photoRow, existingObject.upload_completed_at);
        return { photoUid: photo.photoUid, storedAt: existingObject.upload_completed_at, duplicate: true };
      }

      const bucket = client.storage.from("site-photos");
      const { error: originalError } = await bucket.upload(originalPath, originalBlob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (originalError) throw originalError;
      const { error: thumbnailError } = await bucket.upload(thumbnailPath, thumbnail.blob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (thumbnailError) throw thumbnailError;

      const completedAt = new Date().toISOString();
      const { error: objectError } = await client.from("photo_objects").upsert({
        photo_id: photoRow.id, site_id: siteId, bucket_id: "site-photos", object_path: originalPath,
        sha256: photo.sha256, bytes: photo.bytes, status: "complete", upload_completed_at: completedAt,
        thumbnail_object_path: thumbnailPath, thumbnail_sha256: thumbnail.sha256,
        thumbnail_bytes: thumbnail.bytes, thumbnail_width: thumbnail.width, thumbnail_height: thumbnail.height
      }, { onConflict: "photo_id" });
      if (objectError) throw objectError;

      const { data: stored, error: verifyError } = await client.from("photo_objects")
        .select("status,object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes")
        .eq("photo_id", photoRow.id).single();
      if (verifyError) throw verifyError;
      if (stored.status !== "complete" || stored.object_path !== originalPath || stored.sha256 !== photo.sha256 || Number(stored.bytes) !== Number(photo.bytes)
        || stored.thumbnail_object_path !== thumbnailPath || stored.thumbnail_sha256 !== thumbnail.sha256
        || Number(stored.thumbnail_bytes) !== Number(thumbnail.bytes) || !stored.upload_completed_at) {
        throw new Error("Supabase側の写真保存確認に失敗しました。");
      }

      await recordSyncEvent(photoRow, completedAt);
      return { photoUid: photo.photoUid, storedAt: completedAt };
    },
    async listCompletePhotoSnapshot(siteId) {
      const { data: projects, error: projectError } = await client.from("projects")
        .select("id,project_uid,kouji_id,name,contractor,updated_at").eq("site_id", siteId);
      if (projectError) throw projectError;
      const { data: objects, error: objectError } = await client.from("photo_objects")
        .select("photo_id,object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes,thumbnail_width,thumbnail_height")
        .eq("site_id", siteId).eq("status", "complete").not("upload_completed_at", "is", null);
      if (objectError) throw objectError;
      const objectByPhoto = new Map((objects || []).map(row => [row.photo_id, row]));
      const photoIds = [...objectByPhoto.keys()];
      const photos = [];
      for (let offset = 0; offset < photoIds.length; offset += 200) {
        const { data, error } = await client.from("photos")
          .select("id,project_id,photo_uid,captured_at,sha256,mime_type,width,height,bytes,metadata,updated_at")
          .eq("site_id", siteId).in("id", photoIds.slice(offset, offset + 200));
        if (error) throw error;
        photos.push(...(data || []));
      }
      const normalizedProjects = (projects || []).map(row => ({
        id: row.id, projectUid: row.project_uid, koujiId: row.kouji_id,
        name: row.name, contractor: row.contractor, updatedAt: row.updated_at
      }));
      const normalizedPhotos = photos.map(row => {
        const object = objectByPhoto.get(row.id);
        return {
          id: row.id, projectId: row.project_id, photoUid: row.photo_uid, capturedAt: row.captured_at,
          sha256: row.sha256, mimeType: row.mime_type, width: row.width, height: row.height,
          bytes: Number(row.bytes), metadata: row.metadata, updatedAt: row.updated_at,
          objectPath: object.object_path, thumbnailPath: object.thumbnail_object_path,
          thumbnailSha256: object.thumbnail_sha256, thumbnailBytes: Number(object.thumbnail_bytes),
          thumbnailWidth: object.thumbnail_width, thumbnailHeight: object.thumbnail_height,
          completedAt: object.upload_completed_at
        };
      });
      return { projects: normalizedProjects, photos: normalizedPhotos };
    },
    async downloadPhotoObject(path) {
      if (typeof path !== "string" || !/^[0-9a-f-]{36}\/(photos|thumbnails)\/[0-9a-f-]{36}\.jpg$/.test(path)) {
        throw new Error("クラウド写真の保存先が不正です。");
      }
      const { data, error } = await client.storage.from("site-photos").download(path);
      if (error) throw error;
      if (!(data instanceof Blob)) throw new Error("クラウド写真を取得できませんでした。");
      return data;
    },
    subscribe(siteId, callback) {
      channel = client.channel(`site-events:${siteId}`).on("postgres_changes", {
        event: "INSERT", schema: "public", table: "sync_events", filter: `site_id=eq.${siteId}`
      }, payload => callback({
        eventId: payload.new.event_id, siteId: payload.new.site_id, entityId: payload.new.entity_id,
        eventType: payload.new.event_type, deviceName: payload.new.device_name,
        payload: payload.new.payload, createdAt: payload.new.created_at
      })).subscribe();
      return () => { if (channel) client.removeChannel(channel); channel = null; };
    },
    unsubscribe() { if (channel) client.removeChannel(channel); channel = null; }
  };
}
