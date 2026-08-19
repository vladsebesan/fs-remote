use std::path::Path;

use fsremote_protocol::{FsChangeKind, ServerMessage, TMP_UPLOAD_SUFFIX};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

pub fn spawn_root_watchers(
    roots: &std::collections::HashMap<String, std::path::PathBuf>,
    broadcast_tx: tokio::sync::broadcast::Sender<ServerMessage>,
) -> anyhow::Result<Vec<RecommendedWatcher>> {
    let (send, mut recv) = tokio::sync::mpsc::unbounded_channel::<(String, Option<String>)>();
    tokio::spawn({
        let broadcast_tx = broadcast_tx.clone();
        async move {
            while let Some((root_id, path)) = recv.recv().await {
                let _ = broadcast_tx.send(ServerMessage::FsChanged {
                    root_id,
                    path,
                    kind: FsChangeKind::Other,
                });
            }
        }
    });

    let mut keep = Vec::new();
    for (root_id, root_path) in roots.iter() {
        let root_id = root_id.clone();
        let root_path = root_path.clone();
        let root_path_cb = root_path.clone();
        let send = send.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    if matches!(ev.kind, EventKind::Access(_)) {
                        return;
                    }
                    let mut rel_hint: Option<String> = None;
                    'paths: for p in ev.paths {
                        if let Ok(rel) = p.strip_prefix(&root_path_cb) {
                            let s = rel.to_string_lossy().replace('\\', "/");
                            if s.ends_with(TMP_UPLOAD_SUFFIX) {
                                continue 'paths;
                            }
                            rel_hint = Some(s);
                            break;
                        }
                    }
                    let _ = send.send((root_id.clone(), rel_hint));
                }
            },
            Config::default(),
        )?;
        watcher.watch(Path::new(&root_path), RecursiveMode::Recursive)?;
        keep.push(watcher);
    }
    Ok(keep)
}
