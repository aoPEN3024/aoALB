function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashBlob(blob) {
  return hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

async function assertJpegMagic(blob) {
  const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (header.length !== 3 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) {
    throw new Error("JPEGのマジックバイトが一致しません。");
  }
}

async function imageBitmapThumbnail(blob, maxDimension, quality) {
  const source = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("JPEGを画像として読み込めません。")); };
    image.src = url;
  });
  try {
    const sourceWidth = source.width || source.naturalWidth;
    const sourceHeight = source.height || source.naturalHeight;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, width, height);
    const thumbnail = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("サムネイルを生成できませんでした。")), "image/jpeg", quality));
    return { blob: thumbnail, width, height, sourceWidth, sourceHeight };
  } finally {
    source.close?.();
  }
}

export async function createPhotoPackage({ photo, project, file, siteId, eventId, deviceName }) {
  if (!file?.blob || file.blob.type !== "image/jpeg") throw new Error("JPEGデータを読み込めません。");
  await assertJpegMagic(file.blob);
  if (file.blob.size !== Number(photo.bytes)) throw new Error("JPEGのファイル容量が写真情報と一致しません。");
  const actualSha256 = await hashBlob(file.blob);
  if (actualSha256 !== photo.sha256) throw new Error("JPEGのSHA-256が写真情報と一致しません。");
  const thumbnail = await imageBitmapThumbnail(file.blob, 480, 0.76);
  if (thumbnail.sourceWidth !== Number(photo.width) || thumbnail.sourceHeight !== Number(photo.height)) {
    throw new Error("JPEGの画像寸法が写真情報と一致しません。");
  }
  const thumbnailSha256 = await hashBlob(thumbnail.blob);
  return {
    eventId, siteId, deviceName, project: {
      projectUid: project.projectUid, koujiId: project.koujiId ?? null, name: project.name, contractor: project.contractor || ""
    },
    photo: {
      photoUid: photo.photoUid, capturedAt: photo.capturedAt || null, sha256: photo.sha256, mimeType: "image/jpeg",
      width: photo.width, height: photo.height, bytes: photo.bytes,
      metadata: { classification: photo.classification, boardSnapshot: photo.boardSnapshot, ledger: photo.ledger, legacyId: photo.legacyId ?? null }
    },
    originalBlob: file.blob,
    thumbnail: { blob: thumbnail.blob, sha256: thumbnailSha256, bytes: thumbnail.blob.size, width: thumbnail.width, height: thumbnail.height }
  };
}

export function classifyPhotoSyncError(error) {
  const message = String(error?.message || error || "写真同期に失敗しました。");
  const code = String(error?.code || "");
  if (/jwt|session|auth|sign.?in|ログイン|認証/i.test(message) || ["401", "PGRST301"].includes(code)) return { type: "auth", message: "認証の有効期限を確認できません。現場へ再接続してください。" };
  if (/row.level|permission|policy|forbidden|権限/i.test(message) || ["403", "42501"].includes(code)) return { type: "permission", message: "この現場へ写真を保存する権限がありません。" };
  if (/quota|storage.*full|容量.*不足|insufficient storage/i.test(message) || code === "507") return { type: "quota", message: "クラウドまたは端末の保存容量が不足しています。" };
  if (/fetch|network|offline|通信|connection/i.test(message)) return { type: "network", message: "通信が中断されました。次回起動時または再開後に送信します。" };
  if (/SHA-256|JPEG|サムネイル|ファイル容量/.test(message)) return { type: "integrity", message };
  return { type: "unknown", message };
}
