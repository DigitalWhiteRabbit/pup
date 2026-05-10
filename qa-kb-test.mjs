import { chromium } from "/tmp/node_modules/playwright/index.mjs";
import path from "path";
import fs from "fs";

const BASE = "http://localhost:3000";
const SHOTS = "/Users/bruno/Desktop/pup/public/qa-screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

const log = (msg) => console.log(`[QA] ${msg}`);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const consoleLogs = [];
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
    else consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) =>
    consoleErrors.push(`PAGE ERROR: ${err.message}`),
  );

  // Step 1: Login
  log("Navigating to login page...");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.screenshot({
    path: path.join(SHOTS, "01-login-page.png"),
    fullPage: true,
  });
  log("Screenshot: 01-login-page.png");

  // Fill login form
  await page.fill("#loginOrEmail", "admin");
  await page.fill('input[type="password"]', "admin123");
  await page.screenshot({
    path: path.join(SHOTS, "02-login-filled.png"),
    fullPage: true,
  });

  await page.click('button[type="submit"]');
  await page
    .waitForNavigation({ waitUntil: "networkidle", timeout: 15000 })
    .catch(() => {});
  await page.screenshot({
    path: path.join(SHOTS, "03-after-login.png"),
    fullPage: true,
  });
  log(`After login URL: ${page.url()}`);

  // Step 2: Navigate to workspaces
  await page.goto(`${BASE}/workspaces`, { waitUntil: "networkidle" });
  await page.screenshot({
    path: path.join(SHOTS, "04-workspaces-list.png"),
    fullPage: true,
  });
  log("Screenshot: 04-workspaces-list.png");

  // Use known workspace ID from DB (Atlas workspace)
  const wsId = "cmoywo3wj00018znjwlmqy28f";
  log(`Using workspace ID: ${wsId}`);

  // Navigate directly to workspace dashboard
  await page.goto(`${BASE}/workspaces/${wsId}/dashboard`, {
    waitUntil: "networkidle",
  });
  await page.screenshot({
    path: path.join(SHOTS, "05-workspace-dashboard.png"),
    fullPage: true,
  });
  log(`Workspace dashboard URL: ${page.url()}`);

  // Step 3: Navigate to Knowledge Base
  await page.goto(`${BASE}/workspaces/${wsId}/knowledge`, {
    waitUntil: "networkidle",
  });
  await page.screenshot({
    path: path.join(SHOTS, "06-kb-page.png"),
    fullPage: true,
  });
  log(`KB URL: ${page.url()}`);

  // Step 4: Check for tabs
  const articlesTab = page
    .locator(
      'button:has-text("Статьи"), [role="tab"]:has-text("Статьи"), a:has-text("Статьи")',
    )
    .first();
  const docsTab = page
    .locator(
      'button:has-text("Документы"), [role="tab"]:has-text("Документы"), a:has-text("Документы")',
    )
    .first();

  const articlesVisible = await articlesTab.isVisible().catch(() => false);
  const docsVisible = await docsTab.isVisible().catch(() => false);
  log(`Статьи tab visible: ${articlesVisible}`);
  log(`Документы tab visible: ${docsVisible}`);

  await page.screenshot({
    path: path.join(SHOTS, "07-kb-tabs.png"),
    fullPage: true,
  });

  // Step 5: Click Документы tab
  if (docsVisible) {
    await docsTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(SHOTS, "08-kb-documents-tab.png"),
      fullPage: true,
    });
    log("Screenshot: 08-kb-documents-tab.png (Documents tab)");
  } else {
    log("WARNING: Документы tab not found, taking screenshot of current state");
    await page.screenshot({
      path: path.join(SHOTS, "08-kb-documents-tab-NOTFOUND.png"),
      fullPage: true,
    });
  }

  // Step 6: Check for file upload zone
  const uploadZone = page
    .locator(
      '[data-testid*="upload"], .upload-zone, input[type="file"], label:has-text("Выбрать файлы"), button:has-text("Выбрать файлы")',
    )
    .first();
  const uploadVisible = await uploadZone.isVisible().catch(() => false);
  log(`Upload zone visible: ${uploadVisible}`);

  // Step 7: Try to upload a test file
  // Create a small test file
  const testFilePath = "/tmp/qa-test-upload.txt";
  fs.writeFileSync(
    testFilePath,
    "QA Test file content - uploaded by EvidenceQA agent",
  );

  const fileInput = page.locator('input[type="file"]').first();
  const fileInputVisible = await fileInput.isVisible().catch(() => false);
  const fileInputExists = (await fileInput.count()) > 0;
  log(`File input exists: ${fileInputExists}, visible: ${fileInputVisible}`);

  if (fileInputExists) {
    // Set the file on the input (works even if hidden)
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(SHOTS, "09-after-file-select.png"),
      fullPage: true,
    });
    log("Screenshot: 09-after-file-select.png (after file selection)");

    // Look for upload/submit button
    const uploadBtn = page
      .locator(
        'button:has-text("Загрузить"), button:has-text("Upload"), button[type="submit"]',
      )
      .first();
    const uploadBtnVisible = await uploadBtn.isVisible().catch(() => false);
    if (uploadBtnVisible) {
      await uploadBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({
        path: path.join(SHOTS, "10-after-upload.png"),
        fullPage: true,
      });
      log("Screenshot: 10-after-upload.png (after upload attempt)");
    }
  } else {
    log("No file input found on documents tab");
    await page.screenshot({
      path: path.join(SHOTS, "09-no-file-input.png"),
      fullPage: true,
    });
  }

  // Final state screenshot
  await page.screenshot({
    path: path.join(SHOTS, "11-final-state.png"),
    fullPage: true,
  });

  // Output results
  const results = {
    url: page.url(),
    articlesTabVisible: articlesVisible,
    docsTabVisible: docsVisible,
    uploadZoneVisible: uploadVisible,
    fileInputExists,
    consoleErrors,
    consoleLogs: consoleLogs.slice(0, 30),
  };

  console.log("\n=== QA RESULTS ===");
  console.log(JSON.stringify(results, null, 2));

  await browser.close();
})();
