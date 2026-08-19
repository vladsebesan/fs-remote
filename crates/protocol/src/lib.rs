//! Wire protocol types (JSON control messages + binary chunk framing).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const TMP_UPLOAD_SUFFIX: &str = ".tmpupload";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub token: String,
    pub expires_in_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientBody {
    List {
        root_id: String,
        path: String,
    },
    /// Full recursive directory tree from the root (for tree navigation UI).
    ListTree {
        root_id: String,
    },
    Mkdir {
        root_id: String,
        path: String,
    },
    Remove {
        root_id: String,
        path: String,
    },
    Rename {
        root_id: String,
        from: String,
        to: String,
    },
    Copy {
        from_root_id: String,
        from: String,
        to_root_id: String,
        to: String,
    },
    Move {
        from_root_id: String,
        from: String,
        to_root_id: String,
        to: String,
    },
    BeginUpload {
        root_id: String,
        path: String,
        size: u64,
    },
    EndUpload {
        transfer_id: Uuid,
    },
    AbortUpload {
        transfer_id: Uuid,
    },
    BeginDownload {
        root_id: String,
        path: String,
    },
    AbortDownload {
        transfer_id: Uuid,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvelope {
    pub token: String,
    pub body: ClientBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FsChangeKind {
    Created,
    Modified,
    Removed,
    Renamed,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Error {
        code: String,
        message: String,
    },
    Pong,
    ListResult {
        root_id: String,
        path: String,
        entries: Vec<DirEntry>,
    },
    ListTreeResult {
        root_id: String,
        tree: Vec<TreeEntry>,
    },
    UploadAccepted {
        transfer_id: Uuid,
        max_chunk: u32,
    },
    UploadFinished {
        transfer_id: Uuid,
    },
    UploadAborted {
        transfer_id: Uuid,
    },
    DownloadReady {
        transfer_id: Uuid,
        size: u64,
        max_chunk: u32,
    },
    DownloadFinished {
        transfer_id: Uuid,
    },
    DownloadAborted {
        transfer_id: Uuid,
    },
    Progress {
        transfer_id: Uuid,
        bytes_completed: u64,
        bytes_total: Option<u64>,
    },
    FsChanged {
        root_id: String,
        path: Option<String>,
        kind: FsChangeKind,
    },
    MkdirOk {
        root_id: String,
        path: String,
    },
    /// Returned after a successful `Move`. `to` reflects the possibly
    /// auto-renamed destination when the original name collided.
    MoveOk {
        to_root_id: String,
        to: String,
    },
    /// Returned after a successful `Copy`. `to` reflects the possibly
    /// auto-renamed destination when the original name collided.
    CopyOk {
        to_root_id: String,
        to: String,
    },
    Ok,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Last modification time, seconds since UNIX epoch. `None` if filesystem
    /// can't report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
}

/// One node in a recursive tree (`list_tree`); directories carry nested `children`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    pub name: String,
    /// Path relative to the filesystem root, POSIX-style (no leading slash).
    pub rel_path: String,
    pub is_dir: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeEntry>,
}

/// Client -> server binary upload chunk layout (little-endian):
/// token_len: u32, token utf-8, transfer_id: 16 bytes, seq: u64, payload_len: u32, payload
pub fn encode_upload_chunk(
    token: &str,
    transfer_id: Uuid,
    seq: u64,
    payload: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let token_bytes = token.as_bytes();
    if token_bytes.len() > u32::MAX as usize {
        return Err(ProtocolError::TooLarge);
    }
    let plen = payload.len();
    if plen > u32::MAX as usize {
        return Err(ProtocolError::TooLarge);
    }
    let mut out = Vec::with_capacity(4 + token_bytes.len() + 16 + 8 + 4 + plen);
    out.extend_from_slice(&(token_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(token_bytes);
    out.extend_from_slice(transfer_id.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(plen as u32).to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn decode_upload_chunk(data: &[u8]) -> Result<UploadChunk<'_>, ProtocolError> {
    if data.len() < 4 {
        return Err(ProtocolError::Truncated);
    }
    let tlen = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    let mut i = 4;
    if data.len() < i + tlen + 16 + 8 + 4 {
        return Err(ProtocolError::Truncated);
    }
    let token = std::str::from_utf8(&data[i..i + tlen]).map_err(|_| ProtocolError::InvalidUtf8)?;
    i += tlen;
    let tid = Uuid::from_slice(&data[i..i + 16]).map_err(|_| ProtocolError::InvalidUuid)?;
    i += 16;
    let seq = u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    i += 8;
    let plen = u32::from_le_bytes(data[i..i + 4].try_into().unwrap()) as usize;
    i += 4;
    if data.len() < i + plen {
        return Err(ProtocolError::Truncated);
    }
    let payload = &data[i..i + plen];
    Ok(UploadChunk {
        token,
        transfer_id: tid,
        seq,
        payload,
    })
}

#[derive(Debug, Clone)]
pub struct UploadChunk<'a> {
    pub token: &'a str,
    pub transfer_id: Uuid,
    pub seq: u64,
    pub payload: &'a [u8],
}

/// Server -> client download binary: transfer_id 16, seq u64, len u32, bytes
pub fn encode_download_chunk(transfer_id: Uuid, seq: u64, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let plen = payload.len();
    if plen > u32::MAX as usize {
        return Err(ProtocolError::TooLarge);
    }
    let mut out = Vec::with_capacity(16 + 8 + 4 + plen);
    out.extend_from_slice(transfer_id.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(plen as u32).to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn decode_download_chunk(data: &[u8]) -> Result<DownloadChunk<'_>, ProtocolError> {
    if data.len() < 16 + 8 + 4 {
        return Err(ProtocolError::Truncated);
    }
    let tid = Uuid::from_slice(&data[0..16]).map_err(|_| ProtocolError::InvalidUuid)?;
    let seq = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let plen = u32::from_le_bytes(data[24..28].try_into().unwrap()) as usize;
    if data.len() < 28 + plen {
        return Err(ProtocolError::Truncated);
    }
    Ok(DownloadChunk {
        transfer_id: tid,
        seq,
        payload: &data[28..28 + plen],
    })
}

#[derive(Debug, Clone)]
pub struct DownloadChunk<'a> {
    pub transfer_id: Uuid,
    pub seq: u64,
    pub payload: &'a [u8],
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("truncated frame")]
    Truncated,
    #[error("invalid utf8")]
    InvalidUtf8,
    #[error("invalid uuid")]
    InvalidUuid,
    #[error("value too large")]
    TooLarge,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_upload_chunk() {
        let tok = "abc.def";
        let id = Uuid::new_v4();
        let p = b"hello";
        let enc = encode_upload_chunk(tok, id, 3, p).unwrap();
        let d = decode_upload_chunk(&enc).unwrap();
        assert_eq!(d.token, tok);
        assert_eq!(d.transfer_id, id);
        assert_eq!(d.seq, 3);
        assert_eq!(d.payload, p);
    }
}
