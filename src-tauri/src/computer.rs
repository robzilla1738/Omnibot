use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri::Url;

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

/// Accepts only absolute web and mail links, normalized by the URL parser.
pub fn external_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "This link is not a valid URL.")?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed),
        "mailto" => Ok(parsed),
        _ => Err("Only web and email links can be opened.".into()),
    }
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    let url = external_url(url)?;
    let status = Command::new("/usr/bin/open")
        .arg(url.as_str())
        .status()
        .map_err(|e| format!("Failed to open link: {e}"))?;
    if !status.success() {
        return Err("macOS could not open this link.".into());
    }
    Ok(())
}

fn local_or_https_url(target: &str) -> Option<Result<Url, String>> {
    let url = Url::parse(target).ok()?;
    match url.scheme() {
        "https" if url.host_str().is_some() => Some(Ok(url)),
        "http" => Some(
            matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                .then_some(url)
                .ok_or_else(|| "Only HTTPS and local http://localhost links can be opened.".into()),
        ),
        _ => None,
    }
}

const LAUNCHABLE_EXTENSIONS: &[&str] = &[
    "app",
    "command",
    "sh",
    "bash",
    "zsh",
    "tool",
    "terminal",
    "workflow",
    "action",
    "pkg",
    "mpkg",
    "scpt",
    "applescript",
    "jar",
];

/// `open` runs scripts and installers, so those may only be revealed in Finder.
fn is_launchable(path: &Path) -> bool {
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase());
    if extension.is_some_and(|ext| LAUNCHABLE_EXTENSIONS.contains(&ext.as_str())) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            return meta.is_file() && meta.permissions().mode() & 0o111 != 0;
        }
    }
    false
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
        let status = Command::new("/usr/bin/open")
            .args(["-a", app])
            .status()
            .map_err(|e| format!("Failed to launch application '{app}': {e}"))?;
        if !status.success() {
            return Err(format!("macOS could not open application '{app}'."));
        }
        return Ok(format!("Opened application '{app}'."));
    }

    if let Some(url) = local_or_https_url(trimmed) {
        let url = url?;
        let mut cmd = Command::new("/usr/bin/open");
        if let Some(app) = clean_app {
            cmd.args(["-a", app]);
        }
        let status = cmd
            .arg(url.as_str())
            .status()
            .map_err(|e| format!("Failed to open URL '{url}': {e}"))?;
        if !status.success() {
            return Err(format!("macOS could not open URL '{url}'."));
        }
        return Ok(format!("Opened URL '{url}'."));
    }

    let resolved = resolve_existing_path(workspace_root, trimmed)?;
    if !reveal_in_finder && is_launchable(&resolved) {
        return Err(format!(
            "'{}' is an app, script, or installer. Omnibot only reveals these in Finder.",
            resolved.display()
        ));
    }
    let mut cmd = Command::new("/usr/bin/open");
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

/// Credential stores matched by a single path component anywhere in the path.
const BLOCKED_NAMES: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".pypirc",
    ".kube",
    ".claude.json",
    "keychains",
];

/// Credential stores matched by consecutive path components (lowercase).
const BLOCKED_SEQUENCES: &[&[&str]] = &[
    &[".docker", "config.json"],
    &[".config", "gh"],
    &[".codex", "auth.json"],
    &[".claude", ".credentials.json"],
    &["library", "cookies"],
    &["library", "safari"],
    &["library", "containers", "com.apple.safari"],
    &["application support", "google", "chrome"],
    &["application support", "firefox"],
    &["application support", "arc"],
    &["application support", "bravesoftware"],
    &["application support", "microsoft edge"],
];

fn omni_data_root() -> &'static Path {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = crate::state::omni_data_dir();
        fs::canonicalize(&dir).unwrap_or(dir)
    })
}

/// Omnibot's own store and API token are private; bot homes, project notes, and
/// worktrees are working folders the user may browse.
fn is_private_app_data(path: &Path, data_root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(data_root) else {
        return false;
    };
    let parts: Vec<_> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    !match parts.as_slice() {
        [first, ..] if first == "projects" || first == "worktrees" => true,
        [first, _, home, ..] if first == "bots" && home == "home" => true,
        _ => false,
    }
}

fn is_blocked_path(path: &Path) -> bool {
    is_blocked_path_in(path, omni_data_root())
}

fn is_blocked_path_in(path: &Path, data_root: &Path) -> bool {
    if is_private_app_data(path, data_root) {
        return true;
    }
    let parts: Vec<String> = path
        .components()
        .filter_map(|comp| match comp {
            Component::Normal(os) => Some(os.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    parts.iter().any(|name| {
        name == ".env" || name.starts_with(".env.") || BLOCKED_NAMES.contains(&name.as_str())
    }) || BLOCKED_SEQUENCES.iter().any(|sequence| {
        parts
            .windows(sequence.len())
            .any(|window| window.iter().zip(sequence.iter()).all(|(a, b)| a == b))
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_stores_and_private_app_data_are_blocked() {
        let data = Path::new("/Users/me/.omni-bot");
        for path in [
            "/Users/me/.ssh/id_ed25519",
            "/Users/me/project/.env.local",
            "/Users/me/.docker/config.json",
            "/Users/me/.config/gh/hosts.yml",
            "/Users/me/.codex/auth.json",
            "/Users/me/.claude/.credentials.json",
            "/Users/me/.claude.json",
            "/Users/me/Library/Cookies/Cookies.binarycookies",
            "/Users/me/Library/Application Support/Google/Chrome/Default/Login Data",
            "/Users/me/Library/Application Support/BraveSoftware/Brave-Browser",
            "/Users/me/Library/Safari/History.db",
            "/Users/me/.omni-bot",
            "/Users/me/.omni-bot/store.json",
            "/Users/me/.omni-bot/api-token",
            "/Users/me/.omni-bot/bots/41/memory.md",
        ] {
            assert!(is_blocked_path_in(Path::new(path), data), "{path}");
        }
        for path in [
            "/Users/me/project/src/cookies/index.ts",
            "/Users/me/.config/nvim/init.lua",
            "/Users/me/.omni-bot/bots/41/home/notes.txt",
            "/Users/me/.omni-bot/projects/70/memory.md",
            "/Users/me/.omni-bot/worktrees/aa/bb/src",
        ] {
            assert!(!is_blocked_path_in(Path::new(path), data), "{path}");
        }
    }

    #[test]
    fn urls_are_parsed_instead_of_prefix_matched() {
        assert!(local_or_https_url("http://localhost.attacker.example/")
            .unwrap()
            .is_err());
        assert!(local_or_https_url("http://localhost:3000/app")
            .unwrap()
            .is_ok());
        assert!(local_or_https_url("https://example.com").unwrap().is_ok());
        assert!(local_or_https_url("README.md").is_none());
        assert!(external_url("https://example.com/a?b=c").is_ok());
        assert!(external_url("mailto:someone@example.com").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "x-apple.systempreferences:",
            "-a Terminal",
            "https://",
        ] {
            assert!(external_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn scripts_and_apps_are_only_revealed() {
        let dir = std::env::temp_dir().join(format!("omni-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("Tool.app")).unwrap();
        let script = dir.join("run");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(dir.join("notes.txt"), "hi").unwrap();
        let root = dir.to_string_lossy();
        for target in ["Tool.app", "run"] {
            let error = open_on_desktop(&root, target, Some("TextEdit"), false).unwrap_err();
            assert!(error.contains("only reveals"), "{error}");
        }
        assert!(is_launchable(&dir.join("Tool.app")));
        assert!(!is_launchable(&dir.join("notes.txt")));
        assert!(!is_launchable(&dir));
        let _ = fs::remove_dir_all(dir);
    }
}
