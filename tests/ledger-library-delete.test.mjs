import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ledgerListDetails } from "../js/ledger.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ledgerJs = readFileSync(new URL("../js/ledger.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../js/storage.js", import.meta.url), "utf8");
const sync = readFileSync(new URL("../js/cloud/ledger-sync.js", import.meta.url), "utf8");
const provider = readFileSync(new URL("../js/cloud/supabase-provider.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/202609100001_ledger_lifecycle.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollback/202609100099_rollback_ledger_lifecycle.sql", import.meta.url), "utf8");

assert.deepEqual(ledgerListDetails({ internalId: "a", pages: [{ slots: [{ type: "photo", photoId: "1" }] }] }, "a"), {
  placed: 1, pages: 1, state: "編集中"
});
assert.equal(ledgerListDetails({ internalId: "b", syncStatus: "pending", pages: [] }).state, "保存待ち");
assert.equal(ledgerListDetails({ internalId: "b", syncStatus: "error", pages: [] }).state, "送信エラー");

for (const id of ["ledger-list", "ledger-list-body", "ledger-list-toggle", "ledger-list-count", "ledger-title-save", "ledger-delete-dialog", "ledger-delete-submit"]) {
  assert.match(html, new RegExp(`id="${id}"`));
}

assert.match(html, /aria-controls="ledger-list-body"/);
assert.match(ledgerJs, /function setLedgerListOpen\(open\)/);
assert.match(ledgerJs, /ui\.titleSave\.addEventListener\("click", saveLedgerTitle\)/);
assert.match(html, /写真一覧の写真や原寸画像は削除されません/);
assert.match(storage, /db\.transaction\(\["ledgers", "cloudChanges", "cloudConflicts"\], "readwrite"\)/);
assert.match(storage, /ledgerStore\.delete\(internalId\)/);
assert.doesNotMatch(storage.match(/export async function deleteLocalLedger[\s\S]*?\n}/)?.[0] || "", /photoFiles|photos|cloudFiles/);
assert.match(sync, /export async function deleteLedgerForProject/);
assert.match(sync, /provider\.deleteLedgerSnapshot/);
assert.match(sync, /provider\.listLedgerDeletions/);
assert.match(provider, /rpc\("delete_ledger_snapshot"/);
assert.match(provider, /rpc\("list_site_ledger_deletions"/);

assert.match(migration, /language plpgsql security definer set search_path = ''/);
assert.match(migration, /private\.has_site_role\(p_site_id, 'editor'\)/);
assert.match(migration, /p_expected_revision is distinct from v_ledger\.revision/);
assert.match(migration, /set deleted_at = pg_catalog\.now\(\), deleted_by = auth\.uid\(\)/);
assert.match(migration, /delete from public\.ledger_pages/);
assert.match(migration, /delete from public\.ledger_photo_captions/);
assert.doesNotMatch(migration, /delete from public\.photos|delete from public\.photo_objects|storage\.objects/);
assert.match(migration, /revoke all on function public\.delete_ledger_snapshot[^]+from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.delete_ledger_snapshot[^]+to authenticated/);
assert.match(rollback, /Rollback refused: deleted ledger tombstones exist/);

assert.match(html, /20260911-ledger-library2/);
console.log("ledger list and ledger-only deletion checks passed");
