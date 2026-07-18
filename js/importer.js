export const IMPORT_LIMITS = Object.freeze({
  maxZipBytes: 250 * 1024 * 1024,
  maxPhotos: 1000,
  maxJpegBytes: 20 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxPixels: 50_000_000,
  maxManifestBytes: 10 * 1024 * 1024,
  maxEntries: 1010
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TEXT_FIELDS = ["koushu", "shubetsu", "saibetsu", "sokuten", "tekiyo"];
const BOARD_FIELDS = ["koujimei", "contractor", ...TEXT_FIELDS];

export class ImportValidationError extends Error {
  constructor(errors, context = {}) {
    super(errors[0] || "ZIPの検証に失敗しました。");
    this.name = "ImportValidationError";
    this.errors = errors;
    this.context = context;
  }
}

function fail(message, context) {
  throw new ImportValidationError([message], context);
}

function requireText(value, label, { allowEmpty = true, maxLength = 2000 } = {}) {
  if (typeof value !== "string") fail(`${label}は文字列である必要があります。`);
  if (!allowEmpty && !value.trim()) fail(`${label}が空です。`);
  if (value.length > maxLength) fail(`${label}が長すぎます。`);
  return value;
}

function normalizeFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}が不正です。`);
  return Object.fromEntries(fields.map(field => [field, requireText(value[field] ?? "", `${label}.${field}`)]));
}

function validatePath(rawPath, isDirectory, seen) {
  if (typeof rawPath !== "string" || !rawPath) fail("ZIP内に名前のない項目があります。");
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) fail(`ZIP内パスに制御文字があります: ${JSON.stringify(rawPath)}`);
  if (rawPath.includes("\\")) fail(`バックスラッシュを含むZIP内パスは使用できません: ${rawPath}`);
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) fail(`絶対パスは使用できません: ${rawPath}`);
  const normalized = rawPath.normalize("NFC");
  const comparable = isDirectory ? normalized.replace(/\/$/, "") : normalized;
  const parts = comparable.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) fail(`危険なZIP内パスです: ${rawPath}`);
  if (seen.has(normalized)) fail(`正規化後に重複するZIP内パスがあります: ${rawPath}`);
  seen.add(normalized);
  return normalized;
}

function getUncompressedSize(entry) {
  const size = entry?._data?.uncompressedSize;
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

async function inspectZipContainer(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const minimum = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) { eocd = offset; break; }
  }
  if (eocd < 0) fail("ZIPの終端情報が見つかりません。");
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) fail("分割ZIPには対応していません。");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("ZIP64形式には対応していません。");
  if (entryCount > IMPORT_LIMITS.maxEntries) fail(`ZIP内の項目数が上限${IMPORT_LIMITS.maxEntries}件を超えています。`);
  if (centralOffset + centralSize > eocd) fail("ZIPの中央ディレクトリが不正です。");

  const seenPaths = new Set();
  const sizes = new Map();
  let expandedTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) fail("ZIPの中央ディレクトリ項目が不正です。");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (flags & 1) fail("暗号化されたZIPには対応していません。");
    if (method !== 0 && method !== 8) fail("未対応のZIP圧縮方式が含まれています。");
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > eocd) fail("ZIP内パスの長さが不正です。");
    let rawPath;
    try { rawPath = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameStart, nameStart + nameLength)); }
    catch (_) { fail("ZIP内パスはUTF-8である必要があります。"); }
    const isDirectory = rawPath.endsWith("/");
    const normalized = validatePath(rawPath, isDirectory, seenPaths);
    expandedTotal += uncompressedSize;
    if (expandedTotal > IMPORT_LIMITS.maxExpandedBytes) fail("展開後の合計サイズが1GBを超えています。");
    sizes.set(normalized, uncompressedSize);
    if (isDirectory) {
      const directory = normalized.replace(/\/$/, "");
      if (directory !== "aoalb-export" && directory !== "aoalb-export/photos") fail(`想定外のフォルダがあります: ${rawPath}`);
    } else if (normalized !== "aoalb-export/manifest.json" && !/^aoalb-export\/photos\/[0-9a-f-]+\.jpg$/i.test(normalized)) {
      fail(`想定外のファイルがあります: ${rawPath}`);
    }
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) fail("ZIPの中央ディレクトリサイズが一致しません。");
  return { buffer, entryCount, expandedTotal, sizes };
}

async function decodeDimensions(blob) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try { return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close(); }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { const result = { width: image.naturalWidth, height: image.naturalHeight }; URL.revokeObjectURL(url); resolve(result); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("JPEGを画像としてデコードできません。")); };
    image.src = url;
  });
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function emitProgress(callback, phase, current, total, message) {
  callback?.({ phase, current, total, message, percent: total ? Math.round(current / total * 100) : 0 });
}

function normalizePhoto(photo, index, projectUid) {
  const label = `写真${index + 1}`;
  if (!photo || typeof photo !== "object" || Array.isArray(photo)) fail(`${label}のレコードが不正です。`);
  if (!UUID_RE.test(photo.photoUid || "")) fail(`${label}のphotoUidが有効なUUIDではありません。`);
  if (photo.projectUid !== projectUid) fail(`${label}のprojectUidが対象工事と一致しません。`);
  if (photo.filePath !== `photos/${photo.photoUid}.jpg`) fail(`${label}のfilePathはphotoUid.jpgと一致する必要があります。`);
  if (!SHA256_RE.test(photo.sha256 || "")) fail(`${label}のSHA-256が不正です。`);
  if (photo.mimeType !== "image/jpeg") fail(`${label}のmimeTypeはimage/jpegである必要があります。`);
  if (!Number.isSafeInteger(photo.bytes) || photo.bytes <= 0 || photo.bytes > IMPORT_LIMITS.maxJpegBytes) fail(`${label}のbytesが上限外です。`);
  if (!Number.isSafeInteger(photo.width) || !Number.isSafeInteger(photo.height) || photo.width <= 0 || photo.height <= 0) fail(`${label}の画像寸法が不正です。`);
  if (photo.width * photo.height > IMPORT_LIMITS.maxPixels) fail(`${label}は最大画素数50MPを超えています。`);
  const ledger = photo.ledger && typeof photo.ledger === "object" && !Array.isArray(photo.ledger) ? photo.ledger : {};
  return {
    photoUid: photo.photoUid,
    legacyId: photo.legacyId ?? null,
    projectUid,
    schemaVersion: photo.schemaVersion ?? null,
    capturedAt: requireText(photo.capturedAt ?? "", `${label}.capturedAt`),
    filePath: photo.filePath,
    sha256: photo.sha256,
    mimeType: "image/jpeg",
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    classification: normalizeFields(photo.classification || {}, TEXT_FIELDS, `${label}.classification`),
    boardSnapshot: normalizeFields(photo.boardSnapshot || {}, BOARD_FIELDS, `${label}.boardSnapshot`),
    ledger: {
      title: requireText(ledger.title ?? "", `${label}.ledger.title`),
      description: requireText(ledger.description ?? "", `${label}.ledger.description`),
      manual: ledger.manual === true
    }
  };
}

export async function validateAoalbZip(file, onProgress) {
  const context = { observedExportId: null, projectName: "" };
  if (!(file instanceof Blob)) fail("ZIPファイルを選択してください。", context);
  if (file.size <= 0) fail("ZIPファイルが空です。", context);
  if (file.size > IMPORT_LIMITS.maxZipBytes) fail("ZIPは250MB以下にしてください。", context);
  if (!globalThis.JSZip) fail("ZIP読込みライブラリを読み込めませんでした。", context);

  emitProgress(onProgress, "zip", 0, 1, "ZIP構造を確認しています");
  let inspection;
  try { inspection = await inspectZipContainer(file); }
  catch (error) {
    if (error instanceof ImportValidationError) throw new ImportValidationError(error.errors, context);
    fail("ZIP構造を確認できません。", context);
  }
  let zip;
  try { zip = await globalThis.JSZip.loadAsync(inspection.buffer, { createFolders: false, checkCRC32: true }); }
  catch (_) { fail("ZIPを開けません。ファイルが壊れている可能性があります。", context); }

  const entries = Object.values(zip.files);
  if (entries.length !== inspection.entryCount) fail("ZIP内に重複または不整合な項目があります。", context);

  const manifestEntry = zip.file("aoalb-export/manifest.json");
  if (!manifestEntry) fail("aoalb-export/manifest.jsonがありません。", context);
  if ((inspection.sizes.get("aoalb-export/manifest.json") || getUncompressedSize(manifestEntry)) > IMPORT_LIMITS.maxManifestBytes) fail("manifest.jsonが大きすぎます。", context);

  let manifest;
  try {
    const text = (await manifestEntry.async("string")).replace(/^\uFEFF/, "");
    manifest = JSON.parse(text);
  } catch (_) { fail("manifest.jsonをJSONとして解析できません。", context); }

  context.observedExportId = typeof manifest.exportId === "string" ? manifest.exportId : null;
  context.projectName = typeof manifest.project?.name === "string" ? manifest.project.name : "";
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest.jsonのルートが不正です。", context);
  if (manifest.app !== "aoPIC") fail("manifest.appはaoPICである必要があります。", context);
  if (manifest.type !== "aoALB-export") fail("manifest.typeはaoALB-exportである必要があります。", context);
  if (manifest.manifestVersion !== 1) fail("対応しているmanifestVersionは1だけです。", context);
  if (!UUID_RE.test(manifest.exportId || "")) fail("exportIdが有効なUUIDではありません。", context);
  if (!manifest.project || typeof manifest.project !== "object" || Array.isArray(manifest.project)) fail("projectが不正です。", context);
  if (!UUID_RE.test(manifest.project.projectUid || "")) fail("projectUidが有効なUUIDではありません。", context);
  if (!Array.isArray(manifest.photos)) fail("photosは配列である必要があります。", context);
  if (manifest.photos.length > IMPORT_LIMITS.maxPhotos) fail(`写真数が上限${IMPORT_LIMITS.maxPhotos}枚を超えています。`, context);

  const project = {
    projectUid: manifest.project.projectUid,
    koujiId: manifest.project.koujiId ?? null,
    name: requireText(manifest.project.name ?? "", "project.name", { allowEmpty: false }),
    contractor: requireText(manifest.project.contractor ?? "", "project.contractor")
  };
  const records = manifest.photos.map((photo, index) => normalizePhoto(photo, index, project.projectUid));
  const photoUids = new Set();
  const filePaths = new Set();
  for (const record of records) {
    if (photoUids.has(record.photoUid)) fail(`photoUidが重複しています: ${record.photoUid}`, context);
    if (filePaths.has(record.filePath)) fail(`filePathが重複しています: ${record.filePath}`, context);
    photoUids.add(record.photoUid);
    filePaths.add(record.filePath);
  }

  const actualJpegs = entries.filter(entry => !entry.dir && entry.name.startsWith("aoalb-export/photos/")).map(entry => entry.name.slice("aoalb-export/".length));
  const missing = records.map(record => record.filePath).filter(path => !actualJpegs.includes(path));
  const extra = actualJpegs.filter(path => !filePaths.has(path));
  if (missing.length) fail(`JPEGが不足しています: ${missing.join(", ")}`, context);
  if (extra.length) fail(`manifestにないJPEGがあります: ${extra.join(", ")}`, context);
  if (records.length !== actualJpegs.length) fail("写真レコードとJPEGが一対一で対応していません。", context);

  const photos = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    emitProgress(onProgress, "photo", index, records.length, `JPEGを検証中 ${index + 1}/${records.length}`);
    const entry = zip.file(`aoalb-export/${record.filePath}`);
    let bytes;
    try { bytes = await entry.async("uint8array"); }
    catch (_) { fail(`JPEGを展開できません: ${record.filePath}`, context); }
    if (bytes.length > IMPORT_LIMITS.maxJpegBytes) fail(`JPEGが20MBを超えています: ${record.filePath}`, context);
    if (bytes.length !== record.bytes) fail(`bytesが一致しません: ${record.filePath}`, context);
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail(`JPEGマジックバイトが不正です: ${record.filePath}`, context);
    const blob = new Blob([bytes], { type: "image/jpeg" });
    let dimensions;
    try { dimensions = await decodeDimensions(blob); }
    catch (_) { fail(`JPEGを画像としてデコードできません: ${record.filePath}`, context); }
    if (dimensions.width !== record.width || dimensions.height !== record.height) fail(`画像寸法が一致しません: ${record.filePath}`, context);
    const hash = await sha256Hex(bytes).catch(() => null);
    if (!hash) fail(`SHA-256を計算できません: ${record.filePath}`, context);
    if (hash !== record.sha256) fail(`SHA-256が一致しません: ${record.filePath}`, context);
    photos.push({ ...record, blob });
    if (index % 5 === 4) await new Promise(resolve => setTimeout(resolve, 0));
  }
  emitProgress(onProgress, "complete", records.length, records.length || 1, "全件の検証が完了しました");
  return {
    exportId: manifest.exportId,
    exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : null,
    project,
    photos,
    warnings: [],
    manifestVersion: 1,
    sourceName: file.name || ""
  };
}
