const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const baseUrl = process.env.AOALB_TEST_URL || "http://127.0.0.1:8931/";

async function seed(page) {
  await page.evaluate(async () => {
    const request = indexedDB.open("aoALBDB", 5);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const value = request.result;
        if (!value.objectStoreNames.contains("imports")) {
          const store = value.createObjectStore("imports", { keyPath: "internalId" });
          store.createIndex("exportId", "exportId", { unique: true });
          store.createIndex("importedAt", "importedAt");
          store.createIndex("projectUid", "projectUid");
        }
        if (!value.objectStoreNames.contains("projects")) {
          const store = value.createObjectStore("projects", { keyPath: "internalId" });
          store.createIndex("projectUid", "projectUid", { unique: true });
          store.createIndex("lastImportedAt", "lastImportedAt");
        }
        if (!value.objectStoreNames.contains("photos")) {
          const store = value.createObjectStore("photos", { keyPath: "internalId" });
          store.createIndex("photoUid", "photoUid", { unique: true });
          store.createIndex("projectUid", "projectUid");
          store.createIndex("capturedAt", "capturedAt");
        }
        if (!value.objectStoreNames.contains("photoFiles")) {
          const store = value.createObjectStore("photoFiles", { keyPath: "photoInternalId" });
          store.createIndex("photoUid", "photoUid", { unique: true });
        }
        for (const name of ["ledgers", "settings"]) if (!value.objectStoreNames.contains(name)) value.createObjectStore(name, { keyPath: name === "settings" ? "key" : "internalId" });
        for (const [name, key] of [["cloudFiles", "cacheKey"], ["cloudChanges", "changeId"], ["cloudConflicts", "conflictId"]]) {
          if (!value.objectStoreNames.contains(name)) value.createObjectStore(name, { keyPath: key });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext("2d");
    context.fillStyle = "#4a6a86";
    context.fillRect(0, 0, 32, 24);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.45));
    const transaction = db.transaction(["projects", "photos", "photoFiles", "ledgers"], "readwrite");
    transaction.objectStore("projects").put({ internalId: "perf-project", projectUid: "perf-project-uid", name: "速度検証工事", contractor: "検証" });
    for (let index = 0; index < 300; index += 1) {
      const internalId = `perf-photo-${String(index).padStart(3, "0")}`;
      const photoUid = `perf-photo-uid-${String(index).padStart(3, "0")}`;
      transaction.objectStore("photos").put({
        internalId, photoUid, projectUid: "perf-project-uid",
        capturedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
        classification: { koushu: "塗装", shubetsu: "施工状況", saibetsu: "検証", sokuten: `測点${index + 1}`, tekiyo: "" },
        ledger: { title: `写真${index + 1}`, description: "速度検証用" }
      });
      transaction.objectStore("photoFiles").put({ photoInternalId: internalId, photoUid, blob });
    }
    const placed = Array.from({ length: 60 }, (_, index) => ({ type: "photo", photoId: `perf-photo-${String(index).padStart(3, "0")}` }));
    const pages = [];
    for (let index = 0; index < placed.length; index += 3) pages.push({ slots: placed.slice(index, index + 3) });
    pages.push({ slots: [{ type: "blank" }, { type: "blank" }, { type: "blank" }] });
    transaction.objectStore("ledgers").put({
      internalId: "perf-ledger", ledgerId: "perf-ledger", schemaVersion: 2, projectId: "perf-project",
      title: "速度検証台帳", template: "construction-3", showCover: true, viewMode: "single",
      captionOverrides: {}, pages, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    localStorage.setItem("aoALB:selectedProjectUid", "perf-project-uid");
    localStorage.setItem("aoALB:selectedLedgerId", "perf-ledger");
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) consoleErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`));
  try {
    await page.goto(`${baseUrl}#ledgers`, { waitUntil: "networkidle" });
    await seed(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#ledger-photo-list .ledger-photo-card").first().waitFor();
    assert.equal(await page.locator("#ledger-photo-list .ledger-photo-card").count(), 240);
    assert.equal(await page.locator("#ledger-pages .ledger-slot").count(), 63);

    await page.evaluate(() => { window.__selectedCard = document.querySelector("#ledger-photo-list .ledger-photo-card"); });
    const selectionStarted = Date.now();
    await page.locator("#ledger-photo-list .ledger-photo-card").first().click();
    const selectionMs = Date.now() - selectionStarted;
    assert.equal(await page.locator("#ledger-photo-list .ledger-photo-card.selected").count(), 1);
    assert.equal(await page.evaluate(() => window.__selectedCard === document.querySelector("#ledger-photo-list .ledger-photo-card")), true);
    assert.ok(selectionMs < 1000, `photo selection took ${selectionMs}ms`);

    const placementStarted = Date.now();
    await page.locator('#ledger-pages .ledger-slot.empty').first().click();
    await page.locator("#ledger-save-status").filter({ hasText: "保存しました" }).waitFor({ timeout: 10000 });
    const placementMs = Date.now() - placementStarted;
    assert.equal(await page.locator("#ledger-photo-list .ledger-photo-card").count(), 239);
    assert.equal(await page.locator("#ledger-pages .ledger-slot.empty").count(), 2);
    assert.ok(placementMs < 10000, `photo placement took ${placementMs}ms`);

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#ledger-pages .ledger-slot").first().waitFor();
    assert.equal(await page.locator("#ledger-photo-list .ledger-photo-card").count(), 239);
    assert.equal(await page.locator("#ledger-pages .ledger-slot.empty").count(), 2);

    await page.waitForFunction(() => !document.querySelector("#ledger-print")?.disabled);
    await page.evaluate(() => {
      window.__printCalled = false;
      window.print = () => { window.__printCalled = true; };
    });
    await page.locator("#ledger-print").click();
    await page.waitForFunction(() => window.__printCalled === true);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#ledger-pages img")].every(image => Boolean(image.src))), true);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await page.locator("#ledger-save-status").filter({ hasText: "印刷画面を開きました" }).waitFor();

    const responsive = [];
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      responsive.push(await page.evaluate(viewport => ({
        viewport,
        photoPaneVisible: getComputedStyle(document.querySelector(".ledger-library")).display !== "none",
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }), width));
    }
    const unexpectedErrors = consoleErrors.filter(message =>
      !message.includes("Content-Security-Policy directive")
      && !message.includes("Failed to load resource: the server responded with a status of 404"));
    assert.deepEqual(unexpectedErrors, []);
    console.log(JSON.stringify({ selectionMs, placementMs, photos: 300, placedBefore: 60, responsive, unexpectedErrors: unexpectedErrors.length }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
