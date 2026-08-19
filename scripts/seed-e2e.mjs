#!/usr/bin/env node
// Seed two workspace roots with deeply nested folders and files of varying
// sizes, used by the Playwright e2e suite. Deterministic so tests can assert
// sizes and file counts.
//
// Layout (relative to repo root, unless --dest specifies otherwise):
//   tests/e2e/fixtures/workspaceA/
//     README.md                                         (~ 200 B)
//     docs/
//       notes.md                                        (~ 1 KB)
//       manuals/
//         intro.txt                                     (~ 512 B)
//         deep/
//           chapter-1.txt                               (~ 10 KB)
//           chapter-2.txt                               (~ 100 KB)
//           archive/
//             large.bin                                 (~ 2 MB)
//     photos/
//       vacation/2024/07/
//         beach.jpg                                     (~ 500 KB)
//         sunset.jpg                                    (~ 1.5 MB)
//
//   tests/e2e/fixtures/workspaceB/
//     notes.txt                                         (~ 400 B)
//     zero.txt                                          (0 B)
//     projects/
//       alpha/src/nested/deep/
//         main.rs                                       (~ 4 KB)
//         lib.rs                                        (~ 16 KB)
//       beta/data/
//         sample.csv                                    (~ 250 KB)
//         big.bin                                       (~ 5 MB)
//
// Usage:
//   node scripts/seed-e2e.mjs            # seed fixtures (recreates them)
//   node scripts/seed-e2e.mjs --keep     # only create missing files
//   node scripts/seed-e2e.mjs --dest X   # write under a different root

import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const args = new Map();
for (let i = 2; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--keep" || a === "-k") args.set("keep", true);
  else if (a === "--help" || a === "-h") args.set("help", true);
  else if (a === "--dest") args.set("dest", argv[++i]);
  else {
    console.error(`Unknown argument: ${a}`);
    args.set("help", true);
  }
}

if (args.get("help")) {
  console.error(
    "Usage: node scripts/seed-e2e.mjs [--dest <dir>] [--keep]\n" +
      "  --dest   Parent directory for workspace fixtures.\n" +
      "           Defaults to <repo>/tests/e2e/fixtures\n" +
      "  --keep   Don't delete existing files before seeding.",
  );
  exit(0);
}

const DEST = resolve(args.get("dest") || join(REPO_ROOT, "tests/e2e/fixtures"));
const KEEP = Boolean(args.get("keep"));

// Deterministic pseudo-random byte generator (xorshift32) so every run
// produces byte-identical fixtures, letting tests assert sizes without
// drift between machines.
function makeRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x1a2b3c4d;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

async function writeBinary(path, size, seed) {
  await mkdir(dirname(path), { recursive: true });
  const rng = makeRng(seed);
  const ws = createWriteStream(path);
  const CHUNK = 64 * 1024;
  let remaining = size;
  const buf = Buffer.allocUnsafe(CHUNK);
  while (remaining > 0) {
    const n = Math.min(remaining, CHUNK);
    for (let i = 0; i < n; i += 4) {
      buf.writeUInt32LE(rng(), i);
    }
    if (!ws.write(buf.subarray(0, n))) {
      await new Promise((r) => ws.once("drain", r));
    }
    remaining -= n;
  }
  await new Promise((resolvePromise, reject) => {
    ws.on("finish", resolvePromise);
    ws.on("error", reject);
    ws.end();
  });
}

async function writeText(path, size, { seed, lineHint = "line" } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const rng = makeRng(seed ?? 0xa5a5a5);
  const ws = createWriteStream(path, { encoding: "utf8" });
  let written = 0;
  let lineNo = 1;
  while (written < size) {
    const jitter = rng() % 40;
    const line = `${lineHint} ${lineNo.toString().padStart(5, "0")} :: ${"x".repeat(jitter)}\n`;
    const remaining = size - written;
    const piece = line.length > remaining ? line.slice(0, remaining) : line;
    if (!ws.write(piece)) {
      await new Promise((r) => ws.once("drain", r));
    }
    written += Buffer.byteLength(piece, "utf8");
    lineNo += 1;
  }
  await new Promise((resolvePromise, reject) => {
    ws.on("finish", resolvePromise);
    ws.on("error", reject);
    ws.end();
  });
}

const KiB = 1024;
const MiB = 1024 * 1024;

const PLAN = [
  {
    root: "workspaceA",
    files: [
      { path: "README.md", kind: "text", size: 200, seed: 1 },
      { path: "docs/notes.md", kind: "text", size: 1 * KiB, seed: 2 },
      { path: "docs/manuals/intro.txt", kind: "text", size: 512, seed: 3 },
      {
        path: "docs/manuals/deep/chapter-1.txt",
        kind: "text",
        size: 10 * KiB,
        seed: 4,
      },
      {
        path: "docs/manuals/deep/chapter-2.txt",
        kind: "text",
        size: 100 * KiB,
        seed: 5,
      },
      {
        path: "docs/manuals/deep/archive/large.bin",
        kind: "binary",
        size: 2 * MiB,
        seed: 6,
      },
      {
        path: "photos/vacation/2024/07/beach.jpg",
        kind: "binary",
        size: 500 * KiB,
        seed: 7,
      },
      {
        path: "photos/vacation/2024/07/sunset.jpg",
        kind: "binary",
        size: 3 * MiB / 2,
        seed: 8,
      },
    ],
  },
  {
    root: "workspaceB",
    files: [
      { path: "notes.txt", kind: "text", size: 400, seed: 10 },
      { path: "zero.txt", kind: "binary", size: 0, seed: 0 },
      {
        path: "projects/alpha/src/nested/deep/main.rs",
        kind: "text",
        size: 4 * KiB,
        seed: 11,
      },
      {
        path: "projects/alpha/src/nested/deep/lib.rs",
        kind: "text",
        size: 16 * KiB,
        seed: 12,
      },
      {
        path: "projects/beta/data/sample.csv",
        kind: "text",
        size: 250 * KiB,
        seed: 13,
        lineHint: "row",
      },
      {
        path: "projects/beta/data/big.bin",
        kind: "binary",
        size: 5 * MiB,
        seed: 14,
      },
    ],
  },
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function seed() {
  await mkdir(DEST, { recursive: true });
  for (const workspace of PLAN) {
    const root = join(DEST, workspace.root);
    if (!KEEP && (await exists(root))) {
      await rm(root, { recursive: true, force: true });
    }
    await mkdir(root, { recursive: true });
    for (const f of workspace.files) {
      const full = join(root, f.path);
      if (KEEP && (await exists(full))) continue;
      if (f.kind === "text") {
        await writeText(full, f.size, {
          seed: f.seed,
          lineHint: f.lineHint,
        });
      } else {
        await writeBinary(full, f.size, f.seed);
      }
    }
    console.log(
      `seeded ${workspace.root} (${workspace.files.length} files) -> ${root}`,
    );
  }
}

seed().catch((err) => {
  console.error(err);
  exit(1);
});
