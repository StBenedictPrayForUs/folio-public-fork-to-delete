// Runs the Electron smoke tests at the same time, each in its own app and profile, and prints each one's output
// as a block when it finishes. Sequentially they take the sum of their times; together, about the longest one's.
// Run `npm run build` first.
import { spawn } from "node:child_process";
import path from "node:path";

const scripts = ["smoke-test.mjs", "smoke-documents.mjs", "smoke-rotate-ocr.mjs", "smoke-print.mjs", "smoke-print-resolution.mjs"];
const started = Date.now();
const results = await Promise.all(scripts.map((script) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, script)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("close", (code, signal) => {
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    process.stdout.write(`\n=== ${script} (${code === 0 ? "passed" : "FAILED"}, ${seconds}s)\n${output}`);
    resolve(code === 0 && !signal);
  });
})));
const failed = scripts.filter((_, i) => !results[i]);
if (failed.length) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  process.exit(1);
}
