import * as Comlink from "comlink";
import { encodeUploadChunk } from "./protocol";

export type TreeEntry = {
  name: string;
  rel_path: string;
  is_dir: boolean;
  size: number;
  children?: TreeEntry[];
};

type ServerMessage =
  | { type: "error"; code: string; message: string }
  | { type: "pong" }
  | { type: "list_result"; root_id: string; path: string; entries: { name: string; is_dir: boolean; size: number }[] }
  | { type: "list_tree_result"; root_id: string; tree: TreeEntry[] }
  | { type: "upload_accepted"; transfer_id: string; max_chunk: number }
  | { type: "upload_finished"; transfer_id: string }
  | { type: "upload_aborted"; transfer_id: string }
  | { type: "download_ready"; transfer_id: string; size: number; max_chunk: number }
  | { type: "download_finished"; transfer_id: string }
  | { type: "download_aborted"; transfer_id: string }
  | { type: "progress"; transfer_id: string; bytes_completed: number; bytes_total?: number }
  | { type: "fs_changed"; root_id: string; path?: string; kind: string }
  | { type: "mkdir_ok"; root_id: string; path: string }
  | { type: "move_ok"; to_root_id: string; to: string }
  | { type: "copy_ok"; to_root_id: string; to: string }
  | { type: "ok" };

let ws: WebSocket | null = null;
let token = "";
let onServerEvent: ((m: ServerMessage) => void) | null = null;

const waiters: Array<(m: ServerMessage) => boolean> = [];

let downloadSink: null | { transferId: string; chunks: Uint8Array[] } = null;

function dispatch(m: ServerMessage) {
  if (m.type === "fs_changed" || m.type === "progress") {
    onServerEvent?.(m);
  }

  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i](m)) {
      waiters.splice(i, 1);
      return;
    }
  }

  if (m.type !== "progress" && m.type !== "fs_changed") {
    onServerEvent?.(m);
  }
}

function waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 120_000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const idx = waiters.indexOf(fn);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error("timeout waiting for server"));
    }, timeoutMs);
    function fn(m: ServerMessage): boolean {
      if (pred(m)) {
        clearTimeout(t);
        resolve(m);
        return true;
      }
      return false;
    }
    waiters.push(fn);
  });
}

function sendEnvelope(body: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("websocket not connected");
  }
  ws.send(JSON.stringify({ token, body }));
}

function wireSocket() {
  if (!ws) return;
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      if (!downloadSink) {
        return;
      }
      const u8 = new Uint8Array(ev.data);
      const dv = new DataView(ev.data);
      const plen = dv.getUint32(24, true);
      const payload = u8.slice(28, 28 + plen);
      downloadSink.chunks.push(payload);
      return;
    }

    if (typeof ev.data === "string") {
      try {
        const m = JSON.parse(ev.data) as ServerMessage;
        dispatch(m);
      } catch {
        /* ignore */
      }
    }
  };
}

export const api = {
  setEventHandler(handler: (m: ServerMessage) => void) {
    onServerEvent = handler;
  },

  async login(httpBase: string, username: string, password: string) {
    const r = await fetch(`${httpBase}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error("login failed");
    const j = (await r.json()) as { token: string };
    token = j.token;
    return j.token;
  },

  connect(wsUrl: string, tok: string): Promise<void> {
    return new Promise((resolve, reject) => {
      token = tok;
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket error"));
      wireSocket();
    });
  },

  async list(rootId: string, path: string) {
    sendEnvelope({ type: "list", root_id: rootId, path });
    const m = await waitFor((x) => x.type === "list_result" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
    return m as Extract<ServerMessage, { type: "list_result" }>;
  },

  async listTree(rootId: string) {
    sendEnvelope({ type: "list_tree", root_id: rootId });
    const m = await waitFor((x) => x.type === "list_tree_result" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
    return m as Extract<ServerMessage, { type: "list_tree_result" }>;
  },

  async mkdir(rootId: string, path: string) {
    sendEnvelope({ type: "mkdir", root_id: rootId, path });
    const m = await waitFor((x) => x.type === "mkdir_ok" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
    return m;
  },

  async remove(rootId: string, path: string) {
    sendEnvelope({ type: "remove", root_id: rootId, path });
    const m = await waitFor((x) => x.type === "ok" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
  },

  async rename(rootId: string, from: string, to: string) {
    sendEnvelope({ type: "rename", root_id: rootId, from, to });
    const m = await waitFor((x) => x.type === "ok" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
  },

  async copy(fromRoot: string, from: string, toRoot: string, to: string) {
    sendEnvelope({
      type: "copy",
      from_root_id: fromRoot,
      from,
      to_root_id: toRoot,
      to,
    });
    const m = await waitFor((x) => x.type === "copy_ok" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
    const ok = m as Extract<ServerMessage, { type: "copy_ok" }>;
    return { toRoot: ok.to_root_id, to: ok.to };
  },

  async move(fromRoot: string, from: string, toRoot: string, to: string) {
    sendEnvelope({
      type: "move",
      from_root_id: fromRoot,
      from,
      to_root_id: toRoot,
      to,
    });
    const m = await waitFor((x) => x.type === "move_ok" || x.type === "error");
    if (m.type === "error") throw new Error(m.message);
    const ok = m as Extract<ServerMessage, { type: "move_ok" }>;
    return { toRoot: ok.to_root_id, to: ok.to };
  },

  async uploadFile(
    rootId: string,
    relPath: string,
    file: File,
    onProgress?: (completed: number, total: number) => void,
  ) {
    if (!ws) throw new Error("no ws");
    const size = file.size;
    onProgress?.(0, size);
    sendEnvelope({ type: "begin_upload", root_id: rootId, path: relPath, size });
    const accepted = await waitFor((x) => x.type === "upload_accepted" || x.type === "error");
    if (accepted.type === "error") throw new Error(accepted.message);
    const a = accepted as Extract<ServerMessage, { type: "upload_accepted" }>;
    const transferId = a.transfer_id;
    const maxChunk = a.max_chunk;

    let offset = 0;
    let seq = 0;
    while (offset < size) {
      const end = Math.min(offset + maxChunk, size);
      const ab = await file.slice(offset, end).arrayBuffer();
      const chunk = new Uint8Array(ab);
      ws.send(encodeUploadChunk(token, transferId, seq, chunk));
      seq += 1;
      offset = end;
      onProgress?.(offset, size);
    }

    sendEnvelope({ type: "end_upload", transfer_id: transferId });
    const fin = await waitFor((x) => x.type === "upload_finished" || x.type === "error");
    if (fin.type === "error") throw new Error(fin.message);
  },

  async downloadFile(
    rootId: string,
    relPath: string,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<Uint8Array> {
    if (!ws) throw new Error("no ws");
    sendEnvelope({ type: "begin_download", root_id: rootId, path: relPath });
    const ready = await waitFor((x) => x.type === "download_ready" || x.type === "error");
    if (ready.type === "error") throw new Error(ready.message);
    const r = ready as Extract<ServerMessage, { type: "download_ready" }>;
    const transferId = r.transfer_id;
    const total = r.size;
    onProgress?.(0, total);

    const prev = onServerEvent;
    onServerEvent = (m) => {
      if (m.type === "progress" && m.transfer_id === transferId) {
        onProgress?.(m.bytes_completed, total);
      }
      prev?.(m);
    };

    downloadSink = { transferId, chunks: [] };
    await waitFor((x) => x.type === "download_finished" && x.transfer_id === transferId);
    const chunks = downloadSink.chunks;
    downloadSink = null;
    onServerEvent = prev;
    onProgress?.(total, total);

    let got = 0;
    for (const c of chunks) got += c.byteLength;
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  },

  ping() {
    sendEnvelope({ type: "ping" });
  },
};

Comlink.expose(api);
