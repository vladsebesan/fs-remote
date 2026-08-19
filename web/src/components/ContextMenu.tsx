import { Box, Divider, Paper, Text, UnstyledButton } from "@mantine/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import classes from "./ContextMenu.module.css";

export type ContextMenuItem =
  | {
      type?: "item";
      label: string;
      icon?: React.ReactNode;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | { type: "divider" };

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 0;
    const margin = 6;
    const maxLeft = window.innerWidth - w - margin;
    const maxTop = window.innerHeight - h - margin;
    setPos({
      left: Math.max(margin, Math.min(state.x, maxLeft)),
      top: Math.max(margin, Math.min(state.y, maxTop)),
    });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <Paper
      ref={ref}
      withBorder
      shadow="md"
      radius="md"
      p={4}
      className={classes.menu}
      style={{
        position: "fixed",
        left: pos?.left ?? state.x,
        top: pos?.top ?? state.y,
        visibility: pos ? "visible" : "hidden",
        zIndex: 1000,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) => {
        if (item.type === "divider") {
          return <Divider key={`d${i}`} my={4} />;
        }
        return (
          <UnstyledButton
            key={i}
            disabled={item.disabled}
            data-danger={item.danger || undefined}
            className={classes.item}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <Box className={classes.icon}>{item.icon}</Box>
            <Text size="sm">{item.label}</Text>
          </UnstyledButton>
        );
      })}
    </Paper>
  );
}
