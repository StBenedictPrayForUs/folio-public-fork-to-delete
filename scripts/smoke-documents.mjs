// Smoke checks that open their own documents (OCR, content editing, links, page export, organizing, pen widths).
// They run in a second app so `npm run smoke` can run them alongside smoke-test.mjs. Run `npm run build` first.
import { _electron as electron } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { readerPage } from "./reader-page.mjs";
import { checkDocumentTools } from "./smoke-reader-tools.mjs";
import { root, smokeLaunch } from "./smoke-launch.mjs";

const shots = path.join(root, "release", "smoke");
mkdirSync(shots, { recursive: true });
const { env, executablePath, args } = smokeLaunch("folio-smoke-documents-");
const app = await electron.launch({ executablePath, args, env, timeout: 60_000 });
try {
  const page = readerPage(await app.firstWindow());
  const failures = [];
  page.on("pageerror", (error) => {
    console.error(error.stack ?? String(error));
    failures.push(String(error));
  });
  await page.getByRole("button", { name: /Try a sample/ }).click({ timeout: 30_000 });
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  await checkDocumentTools(app, page, env.FOLIO_TEST_USER_DATA, shots);
  assert.deepEqual(failures, []);
  console.log(`PASS (${process.platform})`);
} finally {
  await app.close();
}
