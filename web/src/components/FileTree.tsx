import { Box, Group, Loader, Text, UnstyledButton } from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconServer,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

import classes from "./FileTree.module.css";

export type TreeEntry = {
  name: string;
  rel_path: string;
  is_dir: boolean;
  size: number;
  children?: TreeEntry[];
};

export type RootBranch = {
  id: string;
  label: string;
  tree: TreeEntry[] | null;
};

export type TreeDnd = {
  onDragStart?: (
    e: React.DragEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  onDragOver?: (
    e: React.DragEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  onDragLeave?: (
    e: React.DragEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  onDrop?: (
    e: React.DragEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  isDropTarget?: (rootId: string, rel: string) => boolean;
};

function TreeNode({
  entry,
  rootId,
  activeRootId,
  activePath,
  depth,
  onOpenDir,
  onOpenFile,
  onContextMenu,
  dnd,
}: {
  entry: TreeEntry;
  rootId: string;
  activeRootId: string | null;
  activePath: string;
  depth: number;
  onOpenDir: (rootId: string, rel: string) => void;
  onOpenFile: (rootId: string, rel: string) => void;
  onContextMenu?: (
    e: React.MouseEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  dnd?: TreeDnd;
}) {
  const isCurrentRoot = activeRootId === rootId;
  const isOnPath =
    isCurrentRoot &&
    (activePath === entry.rel_path ||
      activePath.startsWith(entry.rel_path + "/"));
  const isActive = isCurrentRoot && activePath === entry.rel_path;
  const [open, setOpen] = useState(isOnPath);

  useEffect(() => {
    if (isOnPath) setOpen(true);
  }, [isOnPath]);

  if (!entry.is_dir) return null;

  const kids = (entry.children ?? []).filter((c) => c.is_dir);
  const isDropTarget = dnd?.isDropTarget?.(rootId, entry.rel_path) ?? false;
  return (
    <Box>
      <UnstyledButton
        className={classes.row}
        data-active={isActive || undefined}
        data-drop-target={isDropTarget || undefined}
        draggable
        onDragStart={(e) => dnd?.onDragStart?.(e, rootId, entry)}
        onDragOver={(e) => dnd?.onDragOver?.(e, rootId, entry)}
        onDragLeave={(e) => dnd?.onDragLeave?.(e, rootId, entry)}
        onDrop={(e) => dnd?.onDrop?.(e, rootId, entry)}
        onClick={() => {
          setOpen((v) => !v);
          onOpenDir(rootId, entry.rel_path);
        }}
        onContextMenu={(e) => onContextMenu?.(e, rootId, entry)}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <Group gap={6} wrap="nowrap">
          {open ? (
            <IconChevronDown size={12} stroke={1.6} />
          ) : (
            <IconChevronRight size={12} stroke={1.6} />
          )}
          {open ? (
            <IconFolderOpen size={14} stroke={1.6} />
          ) : (
            <IconFolder size={14} stroke={1.6} />
          )}
          <Text size="xs" fw={isActive ? 600 : 500} truncate>
            {entry.name}
          </Text>
        </Group>
      </UnstyledButton>
      {open && kids.length > 0 ? (
        <Box>
          {kids.map((child) => (
            <TreeNode
              key={child.rel_path}
              entry={child}
              rootId={rootId}
              activeRootId={activeRootId}
              activePath={activePath}
              depth={depth + 1}
              onOpenDir={onOpenDir}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              dnd={dnd}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function RootBranchNode({
  branch,
  activeRootId,
  activePath,
  onOpenDir,
  onOpenFile,
  onContextMenu,
  dnd,
}: {
  branch: RootBranch;
  activeRootId: string | null;
  activePath: string;
  onOpenDir: (rootId: string, rel: string) => void;
  onOpenFile: (rootId: string, rel: string) => void;
  onContextMenu?: (
    e: React.MouseEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  dnd?: TreeDnd;
}) {
  const isCurrentRoot = activeRootId === branch.id;
  const isActive = isCurrentRoot && activePath === "";
  const [open, setOpen] = useState(isCurrentRoot);

  useEffect(() => {
    if (isCurrentRoot) setOpen(true);
  }, [isCurrentRoot]);

  const kids = (branch.tree ?? []).filter((c) => c.is_dir);
  const rootEntry: TreeEntry = {
    name: branch.label,
    rel_path: "",
    is_dir: true,
    size: 0,
  };
  const isDropTarget = dnd?.isDropTarget?.(branch.id, "") ?? false;
  return (
    <Box>
      <UnstyledButton
        className={classes.row}
        data-active={isActive || undefined}
        data-root
        data-drop-target={isDropTarget || undefined}
        onDragOver={(e) => dnd?.onDragOver?.(e, branch.id, rootEntry)}
        onDragLeave={(e) => dnd?.onDragLeave?.(e, branch.id, rootEntry)}
        onDrop={(e) => dnd?.onDrop?.(e, branch.id, rootEntry)}
        onClick={() => {
          setOpen((v) => !v);
          onOpenDir(branch.id, "");
        }}
        onContextMenu={(e) => onContextMenu?.(e, branch.id, rootEntry)}
        style={{ paddingLeft: 6 }}
      >
        <Group gap={6} wrap="nowrap">
          {open ? (
            <IconChevronDown size={12} stroke={1.6} />
          ) : (
            <IconChevronRight size={12} stroke={1.6} />
          )}
          <IconServer size={14} stroke={1.6} />
          <Text size="xs" fw={600} truncate>
            {branch.label}
          </Text>
        </Group>
      </UnstyledButton>
      {open ? (
        branch.tree === null ? (
          <Group gap="xs" px="md" py={4}>
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              Loading…
            </Text>
          </Group>
        ) : kids.length === 0 ? (
          <Text size="xs" c="dimmed" px="md" py={4}>
            Empty
          </Text>
        ) : (
          <Box>
            {kids.map((child) => (
              <TreeNode
                key={child.rel_path}
                entry={child}
                rootId={branch.id}
                activeRootId={activeRootId}
                activePath={activePath}
                depth={1}
                onOpenDir={onOpenDir}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                dnd={dnd}
              />
            ))}
          </Box>
        )
      ) : null}
    </Box>
  );
}

export function FileTree({
  branches,
  activeRootId,
  activePath,
  onOpenDir,
  onOpenFile,
  onContextMenu,
  dnd,
}: {
  branches: RootBranch[];
  activeRootId: string | null;
  activePath: string;
  onOpenDir: (rootId: string, rel: string) => void;
  onOpenFile: (rootId: string, rel: string) => void;
  onContextMenu?: (
    e: React.MouseEvent,
    rootId: string,
    entry: TreeEntry,
  ) => void;
  dnd?: TreeDnd;
}) {
  return (
    <Box>
      {branches.map((b) => (
        <RootBranchNode
          key={b.id}
          branch={b}
          activeRootId={activeRootId}
          activePath={activePath}
          onOpenDir={onOpenDir}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
          dnd={dnd}
        />
      ))}
    </Box>
  );
}
