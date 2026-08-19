// Ground truth about what `scripts/seed-e2e.mjs` produces. Keep this in sync
// with the seed plan so specs can assert the filesystem contents.

export type Workspace = {
  rootId: string;
  label: string;
  // Direct entries at the workspace root.
  topLevel: { name: string; isDir: boolean; size: number }[];
  // Convenience paths used by navigation tests.
  deepFolder: string[]; // folder segments (clicked in order from root)
  deepFiles: { name: string; size: number }[]; // files visible at the deep folder
};

export const WORKSPACE_A: Workspace = {
  rootId: "workspace-a",
  label: "Workspace A",
  topLevel: [
    { name: "docs", isDir: true, size: 0 },
    { name: "photos", isDir: true, size: 0 },
    { name: "README.md", isDir: false, size: 200 },
  ],
  deepFolder: ["docs", "manuals", "deep"],
  deepFiles: [
    { name: "chapter-1.txt", size: 10 * 1024 },
    { name: "chapter-2.txt", size: 100 * 1024 },
  ],
};

export const WORKSPACE_B: Workspace = {
  rootId: "workspace-b",
  label: "Workspace B",
  topLevel: [
    { name: "projects", isDir: true, size: 0 },
    { name: "notes.txt", isDir: false, size: 400 },
    { name: "zero.txt", isDir: false, size: 0 },
  ],
  deepFolder: ["projects", "alpha", "src", "nested", "deep"],
  deepFiles: [
    { name: "lib.rs", size: 16 * 1024 },
    { name: "main.rs", size: 4 * 1024 },
  ],
};

export const ALL_WORKSPACES = [WORKSPACE_A, WORKSPACE_B];
