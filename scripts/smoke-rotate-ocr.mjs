// A fax page that arrives sideways: turn it in Organize pages, save, and the reopened copy reads its text upright.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { electronPath } from "./electron-path.mjs";
import { readerPage } from "./reader-page.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { PDFDocument } = require("pdf-lib");
const env = { ...process.env, FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), "folio-rotate-")),
  FOLIO_TEST_HIDDEN: process.env.FOLIO_SMOKE_SHOW === "1" ? "0" : "1" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: electronPath(env), args: [root, "--mute-audio"], env, timeout: 60_000 });
try {
  const page = readerPage(await app.firstWindow());
  await page.getByRole("button", { name: /Try a sample/ }).waitFor({ timeout: 30_000 });

  // Two scanned pages: one upright, one whose text runs bottom to top (it needs a clockwise turn).
  const scans = await page.evaluate(() => [false, true].map(sideways => {
    const canvas = document.createElement("canvas");
    canvas.width = 1700; canvas.height = 2200;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#000"; g.font = "bold 64px Arial";
    if (sideways) { g.translate(0, canvas.height); g.rotate(-Math.PI / 2); }
    const lines = sideways ? ["SIDEWAYS ORDER FORM", "Liquid oxygen refill", "Signature on file"] : ["FAX COVER SHEET", "Referral for oxygen", "Please review"];
    lines.forEach((line, i) => g.fillText(line, 160, 220 + i * 110));
    return canvas.toDataURL("image/png");
  }));
  const pdf = await PDFDocument.create();
  for (const url of scans) {
    const image = await pdf.embedPng(Buffer.from(url.split(",")[1], "base64"));
    pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  }
  const bytes = Buffer.from(await pdf.save());
  await app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Sideways fax.pdf", data: Buffer.from(data), path: String.raw`C:\Faxes\Sideways fax.pdf` }), [...bytes]);
  await page.window.waitForFunction(() => document.title.startsWith("Sideways fax.pdf"));

  // A tab's right-click menu copies the path of the file it shows.
  const tabMenu = async name => {
    await page.getByRole("tab", { name, exact: true }).click({ button: "right" });
    return page.getByRole("menuitem", { name: "Copy file path" });
  };
  // Capture the write rather than touch this computer's clipboard.
  await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });
  await (await tabMenu("Sideways fax.pdf")).click();
  assert.equal(await page.evaluate(() => window.__copied), String.raw`C:\Faxes\Sideways fax.pdf`);
  console.log("ok  a tab's menu copies its file path");
  await page.locator('.page[data-page-number="1"] .textLayer').getByText(/COVER/).waitFor({ timeout: 90_000 });
  console.log("ok  the upright scan page is recognized");

  if (!(await page.locator(".sidebar").count())) await page.getByRole("button", { name: /Toggle sidebar/ }).click();
  await page.locator('.thumb[data-key="2"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rotate page clockwise" }).click();
  const organizer = page.getByRole("complementary", { name: "Organize pages" });
  await organizer.waitFor();
  const file = path.join(env.FOLIO_TEST_USER_DATA, "organized.pdf");
  await app.evaluate(({ session }, file) => {
    globalThis.folioRotated = new Promise(resolve => session.defaultSession.once("will-download", (_, item) => {
      item.setSavePath(file);
      item.once("done", (_, state) => resolve(state));
    }));
  }, file);
  await organizer.getByRole("button", { name: "Save organized copy" }).click();
  assert.equal(await app.evaluate(() => globalThis.folioRotated), "completed");
  const saved = await PDFDocument.load(readFileSync(file));
  assert.deepEqual(saved.getPages().map(p => p.getRotation().angle), [0, 90], "only the turned page is rotated");
  console.log("ok  the organized copy saves the page's new orientation");

  await page.window.waitForFunction(() => document.title.startsWith("Sideways fax (organized).pdf"));
  assert.equal(await organizer.count(), 0, "the organizer closes on the reopened copy");
  await page.locator('.page[data-page-number="2"]').scrollIntoViewIfNeeded();
  await page.locator('.page[data-page-number="2"] .textLayer').getByText(/SIDEWAYS/).waitFor({ timeout: 90_000 });
  console.log("ok  the turned page is recognized after saving");
  const copyPath = await tabMenu("Sideways fax (organized).pdf");
  assert.equal(await copyPath.isDisabled(), true, "the saved copy isn't the file the tab was opened from");
  await page.keyboard.press("Escape");
  await copyPath.waitFor({ state: "detached" });

  // A plain click away from selected text dismisses the selection popover, wherever it lands.
  const line = page.locator('.page[data-page-number="2"] .textLayer').getByText(/SIDEWAYS/).first();
  await line.scrollIntoViewIfNeeded();
  await line.dblclick();
  const popover = page.locator(".selection-popover");
  await popover.waitFor();
  const box = await page.locator('.page[data-page-number="2"]').boundingBox();
  // Blank spots on the visible part of the page: its lower right, then its lower left.
  const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  const bottom = Math.min(box.y + box.height, height) - 60;
  await page.mouse.click(Math.min(box.x + box.width, width) - 40, bottom);
  await popover.waitFor({ state: "detached", timeout: 3_000 });
  assert.equal(await page.evaluate(() => getSelection().isCollapsed), true);
  await line.dblclick();
  await popover.waitFor();
  await page.mouse.click(box.x + 30, bottom);
  await popover.waitFor({ state: "detached", timeout: 3_000 });
  await line.dblclick();
  await popover.waitFor();
  await page.locator(".sidebar").click({ position: { x: 10, y: 10 } });
  await popover.waitFor({ state: "detached", timeout: 3_000 });
  console.log("ok  clicking away dismisses the selection popover");

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.locator(".recent-card").first().waitFor();
  await page.screenshot({ path: path.join(root, "release", "smoke", "home-compact.png") });
} finally {
  await app.close();
}
