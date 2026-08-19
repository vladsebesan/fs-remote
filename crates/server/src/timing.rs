//! Append-only timing log (separate from general tracing `log_path`).

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fsremote_protocol::ClientBody;

pub struct TimingLog {
    file: Mutex<std::fs::File>,
}

impl TimingLog {
    pub fn create(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        if file.metadata()?.len() == 0 {
            writeln!(
                &mut file,
                "# unix_ms\tchannel\toperation\tdetail\tduration_ms\tstatus"
            )?;
        }
        Ok(Self {
            file: Mutex::new(file),
        })
    }

    /// One line per operation: unix_ms, channel, operation, detail, duration_ms, ok|err
    pub fn record(&self, channel: &str, operation: &str, detail: &str, elapsed: Duration, ok: bool) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let ms = elapsed.as_secs_f64() * 1000.0;
        let status = if ok { "ok" } else { "err" };
        let safe = detail.replace(['\t', '\n', '\r'], " ");
        let line = format!(
            "{ts}\t{channel}\t{operation}\t{safe}\t{ms:.3}\t{status}\n"
        );
        if let Ok(mut f) = self.file.lock() {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}

/// Short label + detail for timing rows (before `env.body` is moved).
pub fn summarize_client_body(body: &ClientBody) -> (&'static str, String) {
    use ClientBody::*;
    match body {
        Ping => ("ping", String::new()),
        List { root_id, path } => ("list", format!("root_id={root_id} path={path}")),
        ListTree { root_id } => ("list_tree", format!("root_id={root_id}")),
        Mkdir { root_id, path } => ("mkdir", format!("root_id={root_id} path={path}")),
        Remove { root_id, path } => ("remove", format!("root_id={root_id} path={path}")),
        Rename { root_id, from, to } => {
            ("rename", format!("root_id={root_id} from={from} to={to}"))
        }
        Copy {
            from_root_id,
            from,
            to_root_id,
            to,
        } => (
            "copy",
            format!("from_root_id={from_root_id} from={from} to_root_id={to_root_id} to={to}"),
        ),
        Move {
            from_root_id,
            from,
            to_root_id,
            to,
        } => (
            "move",
            format!("from_root_id={from_root_id} from={from} to_root_id={to_root_id} to={to}"),
        ),
        BeginUpload { root_id, path, size } => (
            "begin_upload",
            format!("root_id={root_id} path={path} size={size}"),
        ),
        EndUpload { transfer_id } => ("end_upload", format!("transfer_id={transfer_id}")),
        AbortUpload { transfer_id } => ("abort_upload", format!("transfer_id={transfer_id}")),
        BeginDownload { root_id, path } => (
            "begin_download",
            format!("root_id={root_id} path={path}"),
        ),
        AbortDownload { transfer_id } => ("abort_download", format!("transfer_id={transfer_id}")),
    }
}
