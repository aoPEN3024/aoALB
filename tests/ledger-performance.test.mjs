import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ledger = readFileSync(new URL("../js/ledger.js", import.meta.url), "utf8");
const print = readFileSync(new URL("../js/print.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(ledger, /function updateLibrarySelection\(previousPhotoId = ""\)/);
assert.match(ledger, /selectedPhotoId = selectedPhotoId === photo\.internalId \? "" : photo\.internalId;\s*selectedSlotIndex = -1;\s*updateLibrarySelection\(previousPhotoId\);/);
assert.match(ledger, /cachedPhotoAsset\(image\.dataset\.photoId, "thumbnail"\)/);
assert.match(ledger, /loadPhotoFile: photoId => cachedPhotoAsset\(photoId, assetKind\)/);
assert.match(ledger, /renderPreview\(\{ assetKind = "thumbnail", validateImmediately = false \} = \{\}\)/);
assert.match(ledger, /renderPreview\(\{ assetKind: "original", validateImmediately: true \}\)/);
assert.match(ledger, /Promise\.all\(\[[^]+saving\.then/);
assert.match(ledger, /function updatePreviewSlotSelection\(\)/);
assert.doesNotMatch(ledger, /selectedSlotIndex = selectedSlotIndex === index \? -1 : index;\s*renderPreview\(\)/);
assert.match(ledger, /const photoId = selectedPhotoId;\s*selectedPhotoId = "";\s*updateLibrarySelection\(photoId\);\s*mutate\(ledger => placePhoto\(ledger, index, photoId\)\);/);
assert.doesNotMatch(ledger, /then\(success => \{ if \(success\) selectedPhotoId = "";/);
assert.match(print, /if \(file\?\.url\) \{\s*image\.src = file\.url/);

for (const source of [ledger, app, html]) assert.match(source, /20261119-ledger-speed2/);
assert.doesNotMatch(`${ledger}\n${app}\n${html}`, /20261118-ledger-speed1/);

console.log("ledger interaction performance checks passed");
