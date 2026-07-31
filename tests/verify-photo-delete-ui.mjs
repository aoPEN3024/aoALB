import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
const provider = await readFile(new URL("../js/cloud/supabase-provider.js", import.meta.url), "utf8");
const storage = await readFile(new URL("../js/storage.js", import.meta.url), "utf8");

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, "DOM IDs must be unique");

for (const id of [
  "photo-select-mode",
  "photo-select-all",
  "photo-select-clear",
  "photo-delete-selected",
  "show-trashed-photos",
  "photo-delete-dialog",
  "photo-delete-confirm-text",
  "detail-delete-photo",
  "detail-restore-photo"
]) {
  assert.ok(ids.includes(id), `missing DOM ID: ${id}`);
  assert.ok(app.includes(`"${id}"`), `app does not reference DOM ID: ${id}`);
}

assert.match(provider, /rpc\("trash_photos"/);
assert.match(provider, /rpc\("restore_photo"/);
assert.match(provider, /rpc\("photo_ledger_references"/);
assert.match(provider, /eq\("lifecycle_status", "active"\)/);
assert.match(storage, /db\.transaction\(PHOTO_DELETE_STORES, "readwrite"\)/);
assert.match(app, /selectedBytes/);
assert.match(app, /選択中 \$\{selected\}件・約\$\{formatBytes\(selectedBytes\)\}/);
assert.doesNotMatch(app + provider + storage, /service_role|database password|secret key/i);

console.log("photo deletion UI static verification: OK");
