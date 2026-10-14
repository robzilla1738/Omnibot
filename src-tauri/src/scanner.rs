use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliDriverKind {
    Claude,
    Codex,
    Opencode,
    Cursor,
    Grok,
    Pi,
    Antigravity,
    Muse,
    Acp,
    Gemini,
    Aider,
    Ollama,
    Custom,
}

impl CliDriverKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Cursor => "cursor",
            Self::Grok => "grok",
            Self::Pi => "pi",
            Self::Antigravity => "antigravity",
            Self::Muse => "muse",
            Self::Acp => "acp",
            Self::Gemini => "gemini",
            Self::Aider => "aider",
            Self::Ollama => "ollama",
            Self::Custom => "custom",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "OpenAI Codex",
            Self::Opencode => "OpenCode",
            Self::Cursor => "Cursor Agent",
            Self::Grok => "Grok Build",
            Self::Pi => "Pi Agent",
            Self::Antigravity => "Antigravity",
            Self::Muse => "Muse Code",
            Self::Acp => "ACP Registry",
            Self::Gemini => "Gemini CLI",
            Self::Aider => "Aider",
            Self::Ollama => "Ollama Local",
            Self::Custom => "Custom CLI",
        }
    }

    pub fn default_bot_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Opencode => "OpenCode",
            Self::Cursor => "Cursor",
            Self::Grok => "Grok",
            Self::Pi => "Pi",
            Self::Antigravity => "Antigravity",
            Self::Muse => "Muse",
            Self::Acp => "ACP",
            Self::Gemini => "Gemini",
            Self::Aider => "Aider",
            Self::Ollama => "Ollama",
            Self::Custom => "Agent",
        }
    }

    pub fn default_shape(self) -> &'static str {
        match self {
            Self::Claude => "claude-spark",
            Self::Codex => "codex-bloom",
            Self::Opencode => "opencode-terminal",
            Self::Cursor => "cursor-cube",
            Self::Grok => "grok-orbit",
            Self::Pi => "pi-crest",
            Self::Antigravity => "arch",
            Self::Muse => "bean",
            Self::Acp => "wedge",
            Self::Gemini => "gemini-star",
            Self::Aider => "aider-git",
            Self::Ollama => "ollama-llama",
            Self::Custom => "capsule",
        }
    }

    pub fn default_color(self) -> &'static str {
        match self {
            Self::Claude => "orange",
            Self::Codex => "green",
            Self::Opencode => "cyan",
            Self::Cursor => "blue",
            Self::Grok => "gray",
            Self::Pi => "violet",
            Self::Antigravity => "blue",
            Self::Muse => "cyan",
            Self::Acp => "gray",
            Self::Gemini => "blue",
            Self::Aider => "yellow",
            Self::Ollama => "magenta",
            Self::Custom => "cyan",
        }
    }

    pub fn default_role_title(self) -> &'static str {
        match self {
            Self::Claude => "Architecture & Deep Code",
            Self::Codex => "Execution & Refactoring",
            Self::Opencode => "Full-Stack Harness Agent",
            Self::Cursor => "Fast Codebase Edits",
            Self::Grok => "Systems & Swarm Engineer",
            Self::Pi => "Precision Tool Agent",
            Self::Antigravity => "Google Cloud Coding Agent",
            Self::Muse => "Meta Muse Coding Agent",
            Self::Acp => "Agent Client Protocol",
            Self::Gemini => "Multimodal & Research",
            Self::Aider => "Git Pair Programmer",
            Self::Ollama => "Private Local Models",
            Self::Custom => "Custom CLI Specialist",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHarnessInfo {
    pub id: String,
    pub kind: CliDriverKind,
    pub name: String,
    pub binary_name: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
    pub description: String,
    pub install_hint: String,
    pub auth_hint: String,
    pub models: Vec<String>,
    #[serde(default)]
    pub model_labels: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub models_status: String,
    #[serde(default)]
    pub models_source: Option<String>,
    pub supports_json_stream: bool,
    pub supports_session_resume: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillItem {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMcpServer {
    pub id: String,
    pub name: String,
    pub command_or_url: String,
    pub source: String,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHarnessTestResult {
    pub kind: CliDriverKind,
    pub ok: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub latency_ms: u64,
    pub message: String,
}

pub fn test_cli_harness(kind: CliDriverKind) -> CliHarnessTestResult {
    let start = std::time::Instant::now();
    let harnesses = scan_local_cli_harnesses();
    let Some(info) = harnesses.into_iter().find(|h| h.kind == kind) else {
        return CliHarnessTestResult {
            kind,
            ok: false,
            binary_path: None,
            version: None,
            latency_ms: 0,
            message: "Driver not registered".to_string(),
        };
    };

    let Some(bin_path) = info.binary_path.clone() else {
        return CliHarnessTestResult {
            kind,
            ok: false,
            binary_path: None,
            version: None,
            latency_ms: start.elapsed().as_millis() as u64,
            message: format!("Binary '{}' not found on PATH", info.binary_name),
        };
    };

    let version = probe_version(&bin_path, "--version");
    let latency_ms = start.elapsed().as_millis() as u64;
    let ok = version.is_some();
    let message = match &version {
        Some(v) => format!("Verified {} at {} ({latency_ms}ms)", v, bin_path),
        None => format!("Binary found at {} but --version probe failed", bin_path),
    };

    CliHarnessTestResult {
        kind,
        ok,
        binary_path: Some(bin_path),
        version,
        latency_ms,
        message,
    }
}

pub fn extended_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".grok/bin",
            ".cargo/bin",
            ".bun/bin",
            ".opencode/bin",
            ".cursor/bin",
            "Library/pnpm",
        ] {
            dirs.push(home.join(rel));
        }
    }
    for sys in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        dirs.push(PathBuf::from(sys));
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for p in std::env::split_paths(&path_var) {
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    dirs
}

pub fn augmented_path_env() -> String {
    let dirs = extended_search_dirs();
    std::env::join_paths(dirs)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".to_string())
}

pub fn find_binary(candidates: &[&str]) -> Option<String> {
    let search_dirs = extended_search_dirs();
    for bin_name in candidates {
        let p = Path::new(bin_name);
        if p.is_absolute() && p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
        for dir in &search_dirs {
            let full = dir.join(bin_name);
            if full.is_file() {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn probe_version(binary_path: &str, flag: &str) -> Option<String> {
    // A broken --version command must not hang app startup or a rescan.
    // Spool to a temporary file to avoid filling an undrained pipe.
    use std::io::Read;
    use std::process::Stdio;
    let path = std::env::temp_dir().join(format!("omni-version-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).ok()?;
        let mut command = Command::new(binary_path);
        command
            .arg(flag)
            .env("PATH", augmented_path_env())
            .stdin(Stdio::null())
            .stdout(file.try_clone().ok()?)
            .stderr(file);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().ok()?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    break;
                }
                Ok(None) if start.elapsed() < std::time::Duration::from_secs(3) => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                _ => {
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(-(child.id() as i32), libc::SIGKILL);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .ok()?
            .take(8192)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    })();
    let _ = fs::remove_file(path);
    let raw = result?;
    raw.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("Warning:"))
        .map(|s| s.to_string())
}

pub fn scan_local_cli_harnesses() -> Vec<CliHarnessInfo> {
    type HarnessSpec<'a> = (
        CliDriverKind,
        &'a [&'a str],
        &'a str,
        &'a str,
        &'a str,
        bool,
        bool,
    );
    let specs: Vec<HarnessSpec<'_>> = vec![
        (
            CliDriverKind::Claude,
            &["claude"],
            "Anthropic Claude Code CLI with streaming JSONL, tool execution, skills, and session resume.",
            "brew install --cask claude-code",
            "claude auth login",
            true,
            true,
        ),
        (
            CliDriverKind::Codex,
            &["codex"],
            "OpenAI Codex CLI with non-interactive JSONL execution, sandboxing, and git worktree support.",
            "npm i -g @openai/codex",
            "codex login",
            true,
            true,
        ),
        (
            CliDriverKind::Opencode,
            &["opencode"],
            "OpenCode v2 CLI & local server harness with multi-provider models, thinking blocks, and ACP.",
            "brew install opencode",
            "opencode auth login",
            true,
            true,
        ),
        (
            CliDriverKind::Cursor,
            &["agent", "cursor-agent"],
            "Cursor Agent CLI with streaming partial deltas, auto-review classifier, and plan/build modes.",
            "Install via Cursor -> Install 'agent' CLI",
            "agent login",
            true,
            true,
        ),
        (
            CliDriverKind::Grok,
            &["grok"],
            "xAI Grok Build CLI with streaming Anthropic/ACP JSONL wire output and subagent orchestration.",
            "curl -fsSL https://x.ai/cli | sh",
            "grok login",
            true,
            true,
        ),
        (
            CliDriverKind::Pi,
            &["pi"],
            "Pi coding agent with JSON/RPC modes, read/bash/edit/write tools, and session branching.",
            "npm i -g @mariozechner/pi-coding-agent",
            "pi auth",
            true,
            true,
        ),
        (
            CliDriverKind::Antigravity,
            &["antigravity", "agy"],
            "Google Antigravity coding agent supported by T3 Code.",
            "Install via Google Antigravity",
            "Sign in with Google",
            true,
            false,
        ),
        (
            CliDriverKind::Muse,
            &["muse"],
            "Meta Muse Code CLI agent supported by T3 Code.",
            "Install Muse Code CLI",
            "muse login",
            true,
            false,
        ),
        (
            CliDriverKind::Acp,
            &["acp"],
            "Agent Client Protocol (ACP) Registry standard harness.",
            "opencode acp",
            "acp",
            true,
            false,
        ),
        (
            CliDriverKind::Gemini,
            &["gemini"],
            "Google Gemini CLI for 1M+ token codebase analysis and multimodal tasks.",
            "npm i -g @google/gemini-cli",
            "gemini",
            true,
            false,
        ),
        (
            CliDriverKind::Aider,
            &["aider"],
            "Aider Git-centric pair programming CLI with automatic commit attribution.",
            "pipx install aider-chat",
            "Set API key in environment",
            false,
            false,
        ),
        (
            CliDriverKind::Ollama,
            &["ollama"],
            "Local open-weights LLM runner on your Mac GPU (Metal).",
            "brew install ollama",
            "ollama serve",
            false,
            false,
        ),
    ];

    let mut harnesses: Vec<CliHarnessInfo> = specs
        .into_iter()
        .map(
            |(kind, bin_candidates, description, install_hint, auth_hint, json_stream, resume)| {
                let binary_path = find_binary(bin_candidates);
                let installed = binary_path.is_some();
                CliHarnessInfo {
                    id: kind.as_str().to_string(),
                    kind,
                    name: kind.display_name().to_string(),
                    binary_name: bin_candidates[0].to_string(),
                    binary_path,
                    version: None,
                    installed,
                    description: description.to_string(),
                    install_hint: install_hint.to_string(),
                    auth_hint: auth_hint.to_string(),
                    models: Vec::new(),
                    model_labels: Default::default(),
                    models_status: if installed { "loading" } else { "unavailable" }.into(),
                    models_source: None,
                    supports_json_stream: json_stream,
                    supports_session_resume: resume,
                }
            },
        )
        .collect();

    // At most one probe per registered CLI (12), each with its own timeout.
    // Preserve registry order while avoiding cumulative process startup delays.
    std::thread::scope(|scope| {
        for harness in &mut harnesses {
            if harness.installed {
                scope.spawn(move || {
                    harness.version = harness
                        .binary_path
                        .as_deref()
                        .and_then(|path| probe_version(path, "--version"));
                });
            }
        }
    });
    harnesses
}

pub fn scan_local_skills() -> Vec<LocalSkillItem> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let roots = [
        (home.join(".agents/skills"), "~/.agents/skills"),
        (home.join(".claude/skills"), "~/.claude/skills"),
        (home.join(".codex/skills"), "~/.codex/skills"),
        (home.join(".cursor/skills"), "~/.cursor/skills"),
    ];

    let mut skills = Vec::new();
    let mut seen_slugs = HashSet::new();

    for (root_dir, source_label) in roots {
        let Ok(entries) = fs::read_dir(&root_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().into_owned();
            if slug.starts_with('.') || seen_slugs.contains(&slug) {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let raw = fs::read_to_string(&skill_md).unwrap_or_default();
            let (parsed_name, parsed_desc) = parse_skill_frontmatter(&raw, &slug);
            seen_slugs.insert(slug.clone());
            skills.push(LocalSkillItem {
                id: format!("skill_{slug}"),
                name: parsed_name,
                slug,
                description: parsed_desc,
                path: skill_md.to_string_lossy().into_owned(),
                source: source_label.to_string(),
            });
        }
    }

    skills.sort_by_key(|a| a.name.to_lowercase());
    skills
}

fn parse_skill_frontmatter(raw: &str, fallback_slug: &str) -> (String, String) {
    let mut name = fallback_slug.to_string();
    let mut description = String::new();

    if let Some(rest) = raw.strip_prefix("---") {
        if let Some((front, _body)) = rest.split_once("---") {
            for line in front.lines() {
                let trimmed = line.trim();
                if let Some(v) = trimmed.strip_prefix("name:") {
                    let clean = v.trim().trim_matches('"').trim_matches('\'');
                    if !clean.is_empty() {
                        name = clean.to_string();
                    }
                } else if let Some(v) = trimmed.strip_prefix("description:") {
                    let clean = v.trim().trim_matches('"').trim_matches('\'');
                    if !clean.is_empty() && clean != "|" && clean != ">" {
                        description = clean.to_string();
                    }
                }
            }
        }
    }

    if description.is_empty() {
        for line in raw.lines() {
            let t = line.trim();
            if !t.is_empty() && !t.starts_with("---") && !t.starts_with('#') && !t.contains(':') {
                description = t.chars().take(160).collect();
                break;
            }
        }
    }
    if description.is_empty() {
        description = format!("Local agent skill /{fallback_slug}");
    }

    (name, description)
}

pub fn scan_local_mcp_servers() -> Vec<LocalMcpServer> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut servers = Vec::new();
    let mut seen = HashSet::new();

    let json_candidates = [
        (home.join(".claude.json"), "~/.claude.json"),
        (home.join(".cursor/mcp.json"), "~/.cursor/mcp.json"),
        (
            home.join(".config/opencode/opencode.json"),
            "~/.config/opencode/opencode.json",
        ),
    ];

    for (path, label) in json_candidates {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        for key in ["mcpServers", "mcp"] {
            let Some(obj) = val.get(key).and_then(|v| v.as_object()) else {
                continue;
            };
            for (srv_name, cfg) in obj {
                let dedup = srv_name.to_lowercase();
                if seen.contains(&dedup) {
                    continue;
                }
                let url = cfg
                    .get("url")
                    .or_else(|| cfg.get("serverUrl"))
                    .and_then(|v| v.as_str());
                let cmd = cfg.get("command").and_then(|v| v.as_str());
                let (transport, command_or_url) = if let Some(u) = url {
                    ("http".to_string(), u.to_string())
                } else if let Some(c) = cmd {
                    let args = cfg
                        .get("args")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    (
                        "stdio".to_string(),
                        format!("{c} {args}").trim().to_string(),
                    )
                } else {
                    ("mcp".to_string(), "configured".to_string())
                };
                seen.insert(dedup);
                servers.push(LocalMcpServer {
                    id: format!("mcp_{srv_name}"),
                    name: srv_name.clone(),
                    command_or_url,
                    source: label.to_string(),
                    transport,
                });
            }
        }
    }

    servers
}
