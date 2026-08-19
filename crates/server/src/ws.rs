use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use fsremote_protocol::{
    decode_upload_chunk, encode_download_chunk, ClientBody, ClientEnvelope, FsChangeKind,
    ServerMessage, TMP_UPLOAD_SUFFIX,
};
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

use crate::fsutil::{copy_recursive, list_root_path, staging_path_for, uniquify_destination};
use crate::paths::safe_join;
use crate::auth;
use crate::state::AppState;

struct UploadState {
    staging: PathBuf,
    final_path: PathBuf,
    size: u64,
    written: u64,
    next_seq: u64,
    root_id: String,
    rel_final: String,
    file: File,
}

pub async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut write, mut read) = socket.split();
    let mut uploads: HashMap<Uuid, UploadState> = HashMap::new();
    let mut downloads: HashMap<Uuid, DownloadTask> = HashMap::new();
    let mut broadcast_rx = state.broadcast_tx.subscribe();

    loop {
        tokio::select! {
            biased;
            b = broadcast_rx.recv() => {
                match b {
                    Ok(msg) => {
                        if let Ok(js) = serde_json::to_string(&msg) {
                            if write.send(Message::Text(js.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = read.next() => {
                let Some(msg) = incoming else { break; };
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    Message::Text(t) => {
                        let env: ClientEnvelope = match serde_json::from_str(&t) {
                            Ok(e) => e,
                            Err(e) => {
                                let _ = write.send(err_msg("bad_json", &e.to_string())).await;
                                continue;
                            }
                        };
                        if let Err(e) = auth::verify_jwt(&state.config.jwt_secret, &env.token) {
                            let _ = write.send(err_msg("auth", &e.to_string())).await;
                            continue;
                        }
                        if let Err(e) =
                            handle_json(&state, &mut write, &mut uploads, &mut downloads, env).await
                        {
                            let _ = write.send(err_msg("handler", &e.to_string())).await;
                        }
                    }
                    Message::Binary(bin) => {
                        let chunk = match decode_upload_chunk(&bin) {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = write.send(err_msg("chunk", &e.to_string())).await;
                                continue;
                            }
                        };
                        if let Err(e) = auth::verify_jwt(&state.config.jwt_secret, chunk.token) {
                            let _ = write.send(err_msg("auth", &e.to_string())).await;
                            continue;
                        }
                        let ustart = Instant::now();
                        let ur = handle_upload_chunk(
                            &state,
                            &mut write,
                            &mut uploads,
                            chunk.transfer_id,
                            chunk.seq,
                            chunk.payload,
                        )
                        .await;
                        if let Some(log) = &state.timing_log {
                            log.record(
                                "ws",
                                "upload_chunk",
                                &format!("transfer_id={}", chunk.transfer_id),
                                ustart.elapsed(),
                                ur.is_ok(),
                            );
                        }
                        if let Err(e) = ur {
                            let _ = write.send(err_msg("upload", &e.to_string())).await;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(p) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Message::Pong(_) => {}
                }
            }
        }
    }
}

fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    a == b
}

/// True when `candidate` is equal to or lives inside `base` (by component match).
fn is_under(candidate: &std::path::Path, base: &std::path::Path) -> bool {
    let bc: Vec<_> = base.components().collect();
    let cc: Vec<_> = candidate.components().collect();
    if cc.len() < bc.len() {
        return false;
    }
    for i in 0..bc.len() {
        if bc[i] != cc[i] {
            return false;
        }
    }
    true
}

/// Replace the leaf of a posix relative path with `leaf`.
fn rel_with_leaf(rel: &str, leaf: &str) -> String {
    if let Some(i) = rel.rfind('/') {
        format!("{}/{}", &rel[..i], leaf)
    } else {
        leaf.to_string()
    }
}

#[cfg(target_os = "linux")]
fn libc_exdev() -> i32 {
    18
}
#[cfg(target_os = "macos")]
fn libc_exdev() -> i32 {
    18
}
#[cfg(target_os = "windows")]
fn libc_exdev() -> i32 {
    17
}
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn libc_exdev() -> i32 {
    18
}

fn err_msg(code: &str, message: &str) -> Message {
    let m = ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    };
    Message::Text(serde_json::to_string(&m).unwrap_or_else(|_| r#"{"type":"error"}"#.to_string()).into())
}

async fn handle_json(
    state: &Arc<AppState>,
    write: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    uploads: &mut HashMap<Uuid, UploadState>,
    downloads: &mut HashMap<Uuid, DownloadTask>,
    env: ClientEnvelope,
) -> anyhow::Result<()> {
    let (op, detail) = crate::timing::summarize_client_body(&env.body);
    let start = Instant::now();
    let result = handle_json_inner(state, write, uploads, downloads, env).await;
    if let Some(log) = &state.timing_log {
        log.record("ws", op, &detail, start.elapsed(), result.is_ok());
    }
    result
}

async fn handle_json_inner(
    state: &Arc<AppState>,
    write: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    uploads: &mut HashMap<Uuid, UploadState>,
    downloads: &mut HashMap<Uuid, DownloadTask>,
    env: ClientEnvelope,
) -> anyhow::Result<()> {
    match env.body {
        ClientBody::Ping => {
            let m = serde_json::to_string(&ServerMessage::Pong)?;
            write.send(Message::Text(m.into())).await?;
        }
        ClientBody::List { root_id, path } => {
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let (_p, entries) = list_root_path(root, &path).await?;
            let msg = ServerMessage::ListResult {
                root_id,
                path: _p,
                entries,
            };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::ListTree { root_id } => {
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let root_path = root.clone();
            let tree = tokio::task::spawn_blocking(move || crate::fsutil::list_tree_sync(&root_path))
                .await
                .map_err(|e| anyhow::anyhow!("tree walk join: {e}"))??;
            let msg = ServerMessage::ListTreeResult { root_id, tree };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::Mkdir { root_id, path } => {
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let target = safe_join(root, &path)?;
            fs::create_dir_all(&target).await?;
            state.broadcast_fs_changed(root_id.clone(), Some(path.clone()), FsChangeKind::Created);
            let msg = ServerMessage::MkdirOk { root_id, path };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::Remove { root_id, path } => {
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let target = safe_join(root, &path)?;
            let meta = fs::metadata(&target).await?;
            if meta.is_dir() {
                fs::remove_dir_all(&target).await?;
            } else {
                fs::remove_file(&target).await?;
            }
            state.broadcast_fs_changed(root_id.clone(), Some(path.clone()), FsChangeKind::Removed);
            let msg = ServerMessage::Ok;
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::Rename { root_id, from, to } => {
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let a = safe_join(root, &from)?;
            let b = safe_join(root, &to)?;
            fs::rename(&a, &b).await?;
            state.broadcast_fs_changed(root_id.clone(), Some(to.clone()), FsChangeKind::Renamed);
            let msg = ServerMessage::Ok;
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::Copy {
            from_root_id,
            from,
            to_root_id,
            to,
        } => {
            let from_root = state
                .roots
                .get(&from_root_id)
                .ok_or_else(|| anyhow::anyhow!("unknown from_root_id"))?
                .clone();
            let to_root = state
                .roots
                .get(&to_root_id)
                .ok_or_else(|| anyhow::anyhow!("unknown to_root_id"))?
                .clone();
            let src = safe_join(&from_root, &from)?;
            let desired_dst = safe_join(&to_root, &to)?;
            if same_path(&src, &desired_dst) {
                anyhow::bail!("source and destination are the same");
            }
            if is_under(&desired_dst, &src) {
                anyhow::bail!("cannot copy a folder into itself");
            }
            let (final_abs, final_name) = uniquify_destination(&desired_dst)?;
            let final_rel = rel_with_leaf(&to, &final_name);
            let final_abs_c = final_abs.clone();
            let src_c = src.clone();
            tokio::task::spawn_blocking(move || copy_recursive(&src_c, &final_abs_c)).await??;
            state.broadcast_fs_changed(
                to_root_id.clone(),
                Some(final_rel.clone()),
                FsChangeKind::Created,
            );
            let msg = ServerMessage::CopyOk {
                to_root_id,
                to: final_rel,
            };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::Move {
            from_root_id,
            from,
            to_root_id,
            to,
        } => {
            let from_root = state
                .roots
                .get(&from_root_id)
                .ok_or_else(|| anyhow::anyhow!("unknown from_root_id"))?
                .clone();
            let to_root = state
                .roots
                .get(&to_root_id)
                .ok_or_else(|| anyhow::anyhow!("unknown to_root_id"))?
                .clone();
            let src = safe_join(&from_root, &from)?;
            let desired_dst = safe_join(&to_root, &to)?;
            if same_path(&src, &desired_dst) {
                let msg = ServerMessage::MoveOk {
                    to_root_id,
                    to,
                };
                write
                    .send(Message::Text(serde_json::to_string(&msg)?.into()))
                    .await?;
                return Ok(());
            }
            if is_under(&desired_dst, &src) {
                anyhow::bail!("cannot move a folder into itself");
            }
            let (final_abs, final_name) = uniquify_destination(&desired_dst)?;
            let final_rel = rel_with_leaf(&to, &final_name);
            // Try rename first; fall back to recursive copy + remove if the
            // destination is on a different filesystem.
            let rename_res = fs::rename(&src, &final_abs).await;
            if let Err(e) = rename_res {
                let is_exdev = e.raw_os_error() == Some(libc_exdev());
                if !is_exdev {
                    return Err(e.into());
                }
                let src_c = src.clone();
                let final_abs_c = final_abs.clone();
                tokio::task::spawn_blocking(move || copy_recursive(&src_c, &final_abs_c))
                    .await??;
                // Remove source after successful copy.
                let meta = fs::metadata(&src).await?;
                if meta.is_dir() {
                    fs::remove_dir_all(&src).await?;
                } else {
                    fs::remove_file(&src).await?;
                }
            }
            state.broadcast_fs_changed(
                from_root_id.clone(),
                Some(from.clone()),
                FsChangeKind::Removed,
            );
            state.broadcast_fs_changed(
                to_root_id.clone(),
                Some(final_rel.clone()),
                FsChangeKind::Renamed,
            );
            let msg = ServerMessage::MoveOk {
                to_root_id,
                to: final_rel,
            };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::BeginUpload {
            root_id,
            path,
            size,
        } => {
            if size > state.config.max_upload_size {
                anyhow::bail!("file too large");
            }
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let final_path = safe_join(root, &path)?;
            if path.ends_with(TMP_UPLOAD_SUFFIX) {
                anyhow::bail!("invalid name");
            }
            if fs::metadata(&final_path).await.is_ok() {
                anyhow::bail!("target exists");
            }
            let staging = staging_path_for(&final_path)?;
            if fs::metadata(&staging).await.is_ok() {
                anyhow::bail!("staging exists");
            }
            let tid = Uuid::new_v4();
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)
                .await?;
            if let Err(e) = file.set_len(size).await {
                let _ = fs::remove_file(&staging).await;
                return Err(e.into());
            }
            uploads.insert(
                tid,
                UploadState {
                    staging,
                    final_path,
                    size,
                    written: 0,
                    next_seq: 0,
                    root_id: root_id.clone(),
                    rel_final: path.clone(),
                    file,
                },
            );
            let msg = ServerMessage::UploadAccepted {
                transfer_id: tid,
                max_chunk: state.config.max_chunk_size,
            };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::EndUpload { transfer_id } => {
            let mut up = uploads
                .remove(&transfer_id)
                .ok_or_else(|| anyhow::anyhow!("unknown transfer"))?;
            if up.written != up.size {
                let _ = fs::remove_file(&up.staging).await;
                anyhow::bail!("incomplete upload");
            }
            up.file.flush().await?;
            drop(up.file);
            fs::rename(&up.staging, &up.final_path).await?;
            state.broadcast_fs_changed(
                up.root_id.clone(),
                Some(up.rel_final.clone()),
                FsChangeKind::Created,
            );
            let msg = ServerMessage::UploadFinished { transfer_id };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::AbortUpload { transfer_id } => {
            if let Some(up) = uploads.remove(&transfer_id) {
                drop(up.file);
                let _ = fs::remove_file(&up.staging).await;
            }
            let msg = ServerMessage::UploadAborted { transfer_id };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
        ClientBody::BeginDownload { root_id, path } => {
            let root = state.roots.get(&root_id).ok_or_else(|| anyhow::anyhow!("unknown root"))?;
            let file_path = safe_join(root, &path)?;
            let meta = fs::metadata(&file_path).await?;
            if !meta.is_file() {
                anyhow::bail!("not a file");
            }
            let size = meta.len();
            let tid = Uuid::new_v4();
            let file = File::open(&file_path).await?;
            downloads.insert(
                tid,
                DownloadTask {
                    file,
                    size,
                    sent: 0,
                },
            );
            let msg = ServerMessage::DownloadReady {
                transfer_id: tid,
                size,
                max_chunk: state.config.max_chunk_size,
            };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
            stream_download(write, downloads, tid, state.config.max_chunk_size as usize).await?;
        }
        ClientBody::AbortDownload { transfer_id } => {
            downloads.remove(&transfer_id);
            let msg = ServerMessage::DownloadAborted { transfer_id };
            write
                .send(Message::Text(serde_json::to_string(&msg)?.into()))
                .await?;
        }
    }
    Ok(())
}

struct DownloadTask {
    file: File,
    size: u64,
    sent: u64,
}

async fn stream_download(
    write: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    downloads: &mut HashMap<Uuid, DownloadTask>,
    tid: Uuid,
    chunk: usize,
) -> anyhow::Result<()> {
    let task = downloads.get_mut(&tid).ok_or_else(|| anyhow::anyhow!("no download"))?;
    let mut buf = vec![0u8; chunk];
    let mut seq = 0u64;
    while task.sent < task.size {
        let n = ((task.size - task.sent).min(chunk as u64)) as usize;
        let read = task.file.read(&mut buf[..n]).await?;
        if read == 0 {
            break;
        }
        let frame = encode_download_chunk(tid, seq, &buf[..read])?;
        write.send(Message::Binary(frame.into())).await?;
        task.sent += read as u64;
        seq += 1;
        let prog = ServerMessage::Progress {
            transfer_id: tid,
            bytes_completed: task.sent,
            bytes_total: Some(task.size),
        };
        write
            .send(Message::Text(serde_json::to_string(&prog)?.into()))
            .await?;
    }
    downloads.remove(&tid);
    let done = ServerMessage::DownloadFinished { transfer_id: tid };
    write
        .send(Message::Text(serde_json::to_string(&done)?.into()))
        .await?;
    Ok(())
}

async fn handle_upload_chunk(
    state: &Arc<AppState>,
    write: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    uploads: &mut HashMap<Uuid, UploadState>,
    transfer_id: Uuid,
    seq: u64,
    payload: &[u8],
) -> anyhow::Result<()> {
    let up = uploads
        .get_mut(&transfer_id)
        .ok_or_else(|| anyhow::anyhow!("unknown transfer"))?;
    if seq != up.next_seq {
        anyhow::bail!("bad seq");
    }
    let max = state.config.max_chunk_size as u64;
    if payload.len() as u64 > max {
        anyhow::bail!("chunk too large");
    }
    if up.written + payload.len() as u64 > up.size {
        anyhow::bail!("too much data");
    }
    up.file.seek(std::io::SeekFrom::Start(up.written)).await?;
    up.file.write_all(payload).await?;
    up.written += payload.len() as u64;
    up.next_seq += 1;
    let prog = ServerMessage::Progress {
        transfer_id,
        bytes_completed: up.written,
        bytes_total: Some(up.size),
    };
    write
        .send(Message::Text(serde_json::to_string(&prog)?.into()))
        .await?;
    Ok(())
}
