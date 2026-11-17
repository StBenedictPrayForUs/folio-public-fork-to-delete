// How the smoke tests start Folio: a fresh profile, hidden unless FOLIO_SMOKE_SHOW=1, muted.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { electronPath } from "./electron-path.mjs";

export const root = path.resolve(import.meta.dirname, "..");

export function smokeLaunch(profilePrefix, extraArgs = []) {
  const env = { ...process.env, FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), profilePrefix)),
    FOLIO_TEST_HIDDEN: process.env.FOLIO_SMOKE_SHOW === "1" ? "0" : "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  // Containers often run as root, where Chromium's sandbox can't start.
  const args = [root, "--mute-audio", ...extraArgs,
    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
  return { env, executablePath: electronPath(env), args };
}
