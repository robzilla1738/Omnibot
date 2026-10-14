use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub workspace_root: String,
    pub workspace_exists: bool,
    pub home_dir: String,
    pub desktop_dir: String,
    pub documents_dir: String,
    pub downloads_dir: String,
    pub frontmost_app: Option<String>,
}

pub fn get_system_overview(workspace_root: &str) -> SystemOverview {
    let hostname = Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".to_string());

    let frontmost_app = Command::new("lsappinfo")
        .args(["info", "-only", "name", "-app", "front"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.split('"')
                .nth(3)
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
        });

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let desktop = dirs::desktop_dir().unwrap_or_else(|| home.join("Desktop"));
    let documents = dirs::document_dir().unwrap_or_else(|| home.join("Documents"));
    let downloads = dirs::download_dir().unwrap_or_else(|| home.join("Downloads"));

    let root_path = Path::new(workspace_root);
    SystemOverview {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname,
        workspace_root: workspace_root.to_string(),
        workspace_exists: root_path.exists(),
        home_dir: home.to_string_lossy().into_owned(),
        desktop_dir: desktop.to_string_lossy().into_owned(),
        documents_dir: documents.to_string_lossy().into_owned(),
        downloads_dir: downloads.to_string_lossy().into_owned(),
        frontmost_app,
    }
}

pub fn list_workspace_directory(
    workspace_root: &str,
    relative_path: Option<&str>,
) -> Result<Vec<LocalFileEntry>, String> {
    let target = resolve_existing_path(workspace_root, relative_path.unwrap_or("."))?;
    let entries = fs::read_dir(&target)
        .map_err(|e| format!("Could not read directory {}: {e}", target.display()))?;

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name != ".github" {
            continue;
        }
        let path = entry.path();
        if is_blocked_path(&path) {
            continue;
        }
        out.push(entry_from_path(&path, Some(name)));
        if out.len() >= 180 {
            break;
        }
    }

    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

pub fn read_workspace_file(
    workspace_root: &str,
    relative_or_full_path: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let target = resolve_existing_path(workspace_root, relative_or_full_path)?;
    if target.is_dir() {
        return Err(format!(
            "'{}' is a directory; use list_local_files instead.",
            target.display()
        ));
    }
    let limit = max_bytes.clamp(512, 256_000);
    let file = fs::File::open(&target)
        .map_err(|e| format!("Could not read file {}: {e}", target.display()))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Only regular files can be previewed.".into());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read file {}: {e}", target.display()))?;
    let slice = if bytes.len() > limit {
        &bytes[..limit]
    } else {
        &bytes[..]
    };
    let mut text = String::from_utf8_lossy(slice).into_owned();
    if bytes.len() > limit {
        text.push_str(&format!("\n\n... [truncated at {limit} bytes]"));
    }
    Ok(text)
}

pub fn search_workspace_files(
    workspace_root: &str,
    query: &str,
    base_path: Option<&str>,
) -> Result<Vec<LocalFileEntry>, String> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return list_workspace_directory(workspace_root, base_path);
    }
    let root = resolve_existing_path(workspace_root, base_path.unwrap_or("."))?;
    let mut matches = Vec::new();
    walk_matching_files(&root, &needle, 0, &mut matches);
    Ok(matches)
}

pub fn open_on_desktop(
    workspace_root: &str,
    target: &str,
    app_name: Option<&str>,
    reveal_in_finder: bool,
) -> Result<String, String> {
    let trimmed = target.trim();
    let clean_app = app_name.map(str::trim).filter(|s| !s.is_empty());

    if trimmed.is_empty() {
        let Some(app) = clean_app else {
            return Err(
                "Provide either a file/folder/URL target or an application name.".to_string(),
            );
        };
        let status = Command::new("open")
            .args(["-a", app])
            .status()
            .map_err(|e| format!("Failed to launch application '{app}': {e}"))?;
        if !status.success() {
            return Err(format!("macOS could not open application '{app}'."));
        }
        return Ok(format!("Opened application '{app}'."));
    }

    if trimmed.starts_with("https://")
        || trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
    {
        let mut cmd = Command::new("open");
        if let Some(app) = clean_app {
            cmd.args(["-a", app]);
        }
        let status = cmd
            .arg(trimmed)
            .status()
            .map_err(|e| format!("Failed to open URL '{trimmed}': {e}"))?;
        if !status.success() {
            return Err(format!("macOS could not open URL '{trimmed}'."));
        }
        return Ok(format!("Opened URL '{trimmed}'."));
    }

    let resolved = resolve_existing_path(workspace_root, trimmed)?;
    let mut cmd = Command::new("open");
    if reveal_in_finder {
        cmd.arg("-R");
    } else if let Some(app) = clean_app {
        cmd.args(["-a", app]);
    }
    let status = cmd
        .arg(&resolved)
        .status()
        .map_err(|e| format!("Failed to open '{}': {e}", resolved.display()))?;
    if !status.success() {
        return Err(format!(
            "macOS open exited with error for '{}'.",
            resolved.display()
        ));
    }

    if reveal_in_finder {
        Ok(format!("Revealed '{}' in Finder.", resolved.display()))
    } else {
        Ok(format!("Opened '{}'.", resolved.display()))
    }
}

pub fn write_clipboard_text(text: &str) -> Result<String, String> {
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn pbcopy: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write to pbcopy: {e}"))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for pbcopy: {e}"))?;
    if !status.success() {
        return Err("pbcopy exited with an error.".to_string());
    }
    Ok(format!(
        "Copied {} characters to clipboard.",
        text.chars().count()
    ))
}

fn entry_from_path(path: &Path, name_override: Option<String>) -> LocalFileEntry {
    let meta = fs::metadata(path).ok();
    let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
    let size_bytes = meta.as_ref().map_or(0, |m| m.len());
    let modified_ms = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let name = name_override.unwrap_or_else(|| {
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned())
    });
    LocalFileEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        size_bytes,
        modified_ms,
    }
}

fn walk_matching_files(dir: &Path, needle: &str, depth: usize, out: &mut Vec<LocalFileEntry>) {
    if depth > 5 || out.len() >= 80 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 80 {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        let path = entry.path();
        if is_blocked_path(&path) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let is_dir = meta.is_dir();
        if needle == "*" || name.to_ascii_lowercase().contains(needle) {
            out.push(entry_from_path(&path, Some(name)));
        }
        if is_dir {
            walk_matching_files(&path, needle, depth + 1, out);
        }
    }
}

fn is_blocked_path(path: &Path) -> bool {
    for comp in path.components() {
        let Component::Normal(os) = comp else {
            continue;
        };
        let lower = os.to_string_lossy().to_ascii_lowercase();
        if lower == ".env"
            || lower.starts_with(".env.")
            || matches!(
                lower.as_str(),
                ".ssh" | ".aws" | ".gnupg" | ".npmrc" | ".netrc" | "keychains"
            )
        {
            return true;
        }
    }
    false
}

fn expand_candidate_path(workspace_root: &str, candidate: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root).unwrap_or_else(|_| PathBuf::from(workspace_root));
    let trimmed = candidate.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(root);
    }

    let home = dirs::home_dir().unwrap_or_else(|| root.clone());
    if trimmed == "~" {
        return Ok(home);
    }
    if let Some(stripped) = trimmed.strip_prefix("~/") {
        return Ok(home.join(stripped));
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        Ok(PathBuf::from(trimmed))
    } else {
        Ok(root.join(trimmed))
    }
}

fn resolve_existing_path(workspace_root: &str, candidate: &str) -> Result<PathBuf, String> {
    let expanded = expand_candidate_path(workspace_root, candidate)?;
    let canonical = fs::canonicalize(&expanded)
        .map_err(|e| format!("Path '{}' not found: {e}", expanded.display()))?;
    if is_blocked_path(&canonical) {
        return Err(format!(
            "Access denied: '{}' is a protected credential path.",
            canonical.display()
        ));
    }
    Ok(canonical)
}
