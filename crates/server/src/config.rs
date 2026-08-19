use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub bind: String,
    pub jwt_secret: String,
    pub jwt_exp_secs: u64,
    pub max_chunk_size: u32,
    pub max_upload_size: u64,
    pub log_path: PathBuf,
    /// When `None`, defaults to `fsremote.timing.log` next to `log_path`.
    #[serde(default)]
    pub timing_log_path: Option<PathBuf>,
    pub roots: Vec<RootConfig>,
    pub users: Vec<UserConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RootConfig {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserConfig {
    pub username: String,
    pub password_hash: String,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        let c: Config = toml::from_str(&raw)?;
        Ok(c)
    }

    pub fn resolve_roots(&self) -> anyhow::Result<HashMap<String, PathBuf>> {
        let mut m = HashMap::new();
        for r in &self.roots {
            if m.contains_key(&r.id) {
                anyhow::bail!(
                    "duplicate root id {:?} in config (each [[roots]] id must be unique)",
                    r.id
                );
            }
            let canon = r.path.canonicalize().map_err(|e| {
                anyhow::anyhow!("root {} path {:?}: {}", r.id, r.path, e)
            })?;
            m.insert(r.id.clone(), canon);
        }
        Ok(m)
    }

    /// Effective path for the command timing log (separate from `log_path`).
    pub fn timing_log_path_resolved(&self) -> PathBuf {
        self.timing_log_path.clone().unwrap_or_else(|| {
            self.log_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("fsremote.timing.log")
        })
    }
}
