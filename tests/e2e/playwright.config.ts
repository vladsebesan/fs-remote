import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const WEB_URL = process.env.FSREMOTE_WEB_URL || "http://127.0.0.1:5173";
const API_URL = process.env.FSREMOTE_API_URL || "http://127.0.0.1:8080";
const REUSE = !process.env.CI;

export default defineConfig({
  testDir: "./specs",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "playwright-report" }]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  globalSetup: "./globalSetup.ts",
  use: {
    baseURL: WEB_URL,
    // Run headed locally so you can watch the tests; CI forces headless.
    headless: Boolean(process.env.CI) || process.env.HEADLESS === "1",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        // Use the user's system-installed Google Chrome. No need to run
        // `playwright install` — launches /Applications/Google Chrome.app
        // directly. Override with PLAYWRIGHT_CHANNEL=chromium to fall back to
        // a managed Playwright download if Chrome is not available.
        channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
      },
    },
  ],
  webServer: [
    {
      // Rust backend pointed at the seeded fixtures.
      command: "cargo run -p fsremote-server",
      cwd: REPO_ROOT,
      url: `${API_URL}/health`,
      reuseExistingServer: REUSE,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
      env: {
        FSREMOTE_CONFIG: `${REPO_ROOT}/config.e2e.toml`,
        RUST_LOG: process.env.RUST_LOG ?? "info",
      },
    },
    {
      // Vite dev server — proxies /api, /health, /ws to the backend.
      command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
      cwd: `${REPO_ROOT}/web`,
      url: WEB_URL,
      reuseExistingServer: REUSE,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
