# fsremote end-to-end tests

Playwright suite that drives the real React app against the Rust backend with
a deterministic, deeply-nested filesystem fixture.

## Layout

```
tests/e2e/
  playwright.config.ts   # Chromium project, spawns server + Vite via webServer
  globalSetup.ts         # Reseeds fixtures before every run
  specs/
    fixtures.ts          # Ground truth that mirrors the seed script
    helpers.ts           # login(), openWorkspace(), descend(), card()
    01-auth.spec.ts      # Valid + invalid sign-in
    02-navigation.spec.ts# Sidebar roots, deep folder drill-down, breadcrumb
    03-files.spec.ts     # List-view sizes, search, empty-folder state
  fixtures/              # (gitignored) generated seed output
```

Related files outside this folder:

- `scripts/seed-e2e.mjs` — builds the fixtures.
- `config.e2e.toml` — server config pointing at the seeded roots.
- `.cursor/mcp.json` — Playwright MCP server for chat-driven exploration.

## One-time setup

```bash
cd tests/e2e
npm install
npx playwright install chromium
```

## Running

From `tests/e2e/`:

```bash
npm test              # headed by default (watch the browser)
HEADLESS=1 npm test   # headless locally
npm run test:ui       # Playwright UI runner (best for debugging)
npm run report        # open the last HTML report
```

### Running from the Cursor agent / integrated shell

Chrome crashes in `HIServices / TransformProcessType` when launched inside
Cursor's extension-host process tree (Responsible Process: Cursor). Use
`scripts/run-e2e.sh` to spawn the run in a detached process with a different
parent, which avoids the crash:

```bash
./scripts/run-e2e.sh              # opens a new Terminal.app window (default)
./scripts/run-e2e.sh --nohup      # fully detached; logs -> tests/e2e/run.log
./scripts/run-e2e.sh --foreground # run in the current shell (same as npm test)
HEADLESS=1 ./scripts/run-e2e.sh   # headless in a new Terminal window
```

The script also stops anything already listening on `8080` / `5173` before
handing off to Playwright, so a stale dev stack won't block the run.

By default the suite uses your system-installed **Google Chrome** (via
`channel: "chrome"`) so no managed browser download is required — just make
sure Chrome is installed in `/Applications`.

If you prefer Playwright's bundled Chromium instead:

```bash
npm run install-browsers          # installs chromium + chromium-headless-shell
PLAYWRIGHT_CHANNEL=chromium npm test
```

CI runs set `process.env.CI`, which forces headless automatically.

Playwright's `webServer` block starts the Rust backend (`cargo run
-p fsremote-server` with `FSREMOTE_CONFIG=config.e2e.toml`) and the Vite dev
server automatically. Ports `8080` and `5173` must be free before the run —
stop any existing dev stack first:

```bash
lsof -ti tcp:8080 tcp:5173 -sTCP:LISTEN | xargs kill 2>/dev/null
```

To skip the (re)seed step on a run (e.g. if you've hand-edited the fixtures):

```bash
FSREMOTE_SKIP_SEED=1 npm test
```

## Seed script

Run the seeder directly from the repo root:

```bash
node scripts/seed-e2e.mjs           # full reseed
node scripts/seed-e2e.mjs --keep    # only fill in missing files
node scripts/seed-e2e.mjs --dest /tmp/other  # write elsewhere
```

The produced layout is deterministic — file sizes match `specs/fixtures.ts`
exactly, so assertions like `expect(row).toContainText("10.0 KB")` are safe.

| Workspace        | Max depth | Notable files                                    |
| ---------------- | --------- | ------------------------------------------------ |
| `workspace-a`    | 5 levels  | `docs/manuals/deep/archive/large.bin` (~2 MB)    |
| `workspace-b`    | 5 levels  | `projects/beta/data/big.bin` (~5 MB), `zero.txt` |

## Chat-driven exploration (Playwright MCP)

`.cursor/mcp.json` registers `@playwright/mcp`. To use it:

1. Reload Cursor (or toggle the server in Settings → MCP).
2. Start the stack manually with the e2e config:

   ```bash
   node scripts/seed-e2e.mjs
   FSREMOTE_CONFIG=config.e2e.toml ./scripts/start.sh
   ```

3. In chat, ask the agent to open `http://127.0.0.1:5173`, sign in as
   `admin` / `admin`, and click through the UI. The agent will report back
   with screenshots and DOM snapshots.

## Tips

- First `cargo run` compiles the backend; raise the `timeout` of the first
  `webServer` entry if you hit a cold-start timeout. You can also swap the
  `command` for the pre-built binary to skip Cargo entirely:

  ```ts
  command: "./target/debug/fsremote-server",
  ```

- Traces, videos, and screenshots are captured on failure into
  `tests/e2e/test-results/`; `playwright-report/` contains the browsable
  HTML report.
- Specs run with `workers: 1` and `fullyParallel: false` because they all
  share a single backend and mutate the same filesystem. If you add parallel
  specs, either seed per-test subfolders or add a dedicated root.
