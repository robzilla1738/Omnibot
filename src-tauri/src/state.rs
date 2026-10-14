use crate::git_ops::{inspect_git_status, GitRepoStatus};
use crate::scanner::{
    scan_local_cli_harnesses, scan_local_mcp_servers, scan_local_skills, CliDriverKind,
    CliHarnessInfo, LocalMcpServer, LocalSkillItem,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub role_title: String,
    pub description: String,
    #[serde(default)]
    pub avatar_image: Option<String>,
    pub shape: String,
    pub color: String,
    pub is_primary: bool,
    pub cli_driver: CliDriverKind,
    pub model: Option<String>,
    pub reasoning_effort: String,
    pub permission_mode: String,
    pub system_prompt: String,
    pub memories: Vec<String>,
    pub auto_created_for_cli: bool,
    #[serde(default)]
    pub custom_command: Option<String>,
    #[serde(default)]
    pub max_turn_budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocation {
    pub id: String,
    pub name: String,
    pub input_summary: String,
    pub command: Option<String>,
    pub output_summary: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffEvent {
    pub from_bot_id: String,
    pub from_bot_name: String,
    pub to_bot_ids: Vec<String>,
    pub to_bot_names: Vec<String>,
    pub mode: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub author_bot_id: Option<String>,
    pub author_name: Option<String>,
    pub author_shape: Option<String>,
    pub author_color: Option<String>,
    pub cli_driver: Option<CliDriverKind>,
    pub model: Option<String>,
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolInvocation>,
    pub handoffs: Vec<HandoffEvent>,
    pub skill_slug: Option<String>,
    pub mentioned_bot_ids: Vec<String>,
    pub worktree_path: Option<String>,
    pub duration_ms: Option<u64>,
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub usage_reported: bool,
    #[serde(default)]
    pub model_reported: bool,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    pub status: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    #[serde(default)]
    pub is_bot_home: bool,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub is_primary: bool,
    pub is_group: bool,
    pub participant_bot_ids: Vec<String>,
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
    pub use_worktrees: bool,
    pub max_swarm_turns: u32,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub native_sessions: HashMap<String, String>,
    #[serde(default)]
    pub last_synced_msg_index: HashMap<String, usize>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    #[serde(default)]
    pub approve_all_tools: bool,
    #[serde(default)]
    pub memories: Vec<String>,
    pub id: String,
    pub name: String,
    pub path: String,
    pub description: String,
    pub instructions: String,
    #[serde(default)]
    pub assigned_bot_ids: Vec<String>,
    #[serde(default)]
    pub lead_bot_id: Option<String>,
    #[serde(default)]
    pub use_worktrees_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub cron: String,
    #[serde(default)]
    pub schedule: Option<crate::routines::RoutineSchedule>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub last_attempt_ms: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub prompt: String,
    pub bot_id: String,
    pub enabled: bool,
    pub last_run_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActivityEntry {
    pub id: String,
    pub tool_name: String,
    pub summary: String,
    pub status: String,
    pub duration_ms: u64,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBotRun {
    pub chat_id: String,
    pub message_id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub cli_driver: CliDriverKind,
    pub activity: String,
    pub started_at_ms: u64,
}

fn default_max_context_messages() -> u32 {
    6
}
fn default_max_message_chars() -> usize {
    1400
}
fn default_max_turn_budget_usd() -> f64 {
    1.50
}
fn default_max_parallel_bots() -> u32 {
    3
}
fn default_turn_timeout_secs() -> u64 {
    300
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmniPreferences {
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default)]
    pub pinned_bot_ids: Vec<String>,
    pub workspace_root: String,
    pub default_max_swarm_turns: u32,
    pub approve_all_tools: bool,
    pub global_instructions: String,
    pub shared_memories: Vec<String>,
    #[serde(default = "default_max_context_messages")]
    pub max_context_messages: u32,
    #[serde(default = "default_max_message_chars")]
    pub max_message_chars: usize,
    #[serde(default = "default_max_turn_budget_usd")]
    pub max_turn_budget_usd: f64,
    #[serde(default = "default_max_parallel_bots")]
    pub max_parallel_bots: u32,
    #[serde(default = "default_turn_timeout_secs")]
    pub turn_timeout_secs: u64,
    #[serde(default = "default_true")]
    pub prevent_handoff_loops: bool,
    #[serde(default = "default_true")]
    pub only_explicit_handoffs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStore {
    #[serde(default)]
    pub home_layout_version: u32,
    pub preferences: OmniPreferences,
    pub bots: Vec<BotProfile>,
    pub chats: Vec<ChatThread>,
    pub workspaces: Vec<WorkspaceEntry>,
    pub routines: Vec<RoutineEntry>,
    #[serde(default)]
    pub dismissed_bot_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmniSnapshot {
    pub server_port: u16,
    pub server_base_url: String,
    pub preferences: OmniPreferences,
    pub harnesses: Vec<CliHarnessInfo>,
    pub bots: Vec<BotProfile>,
    pub chats: Vec<ChatThread>,
    pub workspaces: Vec<WorkspaceEntry>,
    pub routines: Vec<RoutineEntry>,
    pub skills: Vec<LocalSkillItem>,
    pub mcp_servers: Vec<LocalMcpServer>,
    pub git_status: GitRepoStatus,
    pub computer_activity: Vec<ComputerActivityEntry>,
    pub active_runs: Vec<ActiveBotRun>,
    pub active_workflow_chat_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum OmniStreamEvent {
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        chat_id: String,
        message_id: String,
        bot_id: String,
        bot_name: String,
        cli_driver: CliDriverKind,
        model: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ThinkingDelta {
        chat_id: String,
        message_id: String,
        bot_id: String,
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    TextDelta {
        chat_id: String,
        message_id: String,
        bot_id: String,
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        chat_id: String,
        message_id: String,
        bot_id: String,
        tool: ToolInvocation,
    },
    #[serde(rename_all = "camelCase")]
    Handoff {
        chat_id: String,
        message_id: String,
        handoff: HandoffEvent,
    },
    #[serde(rename_all = "camelCase")]
    TurnFinished {
        chat_id: String,
        message_id: String,
        bot_id: String,
        status: String,
        duration_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    StateUpdated { chat_id: Option<String> },
}

pub struct OmniRuntimeState {
    pub server_port: u16,
    pub data_dir: PathBuf,
    pub store_lock: Option<fs::File>,
    pub store: PersistedStore,
    pub harnesses: Vec<CliHarnessInfo>,
    pub skills: Vec<LocalSkillItem>,
    pub mcp_servers: Vec<LocalMcpServer>,
    pub computer_activity: Vec<ComputerActivityEntry>,
    pub active_runs: HashMap<String, ActiveBotRun>,
    pub cancelled_chats: HashSet<String>,
    pub active_workflows: HashSet<String>,
    pub event_tx: broadcast::Sender<OmniStreamEvent>,
}

pub type SharedOmniState = Arc<RwLock<OmniRuntimeState>>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn omni_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("OMNI_BOT_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omni-bot")
}

fn store_file_path() -> PathBuf {
    omni_data_dir().join("store.json")
}

fn default_workspace_root() -> String {
    let cwd = std::env::current_dir().ok();
    if let Some(dir) = cwd {
        let s = dir.to_string_lossy().into_owned();
        if !s.ends_with("/src-tauri") {
            return s;
        }
        if let Some(parent) = dir.parent() {
            return parent.to_string_lossy().into_owned();
        }
    }
    dirs::desktop_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

impl OmniRuntimeState {
    pub fn load(
        server_port: u16,
        event_tx: broadcast::Sender<OmniStreamEvent>,
    ) -> Result<Self, String> {
        let data_dir = omni_data_dir();
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let store_lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data_dir.join("store.lock"))
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(store_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("Another Omnibot instance is using this data directory. Close it before starting a second instance.".into());
            }
        }
        let harnesses = scan_local_cli_harnesses();
        let skills = scan_local_skills();
        let mcp_servers = scan_local_mcp_servers();

        let mut store = load_or_initialize_store(&harnesses)?;
        migrate_application_identity(&mut store);
        normalize_preferences(&mut store);
        remove_legacy_welcome(&mut store);
        crate::homes::migrate(&mut store);
        for chat in &mut store.chats {
            if chat.id == "chat-swarm-core" && chat.title == "Core Coding Swarm" {
                chat.title = "Core Coding Group".into();
            }
            for message in &mut chat.messages {
                if message.status == "streaming" {
                    message.status = "stopped".into();
                    for tool in &mut message.tool_calls {
                        if tool.status == "running" {
                            tool.status = "stopped".into();
                        }
                    }
                }
            }
        }
        save_store(&store)?;

        Ok(Self {
            server_port,
            data_dir,
            store_lock: Some(store_lock),
            store,
            harnesses,
            skills,
            mcp_servers,
            computer_activity: Vec::new(),
            active_runs: HashMap::new(),
            cancelled_chats: HashSet::new(),
            active_workflows: HashSet::new(),
            event_tx,
        })
    }

    pub fn persist(&self) -> Result<(), String> {
        save_store_at(&self.store, &self.data_dir)
    }

    pub fn emit(&self, event: OmniStreamEvent) {
        let _ = self.event_tx.send(event);
    }

    pub fn record_activity(
        &mut self,
        tool_name: &str,
        summary: String,
        status: &str,
        duration_ms: u64,
    ) {
        let timestamp_ms = now_ms();
        let entry = ComputerActivityEntry {
            id: format!("act_{timestamp_ms}_{}", self.computer_activity.len()),
            tool_name: tool_name.to_string(),
            summary,
            status: status.to_string(),
            duration_ms,
            timestamp_ms,
        };
        self.computer_activity.insert(0, entry);
        if self.computer_activity.len() > 50 {
            self.computer_activity.truncate(50);
        }
    }

    pub fn snapshot(&self) -> OmniSnapshot {
        let git_status = inspect_git_status(&self.store.preferences.workspace_root);
        let mut active_runs: Vec<ActiveBotRun> = self.active_runs.values().cloned().collect();
        active_runs.sort_by_key(|r| r.started_at_ms);

        OmniSnapshot {
            server_port: self.server_port,
            server_base_url: format!("http://127.0.0.1:{}", self.server_port),
            preferences: self.store.preferences.clone(),
            harnesses: self.harnesses.clone(),
            bots: self.store.bots.clone(),
            chats: self.store.chats.clone(),
            workspaces: self.store.workspaces.clone(),
            routines: self.store.routines.clone(),
            skills: self.skills.clone(),
            mcp_servers: self.mcp_servers.clone(),
            git_status,
            computer_activity: self.computer_activity.clone(),
            active_runs,
            active_workflow_chat_ids: self.active_workflows.iter().cloned().collect(),
        }
    }
}

// Change only application-identifying phrases in saved instructions, never bot names or history.
fn migrate_application_identity(store: &mut PersistedStore) {
    let mut changed = HashSet::new();
    for bot in &mut store.bots {
        if bot.avatar_image.as_deref() == Some("/botfinity-gauntlet.png") {
            bot.avatar_image = Some("/omnibot-gauntlet.png".into());
        }
        let prompt = bot
            .system_prompt
            .replace("CLI inside Botfinity.", "CLI inside Omnibot.")
            .replace("CLI inside Omni Bot.", "CLI inside Omnibot.")
            .replace("Bot in Omni Bot on macOS.", "Bot in Omnibot on macOS.");
        if prompt != bot.system_prompt {
            bot.system_prompt = prompt;
            changed.insert(bot.id.clone());
        }
    }
    for chat in &mut store.chats {
        chat.native_sessions.retain(|id, _| !changed.contains(id));
        chat.last_synced_msg_index
            .retain(|id, _| !changed.contains(id));
    }
}

// Old releases seeded a synthetic reply with a fixed provider and CLI count.
// Remove only that bundled message; real replies retain their original provenance.
pub fn remove_legacy_welcome(store: &mut PersistedStore) {
    for chat in &mut store.chats {
        let count = chat.messages.len();
        chat.messages.retain(|message| {
            !(message.role == "assistant"
                && ((message.id == "msg-welcome-omni"
                    && message.text.starts_with("Welcome to **Omni Bot**."))
                    || (message.id == "msg-swarm-intro"
                        && message
                            .text
                            .starts_with("**Core Coding Swarm** is ready with **"))))
        });
        if chat.messages.len() != count {
            // Removing a transcript entry invalidates native resume watermarks.
            chat.native_sessions.clear();
            chat.last_synced_msg_index.clear();
        }
    }
}

fn load_or_initialize_store(harnesses: &[CliHarnessInfo]) -> Result<PersistedStore, String> {
    let path = store_file_path();
    match fs::read_to_string(&path) {
        Ok(raw) => {
            return serde_json::from_str(&raw).map_err(|e| {
                format!(
                    "Could not read saved state at {}: {e}. The original file was preserved.",
                    path.display()
                )
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    }

    initialize_store(harnesses)
}

fn initialize_store(harnesses: &[CliHarnessInfo]) -> Result<PersistedStore, String> {
    let workspace_root = default_workspace_root();
    let preferred_primary_driver = harnesses
        .iter()
        .find(|h| h.installed && h.kind == CliDriverKind::Claude)
        .or_else(|| harnesses.iter().find(|h| h.installed))
        .map(|h| h.kind)
        .unwrap_or(CliDriverKind::Claude);

    let omni_bot = BotProfile {
        id: "bot-omni".to_string(),
        name: "Omni".to_string(),
        slug: "omni".to_string(),
        role_title: "Your personal assistant".to_string(),
        description: "Your personal assistant for ideas, plans, memories, and working with your team.".to_string(),
        avatar_image: Some("/omnibot-gauntlet.png".to_string()),
        shape: "blob".to_string(),
        color: "cyan".to_string(),
        is_primary: true,
        cli_driver: preferred_primary_driver,
        model: None,
        reasoning_effort: "high".to_string(),
        permission_mode: "auto".to_string(),
        system_prompt: "Help the user with any task supported by the available tools: thinking, research, writing, coding, files, and coordinating their team. Remember saved preferences. Projects provide optional workspace context. Follow the user’s explicit requests within configured permissions. Delegate only to available teammates using complete explicit handoff blocks.".to_string(),
        memories: Vec::new(),
        auto_created_for_cli: false,
        custom_command: None,
        max_turn_budget_usd: None,
    };

    let primary_chat = ChatThread {
        is_bot_home: true,
        id: "chat-omni-primary".to_string(),
        title: "Omni".to_string(),
        subtitle: "Primary Coordinator Bot".to_string(),
        is_primary: true,
        is_group: false,
        participant_bot_ids: vec!["bot-omni".to_string()],
        workspace_id: None,
        workspace_path: None,
        use_worktrees: false,
        max_swarm_turns: 4,
        messages: Vec::new(),
        native_sessions: HashMap::new(),
        last_synced_msg_index: HashMap::new(),
        updated_at_ms: now_ms(),
    };

    let workspaces = Vec::new();

    let routines = Vec::new();

    Ok(PersistedStore {
        home_layout_version: 3,
        preferences: OmniPreferences {
            onboarding_completed: false,
            pinned_bot_ids: Vec::new(),
            workspace_root,
            default_max_swarm_turns: 4,
            approve_all_tools: false,
            global_instructions:
                "Delegate only to available teammates using complete, explicit handoff blocks."
                    .to_string(),
            shared_memories: Vec::new(),
            max_context_messages: 6,
            max_message_chars: 1400,
            max_turn_budget_usd: 1.50,
            max_parallel_bots: 3,
            turn_timeout_secs: 300,
            prevent_handoff_loops: true,
            only_explicit_handoffs: true,
        },
        bots: vec![omni_bot],
        chats: vec![primary_chat],
        workspaces,
        routines,
        dismissed_bot_ids: Vec::new(),
    })
}

fn normalize_preferences(store: &mut PersistedStore) {
    // Ensure guardrail defaults are within sane bounds
    store.preferences.max_context_messages = store.preferences.max_context_messages.clamp(2, 24);
    store.preferences.max_message_chars = store.preferences.max_message_chars.clamp(400, 6000);
    if store.preferences.max_turn_budget_usd <= 0.0 {
        store.preferences.max_turn_budget_usd = 1.50;
    }
    store.preferences.max_parallel_bots = store.preferences.max_parallel_bots.clamp(1, 6);
    store.preferences.turn_timeout_secs = store.preferences.turn_timeout_secs.clamp(30, 1800);

    store
        .preferences
        .pinned_bot_ids
        .retain(|id| store.bots.iter().any(|b| &b.id == id && !b.is_primary));
}

pub(crate) fn import_cli_bots(store: &mut PersistedStore, harnesses: &[CliHarnessInfo]) {
    for h in harnesses.iter().filter(|h| h.installed) {
        let bot_id = format!("bot-{}", h.kind.as_str());
        store.dismissed_bot_ids.retain(|id| id != &bot_id);
        let already_exists = store.bots.iter().any(|b| b.id == bot_id);
        if !already_exists {
            let slug = h.kind.as_str().to_string();
            let base_name = h.kind.default_bot_name();
            let mut name = base_name.to_string();
            let mut suffix = 2;
            while store
                .bots
                .iter()
                .any(|b| b.name.eq_ignore_ascii_case(&name))
            {
                name = format!("{base_name} {suffix}");
                suffix += 1;
            }
            let role_title = h.kind.default_role_title().to_string();
            let shape = h.kind.default_shape().to_string();
            let color = h.kind.default_color().to_string();

            store.bots.push(BotProfile {
                id: bot_id.clone(),
                name: name.clone(),
                slug: slug.clone(),
                role_title: role_title.clone(),
                description: h.description.clone(),
                avatar_image: None,
                shape: shape.clone(),
                color: color.clone(),
                is_primary: false,
                cli_driver: h.kind,
                model: None,
                reasoning_effort: "medium".to_string(),
                permission_mode: "auto".to_string(),
                system_prompt: format!(
                    "You are {name} ({role_title}), powered by the local `{}` CLI inside Omnibot. Collaborate with the user and available teammates in the current roster. Delegate with complete, explicit handoff blocks. Be concise, accurate, and write clean code.",
                    h.binary_name
                ),
                memories: Vec::new(),
                auto_created_for_cli: true,
                custom_command: None,
                max_turn_budget_usd: None,
            });

            // Ensure a dedicated 1:1 thread exists for this Bot
            let direct_chat_id = format!("chat-direct-{slug}");
            if !store.chats.iter().any(|c| c.id == direct_chat_id) {
                store.chats.push(ChatThread {
                    is_bot_home: true,
                    id: direct_chat_id,
                    title: name.clone(),
                    subtitle: format!(
                        "{} · {}",
                        h.name,
                        h.version.as_deref().unwrap_or("installed")
                    ),
                    is_primary: false,
                    is_group: false,
                    participant_bot_ids: vec![bot_id.clone()],
                    workspace_id: None,
                    workspace_path: None,
                    use_worktrees: false,
                    max_swarm_turns: 4,
                    messages: Vec::new(),
                    native_sessions: HashMap::new(),
                    last_synced_msg_index: HashMap::new(),
                    updated_at_ms: now_ms(),
                });
            }
        }
    }
}

fn save_store(store: &PersistedStore) -> Result<(), String> {
    save_store_at(store, &omni_data_dir())
}

fn save_store_at(store: &PersistedStore, dir: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize store: {e}"))?;
    // Replace atomically so a crash cannot leave a half-written transcript.
    let temp = dir.join(format!("store-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, dir.join("store.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|e| format!("Failed to write store: {e}"))?;
    if let Err(error) = crate::homes::sync_memory_folders(dir, store) {
        eprintln!("Memory folder export: {error}");
    }
    Ok(())
}

/// Only bundled artwork and bounded raster data are accepted; never remote URLs or SVG.
pub fn validate_avatar_image(image: Option<&str>) -> Result<(), String> {
    let Some(image) = image else {
        return Ok(());
    };
    if matches!(image, "/omnibot-gauntlet.png" | "/botfinity-gauntlet.png") {
        return Ok(());
    }
    if image.len() <= 800_000 {
        if let Some(data) = image.strip_prefix("data:image/png;base64,") {
            let content = data.trim_end_matches('=');
            if content.starts_with("iVBORw0KGgo")
                && data.len() % 4 == 0
                && data.len() - content.len() <= 2
                && content
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
            {
                return Ok(());
            }
        }
    }
    Err("Choose a local PNG profile picture or the bundled gauntlet.".into())
}

/// Slow CLI discovery runs off the UI/runtime thread and outside the shared state lock.
pub async fn rescan_environment(state: SharedOmniState) -> Result<OmniSnapshot, String> {
    let refresh_state = state.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        let harnesses = scan_local_cli_harnesses();
        let skills = scan_local_skills();
        let mcp_servers = scan_local_mcp_servers();
        let mut guard = state
            .write()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.harnesses = harnesses;
        guard.skills = skills;
        guard.mcp_servers = mcp_servers;
        Ok::<OmniSnapshot, String>(guard.snapshot())
    })
    .await
    .map_err(|error| format!("Tool discovery failed: {error}"))??;
    tokio::spawn(crate::models::refresh(refresh_state));
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_rename_preserves_profiles_and_refreshes_affected_sessions_once() {
        let mut store = initialize_store(&[]).unwrap();
        let bot = &mut store.bots[0];
        bot.name = "My assistant".into();
        bot.avatar_image = Some("/botfinity-gauntlet.png".into());
        bot.system_prompt = "You are Omni, the lead coordinator Bot in Omni Bot on macOS. Keep my custom instructions.".into();
        let id = bot.id.clone();
        store.chats[0]
            .native_sessions
            .insert(id.clone(), "old-session".into());
        store.chats[0].last_synced_msg_index.insert(id.clone(), 4);
        migrate_application_identity(&mut store);
        assert_eq!(store.bots[0].name, "My assistant");
        assert_eq!(
            store.bots[0].avatar_image.as_deref(),
            Some("/omnibot-gauntlet.png")
        );
        assert_eq!(store.bots[0].system_prompt, "You are Omni, the lead coordinator Bot in Omnibot on macOS. Keep my custom instructions.");
        assert!(!store.chats[0].native_sessions.contains_key(&id));
        assert!(!store.chats[0].last_synced_msg_index.contains_key(&id));
        store.chats[0]
            .native_sessions
            .insert(id.clone(), "new-session".into());
        migrate_application_identity(&mut store);
        assert_eq!(
            store.chats[0].native_sessions.get(&id).map(String::as_str),
            Some("new-session")
        );
    }

    #[test]
    fn fresh_store_has_only_main_bot_and_requires_setup() {
        let store = initialize_store(&[]).unwrap();
        assert_eq!(store.bots.len(), 1);
        assert!(store.bots[0].is_primary);
        assert_eq!(
            store.bots[0].avatar_image.as_deref(),
            Some("/omnibot-gauntlet.png")
        );
        assert_eq!(store.chats.len(), 1);
        assert!(store.chats[0].messages.is_empty());
        assert!(store.preferences.pinned_bot_ids.is_empty());
        assert!(!store.preferences.onboarding_completed);
        assert!(!store.preferences.approve_all_tools);
        assert!(store.preferences.shared_memories.is_empty());
        assert!(store.routines.is_empty());
    }

    use crate::test_support::Fixture;

    #[test]
    fn atomic_store_roundtrips_and_leaves_no_partial_files() {
        let f = Fixture::new(&["A"]);
        let g = f.state.read().unwrap();
        g.persist().unwrap();
        let stored: PersistedStore =
            serde_json::from_str(&fs::read_to_string(g.data_dir.join("store.json")).unwrap())
                .unwrap();
        assert_eq!(stored.bots[0].name, "A");
        assert!(!fs::read_dir(&g.data_dir).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "tmp")));
        assert!(g.data_dir.join("bots").is_dir());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(g.data_dir.join("store.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
