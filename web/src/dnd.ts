export const DND_MIME = "application/x-fsremote";

export type DragPayload = {
  rootId: string;
  paths: string[];
};

export function writeDragPayload(
  dt: DataTransfer,
  payload: DragPayload,
) {
  try {
    dt.setData(DND_MIME, JSON.stringify(payload));
    dt.setData(
      "text/plain",
      payload.paths.map((p) => p.split("/").pop() ?? p).join("\n"),
    );
    dt.effectAllowed = "copyMove";
  } catch {
    /* older browsers */
  }
}

export function readDragPayload(dt: DataTransfer): DragPayload | null {
  try {
    const raw = dt.getData(DND_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DragPayload;
    if (
      !parsed ||
      typeof parsed.rootId !== "string" ||
      !Array.isArray(parsed.paths) ||
      parsed.paths.some((p) => typeof p !== "string")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

export function joinRel(base: string, leaf: string): string {
  if (!base) return leaf;
  return `${base.replace(/\/$/, "")}/${leaf}`;
}

export function leafName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

/// True when `candidate` equals `base` or lives under `base` (posix paths).
export function isUnder(candidate: string, base: string): boolean {
  if (base === "") return true;
  if (candidate === base) return true;
  return candidate.startsWith(base + "/");
}

/// Validates whether dragging `paths` from `fromRoot` onto `toRoot/toPath` is
/// safe (no self-drop, no into-own-descendant, no same-parent no-op). The
/// check only rejects same-root into-own-descendants; cross-root is always
/// allowed.
export function validateDrop(
  fromRoot: string,
  paths: string[],
  toRoot: string,
  toPath: string,
): { ok: true } | { ok: false; reason: string } {
  if (paths.length === 0) return { ok: false, reason: "no items" };
  const crossRoot = fromRoot !== toRoot;
  for (const p of paths) {
    if (!crossRoot) {
      if (p === toPath) {
        return { ok: false, reason: "cannot drop onto itself" };
      }
      if (isUnder(toPath, p)) {
        return { ok: false, reason: "cannot move a folder into itself" };
      }
    }
    if (!crossRoot && parentRel(p) === toPath) {
      return { ok: false, reason: "already in that folder" };
    }
  }
  return { ok: true };
}

export function dropEffectForEvent(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }): "move" | "copy" {
  return e.altKey || (e.ctrlKey && e.metaKey) ? "copy" : "move";
}

/// True when the drag carries OS files / folders (as opposed to our internal
/// move/copy payload).
export function hasExternalFiles(dt: DataTransfer): boolean {
  const types = Array.from(dt.types ?? []);
  return types.includes("Files");
}

/// One node extracted from an external drop. Directories are emitted before
/// their children so the upload loop can `mkdir` ancestors first.
export type ExternalNode =
  | { kind: "dir"; relPath: string }
  | { kind: "file"; relPath: string; file: File };

/// Extract `FileSystemEntry` objects from a drop event synchronously. The
/// returned entries remain usable after the event handler returns, but
/// `webkitGetAsEntry()` itself must be called now.
export function snapshotDropEntries(
  dt: DataTransfer,
): { entries: FileSystemEntry[]; looseFiles: File[] } {
  const items = Array.from(dt.items ?? []);
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const it of items) {
    if (it.kind !== "file") continue;
    const asEntry = (
      it as DataTransferItem & {
        webkitGetAsEntry?: () => FileSystemEntry | null;
      }
    ).webkitGetAsEntry?.();
    if (asEntry) {
      entries.push(asEntry);
    } else {
      const f = it.getAsFile();
      if (f) looseFiles.push(f);
    }
  }
  // Fallback: some environments only expose `files`, not `items`.
  if (entries.length === 0 && looseFiles.length === 0 && dt.files?.length) {
    for (const f of Array.from(dt.files)) looseFiles.push(f);
  }
  return { entries, looseFiles };
}

/// Walk the FileSystemEntry tree(s) depth-first, flattening into ExternalNodes
/// in traversal order (directory first, then its contents).
export async function walkExternalEntries(
  entries: FileSystemEntry[],
): Promise<ExternalNode[]> {
  const out: ExternalNode[] = [];
  for (const entry of entries) {
    await walkOne(entry, "", out);
  }
  return out;
}

async function walkOne(
  entry: FileSystemEntry,
  base: string,
  out: ExternalNode[],
): Promise<void> {
  const rel = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ kind: "file", relPath: rel, file });
    return;
  }
  if (entry.isDirectory) {
    out.push({ kind: "dir", relPath: rel });
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await readAllDirEntries(reader);
    for (const child of children) {
      await walkOne(child, rel, out);
    }
  }
}

function readAllDirEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}
