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
    #[serde(default)]
    pub supports_plan: bool,
    #[serde(default)]
    pub supports_effort: bool,
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
    let Some(spec) = harness_specs().into_iter().find(|s| s.kind == kind) else {
        return CliHarnessTestResult {
            kind,
            ok: false,
            binary_path: None,
            version: None,
            latency_ms: 0,
            message: "Driver not registered".to_string(),
        };
    };

    let Some(bin_path) = find_binary(spec.binaries) else {
        return CliHarnessTestResult {
            kind,
            ok: false,
            binary_path: None,
            version: None,
            latency_ms: start.elapsed().as_millis() as u64,
            message: format!("Binary '{}' not found on PATH", spec.binaries[0]),
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

#[derive(Default)]
struct LoginEnvironment {
    path: Option<String>,
    vars: Vec<(String, String)>,
}

static LOGIN_ENVIRONMENT: std::sync::OnceLock<LoginEnvironment> = std::sync::OnceLock::new();

const LOGIN_ENV_MARKER: &str = "__OMNIBOT_ENV_START__";

fn login_environment() -> &'static LoginEnvironment {
    LOGIN_ENVIRONMENT.get_or_init(capture_login_environment)
}

/// Variables exported by the user's shell profile (API keys, tool homes, etc.).
/// Apps opened from Finder inherit launchd's minimal environment, so CLIs
/// started from here would otherwise miss them. Empty when the app itself was
/// started from a shell, because the process environment is already complete.
pub fn user_environment() -> &'static [(String, String)] {
    &login_environment().vars
}

fn capture_login_environment() -> LoginEnvironment {
    if cfg!(test) || std::env::var_os("SHLVL").is_some() {
        return LoginEnvironment::default();
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    read_shell_environment(&shell, std::time::Duration::from_secs(5)).unwrap_or_default()
}

fn read_shell_environment(shell: &str, timeout: std::time::Duration) -> Option<LoginEnvironment> {
    use std::io::Read;
    use std::process::Stdio;
    let mut command = Command::new(shell);
    command
        .args([
            "-l",
            "-i",
            "-c",
            &format!("printf '%s' {LOGIN_ENV_MARKER}; /usr/bin/env -0"),
        ])
        // Lets shell profiles skip slow or interactive setup for this probe.
        .env("OMNIBOT_RESOLVING_ENVIRONMENT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let bytes = rx.recv_timeout(timeout).ok();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    parse_shell_environment(&bytes?)
}

fn parse_shell_environment(bytes: &[u8]) -> Option<LoginEnvironment> {
    const SKIP: &[&str] = &[
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
        "TERM",
        "COLORTERM",
        "PS1",
        "OMNIBOT_RESOLVING_ENVIRONMENT",
    ];
    let marker = LOGIN_ENV_MARKER.as_bytes();
    let start = bytes.windows(marker.len()).position(|w| w == marker)? + marker.len();
    let mut env = LoginEnvironment::default();
    for entry in bytes[start..].split(|b| *b == 0) {
        let entry = String::from_utf8_lossy(entry);
        let Some((key, value)) = entry.split_once('=') else {
            continue;
        };
        if key.is_empty()
            || SKIP.contains(&key)
            || key.starts_with("TERM_")
            || key.starts_with("TMUX")
            || key.starts_with("ITERM")
        {
            continue;
        }
        if key == "PATH" {
            env.path = Some(value.to_string());
        } else {
            env.vars.push((key.to_string(), value.to_string()));
        }
    }
    Some(env)
}

pub fn extended_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !p.as_os_str().is_empty() && !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    if let Some(path) = &login_environment().path {
        std::env::split_paths(path).for_each(&mut push);
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            "bin",
            ".grok/bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".opencode/bin",
            ".cursor/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".yarn/bin",
            ".local/share/mise/shims",
            ".asdf/shims",
            ".pyenv/shims",
            "Library/pnpm",
        ] {
            push(home.join(rel));
        }
    }
    for sys in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(PathBuf::from(sys));
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        std::env::split_paths(&path_var).for_each(&mut push);
    }
    dirs
}

pub fn augmented_path_env() -> String {
    let dirs = extended_search_dirs();
    std::env::join_paths(dirs)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".to_string())
}

/// PATH for a CLI child process. The binary's own directory goes first so
/// version-manager installs (nvm, volta, mise) find their matching runtime.
pub fn path_env_for_binary(binary_path: &str) -> String {
    let base = augmented_path_env();
    match Path::new(binary_path).parent().filter(|p| p.is_absolute()) {
        Some(dir) => format!("{}:{base}", dir.display()),
        None => base,
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    meta.is_file()
}

fn expand_home(name: &str) -> PathBuf {
    match (name.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(name),
    }
}

/// Resolves the first candidate that is an executable file. Names containing a
/// slash are treated as paths (with `~/` expansion) and never searched on PATH.
pub fn find_binary(candidates: &[&str]) -> Option<String> {
    let search_dirs = extended_search_dirs();
    for bin_name in candidates {
        if bin_name.contains('/') {
            let path = expand_home(bin_name);
            if path.is_absolute() && is_executable_file(&path) {
                return Some(path.to_string_lossy().into_owned());
            }
            continue;
        }
        for dir in &search_dirs {
            let full = dir.join(bin_name);
            if is_executable_file(&full) {
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
            .envs(user_environment().iter().map(|(k, v)| (k, v)))
            .env("PATH", path_env_for_binary(binary_path))
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

struct HarnessSpec {
    kind: CliDriverKind,
    /// Most specific name first; generic names like `agent` are a fallback.
    binaries: &'static [&'static str],
    description: &'static str,
    install_hint: &'static str,
    auth_hint: &'static str,
    json_stream: bool,
    session_resume: bool,
}

fn harness_specs() -> Vec<HarnessSpec> {
    fn spec(
        kind: CliDriverKind,
        binaries: &'static [&'static str],
        description: &'static str,
        install_hint: &'static str,
        auth_hint: &'static str,
        json_stream: bool,
        session_resume: bool,
    ) -> HarnessSpec {
        HarnessSpec {
            kind,
            binaries,
            description,
            install_hint,
            auth_hint,
            json_stream,
            session_resume,
        }
    }
    vec![
        spec(
            CliDriverKind::Claude,
            &["claude"],
            "Anthropic Claude Code CLI with streaming JSONL, tool execution, skills, and session resume.",
            "brew install --cask claude-code",
            "claude auth login",
            true,
            true,
        ),
        spec(
            CliDriverKind::Codex,
            &["codex"],
            "OpenAI Codex CLI with non-interactive JSONL execution, sandboxing, and git worktree support.",
            "npm i -g @openai/codex",
            "codex login",
            true,
            true,
        ),
        spec(
            CliDriverKind::Opencode,
            &["opencode"],
            "OpenCode CLI with multi-provider models, thinking blocks, and session resume.",
            "brew install opencode",
            "opencode auth login",
            true,
            true,
        ),
        spec(
            CliDriverKind::Cursor,
            &["cursor-agent", "agent"],
            "Cursor Agent CLI with streaming partial deltas, auto-review classifier, and plan/build modes.",
            "Install via Cursor -> Install 'agent' CLI",
            "cursor-agent login",
            true,
            true,
        ),
        spec(
            CliDriverKind::Grok,
            &["grok"],
            "xAI Grok Build CLI with streaming JSONL output and session resume.",
            "curl -fsSL https://x.ai/cli | sh",
            "grok login",
            true,
            true,
        ),
        spec(
            CliDriverKind::Pi,
            &["pi"],
            "Pi coding agent with JSON mode, read/bash/edit/write tools, and sessions.",
            "npm i -g @mariozechner/pi-coding-agent",
            "pi auth",
            true,
            true,
        ),
        spec(
            CliDriverKind::Antigravity,
            &["antigravity", "agy"],
            "Experimental: Google Antigravity agent. Omnibot sends one prompt and shows plain-text output.",
            "Install via Google Antigravity",
            "Sign in with Google",
            false,
            false,
        ),
        spec(
            CliDriverKind::Muse,
            &["muse"],
            "Meta Muse Code CLI run headless with `muse exec`; shows plain-text output.",
            "Install Muse Code CLI",
            "muse login",
            false,
            false,
        ),
        spec(
            CliDriverKind::Acp,
            &["acp"],
            "Experimental: passes the prompt as one argument to an `acp` command and shows plain-text output.",
            "opencode acp",
            "acp",
            false,
            false,
        ),
        spec(
            CliDriverKind::Gemini,
            &["gemini"],
            "Google Gemini CLI for large-context codebase analysis; shows plain-text output.",
            "npm i -g @google/gemini-cli",
            "gemini",
            false,
            false,
        ),
        spec(
            CliDriverKind::Aider,
            &["aider"],
            "Aider pair programming CLI. Omnibot turns off its automatic git commits.",
            "pipx install aider-chat",
            "Set API key in environment",
            false,
            false,
        ),
        spec(
            CliDriverKind::Ollama,
            &["ollama"],
            "Local open-weights models on your Mac GPU (Metal). Only installed models are used.",
            "brew install ollama",
            "ollama serve",
            false,
            false,
        ),
    ]
}

pub fn scan_local_cli_harnesses() -> Vec<CliHarnessInfo> {
    let mut harnesses: Vec<CliHarnessInfo> = harness_specs()
        .into_iter()
        .map(|spec| {
            let kind = spec.kind;
            let binary_path = find_binary(spec.binaries);
            let installed = binary_path.is_some();
            CliHarnessInfo {
                supports_plan: crate::execution::supports_plan(kind),
                supports_effort: matches!(kind, CliDriverKind::Claude | CliDriverKind::Codex),
                id: kind.as_str().to_string(),
                kind,
                name: kind.display_name().to_string(),
                binary_name: spec.binaries[0].to_string(),
                binary_path,
                version: None,
                installed,
                description: spec.description.to_string(),
                install_hint: spec.install_hint.to_string(),
                auth_hint: spec.auth_hint.to_string(),
                models: Vec::new(),
                model_labels: Default::default(),
                models_status: if installed { "loading" } else { "unavailable" }.into(),
                models_source: None,
                supports_json_stream: spec.json_stream,
                supports_session_resume: spec.session_resume,
            }
        })
        .collect();

    // At most one probe per registered CLI, each with its own timeout.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_environment_skips_profile_noise_and_session_variables() {
        let raw = b"motd noise __OMNIBOT_ENV_START__PATH=/a:/b\0API_KEY=x=y\0PWD=/tmp\0SHLVL=2\0TERM_PROGRAM=iTerm\0\0";
        let env = parse_shell_environment(raw).unwrap();
        assert_eq!(env.path.as_deref(), Some("/a:/b"));
        assert_eq!(env.vars, vec![("API_KEY".to_string(), "x=y".to_string())]);
        assert!(parse_shell_environment(b"PATH=/a").is_none());
    }

    #[test]
    fn login_shell_environment_is_read_with_a_timeout() {
        let env = read_shell_environment("/bin/sh", std::time::Duration::from_secs(5)).unwrap();
        assert!(env.path.is_some_and(|p| !p.is_empty()));
    }

    #[test]
    fn find_binary_requires_an_executable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("omni-bin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain");
        let tool = dir.join("tool");
        fs::write(&plain, "").unwrap();
        fs::write(&tool, "").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        let path = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(find_binary(&[&path(&plain)]), None);
        assert_eq!(find_binary(&[&path(&dir)]), None);
        assert_eq!(
            find_binary(&[&path(&plain), &path(&tool)]),
            Some(path(&tool))
        );
        assert_eq!(find_binary(&["relative/tool"]), None);
        let _ = fs::remove_dir_all(dir);
    }
}
