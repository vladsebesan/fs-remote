use std::path::{Component, Path, PathBuf};

use fsremote_protocol::TMP_UPLOAD_SUFFIX;

/// Join `rel` (posix-style) under `root` without allowing `..`.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    let rel = rel.replace('\\', "/");
    let mut out = root.to_path_buf();
    for seg in rel.trim_start_matches('/').split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(PathError::PathEscape);
        }
        if seg.contains('/') {
            return Err(PathError::InvalidSegment);
        }
        out.push(seg);
    }
    if !path_under_root(root, &out) {
        return Err(PathError::OutsideRoot);
    }
    Ok(out)
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("path escapes root")]
    PathEscape,
    #[error("invalid path segment")]
    InvalidSegment,
    #[error("path outside root")]
    OutsideRoot,
}

fn path_under_root(root: &Path, candidate: &Path) -> bool {
    let mut r = root.components();
    let mut c = candidate.components();
    loop {
        match (r.next(), c.next()) {
            (None, None) => return true,
            (None, Some(_)) => return true,
            (Some(_), None) => return false,
            (Some(a), Some(b)) if a == b => continue,
            _ => return false,
        }
    }
}

pub fn is_tmp_upload_name(name: &str) -> bool {
    name.ends_with(TMP_UPLOAD_SUFFIX)
}

pub fn file_name_hidden_from_list(name: &str) -> bool {
    is_tmp_upload_name(name)
}

/// Strip Windows `\\?\` prefix for comparisons if present.
pub fn normalize_display_path(p: &Path) -> PathBuf {
    let buf = p.to_path_buf();
    if let Some(s) = buf.to_str() {
        if s.starts_with(r"\\?\") {
            return PathBuf::from(&s[4..]);
        }
    }
    buf
}

/// Best-effort: ensure `candidate` stays under `root` using component walk (works before file exists).
pub fn strict_under_root(root: &Path, candidate: &Path) -> bool {
    let root_c: Vec<Component<'_>> = root.components().collect();
    let cand_c: Vec<Component<'_>> = candidate.components().collect();
    if cand_c.len() < root_c.len() {
        return false;
    }
    for i in 0..root_c.len() {
        if root_c[i] != cand_c[i] {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_basic() {
        let root = Path::new("/tmp/fsremote");
        let p = safe_join(root, "a/b").unwrap();
        assert_eq!(p, Path::new("/tmp/fsremote/a/b"));
    }

    #[test]
    fn rejects_dotdot() {
        let root = Path::new("/tmp/fsremote");
        assert!(safe_join(root, "../x").is_err());
    }
}
