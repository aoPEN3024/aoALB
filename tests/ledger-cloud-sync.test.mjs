import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storage=readFileSync(new URL("../js/storage.js",import.meta.url),"utf8");
const sync=readFileSync(new URL("../js/cloud/ledger-sync.js",import.meta.url),"utf8");
const ledger=readFileSync(new URL("../js/ledger.js",import.meta.url),"utf8");
const provider=readFileSync(new URL("../js/cloud/supabase-provider.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../index.html",import.meta.url),"utf8");

assert.match(storage,/DB_VERSION = 5/);
assert.match(storage,/db\.transaction\(\["ledgers", "cloudChanges"\], "readwrite"\)/);
assert.match(storage,/db\.transaction\(\["cloudConflicts", "cloudChanges"\], "readwrite"\)/);
assert.match(storage,/db\.transaction\(\["photos", "cloudChanges"\], "readwrite"\)/);
assert.match(sync,/expectedRevision: Number\(ledger\.cloud\?\.revision \|\| 0\)/);
assert.match(sync,/recordCloudConflict/);
assert.match(sync,/getCloudConflicts\(siteId\)/);
assert.match(sync,/resolveClassificationConflict/);
assert.match(storage,/conflictStore\.index\("entityKey"\)/);
assert.match(storage,/resolveClassificationConflict/);
assert.match(storage,/expectedRevision: Number\(conflict\.cloudRevision \|\| 0\)/);
assert.match(sync,/if \(!project\?\.siteId[^]+return saveLedger\(ledger\)/);
assert.match(sync,/remoteByLocal/);
assert.match(ledger,/saveLedgerForProject/);
assert.match(provider,/save_ledger_snapshot/);
assert.match(provider,/save_photo_classification_override/);
assert.match(html,/id="ledger-conflict-list"/);
assert.doesNotMatch(sync,/service_role|sb_secret_|password|access_token|refresh_token/i);
console.log("ledger cloud sync static checks passed");
