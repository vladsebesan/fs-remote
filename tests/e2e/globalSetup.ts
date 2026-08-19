import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SEED = resolve(REPO_ROOT, "scripts/seed-e2e.mjs");

// Runs once before the first test. We (re)seed the fixture trees so every
// run starts from a clean, deterministic filesystem.
export default async function globalSetup() {
  if (process.env.FSREMOTE_SKIP_SEED) return;
  execFileSync(process.execPath, [SEED], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}
