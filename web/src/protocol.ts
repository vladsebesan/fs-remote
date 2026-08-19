import { parse as uuidBytesFromString, stringify as uuidStringFromBytes } from "uuid";

/** Matches `fsremote_protocol::encode_upload_chunk` (little-endian). */
export function encodeUploadChunk(
  token: string,
  transferId: string,
  seq: number,
  payload: Uint8Array,
): ArrayBuffer {
  const te = new TextEncoder();
  const tb = te.encode(token);
  const tid = uuidBytesFromString(transferId);
  const plen = payload.byteLength;
  const buf = new ArrayBuffer(4 + tb.length + 16 + 8 + 4 + plen);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint32(0, tb.length, true);
  u8.set(tb, 4);
  let o = 4 + tb.length;
  u8.set(tid, o);
  o += 16;
  dv.setBigUint64(o, BigInt(seq), true);
  o += 8;
  dv.setUint32(o, plen, true);
  o += 4;
  u8.set(payload, o);
  return buf;
}

export function decodeDownloadChunk(data: ArrayBuffer): {
  transferId: string;
  seq: bigint;
  payload: Uint8Array;
} {
  const u8 = new Uint8Array(data);
  const dv = new DataView(data);
  const tid = u8.slice(0, 16);
  const seq = dv.getBigUint64(16, true);
  const plen = dv.getUint32(24, true);
  const payload = u8.slice(28, 28 + plen);
  const transferId = uuidStringFromBytes(tid);
  return { transferId, seq, payload };
}
