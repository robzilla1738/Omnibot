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
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    pub status: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
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
    pub cron: String,
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
    #[serde(default)]
    pub only_explicit_handoffs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedStore {
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
    pub store: PersistedStore,
    pub harnesses: Vec<CliHarnessInfo>,
    pub skills: Vec<LocalSkillItem>,
    pub mcp_servers: Vec<LocalMcpServer>,
    pub computer_activity: Vec<ComputerActivityEntry>,
    pub active_runs: HashMap<String, ActiveBotRun>,
    pub cancelled_chats: HashSet<String>,
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
    dirs::home_dir()
        .map(|h| h.join("Tests/omni-bot"))
        .filter(|p| p.exists())
        .or_else(dirs::desktop_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

impl OmniRuntimeState {
    pub fn load(server_port: u16, event_tx: broadcast::Sender<OmniStreamEvent>) -> Self {
        let harnesses = scan_local_cli_harnesses();
        let skills = scan_local_skills();
        let mcp_servers = scan_local_mcp_servers();

        let mut store = load_or_initialize_store(&harnesses);
        sync_detected_cli_bots(&mut store, &harnesses);
        let _ = save_store(&store);

        Self {
            server_port,
            store,
            harnesses,
            skills,
            mcp_servers,
            computer_activity: Vec::new(),
            active_runs: HashMap::new(),
            cancelled_chats: HashSet::new(),
            event_tx,
        }
    }

    pub fn rescan_environment(&mut self) {
        self.harnesses = scan_local_cli_harnesses();
        self.skills = scan_local_skills();
        self.mcp_servers = scan_local_mcp_servers();
        sync_detected_cli_bots(&mut self.store, &self.harnesses);
        let _ = self.persist();
    }

    pub fn persist(&self) -> Result<(), String> {
        save_store(&self.store)
    }

    pub fn emit(&self, event: OmniStreamEvent) {
        let _ = self.event_tx.send(event);
    }

    pub fn record_activity(&mut self, tool_name: &str, summary: String, status: &str, duration_ms: u64) {
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
        }
    }
}

fn load_or_initialize_store(harnesses: &[CliHarnessInfo]) -> PersistedStore {
    let path = store_file_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<PersistedStore>(&raw) {
            if !parsed.bots.is_empty() {
                return parsed;
            }
        }
    }

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
        role_title: "Lead Swarm Coordinator & Principal Engineer".to_string(),
        description: "Your primary continuous point of contact. Coordinates work across your local CLI Bots (@Claude, @Codex, @OpenCode, @Cursor, @Grok, @Pi), reviews code, and executes tasks directly.".to_string(),
        shape: "blob".to_string(),
        color: "cyan".to_string(),
        is_primary: true,
        cli_driver: preferred_primary_driver,
        model: None,
        reasoning_effort: "high".to_string(),
        permission_mode: "auto".to_string(),
        system_prompt: "You are Omni, the lead coordinator Bot in Omni Bot on macOS. You can solve engineering tasks directly using your local tools, or coordinate and delegate specialized work to your teammate Bots (@Claude, @Codex, @OpenCode, @Cursor, @Grok, @Pi) using @mentions or <handoff to=\"BotName\"> blocks.".to_string(),
        memories: vec![
            "GitHub account: robzilla1738".to_string(),
            "Prefers clean, idiomatic code with zero tech debt".to_string(),
        ],
        auto_created_for_cli: false,
        custom_command: None,
        max_turn_budget_usd: None,
    };

    let primary_chat = ChatThread {
        id: "chat-omni-primary".to_string(),
        title: "Omni".to_string(),
        subtitle: "Primary Coordinator Bot".to_string(),
        is_primary: true,
        is_group: false,
        participant_bot_ids: vec!["bot-omni".to_string()],
        workspace_id: Some("ws-omni-bot".to_string()),
        workspace_path: Some(workspace_root.clone()),
        use_worktrees: false,
        max_swarm_turns: 4,
        messages: vec![ChatMessage {
            id: "msg-welcome-omni".to_string(),
            role: "assistant".to_string(),
            author_bot_id: Some("bot-omni".to_string()),
            author_name: Some("Omni".to_string()),
            author_shape: Some("blob".to_string()),
            author_color: Some("cyan".to_string()),
            cli_driver: Some(preferred_primary_driver),
            model: None,
            text: format!(
                "Welcome to **Botfinity**. I auto-detected **{} local coding CLIs** on your Mac ({}).\n\nEach CLI is set up as its own persistent Bot in your roster, and we can collaborate directly in **Swarm Rooms** or via `@Bot` handoffs:\n- Mention `@Claude`, `@Codex`, `@Grok`, `@OpenCode`, `@Cursor`, or `@Pi` in any chat to bring them into the thread.\n- Use `@all` or `/swarm` to dispatch parallel or sequential multi-bot workflows across your local codebase.\n- Click any Bot in the left rail for a dedicated 1:1 session, or open the **Inspector (`Cmd+I`)** to customize a Bot's character shape, color, CLI harness, or inspect live Git diffs.",
                harnesses.iter().filter(|h| h.installed).count(),
                harnesses
                    .iter()
                    .filter(|h| h.installed)
                    .map(|h| format!("`{}`", h.binary_name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            thinking: String::new(),
            tool_calls: Vec::new(),
            handoffs: Vec::new(),
            skill_slug: None,
            mentioned_bot_ids: Vec::new(),
            worktree_path: None,
            duration_ms: Some(120),
            cost_usd: None,
            input_tokens: None,
            output_tokens: None,
            status: "complete".to_string(),
            created_at_ms: now_ms(),
        }],
        native_sessions: HashMap::new(),
        last_synced_msg_index: HashMap::new(),
        updated_at_ms: now_ms(),
    };

    let workspaces = vec![WorkspaceEntry {
        id: "ws-omni-bot".to_string(),
        name: "omni-bot".to_string(),
        path: workspace_root.clone(),
        description: "Active local project repository".to_string(),
        instructions: "Keep code clean, concise, and idiomatic. Coordinate across bots before large refactors.".to_string(),
        assigned_bot_ids: Vec::new(),
        lead_bot_id: Some("bot-omni".to_string()),
        use_worktrees_default: false,
    }];

    let routines = vec![
        RoutineEntry {
            id: "routine-daily-audit".to_string(),
            name: "Morning Git & Tech Debt Audit".to_string(),
            cron: "0 9 * * 1-5".to_string(),
            prompt: "Inspect recent commits and uncommitted diffs in the active workspace, check for bugs or lint issues, and have @Codex verify @Claude's findings.".to_string(),
            bot_id: "bot-omni".to_string(),
            enabled: false,
            last_run_ms: None,
        },
    ];

    PersistedStore {
        preferences: OmniPreferences {
            workspace_root,
            default_max_swarm_turns: 4,
            approve_all_tools: true,
            global_instructions: "Work directly on the local workspace. When another Bot's specialty is helpful or requested, hand off clearly with @BotName.".to_string(),
            shared_memories: vec![
                "Primary GitHub account: robzilla1738".to_string(),
                "Local coding swarm running on macOS".to_string(),
            ],
            max_context_messages: 6,
            max_message_chars: 1400,
            max_turn_budget_usd: 1.50,
            max_parallel_bots: 3,
            turn_timeout_secs: 300,
            prevent_handoff_loops: true,
            only_explicit_handoffs: false,
        },
        bots: vec![omni_bot],
        chats: vec![primary_chat],
        workspaces,
        routines,
        dismissed_bot_ids: Vec::new(),
    }
}

fn sync_detected_cli_bots(store: &mut PersistedStore, harnesses: &[CliHarnessInfo]) {
    let mut added_bot_ids = Vec::new();

    // Ensure guardrail defaults are within sane bounds
    store.preferences.max_context_messages = store.preferences.max_context_messages.clamp(2, 24);
    store.preferences.max_message_chars = store.preferences.max_message_chars.clamp(400, 6000);
    if store.preferences.max_turn_budget_usd <= 0.0 {
        store.preferences.max_turn_budget_usd = 1.50;
    }
    store.preferences.max_parallel_bots = store.preferences.max_parallel_bots.clamp(1, 6);
    store.preferences.turn_timeout_secs = store.preferences.turn_timeout_secs.clamp(30, 1800);

    // Upgrade legacy default shapes and verbose role titles
    for bot in &mut store.bots {
        if bot.is_primary {
            if bot.shape == "omni-prism" || (bot.shape == "star" && bot.color == "black") {
                bot.shape = "blob".to_string();
                bot.color = "cyan".to_string();
            }
            bot.role_title = "Lead Swarm Coordinator".to_string();
        } else if bot.auto_created_for_cli {
            if matches!(
                bot.shape.as_str(),
                "squircle" | "hex" | "blob" | "gem" | "star" | "pebble" | "sparkle" | "shield" | "cloud"
            ) {
                bot.shape = bot.cli_driver.default_shape().to_string();
            }
            bot.role_title = bot.cli_driver.default_role_title().to_string();
        }
    }

    for h in harnesses.iter().filter(|h| h.installed) {
        let bot_id = format!("bot-{}", h.kind.as_str());
        if store.dismissed_bot_ids.contains(&bot_id) {
            continue;
        }
        let already_exists = store.bots.iter().any(|b| b.id == bot_id);
        if !already_exists {
            let slug = h.kind.as_str().to_string();
            let name = h.kind.default_bot_name().to_string();
            let role_title = h.kind.default_role_title().to_string();
            let shape = h.kind.default_shape().to_string();
            let color = h.kind.default_color().to_string();

            store.bots.push(BotProfile {
                id: bot_id.clone(),
                name: name.clone(),
                slug: slug.clone(),
                role_title: role_title.clone(),
                description: h.description.clone(),
                shape: shape.clone(),
                color: color.clone(),
                is_primary: false,
                cli_driver: h.kind,
                model: h.models.first().cloned(),
                reasoning_effort: "high".to_string(),
                permission_mode: "auto".to_string(),
                system_prompt: format!(
                    "You are {name} ({role_title}), powered by the local `{}` CLI inside Botfinity. Collaborate with the user and your fellow Bots (@Omni, @Claude, @Codex, @OpenCode, @Cursor, @Grok, @Pi). Be concise, accurate, and write clean code.",
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
                    id: direct_chat_id,
                    title: name.clone(),
                    subtitle: format!("{} · {}", h.name, h.version.as_deref().unwrap_or("installed")),
                    is_primary: false,
                    is_group: false,
                    participant_bot_ids: vec![bot_id.clone()],
                    workspace_id: store.workspaces.first().map(|w| w.id.clone()),
                    workspace_path: Some(store.preferences.workspace_root.clone()),
                    use_worktrees: false,
                    max_swarm_turns: 4,
                    messages: Vec::new(),
                    native_sessions: HashMap::new(),
                    last_synced_msg_index: HashMap::new(),
                    updated_at_ms: now_ms(),
                });
            }
        }
        added_bot_ids.push(bot_id);
    }

    // Seed a default Multi-Bot Swarm Room if no group chat exists yet
    let has_group_chat = store.chats.iter().any(|c| c.is_group);
    if !has_group_chat && added_bot_ids.len() >= 2 {
        let swarm_participants: Vec<String> = store
            .bots
            .iter()
            .filter(|b| !b.is_primary)
            .take(4)
            .map(|b| b.id.clone())
            .collect();
        if swarm_participants.len() >= 2 {
            let names: Vec<String> = store
                .bots
                .iter()
                .filter(|b| swarm_participants.contains(&b.id))
                .map(|b| b.name.clone())
                .collect();
            store.chats.insert(
                1,
                ChatThread {
                    id: "chat-swarm-core".to_string(),
                    title: "Core Coding Swarm".to_string(),
                    subtitle: format!("Swarm Room · {}", names.join(", ")),
                    is_primary: false,
                    is_group: true,
                    participant_bot_ids: swarm_participants,
                    workspace_id: store.workspaces.first().map(|w| w.id.clone()),
                    workspace_path: Some(store.preferences.workspace_root.clone()),
                    use_worktrees: false,
                    max_swarm_turns: 4,
                    messages: vec![ChatMessage {
                        id: "msg-swarm-intro".to_string(),
                        role: "assistant".to_string(),
                        author_bot_id: Some("bot-omni".to_string()),
                        author_name: Some("Omni".to_string()),
                        author_shape: Some("blob".to_string()),
                        author_color: Some("cyan".to_string()),
                        cli_driver: Some(CliDriverKind::Claude),
                        model: None,
                        text: format!(
                            "**Core Coding Swarm** is ready with **{}**.\n\n- Address a specific Bot with `@Claude`, `@Codex`, `@Grok`, `@OpenCode`, `@Cursor`, or `@Pi`.\n- Address `@all` to have every Bot in this room weigh in or run in parallel.\n- When one Bot `@mentions` another Bot in its response, the next Bot automatically picks up the baton and continues the work.",
                            names.join(" + ")
                        ),
                        thinking: String::new(),
                        tool_calls: Vec::new(),
                        handoffs: Vec::new(),
                        skill_slug: None,
                        mentioned_bot_ids: Vec::new(),
                        worktree_path: None,
                        duration_ms: None,
                        cost_usd: None,
                        input_tokens: None,
                        output_tokens: None,
                        status: "complete".to_string(),
                        created_at_ms: now_ms(),
                    }],
                    native_sessions: HashMap::new(),
                    last_synced_msg_index: HashMap::new(),
                    updated_at_ms: now_ms(),
                },
            );
        }
    }
}

fn save_store(store: &PersistedStore) -> Result<(), String> {
    let dir = omni_data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize store: {e}"))?;
    fs::write(store_file_path(), json).map_err(|e| format!("Failed to write store: {e}"))
}
