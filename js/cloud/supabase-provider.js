const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.106.2/+esm";

let cachedProviderKey = "";
let cachedProviderPromise = null;

export async function createSupabaseProvider(config) {
  const providerKey = `${config.projectUrl}\n${config.publishableKey}`;
  if (cachedProviderPromise && cachedProviderKey === providerKey) return cachedProviderPromise;

  cachedProviderKey = providerKey;
  cachedProviderPromise = buildSupabaseProvider(config);
  try {
    return await cachedProviderPromise;
  } catch (error) {
    if (cachedProviderKey === providerKey) {
      cachedProviderKey = "";
      cachedProviderPromise = null;
    }
    throw error;
  }
}

async function buildSupabaseProvider(config) {
  const { createClient } = await import(SUPABASE_SDK_URL);
  const client = createClient(config.projectUrl, config.publishableKey, {
    auth: {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,
      flowType: "pkce", storageKey: "aoALB:supabase-auth"
    }
  });
  let channel = null;

  return {
    async getAccountSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      const user = data.session?.user;
      return user ? {
        userId: user.id, email: user.email || "", anonymous: user.is_anonymous === true,
        emailConfirmed: Boolean(user.email_confirmed_at),
        displayName: String(user.user_metadata?.display_name || ""), session: data.session
      } : null;
    },
    async signInWithPassword({ email, password }) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return {
        userId: data.user.id, email: data.user.email || "", anonymous: false,
        displayName: String(data.user.user_metadata?.display_name || "")
      };
    },
    async signUpWithPassword({ email, password, displayName, redirectTo }) {
      const { data, error } = await client.auth.signUp({
        email, password,
        options: { emailRedirectTo: redirectTo, data: { display_name: displayName } }
      });
      if (error) throw error;
      return { userId: data.user?.id || "", confirmationRequired: !data.session };
    },
    async requestPasswordReset({ email, redirectTo }) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
    },
    async updatePassword(password) {
      const { data, error } = await client.auth.updateUser({ password });
      if (error) throw error;
      return data.user;
    },
    async beginAnonymousUpgrade({ email, displayName, redirectTo }) {
      const current = await this.getAccountSession();
      if (!current?.anonymous) throw new Error("匿名利用中の端末だけを昇格できます。");
      const { data, error } = await client.auth.updateUser(
        { email, data: { display_name: displayName } },
        { emailRedirectTo: redirectTo }
      );
      if (error) throw error;
      return data.user;
    },
    async ensureAccountProfile({ displayName, deviceUid, deviceName }) {
      const profileResult = await client.rpc("ensure_my_profile", { p_display_name: displayName });
      if (profileResult.error) throw profileResult.error;
      const deviceResult = await client.rpc("touch_my_account_device", {
        p_device_uid: deviceUid, p_device_name: deviceName
      });
      if (deviceResult.error) throw deviceResult.error;
      return { profile: profileResult.data?.[0] || null, device: deviceResult.data?.[0] || null };
    },
    async listAccountDevices() {
      const { data, error } = await client.rpc("list_my_account_devices");
      if (error) throw error;
      return data || [];
    },
    onAuthStateChange(callback) {
      const { data } = client.auth.onAuthStateChange((event, session) => callback(event, session));
      return () => data.subscription.unsubscribe();
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
    },
    async authenticate({ allowAnonymous = false } = {}) {
      const { data: current, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      if (current.session?.user) return { userId: current.session.user.id, anonymous: current.session.user.is_anonymous === true };
      if (!allowAnonymous) {
        throw new Error("共有工事を利用するには、先にアカウントへログインしてください。");
      }
      const { data, error } = await client.auth.signInAnonymously();
      if (error) throw error;
      return { userId: data.user.id, anonymous: true };
    },
    async restoreMembership() {
      const { data, error } = await client.rpc("list_my_sites");
      if (error) throw error;
      if (!Array.isArray(data) || data.length !== 1) return null;
      const row = data[0];
      return {
        siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name,
        siteStatus: row.site_status || "active", siteRevision: Number(row.site_revision || 1),
        role: row.member_role, deviceName: row.device_name || "名称未設定端末",
        adminCodeConfigured: row.admin_code_configured === true
      };
    },
    async listMySites() {
      const { data, error } = await client.rpc("list_my_sites");
      if (error) throw error;
      return (data || []).map(row => ({
        siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name,
        siteStatus: row.site_status || "active", siteRevision: Number(row.site_revision || 1),
        role: row.member_role, deviceName: row.device_name || "名称未設定端末",
        updatedAt: row.site_updated_at, adminCodeConfigured: row.admin_code_configured === true
      }));
    },
    async joinSite({ siteCode, joinCode, deviceName }) {
      const { data, error } = await client.rpc("join_site", { p_site_code: siteCode, p_join_code: joinCode, p_device_name: deviceName });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") throw new Error("工事PASSの確認回数が上限に達しました。15分後に再試行してください。");
        if (row?.error_code === "membership_disabled") throw new Error("この端末の現場参加は管理者により無効化されています。管理者へ確認してください。");
        if (row?.error_code === "auth_required") throw new Error("匿名端末認証を確認できません。");
        throw new Error("工事IDまたは工事PASSが正しくありません。");
      }
      return { siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name, role: row.member_role, deviceName };
    },
    async claimSiteAdmin({ siteCode, adminCode, deviceName }) {
      const { data, error } = await client.rpc("claim_site_admin", {
        p_site_code: siteCode, p_site_admin_code: adminCode, p_device_name: deviceName
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.site_id) {
        if (row?.error_code === "temporarily_blocked") {
          throw new Error("確認回数が上限に達しました。15分ほど待って再度お試しください。");
        }
        throw new Error("管理者PASSが違うか、現在利用できません。");
      }
      return {
        siteId: row.site_id, siteCode: row.site_code, siteName: row.site_name,
        role: row.member_role, siteStatus: row.site_status || "active",
        siteRevision: Number(row.site_revision || 1),
        adminCodeConfigured: row.admin_code_configured === true, deviceName
      };
    },
    async refreshSite(siteId) {
      const { data, error } = await client.from("sites")
        .select("id,site_code,name,status,revision").eq("id", siteId).single();
      if (error) throw error;
      return {
        siteId: data.id, siteCode: data.site_code, siteName: data.name,
        siteStatus: data.status || "active", siteRevision: Number(data.revision || 1)
      };
    },
    async siteRpc(name, values) {
      const allowed = new Set([
        "update_site", "rotate_site_join_code", "close_site", "reopen_site",
        "trash_site", "restore_site", "delete_empty_site",
        "set_initial_site_admin_code", "rotate_site_admin_code",
        "list_site_members_admin", "set_site_member_active_v2"
      ]);
      if (!allowed.has(name)) throw new Error("この管理操作は利用できません。");
      const { data, error } = await client.rpc(name, values);
      if (error) throw error;
      if (name === "list_site_members_admin") return data || [];
      return Array.isArray(data) ? data[0] : data;
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

      const { data: uploadStateRows, error: uploadStateError } = await client.rpc("check_photo_upload_state", {
        p_site_id: siteId, p_photo_uid: photo.photoUid, p_sha256: photo.sha256
      });
      if (uploadStateError) throw uploadStateError;
      const uploadState = Array.isArray(uploadStateRows) ? uploadStateRows[0] : uploadStateRows;
      if (uploadState?.upload_state === "trashed") {
        const error = new Error("この写真は共有先の「削除済み」にあります。管理者が復元するまで再送しません。");
        error.code = "PHOTO_TRASHED";
        throw error;
      }
      if (uploadState?.upload_state === "conflict") {
        throw new Error("共有先に同じ識別情報の異なる写真があります。管理者へ確認してください。");
      }

      let { data: photoRow, error: photoReadError } = await client.from("photos")
        .select("id,project_id,photo_uid,sha256,bytes,width,height").eq("site_id", siteId).eq("photo_uid", photo.photoUid).maybeSingle();
      if (photoReadError) throw photoReadError;
      if (photoRow && (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== Number(photo.bytes))) {
        throw new Error("共有先に同じ識別情報の異なる写真があります。管理者へ確認してください。");
      }
      if (!photoRow) {
        const sameHash = await client.from("photos")
          .select("id,photo_uid").eq("site_id", siteId).eq("sha256", photo.sha256).maybeSingle();
        if (sameHash.error) throw sameHash.error;
        if (sameHash.data) throw new Error("同じ写真が別の識別情報で登録されています。管理者へ確認してください。");
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
            if (sameHashAfterConflict.data) throw new Error("同じ写真が別の識別情報で登録されています。管理者へ確認してください。");
            throw error;
          }
          if (photoRow.project_id !== projectRow.id || photoRow.sha256 !== photo.sha256 || Number(photoRow.bytes) !== Number(photo.bytes)) {
            throw new Error("共有先に同じ識別情報の異なる写真があります。管理者へ確認してください。");
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
        throw new Error("共有先へ保存した写真を確認できませんでした。");
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
          .select("id,project_id,photo_uid,captured_at,sha256,mime_type,width,height,bytes,metadata,revision,lifecycle_status,trashed_at,updated_at")
          .eq("lifecycle_status", "active")
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
          revision: Number(row.revision || 1), lifecycleStatus: row.lifecycle_status || "active",
          trashedAt: row.trashed_at || null,
          objectPath: object.object_path, thumbnailPath: object.thumbnail_object_path,
          thumbnailSha256: object.thumbnail_sha256, thumbnailBytes: Number(object.thumbnail_bytes),
          thumbnailWidth: object.thumbnail_width, thumbnailHeight: object.thumbnail_height,
          completedAt: object.upload_completed_at
        };
      });
      return { projects: normalizedProjects, photos: normalizedPhotos };
    },
    async listTrashedPhotoSnapshot(siteId) {
      const { data: projects, error: projectError } = await client.from("projects")
        .select("id,project_uid,kouji_id,name,contractor,updated_at").eq("site_id", siteId);
      if (projectError) throw projectError;
      const { data: rows, error: photoError } = await client.from("photos")
        .select("id,project_id,photo_uid,captured_at,sha256,mime_type,width,height,bytes,metadata,revision,lifecycle_status,trashed_at,updated_at")
        .eq("site_id", siteId).eq("lifecycle_status", "trashed").order("trashed_at", { ascending: false });
      if (photoError) throw photoError;
      const photoIds = (rows || []).map(row => row.id);
      const objects = [];
      for (let offset = 0; offset < photoIds.length; offset += 200) {
        const { data, error } = await client.from("photo_objects")
          .select("photo_id,object_path,sha256,bytes,upload_completed_at,thumbnail_object_path,thumbnail_sha256,thumbnail_bytes,thumbnail_width,thumbnail_height")
          .eq("site_id", siteId).in("photo_id", photoIds.slice(offset, offset + 200));
        if (error) throw error;
        objects.push(...(data || []));
      }
      const objectByPhoto = new Map(objects.map(row => [row.photo_id, row]));
      return {
        projects: (projects || []).map(row => ({
          id: row.id, projectUid: row.project_uid, koujiId: row.kouji_id,
          name: row.name, contractor: row.contractor, updatedAt: row.updated_at
        })),
        photos: (rows || []).flatMap(row => {
          const object = objectByPhoto.get(row.id);
          if (!object) return [];
          return [{
            id: row.id, projectId: row.project_id, photoUid: row.photo_uid,
            capturedAt: row.captured_at, sha256: row.sha256, mimeType: row.mime_type,
            width: row.width, height: row.height, bytes: Number(row.bytes),
            metadata: row.metadata, updatedAt: row.updated_at,
            revision: Number(row.revision || 1), lifecycleStatus: row.lifecycle_status,
            trashedAt: row.trashed_at,
            objectPath: object.object_path, thumbnailPath: object.thumbnail_object_path,
            thumbnailSha256: object.thumbnail_sha256, thumbnailBytes: Number(object.thumbnail_bytes),
            thumbnailWidth: object.thumbnail_width, thumbnailHeight: object.thumbnail_height,
            completedAt: object.upload_completed_at
          }];
        })
      };
    },
    async photoLedgerReferences(photoId) {
      const { data, error } = await client.rpc("photo_ledger_references", { p_photo_id: photoId });
      if (error) throw error;
      return data || [];
    },
    async trashPhotos(items) {
      const { data, error } = await client.rpc("trash_photos", {
        p_photo_ids: items.map(item => item.remotePhotoId),
        p_expected_revisions: items.map(item => Number(item.revision))
      });
      if (error) throw error;
      return data || [];
    },
    async restorePhoto(remotePhotoId, revision) {
      const { data, error } = await client.rpc("restore_photo", {
        p_photo_id: remotePhotoId, p_expected_revision: Number(revision)
      });
      if (error) throw error;
      return data;
    },
    async listLedgerSnapshots(siteId) {
      const { data, error } = await client.rpc("list_site_ledger_snapshots", { p_site_id: siteId });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
    async saveLedgerSnapshot(payload) {
      const { data, error } = await client.rpc("save_ledger_snapshot", {
        p_site_id: payload.siteId, p_project_id: payload.remoteProjectId,
        p_ledger_id: payload.remoteLedgerId || null, p_ledger_uid: payload.ledgerUid,
        p_expected_revision: Number(payload.expectedRevision || 0), p_title: payload.title,
        p_template: payload.template, p_show_cover: payload.showCover,
        p_view_mode: payload.viewMode, p_pages: payload.pages, p_captions: payload.captions,
        p_event_id: payload.eventId
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
    async saveClassificationOverride(payload) {
      const { data, error } = await client.rpc("save_photo_classification_override", {
        p_photo_id: payload.remotePhotoId, p_expected_revision: Number(payload.expectedRevision || 0),
        p_override_data: payload.overrideData || {}, p_event_id: payload.eventId
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
    async listClassificationOverrides(siteId) {
      const { data, error } = await client.from("photo_classification_overrides")
        .select("photo_id,override_data,revision,edited_by,updated_at").eq("site_id", siteId);
      if (error) throw error;
      return data || [];
    },
    async downloadPhotoObject(path) {
      if (typeof path !== "string" || !/^[0-9a-f-]{36}\/(photos|thumbnails)\/[0-9a-f-]{36}\.jpg$/.test(path)) {
        throw new Error("共有写真の保存先が正しくありません。");
      }
      const { data, error } = await client.storage.from("site-photos").download(path);
      if (error) throw error;
      if (!(data instanceof Blob)) throw new Error("共有写真を取得できませんでした。");
      return data;
    },
    subscribe(siteId, callback) {
      channel = client.channel(`site-events:${siteId}`).on("postgres_changes", {
        event: "INSERT", schema: "public", table: "sync_events", filter: `site_id=eq.${siteId}`
      }, payload => callback({
        eventId: payload.new.event_id, siteId: payload.new.site_id, entityId: payload.new.entity_id,
        entityType: payload.new.entity_type, eventType: payload.new.event_type, deviceName: payload.new.device_name,
        payload: payload.new.payload, createdAt: payload.new.created_at
      })).subscribe();
      return () => { if (channel) client.removeChannel(channel); channel = null; };
    },
    unsubscribe() { if (channel) client.removeChannel(channel); channel = null; }
  };
}
