import * as Comlink from "comlink";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Remote } from "comlink";
import {
  ActionIcon,
  Alert,
  Anchor,
  AppShell,
  Badge,
  Box,
  Breadcrumbs,
  Button,
  Card,
  Center,
  Code,
  Divider,
  FileButton,
  Flex,
  Group,
  Indicator,
  Loader,
  Menu,
  Modal,
  Paper,
  PasswordInput,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconAlertCircle,
  IconArrowsUpDown,
  IconChevronRight,
  IconClipboard,
  IconCloudUpload,
  IconCopy,
  IconCut,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconDeviceDesktop,
  IconLogout,
  IconMoon,
  IconSettings,
  IconSun,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

import { FileTree, type TreeEntry } from "./components/FileTree";
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuState,
} from "./components/ContextMenu";
import {
  DND_MIME,
  dropEffectForEvent,
  hasExternalFiles,
  joinRel,
  leafName,
  readDragPayload,
  snapshotDropEntries,
  validateDrop,
  walkExternalEntries,
  writeDragPayload,
  type ExternalNode,
} from "./dnd";
import appClasses from "./App.module.css";

type FsApi = {
  setEventHandler: (h: (m: any) => void) => void;
  login: (httpBase: string, u: string, p: string) => Promise<string>;
  connect: (wsUrl: string, token: string) => Promise<void>;
  list: (
    rootId: string,
    path: string,
  ) => Promise<{
    root_id: string;
    path: string;
    entries: FsEntry[];
  }>;
  listTree: (rootId: string) => Promise<{ root_id: string; tree: TreeEntry[] }>;
  mkdir: (rootId: string, path: string) => Promise<unknown>;
  remove: (rootId: string, path: string) => Promise<void>;
  rename: (rootId: string, from: string, to: string) => Promise<void>;
  copy: (
    fromRoot: string,
    from: string,
    toRoot: string,
    to: string,
  ) => Promise<{ toRoot: string; to: string }>;
  move: (
    fromRoot: string,
    from: string,
    toRoot: string,
    to: string,
  ) => Promise<{ toRoot: string; to: string }>;
  uploadFile: (
    rootId: string,
    path: string,
    file: File,
    onProgress?: (completed: number, total: number) => void,
  ) => Promise<void>;
  downloadFile: (
    rootId: string,
    path: string,
    onProgress?: (completed: number, total: number) => void,
  ) => Promise<Uint8Array>;
};

type RootInfo = { id: string; label: string };
type ViewMode = "grid" | "list";
type FsEntry = {
  name: string;
  is_dir: boolean;
  size: number;
  modified?: number;
};

type TransferKind = "upload" | "download";
type TransferStatus = "active" | "done" | "error";
type Transfer = {
  id: string;
  kind: TransferKind;
  name: string;
  totalBytes: number;
  completedBytes: number;
  status: TransferStatus;
  error?: string;
  startedAt: number;
};

const TRANSFER_KEEP_MS = 6_000;

type ClipboardState = {
  mode: "cut" | "copy";
  rid: string;
  paths: string[];
};

type SelectionState = {
  rid: string;
  paths: string[];
};

type DropTarget = { rid: string; rel: string } | null;

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024)
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatModified(secs?: number) {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  if (isNaN(d.getTime())) return "—";
  return dateFmt.format(d);
}

function relativeModified(secs?: number) {
  if (!secs) return null;
  const diffMs = Date.now() - secs * 1000;
  if (diffMs < 0) return null;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function parentRelPath(rel: string) {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

function joinPath(base: string, name: string) {
  if (!base) return name;
  return `${base.replace(/\/$/, "")}/${name}`;
}

export function App() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const hiddenUploadRef = useRef<HTMLInputElement | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [treesByRoot, setTreesByRoot] = useState<
    Record<string, TreeEntry[] | null>
  >({});
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const NAVBAR_MIN_W = 220;
  const NAVBAR_MAX_W = 560;
  const NAVBAR_DEFAULT_W = 308;
  const [navbarWidth, setNavbarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return NAVBAR_DEFAULT_W;
    const raw = window.localStorage.getItem("fsr:navbar-width");
    const n = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return NAVBAR_DEFAULT_W;
    return Math.max(NAVBAR_MIN_W, Math.min(NAVBAR_MAX_W, n));
  });
  useEffect(() => {
    window.localStorage.setItem("fsr:navbar-width", String(navbarWidth));
  }, [navbarWidth]);

  const startNavbarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = navbarWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const w = Math.max(
          NAVBAR_MIN_W,
          Math.min(NAVBAR_MAX_W, startW + dx),
        );
        setNavbarWidth(w);
      };
      const cleanup = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", cleanup);
    },
    [navbarWidth],
  );

  const apiRef = useRef<Remote<FsApi> | null>(null);
  const rootIdRef = useRef<string | null>(null);
  rootIdRef.current = rootId;

  const httpBase = useMemo(() => "", []);
  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    return `${proto}//${host}/ws`;
  }, []);

  const upsertTransfer = useCallback(
    (id: string, patch: Partial<Transfer> & Pick<Transfer, "kind" | "name">) => {
      setTransfers((prev) => {
        const existing = prev[id];
        const next: Transfer = {
          id,
          kind: patch.kind,
          name: patch.name,
          totalBytes: patch.totalBytes ?? existing?.totalBytes ?? 0,
          completedBytes:
            patch.completedBytes ?? existing?.completedBytes ?? 0,
          status: patch.status ?? existing?.status ?? "active",
          error: patch.error ?? existing?.error,
          startedAt: existing?.startedAt ?? Date.now(),
        };
        return { ...prev, [id]: next };
      });
    },
    [],
  );

  const finishTransfer = useCallback(
    (id: string, status: "done" | "error", error?: string) => {
      setTransfers((prev) => {
        const t = prev[id];
        if (!t) return prev;
        return {
          ...prev,
          [id]: {
            ...t,
            status,
            error,
            completedBytes:
              status === "done" ? t.totalBytes || t.completedBytes : t.completedBytes,
          },
        };
      });
      window.setTimeout(() => {
        setTransfers((prev) => {
          if (!prev[id]) return prev;
          const { [id]: _gone, ...rest } = prev;
          return rest;
        });
      }, TRANSFER_KEEP_MS);
    },
    [],
  );

  const loadRoots = useCallback(async (): Promise<RootInfo[]> => {
    const r = await fetch(`${httpBase}/api/roots`);
    if (!r.ok) throw new Error("failed to load roots");
    return (await r.json()) as RootInfo[];
  }, [httpBase]);

  useEffect(() => {
    void loadRoots()
      .then((list) => {
        setRoots(list);
        setRootId((prev) =>
          prev && list.some((x) => x.id === prev)
            ? prev
            : list[0]?.id ?? null,
        );
      })
      .catch(() => {
        setRoots([]);
        setRootId(null);
      });
  }, [loadRoots]);

  const refreshList = useCallback(async () => {
    const api = apiRef.current;
    const rid = rootId;
    if (!api || !token || !rid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.list(rid, path);
      setEntries(res.entries);
    } catch (e) {
      const msg = String(e);
      const missing = /No such file or directory|not found|os error 2/i.test(
        msg,
      );
      if (missing && path !== "") {
        const i = path.lastIndexOf("/");
        const parent = i === -1 ? "" : path.slice(0, i);
        setPath(parent);
        return;
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [path, token, rootId]);

  const refreshListRef = useRef(refreshList);
  refreshListRef.current = refreshList;

  const syncTreeFor = useCallback(
    async (rid: string) => {
      const api = apiRef.current;
      if (!api || !token) return;
      try {
        const r = await api.listTree(rid);
        setTreesByRoot((prev) => ({ ...prev, [rid]: r.tree }));
      } catch (e) {
        setError(String(e));
      }
    },
    [token],
  );

  const syncAllTrees = useCallback(async () => {
    if (!token || roots.length === 0) return;
    await Promise.all(roots.map((r) => syncTreeFor(r.id)));
  }, [token, roots, syncTreeFor]);

  const syncTreeForRef = useRef(syncTreeFor);
  syncTreeForRef.current = syncTreeFor;

  useEffect(() => {
    const w = new Worker(new URL("./fsWorker.ts", import.meta.url), {
      type: "module",
    });
    const api = Comlink.wrap<FsApi>(w);
    apiRef.current = api;
    api.setEventHandler(
      Comlink.proxy((m: any) => {
        if (m?.type === "fs_changed") {
          if (m.root_id) void syncTreeForRef.current(m.root_id);
          if (m.root_id === rootIdRef.current) {
            void refreshListRef.current();
          }
        }
      }),
    );
    return () => w.terminate();
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!token || roots.length === 0) return;
    void syncAllTrees();
  }, [token, roots, syncAllTrees]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const api = apiRef.current;
    if (!api) return;
    setBusy(true);
    try {
      let list = roots;
      if (list.length === 0) {
        list = await loadRoots();
        setRoots(list);
      }
      const rid =
        (rootId && list.some((x) => x.id === rootId)
          ? rootId
          : list[0]?.id) ?? null;
      if (!rid) {
        throw new Error(
          "No workspace folders configured (add at least one [[roots]] entry in config.toml)",
        );
      }
      setRootId(rid);

      const tok = await api.login(httpBase, username, password);
      setToken(tok);
      await api.connect(wsUrl, tok);
      notifications.show({
        title: "Signed in",
        message: "Connected to fsremote",
        color: "indigo",
      });
    } catch (e) {
      setError(String(e));
      notifications.show({
        title: "Sign-in failed",
        message: String(e),
        color: "red",
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setSearch("");
  }, [rootId, path]);

  const visibleEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, search]);

  const transferList = useMemo(() => {
    return Object.values(transfers).sort((a, b) => {
      if (a.status === b.status) return b.startedAt - a.startedAt;
      const order = (s: TransferStatus) => (s === "active" ? 0 : s === "error" ? 1 : 2);
      return order(a.status) - order(b.status);
    });
  }, [transfers]);

  const crumbs = useMemo(() => {
    const rootLabel = roots.find((r) => r.id === rootId)?.label ?? "Root";
    const parts = path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [
      { label: rootLabel, path: "" },
    ];
    let acc = "";
    for (const p of parts) {
      acc = joinPath(acc, p);
      out.push({ label: p, path: acc });
    }
    return out;
  }, [path, roots, rootId]);

  async function onUploadFile(file: File | null) {
    if (!file || !token || !rootId) return;
    const api = apiRef.current!;
    const id = crypto.randomUUID();
    upsertTransfer(id, {
      kind: "upload",
      name: file.name,
      totalBytes: file.size,
      completedBytes: 0,
      status: "active",
    });
    setBusy(true);
    setError(null);
    try {
      const rel = joinPath(path, file.name);
      await api.uploadFile(
        rootId,
        rel,
        file,
        Comlink.proxy((completed: number, total: number) => {
          upsertTransfer(id, {
            kind: "upload",
            name: file.name,
            totalBytes: total,
            completedBytes: completed,
            status: "active",
          });
        }),
      );
      await refreshList();
      finishTransfer(id, "done");
      notifications.show({
        title: "Upload complete",
        message: file.name,
        color: "indigo",
      });
    } catch (err) {
      const msg = String(err);
      setError(msg);
      finishTransfer(id, "error", msg);
      notifications.show({
        title: "Upload failed",
        message: msg,
        color: "red",
      });
    } finally {
      setBusy(false);
    }
  }

  function onDownload(name: string) {
    if (!rootId) return;
    void onDownloadAt(rootId, joinPath(path, name));
  }

  function onDelete(name: string) {
    if (!rootId) return;
    onDeleteAt(rootId, joinPath(path, name));
  }

  function splitRel(rel: string): { parent: string; name: string } {
    const i = rel.lastIndexOf("/");
    if (i === -1) return { parent: "", name: rel };
    return { parent: rel.slice(0, i), name: rel.slice(i + 1) };
  }

  const selectionPathsForCurrent = useMemo(() => {
    if (!selection || selection.rid !== rootId) return new Set<string>();
    return new Set(selection.paths);
  }, [selection, rootId]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    selectionAnchorRef.current = null;
  }, []);

  useEffect(() => {
    clearSelection();
  }, [rootId, path, clearSelection]);

  function onCutToClipboard(rid: string, paths: string[]) {
    if (paths.length === 0) return;
    setClipboard({ mode: "cut", rid, paths });
    notifications.show({
      message:
        paths.length === 1
          ? `Cut “${leafName(paths[0])}”`
          : `Cut ${paths.length} items`,
      color: "indigo",
    });
  }

  function onCopyToClipboard(rid: string, paths: string[]) {
    if (paths.length === 0) return;
    setClipboard({ mode: "copy", rid, paths });
    notifications.show({
      message:
        paths.length === 1
          ? `Copied “${leafName(paths[0])}”`
          : `Copied ${paths.length} items`,
      color: "indigo",
    });
  }

  async function onPasteInto(targetRid: string, targetPath: string) {
    if (!clipboard) return;
    const api = apiRef.current!;
    const { mode, rid: fromRid, paths } = clipboard;
    // Guard: can't paste into an item that's being moved/copied.
    for (const p of paths) {
      if (fromRid === targetRid && (p === targetPath || targetPath.startsWith(p + "/"))) {
        notifications.show({
          title: "Paste blocked",
          message: "Cannot paste a folder into itself.",
          color: "red",
        });
        return;
      }
    }
    setBusy(true);
    setError(null);
    let okCount = 0;
    const errors: string[] = [];
    for (const fromRel of paths) {
      const name = leafName(fromRel);
      const toRel = joinRel(targetPath, name);
      try {
        if (mode === "cut") {
          await api.move(fromRid, fromRel, targetRid, toRel);
        } else {
          await api.copy(fromRid, fromRel, targetRid, toRel);
        }
        okCount += 1;
      } catch (err) {
        errors.push(`${name}: ${String(err)}`);
      }
    }
    if (mode === "cut") setClipboard(null);
    setBusy(false);
    if (errors.length === 0) {
      notifications.show({
        message:
          mode === "cut"
            ? `Moved ${okCount} item${okCount === 1 ? "" : "s"}`
            : `Copied ${okCount} item${okCount === 1 ? "" : "s"}`,
        color: "indigo",
      });
    } else {
      notifications.show({
        title: "Some operations failed",
        message: errors.slice(0, 3).join("\n"),
        color: "red",
      });
    }
  }

  // Move or copy a batch of `paths` from `fromRid` to `toRid/toPath`. Used by
  // drag-and-drop. `mode` decides whether it's a move (default) or copy.
  async function runBatchTransfer(
    mode: "move" | "copy",
    fromRid: string,
    paths: string[],
    toRid: string,
    toPath: string,
  ) {
    if (paths.length === 0) return;
    const v = validateDrop(fromRid, paths, toRid, toPath);
    if (!v.ok) {
      notifications.show({ message: v.reason, color: "yellow" });
      return;
    }
    const api = apiRef.current!;
    setBusy(true);
    setError(null);
    let okCount = 0;
    const errors: string[] = [];
    for (const fromRel of paths) {
      const name = leafName(fromRel);
      const toRel = joinRel(toPath, name);
      try {
        if (mode === "move") {
          await api.move(fromRid, fromRel, toRid, toRel);
        } else {
          await api.copy(fromRid, fromRel, toRid, toRel);
        }
        okCount += 1;
      } catch (err) {
        errors.push(`${name}: ${String(err)}`);
      }
    }
    setBusy(false);
    clearSelection();
    if (errors.length === 0) {
      notifications.show({
        message:
          mode === "move"
            ? `Moved ${okCount} item${okCount === 1 ? "" : "s"}`
            : `Copied ${okCount} item${okCount === 1 ? "" : "s"}`,
        color: "indigo",
      });
    } else {
      notifications.show({
        title: "Some operations failed",
        message: errors.slice(0, 3).join("\n"),
        color: "red",
      });
    }
  }

  function onRenameAt(rid: string, fromRel: string) {
    const { parent, name } = splitRel(fromRel);
    modals.open({
      title: "Rename",
      centered: true,
      children: (
        <RenameForm
          initial={name}
          onCancel={() => modals.closeAll()}
          onSubmit={async (newName) => {
            modals.closeAll();
            const api = apiRef.current!;
            const toRel = joinPath(parent, newName);
            if (toRel === fromRel) return;
            setBusy(true);
            setError(null);
            try {
              await api.rename(rid, fromRel, toRel);
              if (rid === rootId) {
                if (path === fromRel) {
                  setPath(toRel);
                } else if (path.startsWith(fromRel + "/")) {
                  setPath(toRel + path.slice(fromRel.length));
                } else {
                  await refreshList();
                }
              }
              notifications.show({
                message: `Renamed to “${newName}”`,
                color: "indigo",
              });
            } catch (err) {
              const msg = String(err);
              setError(msg);
              notifications.show({
                title: "Rename failed",
                message: msg,
                color: "red",
              });
            } finally {
              setBusy(false);
            }
          }}
        />
      ),
    });
  }

  function onDeleteAt(rid: string, fromRel: string) {
    onDeleteMany(rid, [fromRel]);
  }

  function onDeleteMany(rid: string, paths: string[]) {
    if (paths.length === 0) return;
    const preview = paths.slice(0, 5).map(leafName);
    const remaining = paths.length - preview.length;
    modals.openConfirmModal({
      title: paths.length === 1 ? "Delete" : `Delete ${paths.length} items`,
      centered: true,
      children: (
        <Stack gap={6}>
          <Text size="sm">
            {paths.length === 1 ? (
              <>
                Delete <strong>{leafName(paths[0])}</strong>?
              </>
            ) : (
              <>Delete these {paths.length} items?</>
            )}
          </Text>
          {paths.length > 1 ? (
            <Stack gap={2}>
              {preview.map((n) => (
                <Text key={n} size="xs" c="dimmed" ff="ui-monospace, monospace">
                  • {n}
                </Text>
              ))}
              {remaining > 0 ? (
                <Text size="xs" c="dimmed">
                  … and {remaining} more
                </Text>
              ) : null}
            </Stack>
          ) : null}
          <Text size="xs" c="dimmed">
            This cannot be undone.
          </Text>
        </Stack>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red", "data-testid": "confirm-delete" } as any,
      onConfirm: async () => {
        const api = apiRef.current!;
        setBusy(true);
        setError(null);
        const errors: string[] = [];
        let okCount = 0;
        for (const fromRel of paths) {
          try {
            await api.remove(rid, fromRel);
            okCount += 1;
            if (
              rid === rootId &&
              (path === fromRel || path.startsWith(fromRel + "/"))
            ) {
              const i = fromRel.lastIndexOf("/");
              setPath(i === -1 ? "" : fromRel.slice(0, i));
            }
          } catch (err) {
            errors.push(`${leafName(fromRel)}: ${String(err)}`);
          }
        }
        setBusy(false);
        clearSelection();
        if (rid === rootId) {
          await refreshList();
        }
        if (errors.length === 0) {
          notifications.show({
            message:
              okCount === 1
                ? `Deleted “${leafName(paths[0])}”`
                : `Deleted ${okCount} items`,
            color: "red",
          });
        } else {
          notifications.show({
            title: "Some deletes failed",
            message: errors.slice(0, 3).join("\n"),
            color: "red",
          });
        }
      },
    });
  }

  async function onDownloadAt(rid: string, fromRel: string) {
    const api = apiRef.current!;
    const { name } = splitRel(fromRel);
    const id = crypto.randomUUID();
    upsertTransfer(id, {
      kind: "download",
      name,
      totalBytes: 0,
      completedBytes: 0,
      status: "active",
    });
    setBusy(true);
    setError(null);
    try {
      const bytes = await api.downloadFile(
        rid,
        fromRel,
        Comlink.proxy((completed: number, total: number) => {
          upsertTransfer(id, {
            kind: "download",
            name,
            totalBytes: total,
            completedBytes: completed,
            status: "active",
          });
        }),
      );
      const blob = new Blob([bytes as BlobPart], {
        type: "application/octet-stream",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      finishTransfer(id, "done");
    } catch (err) {
      const msg = String(err);
      setError(msg);
      finishTransfer(id, "error", msg);
    } finally {
      setBusy(false);
    }
  }

  function openCtx(
    e: React.MouseEvent,
    items: ContextMenuItem[],
  ) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }

  // When right-clicking an item, if it's not already selected replace the
  // selection with just it. Otherwise keep the existing multi-selection so
  // the action applies to the whole batch.
  function ensureSelected(rid: string, rel: string): string[] {
    const inSelection =
      selection &&
      selection.rid === rid &&
      selection.paths.includes(rel);
    if (inSelection) {
      return selection!.paths;
    }
    setSelection({ rid, paths: [rel] });
    selectionAnchorRef.current = rel;
    return [rel];
  }

  function pasteMenuItem(targetRid: string, targetPath: string): ContextMenuItem {
    const enabled = !!clipboard;
    const label = clipboard
      ? clipboard.paths.length === 1
        ? `Paste “${leafName(clipboard.paths[0])}”`
        : `Paste ${clipboard.paths.length} items`
      : "Paste";
    return {
      label,
      icon: <IconClipboard size={14} />,
      onClick: () => void onPasteInto(targetRid, targetPath),
      disabled: !enabled,
    };
  }

  function fileMenuItems(rid: string, fromRel: string): ContextMenuItem[] {
    const batch = ensureSelected(rid, fromRel);
    const multi = batch.length > 1;
    return [
      ...(multi
        ? []
        : [
            {
              label: "Download",
              icon: <IconDownload size={14} />,
              onClick: () => void onDownloadAt(rid, fromRel),
            } as ContextMenuItem,
          ]),
      {
        label: multi ? `Cut ${batch.length} items` : "Cut",
        icon: <IconCut size={14} />,
        onClick: () => onCutToClipboard(rid, batch),
      },
      {
        label: multi ? `Copy ${batch.length} items` : "Copy",
        icon: <IconCopy size={14} />,
        onClick: () => onCopyToClipboard(rid, batch),
      },
      ...(multi
        ? []
        : [
            {
              label: "Rename…",
              icon: <IconEdit size={14} />,
              onClick: () => onRenameAt(rid, fromRel),
            } as ContextMenuItem,
          ]),
      { type: "divider" } as ContextMenuItem,
      {
        label: multi ? `Delete ${batch.length} items` : "Delete",
        icon: <IconTrash size={14} />,
        onClick: () => onDeleteMany(rid, batch),
        danger: true,
      },
    ];
  }

  function folderMenuItems(rid: string, fromRel: string): ContextMenuItem[] {
    const batch = ensureSelected(rid, fromRel);
    const multi = batch.length > 1;
    return [
      ...(multi
        ? []
        : [
            {
              label: "Open",
              icon: <IconFolder size={14} />,
              onClick: () => {
                if (rid !== rootId) setRootId(rid);
                setPath(fromRel);
              },
            } as ContextMenuItem,
          ]),
      pasteMenuItem(rid, fromRel),
      {
        label: multi ? `Cut ${batch.length} items` : "Cut",
        icon: <IconCut size={14} />,
        onClick: () => onCutToClipboard(rid, batch),
      },
      {
        label: multi ? `Copy ${batch.length} items` : "Copy",
        icon: <IconCopy size={14} />,
        onClick: () => onCopyToClipboard(rid, batch),
      },
      ...(multi
        ? []
        : [
            {
              label: "Rename…",
              icon: <IconEdit size={14} />,
              onClick: () => onRenameAt(rid, fromRel),
            } as ContextMenuItem,
          ]),
      { type: "divider" },
      {
        label: multi ? `Delete ${batch.length} items` : "Delete",
        icon: <IconTrash size={14} />,
        onClick: () => onDeleteMany(rid, batch),
        danger: true,
      },
    ];
  }

  function emptyAreaMenuItems(): ContextMenuItem[] {
    return [
      {
        label: "Upload file…",
        icon: <IconCloudUpload size={14} />,
        onClick: () => hiddenUploadRef.current?.click(),
        disabled: !rootId,
      },
      pasteMenuItem(rootId ?? "", path),
      {
        label: "New folder…",
        icon: <IconFolderPlus size={14} />,
        onClick: () => openNewFolderModal(),
        disabled: !rootId,
      },
    ];
  }

  function openNewFolderModal() {
    if (!rootId) return;
    modals.open({
      title: "New folder",
      centered: true,
      children: (
        <RenameForm
          initial=""
          submitLabel="Create"
          placeholder="Folder name"
          onCancel={() => modals.closeAll()}
          onSubmit={async (name) => {
            modals.closeAll();
            if (!name.trim() || !rootId) return;
            const api = apiRef.current!;
            const target = joinPath(path, name.trim());
            setBusy(true);
            setError(null);
            try {
              await api.mkdir(rootId, target);
              await refreshList();
              notifications.show({
                message: `Created “${name}”`,
                color: "indigo",
              });
            } catch (err) {
              setError(String(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      ),
    });
  }

  function enterDir(name: string) {
    setPath(joinPath(path, name));
  }

  function goToCrumb(targetPath: string) {
    setPath(targetPath);
  }

  function onLogout() {
    setToken(null);
    setPath("");
    setEntries([]);
    setTreesByRoot({});
    setTransfers({});
    setClipboard(null);
    clearSelection();
    setDropTarget(null);
    setError(null);
  }

  const visibleNamesRef = useRef<string[]>([]);
  useEffect(() => {
    visibleNamesRef.current = visibleEntries.map((e) => e.name);
  }, [visibleEntries]);

  function onEntryClick(
    ev: React.MouseEvent,
    rid: string,
    rel: string,
    isDir: boolean,
    name: string,
  ) {
    const modTypical = ev.metaKey || ev.ctrlKey;
    const shift = ev.shiftKey;
    if (shift && selection && selection.rid === rid) {
      const anchor = selectionAnchorRef.current ?? selection.paths[selection.paths.length - 1];
      const names = visibleNamesRef.current;
      const anchorName = anchor ? leafName(anchor) : name;
      const a = names.indexOf(anchorName);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const range = names
          .slice(lo, hi + 1)
          .map((n) => joinRel(path, n));
        setSelection({ rid, paths: range });
        return;
      }
    }
    if (modTypical) {
      const cur = selection && selection.rid === rid ? selection.paths : [];
      const has = cur.includes(rel);
      const next = has ? cur.filter((x) => x !== rel) : [...cur, rel];
      setSelection(next.length === 0 ? null : { rid, paths: next });
      selectionAnchorRef.current = rel;
      return;
    }
    setSelection({ rid, paths: [rel] });
    selectionAnchorRef.current = rel;
    if (isDir && !ev.defaultPrevented) {
      enterDir(name);
    }
  }

  function isEditableTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    if (el.closest?.("[role=dialog]")) return true;
    return false;
  }

  // Swallow OS-file drops that land outside any registered drop target so the
  // browser doesn't navigate away and replace the app with the dropped file.
  useEffect(() => {
    if (!token) return;
    const block = (ev: DragEvent) => {
      const types = Array.from(ev.dataTransfer?.types ?? []);
      if (!types.includes("Files")) return;
      ev.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const onKey = (ev: KeyboardEvent) => {
      if (isEditableTarget(ev.target)) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (ev.key === "Escape") {
        if (selection) {
          ev.preventDefault();
          clearSelection();
        } else if (clipboard) {
          ev.preventDefault();
          setClipboard(null);
        }
        return;
      }
      if ((ev.key === "Delete" || ev.key === "Backspace") && selection && rootId) {
        ev.preventDefault();
        onDeleteMany(selection.rid, selection.paths);
        return;
      }
      if (mod && ev.key === "a" && rootId) {
        ev.preventDefault();
        const paths = visibleNamesRef.current.map((n) => joinRel(path, n));
        if (paths.length > 0) {
          setSelection({ rid: rootId, paths });
          selectionAnchorRef.current = paths[0];
        }
        return;
      }
      if (mod && ev.key === "x" && selection) {
        ev.preventDefault();
        onCutToClipboard(selection.rid, selection.paths);
        return;
      }
      if (mod && ev.key === "c" && selection) {
        ev.preventDefault();
        onCopyToClipboard(selection.rid, selection.paths);
        return;
      }
      if (mod && ev.key === "v" && clipboard && rootId) {
        ev.preventDefault();
        void onPasteInto(rootId, path);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selection, clipboard, rootId, path]);

  function buildDragImage(label: string, count: number) {
    const div = document.createElement("div");
    div.className = appClasses.dropBadge;
    div.textContent = count > 1 ? `${count} items` : label;
    document.body.appendChild(div);
    return div;
  }

  function onEntryDragStart(
    ev: React.DragEvent,
    rid: string,
    rel: string,
    name: string,
  ) {
    let paths: string[];
    const inSel = selection && selection.rid === rid && selection.paths.includes(rel);
    if (inSel) {
      paths = selection!.paths;
    } else {
      paths = [rel];
      setSelection({ rid, paths });
      selectionAnchorRef.current = rel;
    }
    writeDragPayload(ev.dataTransfer, { rootId: rid, paths });
    const ghost = buildDragImage(name, paths.length);
    ev.dataTransfer.setDragImage(ghost, 10, 10);
    window.setTimeout(() => ghost.remove(), 0);
  }

  function onTargetDragOver(
    ev: React.DragEvent,
    toRid: string,
    toPath: string,
  ) {
    const types = Array.from(ev.dataTransfer.types ?? []);
    const hasInternal = types.includes(DND_MIME);
    const hasExternal = types.includes("Files");
    if (!hasInternal && !hasExternal) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = hasInternal
      ? dropEffectForEvent(ev)
      : "copy";
    setDropTarget({ rid: toRid, rel: toPath });
  }

  function onTargetDragLeave(ev: React.DragEvent) {
    const related = ev.relatedTarget as Node | null;
    const container = ev.currentTarget as HTMLElement;
    if (related && container.contains(related)) return;
    setDropTarget(null);
  }

  function onTargetDrop(
    ev: React.DragEvent,
    toRid: string,
    toPath: string,
  ) {
    ev.preventDefault();
    ev.stopPropagation();
    setDropTarget(null);
    const payload = readDragPayload(ev.dataTransfer);
    if (payload) {
      const mode: "move" | "copy" = dropEffectForEvent(ev);
      void runBatchTransfer(mode, payload.rootId, payload.paths, toRid, toPath);
      return;
    }
    if (hasExternalFiles(ev.dataTransfer)) {
      // Snapshot FileSystemEntry objects synchronously while the event is
      // still live; actual traversal + upload happens async below.
      const { entries, looseFiles } = snapshotDropEntries(ev.dataTransfer);
      if (entries.length === 0 && looseFiles.length === 0) return;
      void handleExternalDrop(toRid, toPath, entries, looseFiles);
    }
  }

  async function handleExternalDrop(
    rid: string,
    basePath: string,
    entries: FileSystemEntry[],
    looseFiles: File[],
  ) {
    const api = apiRef.current;
    if (!api) return;
    let nodes: ExternalNode[] = [];
    try {
      nodes = await walkExternalEntries(entries);
    } catch (err) {
      notifications.show({
        title: "Could not read dropped items",
        message: String(err),
        color: "red",
      });
      return;
    }
    for (const f of looseFiles) {
      nodes.push({ kind: "file", relPath: f.name, file: f });
    }
    if (nodes.length === 0) return;

    setBusy(true);
    setError(null);
    const errors: string[] = [];
    let dirsCreated = 0;
    let filesUploaded = 0;

    // Directory pass first — ensures parents exist before any file upload.
    for (const n of nodes) {
      if (n.kind !== "dir") continue;
      const rel = joinRel(basePath, n.relPath);
      try {
        await api.mkdir(rid, rel);
        dirsCreated += 1;
      } catch (err) {
        errors.push(`mkdir ${n.relPath}: ${String(err)}`);
      }
    }

    for (const n of nodes) {
      if (n.kind !== "file") continue;
      const rel = joinRel(basePath, n.relPath);
      const id = crypto.randomUUID();
      upsertTransfer(id, {
        kind: "upload",
        name: n.relPath,
        totalBytes: n.file.size,
        completedBytes: 0,
        status: "active",
      });
      try {
        await api.uploadFile(
          rid,
          rel,
          n.file,
          Comlink.proxy((completed: number, total: number) => {
            upsertTransfer(id, {
              kind: "upload",
              name: n.relPath,
              totalBytes: total,
              completedBytes: completed,
              status: "active",
            });
          }),
        );
        finishTransfer(id, "done");
        filesUploaded += 1;
      } catch (err) {
        const msg = String(err);
        finishTransfer(id, "error", msg);
        errors.push(`${n.relPath}: ${msg}`);
      }
    }

    setBusy(false);
    if (rid === rootIdRef.current) {
      await refreshList();
    }
    if (errors.length === 0) {
      const dirsPart =
        dirsCreated > 0
          ? ` (+${dirsCreated} folder${dirsCreated === 1 ? "" : "s"})`
          : "";
      notifications.show({
        message: `Uploaded ${filesUploaded} file${filesUploaded === 1 ? "" : "s"}${dirsPart}`,
        color: "indigo",
      });
    } else {
      notifications.show({
        title: "Some uploads failed",
        message: errors.slice(0, 3).join("\n"),
        color: "red",
      });
    }
  }

  function isDropTargetMatch(rid: string, rel: string): boolean {
    return !!dropTarget && dropTarget.rid === rid && dropTarget.rel === rel;
  }

  const refreshBrowser = useCallback(async () => {
    const api = apiRef.current;
    const rid = rootId;
    if (!api || !token || !rid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.list(rid, path);
      setEntries(res.entries);
      await Promise.all(roots.map((r) => syncTreeFor(r.id)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [path, token, rootId, roots, syncTreeFor]);

  const activeTransferCount = transferList.filter(
    (t) => t.status === "active",
  ).length;

  return (
    <>
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: navbarWidth, breakpoint: "sm" }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="sm">
          <Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
            <IconFolder size={16} stroke={1.6} />
            <Breadcrumbs
              separator={<IconChevronRight size={12} />}
              data-testid="cwd"
              styles={{
                root: { flexWrap: "nowrap", overflow: "hidden" },
                separator: { margin: "0 6px" },
              }}
            >
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                const matched =
                  !!rootId && isDropTargetMatch(rootId, c.path);
                return isLast ? (
                  <Text key={c.path + i} size="sm" fw={600} truncate>
                    {c.label}
                  </Text>
                ) : (
                  <Anchor
                    key={c.path + i}
                    size="sm"
                    c="dimmed"
                    onClick={() => goToCrumb(c.path)}
                    onDragOver={(e) =>
                      rootId ? onTargetDragOver(e, rootId, c.path) : undefined
                    }
                    onDragLeave={onTargetDragLeave}
                    onDrop={(e) =>
                      rootId ? onTargetDrop(e, rootId, c.path) : undefined
                    }
                    className={appClasses.crumb}
                    data-drop-target={matched || undefined}
                    style={{ cursor: "pointer" }}
                  >
                    {c.label}
                  </Anchor>
                );
              })}
            </Breadcrumbs>
          </Group>

          <Group gap="sm" wrap="nowrap">
            {clipboard ? (
              <Group gap={4} wrap="nowrap">
                <Tooltip label="Paste into current folder">
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconClipboard size={12} />}
                    disabled={!rootId || busy}
                    onClick={() =>
                      rootId ? void onPasteInto(rootId, path) : undefined
                    }
                    data-testid="paste-btn"
                  >
                    {clipboard.paths.length === 1
                      ? `${clipboard.mode === "cut" ? "Move" : "Paste"} “${leafName(clipboard.paths[0])}”`
                      : `${clipboard.mode === "cut" ? "Move" : "Paste"} ${clipboard.paths.length} items`}
                  </Button>
                </Tooltip>
                <Tooltip label="Clear clipboard">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    onClick={() => setClipboard(null)}
                    aria-label="Clear clipboard"
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ) : null}
            {selection && selection.paths.length > 0 ? (
              <Group gap={4} wrap="nowrap" data-testid="selection-toolbar">
                <Badge
                  variant="light"
                  color="indigo"
                  size="sm"
                  data-testid="selection-count"
                >
                  {selection.paths.length} selected
                </Badge>
                <Tooltip label="Cut (Cmd+X)">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    onClick={() => onCutToClipboard(selection.rid, selection.paths)}
                    aria-label="Cut selection"
                    data-testid="cut-btn"
                  >
                    <IconCut size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Copy (Cmd+C)">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    onClick={() => onCopyToClipboard(selection.rid, selection.paths)}
                    aria-label="Copy selection"
                    data-testid="copy-btn"
                  >
                    <IconCopy size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Delete (Del)">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() => onDeleteMany(selection.rid, selection.paths)}
                    aria-label="Delete selection"
                    data-testid="delete-btn"
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Clear selection (Esc)">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    onClick={clearSelection}
                    aria-label="Clear selection"
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ) : null}
            {busy ? <Loader size="xs" /> : null}
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p={0}>
        <Box
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={startNavbarResize}
          onDoubleClick={() => setNavbarWidth(NAVBAR_DEFAULT_W)}
          className="navbar-resizer"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 200,
          }}
        />
        <Flex h="100%" w="100%">
          <Stack
            w={48}
            py="sm"
            px={0}
            align="center"
            gap="sm"
            justify="space-between"
            style={{
              borderRight: "1px solid var(--app-shell-border-color, var(--mantine-color-default-border))",
              flexShrink: 0,
            }}
          >
            <Stack align="center" gap="xs">
              <Tooltip label="Files" position="right" withArrow>
                <ActionIcon variant="filled" size="lg" radius="md" aria-label="Files">
                  <IconFolder size={18} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Transfers" position="right" withArrow>
                <Indicator
                  size={14}
                  color="indigo"
                  label={activeTransferCount || undefined}
                  disabled={activeTransferCount === 0}
                  inline
                >
                  <ActionIcon
                    variant="subtle"
                    size="lg"
                    radius="md"
                    aria-label="Transfers"
                  >
                    <IconArrowsUpDown size={18} />
                  </ActionIcon>
                </Indicator>
              </Tooltip>
              <Tooltip label="Refresh" position="right" withArrow>
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  radius="md"
                  onClick={() => void refreshBrowser()}
                  disabled={busy}
                  aria-label="Refresh"
                >
                  <IconRefresh size={18} />
                </ActionIcon>
              </Tooltip>
            </Stack>
            <Stack align="center" gap="xs">
              <SettingsMenu />
              <Tooltip label="Sign out" position="right" withArrow>
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  radius="md"
                  onClick={onLogout}
                  aria-label="Sign out"
                >
                  <IconLogout size={18} />
                </ActionIcon>
              </Tooltip>
            </Stack>
          </Stack>

          <Stack gap="sm" p="sm" style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" align="center" gap="xs">
              <Text size="sm" fw={700}>
                Files
              </Text>
            </Group>
            {roots.length === 0 ? (
              <Text size="xs" c="dimmed">
                No folders in config.toml
              </Text>
            ) : (
              <ScrollArea
                style={{ flex: 1, minHeight: 0 }}
                type="hover"
                data-testid="file-tree-sidebar"
              >
                <FileTree
                  branches={roots.map((r) => ({
                    id: r.id,
                    label: r.label,
                    tree: treesByRoot[r.id] ?? null,
                  }))}
                  activeRootId={rootId}
                  activePath={path}
                  onOpenDir={(rid, rel) => {
                    if (rid !== rootId) setRootId(rid);
                    setPath(rel);
                  }}
                  onOpenFile={(rid, rel) => {
                    if (rid !== rootId) setRootId(rid);
                    setPath(parentRelPath(rel));
                  }}
                  onContextMenu={(ev, rid, entry) => {
                    if (entry.rel_path === "") {
                      ev.preventDefault();
                      ev.stopPropagation();
                      return;
                    }
                    const items = entry.is_dir
                      ? folderMenuItems(rid, entry.rel_path)
                      : fileMenuItems(rid, entry.rel_path);
                    openCtx(ev, items);
                  }}
                  dnd={{
                    onDragStart: (ev, rid, entry) => {
                      onEntryDragStart(ev, rid, entry.rel_path, entry.name);
                    },
                    onDragOver: (ev, rid, entry) =>
                      onTargetDragOver(ev, rid, entry.rel_path),
                    onDragLeave: onTargetDragLeave,
                    onDrop: (ev, rid, entry) =>
                      onTargetDrop(ev, rid, entry.rel_path),
                    isDropTarget: isDropTargetMatch,
                  }}
                />
              </ScrollArea>
            )}

            <Divider />

            <Stack gap={6}>
              <Group justify="space-between" align="center">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Transfers
                </Text>
                {transferList.length > 0 ? (
                  <Badge size="xs" variant="light" color="gray">
                    {activeTransferCount} active
                  </Badge>
                ) : null}
              </Group>
              <ScrollArea.Autosize mah={200} type="hover">
                {transferList.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    No transfers in progress.
                  </Text>
                ) : (
                  <Stack gap={8} pr="xs">
                    {transferList.map((t) => (
                      <TransferRow key={t.id} transfer={t} />
                    ))}
                  </Stack>
                )}
              </ScrollArea.Autosize>
            </Stack>
          </Stack>
        </Flex>
      </AppShell.Navbar>

      <AppShell.Main>
        <Stack gap="sm">
          {error ? (
            <Alert
              color="red"
              variant="light"
              icon={<IconAlertCircle size={16} />}
              withCloseButton
              onClose={() => setError(null)}
              data-testid="error"
            >
              {error}
            </Alert>
          ) : null}

          <Paper withBorder p={6} radius="md">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Search in this folder…"
              leftSection={<IconSearch size={14} />}
              rightSection={
                search ? (
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                  >
                    <IconX size={14} />
                  </ActionIcon>
                ) : null
              }
              variant="unstyled"
              size="sm"
              data-testid="file-search"
            />
          </Paper>

          <Group justify="space-between" wrap="wrap" gap="sm">
            <Group gap="xs" wrap="wrap">
              <FileButton
                onChange={(f) => void onUploadFile(f)}
                inputProps={{ "data-testid": "upload-input" } as any}
              >
                {(props) => (
                  <Button
                    {...props}
                    leftSection={<IconCloudUpload size={16} />}
                    data-testid="upload-submit"
                    disabled={busy || !rootId}
                  >
                    Upload
                  </Button>
                )}
              </FileButton>
              <Button
                variant="default"
                leftSection={<IconFolderPlus size={16} />}
                onClick={() => openNewFolderModal()}
                disabled={busy || !rootId}
                data-testid="mkdir-submit"
              >
                New Folder
              </Button>
            </Group>

            <SegmentedControl
              size="xs"
              value={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              data={[
                { label: "Grid", value: "grid" },
                { label: "List", value: "list" },
              ]}
            />
          </Group>

          <Paper
            withBorder
            p="md"
            radius="md"
            mih={200}
            onContextMenu={(e) => openCtx(e, emptyAreaMenuItems())}
            onDragOver={(e) => rootId ? onTargetDragOver(e, rootId, path) : undefined}
            onDragLeave={onTargetDragLeave}
            onDrop={(e) => rootId ? onTargetDrop(e, rootId, path) : undefined}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) clearSelection();
            }}
            data-drop-target={
              rootId && isDropTargetMatch(rootId, path) ? true : undefined
            }
          >
            <Stack gap="sm">
              {entries.length === 0 ? (
                <Center mih={160}>
                  <Stack align="center" gap="xs">
                    <IconFolder size={40} stroke={1.4} opacity={0.5} />
                    <Text c="dimmed" size="sm">
                      This folder is empty
                    </Text>
                    <Text c="dimmed" size="xs">
                      Right-click for upload &amp; new folder
                    </Text>
                  </Stack>
                </Center>
              ) : visibleEntries.length === 0 ? (
                <Center mih={160}>
                  <Stack align="center" gap="xs">
                    <IconSearch size={32} stroke={1.4} opacity={0.5} />
                    <Text c="dimmed" size="sm">
                      No matches for “{search}”
                    </Text>
                  </Stack>
                </Center>
              ) : viewMode === "grid" ? (
                <SimpleGrid
                  cols={{ base: 2, xs: 3, sm: 4, md: 5, lg: 6 }}
                  spacing="md"
                  data-testid="file-grid"
                >
                  {visibleEntries.map((e) => {
                    const rel = joinPath(path, e.name);
                    const selected = selectionPathsForCurrent.has(rel);
                    const cut =
                      clipboard?.mode === "cut" &&
                      clipboard.rid === rootId &&
                      clipboard.paths.includes(rel);
                    const isDrop =
                      e.is_dir && !!rootId && isDropTargetMatch(rootId, rel);
                    return (
                      <FileCard
                        key={e.name}
                        entry={e}
                        selected={selected}
                        cut={cut}
                        dropTarget={isDrop}
                        onClick={(ev) =>
                          onEntryClick(ev, rootId!, rel, e.is_dir, e.name)
                        }
                        onDragStart={(ev) =>
                          onEntryDragStart(ev, rootId!, rel, e.name)
                        }
                        onDragOver={
                          e.is_dir
                            ? (ev) => onTargetDragOver(ev, rootId!, rel)
                            : undefined
                        }
                        onDragLeave={e.is_dir ? onTargetDragLeave : undefined}
                        onDrop={
                          e.is_dir
                            ? (ev) => onTargetDrop(ev, rootId!, rel)
                            : undefined
                        }
                        onDownload={() => void onDownload(e.name)}
                        onDelete={() => onDelete(e.name)}
                        onContextMenu={(ev) => {
                          const items = e.is_dir
                            ? folderMenuItems(rootId!, rel)
                            : fileMenuItems(rootId!, rel);
                          openCtx(ev, items);
                        }}
                      />
                    );
                  })}
                </SimpleGrid>
              ) : (
                <Table
                  highlightOnHover
                  verticalSpacing="xs"
                  striped
                  stickyHeader
                  data-testid="file-table"
                >
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th w={110} ta="right">
                        Size
                      </Table.Th>
                      <Table.Th w={210}>Modified</Table.Th>
                      <Table.Th w={120} />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {visibleEntries.map((e) => {
                    const rel = relativeModified(e.modified);
                    const abs = formatModified(e.modified);
                    const relPath = joinPath(path, e.name);
                    const selected = selectionPathsForCurrent.has(relPath);
                    const cut =
                      clipboard?.mode === "cut" &&
                      clipboard.rid === rootId &&
                      clipboard.paths.includes(relPath);
                    const isDrop =
                      e.is_dir && !!rootId && isDropTargetMatch(rootId, relPath);
                    return (
                      <Table.Tr
                        key={e.name}
                        className={appClasses.row}
                        data-selected={selected || undefined}
                        data-cut={cut || undefined}
                        data-drop-target={isDrop || undefined}
                        draggable
                        onClick={(ev) =>
                          onEntryClick(ev, rootId!, relPath, e.is_dir, e.name)
                        }
                        onDragStart={(ev) =>
                          onEntryDragStart(ev, rootId!, relPath, e.name)
                        }
                        onDragOver={
                          e.is_dir
                            ? (ev) => onTargetDragOver(ev, rootId!, relPath)
                            : undefined
                        }
                        onDragLeave={e.is_dir ? onTargetDragLeave : undefined}
                        onDrop={
                          e.is_dir
                            ? (ev) => onTargetDrop(ev, rootId!, relPath)
                            : undefined
                        }
                        onContextMenu={(ev) => {
                          const items = e.is_dir
                            ? folderMenuItems(rootId!, relPath)
                            : fileMenuItems(rootId!, relPath);
                          openCtx(ev, items);
                        }}
                        style={{ cursor: e.is_dir ? "pointer" : "default" }}
                      >
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            {e.is_dir ? (
                              <IconFolder
                                size={16}
                                color="var(--mantine-color-indigo-6)"
                              />
                            ) : (
                              <IconFile size={16} stroke={1.6} />
                            )}
                            <Text size="sm" fw={e.is_dir ? 500 : 400}>
                              {e.name}
                            </Text>
                          </Group>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text
                            size="xs"
                            c="dimmed"
                            ff="ui-monospace, monospace"
                          >
                            {e.is_dir ? "—" : formatSize(e.size)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          {e.modified ? (
                            <Tooltip label={abs} openDelay={300}>
                              <Text size="xs" c="dimmed">
                                {rel ?? abs}
                              </Text>
                            </Tooltip>
                          ) : (
                            <Text size="xs" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td onClick={(ev) => ev.stopPropagation()}>
                          <Group gap={4} justify="flex-end">
                            {!e.is_dir ? (
                              <Tooltip label="Download">
                                <ActionIcon
                                  variant="subtle"
                                  onClick={() => void onDownload(e.name)}
                                  aria-label={`Download ${e.name}`}
                                >
                                  <IconDownload size={16} />
                                </ActionIcon>
                              </Tooltip>
                            ) : null}
                            <Tooltip label="Delete">
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                onClick={() => onDelete(e.name)}
                                aria-label={`Delete ${e.name}`}
                              >
                                <IconTrash size={16} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          </Paper>
        </Stack>
      </AppShell.Main>

      <input
        ref={hiddenUploadRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0] ?? null;
          e.currentTarget.value = "";
          void onUploadFile(f);
        }}
      />

      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
    </AppShell>

    <Modal
      opened={!token}
      onClose={() => {}}
      withCloseButton={false}
      closeOnEscape={false}
      closeOnClickOutside={false}
      centered
      size={380}
      radius="md"
      padding="lg"
      overlayProps={{ blur: 2, backgroundOpacity: 0.35 }}
      title={
        <Group gap="xs" wrap="nowrap">
          <IconFolder size={18} stroke={1.6} />
          <Title order={4} m={0}>
            Sign in to fsremote
          </Title>
        </Group>
      }
      data-testid="login-modal"
    >
      <form
        id="login-form"
        onSubmit={onLogin}
        data-testid="login-form"
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Connect to your remote workspace. The dev server proxies to{" "}
            <Code>127.0.0.1:8080</Code>.
          </Text>

          {error ? (
            <Alert
              color="red"
              variant="light"
              icon={<IconAlertCircle size={16} />}
              data-testid="error"
            >
              {error}
            </Alert>
          ) : null}

          <TextInput
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            autoComplete="username"
            data-testid="login-user"
            required
            autoFocus
          />
          <PasswordInput
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="current-password"
            data-testid="login-pass"
            required
          />

          <Button
            type="submit"
            loading={busy}
            data-testid="login-submit"
            fullWidth
            mt={4}
          >
            Sign in
          </Button>
        </Stack>
      </form>
    </Modal>
    </>
  );
}

function FileCard({
  entry,
  selected,
  cut,
  dropTarget,
  onClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDownload,
  onDelete,
  onContextMenu,
}: {
  entry: FsEntry;
  selected?: boolean;
  cut?: boolean;
  dropTarget?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDownload: () => void;
  onDelete: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const isDir = entry.is_dir;
  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      className={appClasses.card}
      data-selected={selected || undefined}
      data-cut={cut || undefined}
      data-drop-target={dropTarget || undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ cursor: isDir ? "pointer" : "default" }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={
        isDir
          ? (ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onClick?.(ev as unknown as React.MouseEvent);
              }
            }
          : undefined
      }
      tabIndex={isDir ? 0 : undefined}
      role={isDir ? "button" : undefined}
    >
      <Stack gap={6} align="center">
        <Box pt="xs">
          {isDir ? (
            <IconFolder size={40} stroke={1.4} color="var(--mantine-color-indigo-6)" />
          ) : (
            <IconFile size={40} stroke={1.4} />
          )}
        </Box>
        <Text size="sm" fw={500} ta="center" lineClamp={2}>
          {entry.name}
        </Text>
        <Text size="xs" c="dimmed">
          {isDir ? "Folder" : formatSize(entry.size)}
        </Text>
        <Group gap={4} mt={4} onClick={(ev) => ev.stopPropagation()}>
          {!isDir ? (
            <Tooltip label="Download">
              <ActionIcon
                variant="subtle"
                onClick={onDownload}
                aria-label={`Download ${entry.name}`}
              >
                <IconDownload size={16} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          <Tooltip label="Delete">
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={onDelete}
              aria-label={`Delete ${entry.name}`}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Stack>
    </Card>
  );
}

function TransferRow({ transfer }: { transfer: Transfer }) {
  const total = transfer.totalBytes;
  const completed = transfer.completedBytes;
  const pct =
    total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const isUpload = transfer.kind === "upload";
  const isActive = transfer.status === "active";
  const isError = transfer.status === "error";
  const color = isError ? "red" : isActive ? "indigo" : "teal";
  const Icon = isUpload ? IconCloudUpload : IconDownload;

  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Icon size={14} stroke={1.6} />
          <Text size="xs" fw={500} truncate>
            {transfer.name}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {isError
            ? "Failed"
            : transfer.status === "done"
              ? formatSize(total || completed)
              : `${formatSize(completed)} / ${total > 0 ? formatSize(total) : "?"}`}
        </Text>
      </Group>
      <Progress
        value={isError ? 100 : transfer.status === "done" ? 100 : pct}
        size="sm"
        color={color}
        animated={isActive}
        striped={isActive}
      />
      {isError && transfer.error ? (
        <Text size="10px" c="red" lineClamp={2}>
          {transfer.error}
        </Text>
      ) : null}
    </Stack>
  );
}

function SettingsMenu() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const options: {
    value: "light" | "dark" | "auto";
    label: string;
    icon: React.ReactNode;
  }[] = [
    { value: "light", label: "Light", icon: <IconSun size={14} /> },
    { value: "dark", label: "Dark", icon: <IconMoon size={14} /> },
    { value: "auto", label: "System", icon: <IconDeviceDesktop size={14} /> },
  ];
  return (
    <Menu position="right-end" withArrow shadow="md" width={180}>
      <Menu.Target>
        <Tooltip label="Settings" position="right" withArrow>
          <ActionIcon
            variant="subtle"
            size="lg"
            radius="md"
            aria-label="Settings"
          >
            <IconSettings size={18} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Appearance</Menu.Label>
        {options.map((o) => (
          <Menu.Item
            key={o.value}
            leftSection={o.icon}
            rightSection={
              colorScheme === o.value ? (
                <Text size="xs" c="dimmed">
                  ✓
                </Text>
              ) : null
            }
            onClick={() => setColorScheme(o.value)}
          >
            {o.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function RenameForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = "Rename",
  placeholder,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  submitLabel?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = initial.lastIndexOf(".");
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    }, 30);
    return () => clearTimeout(id);
  }, [initial]);

  const trimmed = value.trim();
  const invalid =
    !trimmed || trimmed.includes("/") || trimmed === "." || trimmed === "..";

  const submit = () => {
    if (invalid) return;
    onSubmit(trimmed);
  };

  return (
    <Stack gap="sm">
      <TextInput
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        data-autofocus
      />
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={invalid}>
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  );
}
