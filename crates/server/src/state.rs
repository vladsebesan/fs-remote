use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use fsremote_protocol::{FsChangeKind, ServerMessage, TMP_UPLOAD_SUFFIX};

use crate::config::Config;
use crate::timing::TimingLog;

pub struct AppState {
    pub config: Arc<Config>,
    pub roots: HashMap<String, PathBuf>,
    pub broadcast_tx: tokio::sync::broadcast::Sender<ServerMessage>,
    /// Keep OS watchers alive for the process lifetime.
    pub _watchers: Vec<notify::RecommendedWatcher>,
    /// Optional: per-command duration log (see `timing_log_path` in config).
    pub timing_log: Option<std::sync::Arc<TimingLog>>,
}

impl AppState {
    pub fn broadcast_fs_changed(&self, root_id: String, path: Option<String>, kind: FsChangeKind) {
        let p = path.clone();
        if let Some(ref sub) = p {
            if sub.ends_with(TMP_UPLOAD_SUFFIX) {
                return;
            }
        }
        let _ = self.broadcast_tx.send(ServerMessage::FsChanged {
            root_id,
            path: p,
            kind,
        });
    }
}
