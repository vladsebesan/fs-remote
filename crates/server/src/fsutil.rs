use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use fsremote_protocol::{DirEntry, TreeEntry, TMP_UPLOAD_SUFFIX};
use tokio::fs;

use crate::paths::{file_name_hidden_from_list, safe_join};

fn modified_unix_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Maximum directory depth for [`list_tree_sync`].
pub const TREE_MAX_DEPTH: usize = 256;
/// Maximum nodes (files + directories) in one tree response.
pub const TREE_MAX_NODES: usize = 100_000;

pub async fn list_root_path(root: &Path, rel: &str) -> anyhow::Result<(String, Vec<DirEntry>)> {
    let dir = safe_join(root, rel)?;
    let mut rd = fs::read_dir(&dir).await?;
    let mut entries = Vec::new();
    while let Some(ent) = rd.next_entry().await? {
        let name = ent.file_name().to_string_lossy().to_string();
        if file_name_hidden_from_list(&name) {
            continue;
        }
        let meta = ent.metadata().await?;
        entries.push(DirEntry {
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified: modified_unix_secs(&meta),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((rel.to_string(), entries))
}

/// Recursive listing of everything under `root` (sync; run in `spawn_blocking` from async handlers).
pub fn list_tree_sync(root: &Path) -> anyhow::Result<Vec<TreeEntry>> {
    let mut count = 0usize;
    walk_tree(root, "", 0, &mut count)
}

fn walk_tree(
    root: &Path,
    rel: &str,
    depth: usize,
    count: &mut usize,
) -> anyhow::Result<Vec<TreeEntry>> {
    if depth > TREE_MAX_DEPTH || *count >= TREE_MAX_NODES {
        return Ok(Vec::new());
    }
    let dir = safe_join(root, rel)?;
    let dir_read = std::fs::read_dir(&dir)?;
    let mut items: Vec<_> = dir_read.collect::<Result<Vec<_>, _>>()?;
    items.sort_by_key(|e| e.file_name());
    let mut entries = Vec::new();
    for ent in items {
        let name = ent.file_name().to_string_lossy().to_string();
        if file_name_hidden_from_list(&name) {
            continue;
        }
        let meta = ent.metadata()?;
        let rel_path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel, name)
        };
        *count += 1;
        if *count > TREE_MAX_NODES {
            break;
        }
        if meta.is_dir() {
            let children = walk_tree(root, &rel_path, depth + 1, count)?;
            entries.push(TreeEntry {
                name,
                rel_path,
                is_dir: true,
                size: 0,
                children,
            });
        } else {
            entries.push(TreeEntry {
                name,
                rel_path,
                is_dir: false,
                size: meta.len(),
                children: Vec::new(),
            });
        }
    }
    Ok(entries)
}

pub fn staging_path_for(final_path: &Path) -> anyhow::Result<PathBuf> {
    let name = final_path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("no file name"))?
        .to_string_lossy();
    let parent = final_path.parent().unwrap_or(Path::new(""));
    Ok(parent.join(format!("{name}{TMP_UPLOAD_SUFFIX}")))
}

/// If `target` already exists, pick a name like `foo (2).txt` in its parent
/// that does not. Returns the potentially-renamed absolute path and its
/// leaf name.
pub fn uniquify_destination(target: &Path) -> anyhow::Result<(PathBuf, String)> {
    let name = target
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("no file name"))?
        .to_string_lossy()
        .to_string();
    let parent = target.parent().unwrap_or(Path::new("")).to_path_buf();
    if !target.exists() {
        return Ok((target.to_path_buf(), name));
    }
    let (stem, ext) = split_name(&name);
    for i in 2..10_000 {
        let candidate = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let p = parent.join(&candidate);
        if !p.exists() {
            return Ok((p, candidate));
        }
    }
    anyhow::bail!("too many name collisions")
}

fn split_name(name: &str) -> (&str, &str) {
    if let Some(dot) = name.rfind('.') {
        if dot > 0 && dot < name.len() - 1 {
            return (&name[..dot], &name[dot + 1..]);
        }
    }
    (name, "")
}

/// Recursively copy `src` to `dst`. For directories this walks children and
/// re-creates the tree on the destination side. Intended to be called from
/// `tokio::task::spawn_blocking`.
pub fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::metadata(src)?;
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for ent in std::fs::read_dir(src)? {
            let ent = ent?;
            let from = ent.path();
            let to = dst.join(ent.file_name());
            copy_recursive(&from, &to)?;
        }
        Ok(())
    } else if meta.is_file() {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst).map(|_| ())
    } else {
        Ok(())
    }
}
