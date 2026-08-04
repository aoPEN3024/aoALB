import assert from "node:assert/strict";
import fs from "node:fs";
import { effectiveClassification, hasClassificationOverride } from "../js/classification.js";

const source = {
  classification: { koushu: "塗装工", shubetsu: "下地", saibetsu: "清掃", sokuten: "A1", tekiyo: "施工前" }
};
assert.deepEqual(effectiveClassification(source), source.classification);
assert.equal(hasClassificationOverride(source), false);

const edited = {
  ...source,
  classificationOverride: { koushu: "補修工", sokuten: "", tekiyo: "変更後" }
};
assert.deepEqual(effectiveClassification(edited), {
  koushu: "補修工", shubetsu: "下地", saibetsu: "清掃", sokuten: "", tekiyo: "変更後"
});
assert.equal(hasClassificationOverride(edited), true);
assert.deepEqual(source.classification, { koushu: "塗装工", shubetsu: "下地", saibetsu: "清掃", sokuten: "A1", tekiyo: "施工前" });

const storage = fs.readFileSync(new URL("../js/storage.js", import.meta.url), "utf8");
assert.match(storage, /db\.transaction\("photos", "readwrite"\)/);
assert.match(storage, /delete photo\.classificationOverride/);
assert.match(storage, /for \(const field of fieldsToReset\) delete override\[field\]/);
assert.doesNotMatch(storage, /classificationOverride.*cloud\/photo-sync/);

const app = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
assert.match(app, /dataset\.resetOriginal/);
assert.match(app, /resetFields\.push\(field\)/);
assert.match(app, /photoListMode !== "active"/);

console.log("classification override verification: OK");
