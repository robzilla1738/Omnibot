use crate::drivers::{execute_bot_turn, DriverTurnRequest};
use crate::git_ops::ensure_bot_worktree;
use crate::state::{
    now_ms, BotProfile, ChatMessage, HandoffEvent, OmniStreamEvent, SharedOmniState,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    pub chat_id: String,
    pub text: String,
    pub skill_slug: Option<String>,
    pub override_bot_id: Option<String>,
    pub override_model: Option<String>,
    pub override_effort: Option<String>,
    pub parallel_mode: Option<bool>,
}

pub async fn dispatch_chat_turn(
    state: SharedOmniState,
    input: SendMessageInput,
) -> Result<String, String> {
    dispatch_turn(state, input, false).await
}

/// Saved routines keep their selected first speaker even when instructions mention teammates.
pub async fn dispatch_routine_turn(
    state: SharedOmniState,
    input: SendMessageInput,
) -> Result<String, String> {
    dispatch_turn(state, input, true).await
}

async fn dispatch_turn(
    state: SharedOmniState,
    input: SendMessageInput,
    fixed_target: bool,
) -> Result<String, String> {
    let trimmed_text = input.text.trim().to_string();
    if trimmed_text.is_empty() {
        return Err("Message text cannot be empty.".to_string());
    }

    let user_msg_id = format!("msg_u_{}", uuid::Uuid::new_v4());

    // 1. Record user message and determine initial target Bot(s)
    let (initial_bots, parallel_initial, max_swarm_turns) = {
        let mut guard = state
            .write()
            .map_err(|_| "State lock poisoned".to_string())?;
        if guard.active_workflows.contains(&input.chat_id) {
            return Err("This chat is still running. Stop it and wait for it to finish before sending again.".into());
        }
        if let Some(id) = &input.override_bot_id {
            if !guard.store.bots.iter().any(|b| &b.id == id) {
                return Err("Selected bot no longer exists.".into());
            }
        }
        let previous_store = guard.store.clone();
        guard.cancelled_chats.remove(&input.chat_id);

        let all_bots = guard.store.bots.clone();
        let active_project = guard
            .store
            .chats
            .iter()
            .find(|c| c.id == input.chat_id)
            .and_then(|c| c.workspace_path.as_ref())
            .and_then(|path| guard.store.workspaces.iter().find(|w| &w.path == path))
            .cloned();

        let (mentioned_ids, is_all_mention) =
            extract_mentioned_bots(&trimmed_text, &all_bots, None);

        let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == input.chat_id) else {
            return Err(format!("Chat '{}' not found.", input.chat_id));
        };

        for mid in &mentioned_ids {
            if !chat.participant_bot_ids.contains(mid) {
                chat.participant_bot_ids.push(mid.clone());
            }
        }
        if chat.participant_bot_ids.len() > 1 && !chat.is_primary {
            chat.is_group = true;
        }

        let user_msg = ChatMessage {
            id: user_msg_id.clone(),
            role: "user".to_string(),
            author_bot_id: None,
            author_name: Some("You".to_string()),
            author_shape: None,
            author_color: None,
            cli_driver: None,
            model: None,
            text: trimmed_text.clone(),
            thinking: String::new(),
            tool_calls: Vec::new(),
            handoffs: Vec::new(),
            skill_slug: input.skill_slug.clone(),
            mentioned_bot_ids: mentioned_ids.clone(),
            worktree_path: None,
            duration_ms: None,
            cost_usd: None,
            usage_reported: false,
            model_reported: false,
            input_tokens: None,
            output_tokens: None,
            status: "complete".to_string(),
            created_at_ms: now_ms(),
        };
        chat.messages.push(user_msg);
        chat.updated_at_ms = now_ms();

        // Auto-title untitled sidechat from first user message
        if (chat.title == "New sidechat"
            || chat.title == "New Swarm Room"
            || chat.title == "Focused Thread")
            && chat.messages.len() <= 2
        {
            let clean_title: String = trimmed_text
                .lines()
                .next()
                .unwrap_or("Sidechat")
                .chars()
                .take(44)
                .collect();
            if !clean_title.trim().is_empty() {
                chat.title = clean_title.trim().to_string();
            }
        }

        let project_assigned_ids: Vec<String> = active_project
            .as_ref()
            .map(|p| p.assigned_bot_ids.clone())
            .unwrap_or_default();

        let target_bot_ids: Vec<String> = if fixed_target {
            vec![input
                .override_bot_id
                .clone()
                .ok_or("Choose a bot for this routine.")?]
        } else if is_all_mention
            || input.parallel_mode.unwrap_or(false)
            || trimmed_text.starts_with("/race ")
            || trimmed_text.starts_with("/swarm ")
            || trimmed_text.starts_with("/group ")
        {
            if chat.participant_bot_ids.len() > 1 {
                chat.participant_bot_ids.clone()
            } else if !project_assigned_ids.is_empty() {
                project_assigned_ids.clone()
            } else {
                all_bots
                    .iter()
                    .filter(|b| !b.is_primary)
                    .map(|b| b.id.clone())
                    .collect()
            }
        } else if !mentioned_ids.is_empty() {
            mentioned_ids
        } else if let Some(override_id) = &input.override_bot_id {
            vec![override_id.clone()]
        } else if chat.is_primary {
            if let Some(lead_id) = active_project
                .as_ref()
                .and_then(|p| p.lead_bot_id.clone())
                .filter(|id| all_bots.iter().any(|b| &b.id == id))
            {
                vec![lead_id]
            } else if let Some(first) = chat.participant_bot_ids.first() {
                vec![first.clone()]
            } else {
                vec!["bot-omni".to_string()]
            }
        } else if let Some(first) = chat.participant_bot_ids.first() {
            vec![first.clone()]
        } else {
            vec!["bot-omni".to_string()]
        };

        for tid in &target_bot_ids {
            if !chat.participant_bot_ids.contains(tid) {
                chat.participant_bot_ids.push(tid.clone());
            }
        }

        let mut unique_targets = HashSet::new();
        let resolved_bots: Vec<BotProfile> = target_bot_ids
            .iter()
            .filter(|id| unique_targets.insert((*id).clone()))
            .filter_map(|id| all_bots.iter().find(|b| &b.id == id).cloned())
            .map(|mut b| {
                if resolved_override_applies(&input, &b, &target_bot_ids) {
                    if let Some(m) = &input.override_model {
                        if !m.trim().is_empty() {
                            b.model = Some(m.clone());
                        }
                    }
                    if let Some(eff) = &input.override_effort {
                        if !eff.trim().is_empty() {
                            b.reasoning_effort = eff.clone();
                        }
                    }
                }
                b
            })
            .collect();

        let max_turns = chat.max_swarm_turns.clamp(1, 8);
        chat.is_group = chat.participant_bot_ids.len() > 1 && !chat.is_primary;
        let is_parallel = resolved_bots.len() > 1
            && (is_all_mention
                || input.parallel_mode.unwrap_or(false)
                || trimmed_text.starts_with("/race "));

        if resolved_bots.is_empty() {
            guard.store = previous_store;
            return Err("No valid bots are available for this chat.".into());
        }
        if let Err(error) = guard.persist() {
            guard.store = previous_store;
            return Err(error);
        }
        guard.active_workflows.insert(input.chat_id.clone());
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(input.chat_id.clone()),
        });

        (resolved_bots, is_parallel, max_turns)
    };

    // Spawn the multi-bot execution loop in the background so the RPC returns immediately
    let bg_state = state.clone();
    let chat_id = input.chat_id.clone();
    let skill_slug = input.skill_slug.clone();

    tokio::spawn(async move {
        run_swarm_workflow(
            bg_state,
            chat_id,
            trimmed_text,
            skill_slug,
            initial_bots,
            parallel_initial,
            max_swarm_turns,
        )
        .await;
    });

    Ok(user_msg_id)
}

// A model override belongs to the selected speaker, never to a different provider.
fn resolved_override_applies(
    input: &SendMessageInput,
    bot: &BotProfile,
    targets: &[String],
) -> bool {
    input
        .override_bot_id
        .as_ref()
        .map_or(targets.len() == 1, |id| id == &bot.id)
}

async fn run_swarm_workflow(
    state: SharedOmniState,
    chat_id: String,
    original_user_prompt: String,
    skill_slug: Option<String>,
    initial_bots: Vec<BotProfile>,
    parallel_initial: bool,
    max_swarm_turns: u32,
) {
    let mut current_wave = initial_bots;
    let mut run_in_parallel = parallel_initial;
    let mut bot_turn_counts = HashMap::new();
    let mut seen_handoff_edges = HashSet::new();
    let mut incoming_handoff_notes: HashMap<String, String> = HashMap::new();
    let mut cumulative_cost_usd = 0.0;
    let (prevent_loops, max_parallel, workflow_budget) = state
        .read()
        .map(|g| {
            (
                g.store.preferences.prevent_handoff_loops,
                g.store.preferences.max_parallel_bots.clamp(1, 6) as usize,
                g.store.preferences.max_turn_budget_usd * 2.5,
            )
        })
        .unwrap_or((true, 1, 0.0));

    for hop in 0..max_swarm_turns {
        if current_wave.is_empty() || is_cancelled(&state, &chat_id) {
            break;
        }
        let mut next_ids = Vec::new();
        let mut next_notes: HashMap<String, String> = HashMap::new();
        let mut next_parallel = false;
        // Parallel peers see the same committed transcript, not partial streaming replies.
        let wave_history_end = state
            .read()
            .ok()
            .and_then(|g| {
                g.store
                    .chats
                    .iter()
                    .find(|c| c.id == chat_id)
                    .map(|c| c.messages.len())
            })
            .unwrap_or(0);
        let concurrency = if run_in_parallel { max_parallel } else { 1 };
        for batch in current_wave.chunks(concurrency) {
            if is_cancelled(&state, &chat_id) {
                break;
            }
            if cumulative_cost_usd >= workflow_budget {
                workflow_notice(
                    &state,
                    &chat_id,
                    "Swarm stopped: reported workflow cost reached the budget limit.",
                );
                break;
            }
            let history_end = if run_in_parallel {
                wave_history_end
            } else {
                state
                    .read()
                    .ok()
                    .and_then(|g| {
                        g.store
                            .chats
                            .iter()
                            .find(|c| c.id == chat_id)
                            .map(|c| c.messages.len())
                    })
                    .unwrap_or(0)
            };
            let mut turns = Vec::new();
            for bot in batch {
                *bot_turn_counts.entry(bot.id.clone()).or_insert(0) += 1;
                turns.push(run_single_bot_step(
                    state.clone(),
                    chat_id.clone(),
                    bot.clone(),
                    StepContext {
                        original_user_prompt: original_user_prompt.clone(),
                        skill_slug: if hop == 0 { skill_slug.clone() } else { None },
                        hop,
                        incoming_handoff_note: incoming_handoff_notes.get(&bot.id).cloned(),
                        history_end,
                    },
                ));
            }
            for result in futures_util::future::join_all(turns).await {
                cumulative_cost_usd += result.cost_usd.unwrap_or(0.0);
                for (from_bot, handoff) in result.handoffs {
                    if is_cancelled(&state, &chat_id) {
                        break;
                    }
                    if hop + 1 >= max_swarm_turns {
                        workflow_notice(
                            &state,
                            &chat_id,
                            "Swarm round limit reached; further handoffs were not scheduled.",
                        );
                        break;
                    }
                    if let Some(handoff) = filter_handoff_against_loops(
                        &from_bot.id,
                        handoff,
                        &bot_turn_counts,
                        &mut seen_handoff_edges,
                        prevent_loops,
                    ) {
                        record_handoff_on_message(&state, &chat_id, &from_bot.id, &handoff);
                        next_parallel |= handoff.mode == "parallel";
                        for id in handoff.to_bot_ids {
                            let note = next_notes.entry(id.clone()).or_default();
                            if !note.is_empty() {
                                note.push_str("\n\n");
                            }
                            note.push_str(&format!("From @{}: {}", from_bot.name, handoff.note));
                            if !next_ids.contains(&id) {
                                next_ids.push(id);
                            }
                        }
                    }
                }
            }
        }
        if cumulative_cost_usd >= workflow_budget {
            break;
        }
        if let Ok(mut guard) = state.write() {
            if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
                for id in &next_ids {
                    if !chat.participant_bot_ids.contains(id) {
                        chat.participant_bot_ids.push(id.clone());
                    }
                }
                chat.is_group = chat.participant_bot_ids.len() > 1 && !chat.is_primary;
            }
            current_wave = next_ids
                .iter()
                .filter_map(|id| guard.store.bots.iter().find(|b| &b.id == id).cloned())
                .collect();
        } else {
            break;
        }
        incoming_handoff_notes = next_notes;
        run_in_parallel = next_parallel;
    }
    if let Ok(mut guard) = state.write() {
        guard.active_workflows.remove(&chat_id);
        guard.cancelled_chats.remove(&chat_id);
        let _ = guard.persist();
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(chat_id),
        });
    }
}

fn workflow_notice(state: &SharedOmniState, chat_id: &str, text: &str) {
    if let Ok(mut guard) = state.write() {
        if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
            if let Some(mut message) = chat.messages.iter().find(|m| m.role == "user").cloned() {
                message.id = uuid::Uuid::new_v4().to_string();
                message.role = "system".into();
                message.author_name = Some("Swarm coordinator".into());
                message.text = text.into();
                message.mentioned_bot_ids.clear();
                message.skill_slug = None;
                message.created_at_ms = now_ms();
                chat.messages.push(message);
            }
        }
    }
}

fn filter_handoff_against_loops(
    from_bot_id: &str,
    mut handoff: HandoffEvent,
    bot_turn_counts: &HashMap<String, u32>,
    seen_edges: &mut HashSet<(String, String)>,
    prevent_loops: bool,
) -> Option<HandoffEvent> {
    if !prevent_loops {
        return Some(handoff);
    }

    let mut allowed_ids = Vec::new();
    let mut allowed_names = Vec::new();

    for (idx, to_id) in handoff.to_bot_ids.iter().enumerate() {
        let count = bot_turn_counts.get(to_id).copied().unwrap_or(0);
        let edge = (from_bot_id.to_string(), to_id.clone());
        // Allow at most 2 turns per Bot in a single autonomous chain and prevent repeating the same directed edge
        if count < 2 && !seen_edges.contains(&edge) {
            seen_edges.insert(edge);
            allowed_ids.push(to_id.clone());
            if let Some(name) = handoff.to_bot_names.get(idx) {
                allowed_names.push(name.clone());
            }
        }
    }

    if allowed_ids.is_empty() {
        return None;
    }

    handoff.to_bot_ids = allowed_ids;
    handoff.to_bot_names = allowed_names;
    Some(handoff)
}

struct SingleBotStepResult {
    cost_usd: Option<f64>,
    handoffs: Vec<(BotProfile, HandoffEvent)>,
}

struct StepContext {
    original_user_prompt: String,
    skill_slug: Option<String>,
    hop: u32,
    incoming_handoff_note: Option<String>,
    history_end: usize,
}

async fn run_single_bot_step(
    state: SharedOmniState,
    chat_id: String,
    mut bot: BotProfile,
    context: StepContext,
) -> SingleBotStepResult {
    let StepContext {
        original_user_prompt,
        skill_slug,
        hop,
        incoming_handoff_note,
        history_end,
    } = context;
    let msg_id = format!("msg_a_{}", uuid::Uuid::new_v4());

    // Prepare placeholder streaming message & build delta-aware context
    if is_cancelled(&state, &chat_id) {
        return SingleBotStepResult {
            cost_usd: None,
            handoffs: Vec::new(),
        };
    }
    let prep = {
        let Ok(mut guard) = state.write() else {
            return SingleBotStepResult {
                cost_usd: None,
                handoffs: Vec::new(),
            };
        };
        let prefs = guard.store.preferences.clone();

        let global_instructions = prefs.global_instructions.clone();
        let shared_memories = prefs.shared_memories.clone();
        let data_dir = guard.data_dir.clone();
        let max_context_messages = prefs.max_context_messages.clamp(2, 24) as usize;
        let max_message_chars = prefs.max_message_chars.clamp(400, 6000);
        let turn_timeout_secs = prefs.turn_timeout_secs.clamp(30, 1800);
        let max_turn_budget_usd = Some(prefs.max_turn_budget_usd);
        let only_explicit_handoffs = prefs.only_explicit_handoffs;

        let all_bots = guard.store.bots.clone();
        let skills = guard.skills.clone();
        let workspaces = guard.store.workspaces.clone();

        let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) else {
            return SingleBotStepResult {
                cost_usd: None,
                handoffs: Vec::new(),
            };
        };

        let active_project = chat
            .workspace_path
            .as_ref()
            .and_then(|path| workspaces.iter().find(|w| &w.path == path))
            .cloned();
        let is_home = chat.workspace_path.is_none();
        let approve_all = active_project.as_ref().is_some_and(|p| p.approve_all_tools);
        if is_home && bot.permission_mode == "bypassPermissions" {
            bot.permission_mode = "auto".into();
        }
        let base_ws = match &chat.workspace_path {
            Some(path) => Ok(path.clone()),
            None => crate::homes::bot_home(&data_dir, &bot.id),
        };
        let use_worktrees = !is_home
            && (chat.use_worktrees
                || active_project
                    .as_ref()
                    .is_some_and(|p| p.use_worktrees_default && chat.is_group));
        let worktree_result = base_ws.and_then(|base| {
            if use_worktrees {
                ensure_bot_worktree(&base, &chat_id, &bot.id)
            } else {
                Ok(base)
            }
        });
        let effective_cwd = worktree_result.clone().unwrap_or_default();

        let resume_sid = chat.native_sessions.get(&bot.id).cloned();
        let last_synced_idx = chat
            .last_synced_msg_index
            .get(&bot.id)
            .copied()
            .unwrap_or(0);

        let prior_end = history_end.min(chat.messages.len());
        let start = if resume_sid.is_some() {
            last_synced_idx.min(prior_end)
        } else {
            0
        };
        let mut history = chat.messages[start..prior_end].to_vec();
        if hop == 0 {
            // The triggering request is passed separately. Later sequential peers must
            // retain earlier bot replies rather than blindly removing the last message.
            if let Some(index) = history.iter().rposition(|m| m.role == "user") {
                history.remove(index);
            }
        }
        if resume_sid.is_some() {
            history.retain(|m| m.author_bot_id.as_deref() != Some(&bot.id));
        }
        let recent_history =
            build_recent_transcript(&history, &bot.id, max_context_messages, max_message_chars);

        // Build prompt for this turn
        let turn_prompt = if hop == 0 && recent_history.is_empty() {
            original_user_prompt.clone()
        } else if hop == 0 {
            let header = if resume_sid.is_some() && last_synced_idx > 0 {
                "Messages from other Bots/User in this room since your last turn:"
            } else {
                "Recent conversation context:"
            };
            format!(
                "{header}\n{}\n\nLatest user request:\n{}",
                recent_history, original_user_prompt
            )
        } else {
            let note_section = incoming_handoff_note
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .map(|n| format!("\nDirect Handoff Instructions for @{}: {}\n", bot.name, n))
                .unwrap_or_default();
            format!(
                "Multi-Bot Swarm Handoff (Hop #{}).\nOriginal user goal:\n{}{}\nRecent Bot conversation & handoff to you (@{}):\n{}\n\nNow respond as @{} ({}) and execute your part of the task. Do not hand back to the previous Bot unless new verification is strictly required.",
                hop + 1,
                original_user_prompt,
                note_section,
                bot.name,
                recent_history,
                bot.name,
                bot.role_title
            )
        };

        // Build system context with project instructions, teammate roster & optional skill
        let mut sys_parts = Vec::new();
        sys_parts.push(format!(
            "You are @{} ({}), running inside Omnibot on macOS via the `{}` CLI harness.",
            bot.name,
            bot.role_title,
            bot.cli_driver.as_str()
        ));
        if !bot.system_prompt.trim().is_empty() {
            sys_parts.push(bot.system_prompt.trim().to_string());
        }
        if let Some(proj) = &active_project {
            if !proj.instructions.trim().is_empty() {
                sys_parts.push(format!(
                    "Project Instructions ({} at `{}`):\n{}",
                    proj.name,
                    proj.path,
                    proj.instructions.trim()
                ));
            }
        }
        if !global_instructions.trim().is_empty() {
            sys_parts.push(format!(
                "Global instructions: {}",
                global_instructions.trim()
            ));
        }
        if !shared_memories.is_empty() {
            sys_parts.push(format!(
                "User preferences shared with all bots:\n- {}",
                shared_memories.join("\n- ")
            ));
        }
        if !bot.memories.is_empty() {
            sys_parts.push(format!(
                "Your personal memory ({}):\n- {}",
                bot.name,
                bot.memories.join("\n- ")
            ));
        }
        if let Some(project) = &active_project {
            if !project.memories.is_empty() {
                sys_parts.push(format!(
                    "Memory for this project only ({}):\n- {}",
                    project.name,
                    project.memories.join("\n- ")
                ));
            }
        }
        if is_home {
            sys_parts.push("This is an ongoing conversation with your user, without a fixed project. Your default working directory is your own local home. Help with any task supported by your tools, including research, writing, coding, file work, and coordination. Act on the user's explicit requests and named folders within the configured tool permissions. A saved project is optional; offer it when persistent workspace context would help. Do not infer an unrelated project or scan unrelated folders. Persistent memory is managed in the app's Memory screen; do not claim to remember a fact permanently unless it has been saved there.".into());
        } else {
            sys_parts.push(format!("Work only in this chat's selected folder: {effective_cwd}. Other chats may use different projects. Project decisions belong in project memory, not global preferences."));
        }

        // Filter teammate roster to Project's assigned Bots (if configured) plus current chat participants
        let project_assigned = active_project
            .as_ref()
            .map(|p| p.assigned_bot_ids.clone())
            .unwrap_or_default();

        let roster_lines: Vec<String> = all_bots
            .iter()
            .filter(|b| {
                b.id != bot.id
                    && (project_assigned.is_empty()
                        || project_assigned.contains(&b.id)
                        || chat.participant_bot_ids.contains(&b.id))
            })
            .map(|b| {
                format!(
                    "- @{} ({}, powered by `{}` CLI)",
                    b.name,
                    b.role_title,
                    b.cli_driver.as_str()
                )
            })
            .collect();
        if !roster_lines.is_empty() {
            sys_parts.push(format!(
                "Teammate Bots available in this project:\n{}\n\nBot-to-Bot Collaboration Protocol:\nIf the user asks you to coordinate with, ask, or hand off work to another Bot (or if another Bot's review/implementation is needed next), include `<handoff to=\"BotName\" mode=\"sequential\">Specific instructions for that Bot</handoff>` at the end of your response. Use one standalone handoff block per task, outside code fences. Address a teammate by its exact name or slug. Include the task, relevant files, completed work, and acceptance criteria. When using isolated worktrees, mention your worktree path and any commit hashes; teammates do not automatically share your changes. Only trigger a handoff when helpful or requested; never hand off just to acknowledge completion.",
                roster_lines.join("\n")
            ));
        }

        if let Some(slug) = &skill_slug {
            if let Some(skill) = skills.iter().find(|s| &s.slug == slug) {
                if let Ok(skill_body) = fs::read_to_string(&skill.path) {
                    let snippet: String = skill_body.chars().take(4500).collect();
                    sys_parts.push(format!(
                        "Active Skill `/{}` ({}):\n{}",
                        skill.slug, skill.name, snippet
                    ));
                }
            }
        }

        let placeholder = ChatMessage {
            id: msg_id.clone(),
            role: "assistant".to_string(),
            author_bot_id: Some(bot.id.clone()),
            author_name: Some(bot.name.clone()),
            author_shape: Some(bot.shape.clone()),
            author_color: Some(bot.color.clone()),
            cli_driver: Some(bot.cli_driver),
            model: bot.model.clone(),
            text: String::new(),
            thinking: String::new(),
            tool_calls: Vec::new(),
            handoffs: Vec::new(),
            skill_slug: None,
            mentioned_bot_ids: Vec::new(),
            worktree_path: if use_worktrees {
                Some(effective_cwd.clone())
            } else {
                None
            },
            duration_ms: None,
            cost_usd: None,
            usage_reported: false,
            model_reported: false,
            input_tokens: None,
            output_tokens: None,
            status: "streaming".to_string(),
            created_at_ms: now_ms(),
        };
        chat.messages.push(placeholder);
        chat.updated_at_ms = now_ms();

        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(chat_id.clone()),
        });

        (
            turn_prompt,
            sys_parts.join("\n\n"),
            effective_cwd,
            resume_sid,
            approve_all,
            turn_timeout_secs,
            max_turn_budget_usd,
            only_explicit_handoffs,
            all_bots,
            worktree_result.err(),
        )
    };

    let (
        prompt,
        system_context,
        cwd,
        resume_session_id,
        approve_all,
        turn_timeout_secs,
        max_budget_usd,
        only_explicit_handoffs,
        all_bots,
        worktree_error,
    ) = prep;

    if let Some(error) = worktree_error {
        if let Ok(mut guard) = state.write() {
            if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
                if let Some(message) = chat.messages.iter_mut().find(|m| m.id == msg_id) {
                    message.status = "error".into();
                    message.text = format!("Could not prepare this bot’s workspace: {error}");
                    message.worktree_path = None;
                }
            }
        }
        return SingleBotStepResult {
            cost_usd: None,
            handoffs: Vec::new(),
        };
    }

    let had_resume = resume_session_id.is_some();

    let output = execute_bot_turn(
        state.clone(),
        DriverTurnRequest {
            chat_id: chat_id.clone(),
            message_id: msg_id.clone(),
            bot: bot.clone(),
            prompt,
            system_context,
            cwd,
            resume_session_id,
            approve_all,
            turn_timeout_secs,
            max_budget_usd,
        },
    )
    .await;

    // Update native session ID & synced message index for future delta-only `--resume`
    if let Ok(mut guard) = state.write() {
        if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
            if output.status != "complete" && had_resume {
                // Clear stale native session so next retry starts cleanly
                chat.native_sessions.remove(&bot.id);
                chat.last_synced_msg_index.remove(&bot.id);
            } else if output.status == "complete" {
                if let Some(sid) = &output.native_session_id {
                    chat.native_sessions.insert(bot.id.clone(), sid.clone());
                    chat.last_synced_msg_index
                        .insert(bot.id.clone(), history_end);
                }
            }
        }
    }

    if output.status != "complete" || output.text.trim().is_empty() {
        return SingleBotStepResult {
            cost_usd: output.cost_usd,
            handoffs: Vec::new(),
        };
    }

    // Parse any outgoing `<handoff to="...">` or actionable `@BotName` directive from this Bot's reply
    let handoffs = parse_bot_handoffs(&bot, &output.text, &all_bots, only_explicit_handoffs)
        .into_iter()
        .map(|h| (bot.clone(), h))
        .collect();

    SingleBotStepResult {
        cost_usd: output.cost_usd,
        handoffs,
    }
}

fn build_recent_transcript(
    messages: &[ChatMessage],
    current_bot_id: &str,
    max_messages: usize,
    max_chars_per_msg: usize,
) -> String {
    let completed: Vec<&ChatMessage> = messages
        .iter()
        .filter(|m| m.status == "complete" && !m.text.trim().is_empty())
        .collect();
    let len = completed.len();
    let slice = if len > max_messages {
        &completed[len - max_messages..]
    } else {
        &completed[..]
    };
    let mut lines = Vec::new();
    for m in slice {
        let speaker = if m.role == "user" {
            "User".to_string()
        } else {
            let name = m.author_name.as_deref().unwrap_or("Bot");
            if m.author_bot_id.as_deref() == Some(current_bot_id) {
                format!("@{name} (you)")
            } else {
                format!("@{name}")
            }
        };
        let clean = m
            .text
            .replace("</handoff>", "")
            .chars()
            .take(max_chars_per_msg)
            .collect::<String>();
        let tool_note = if !m.tool_calls.is_empty() {
            let names: Vec<&str> = m
                .tool_calls
                .iter()
                .take(4)
                .map(|t| t.name.as_str())
                .collect();
            format!(" [ran tools: {}]", names.join(", "))
        } else {
            String::new()
        };
        let workspace_note = m
            .worktree_path
            .as_ref()
            .map(|p| format!(" [worktree: {p}]"))
            .unwrap_or_default();
        lines.push(format!("[{speaker}{tool_note}{workspace_note}]: {clean}"));
    }
    lines.join("\n\n")
}

fn extract_mentioned_bots(
    text: &str,
    all_bots: &[BotProfile],
    exclude_bot_id: Option<&str>,
) -> (Vec<String>, bool) {
    let lower = text.to_lowercase();
    let is_all = ["@all", "@everyone", "@swarm"]
        .iter()
        .any(|token| contains_mention_token(&lower, token));

    let mut found = Vec::new();
    for b in all_bots {
        if exclude_bot_id == Some(b.id.as_str()) {
            continue;
        }
        let name_tok = format!("@{}", b.name.to_lowercase());
        let slug_tok = format!("@{}", b.slug.to_lowercase());
        if (contains_mention_token(&lower, &name_tok) || contains_mention_token(&lower, &slug_tok))
            && !found.contains(&b.id)
        {
            found.push(b.id.clone());
        }
    }
    (found, is_all)
}

fn contains_mention_token(haystack_lower: &str, token_lower: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = haystack_lower[start..].find(token_lower) {
        let abs = start + pos;
        let before_ok = abs == 0
            || !haystack_lower[..abs]
                .chars()
                .last()
                .is_some_and(|c| c.is_alphanumeric());
        let after_idx = abs + token_lower.len();
        let after_ok = after_idx >= haystack_lower.len()
            || !haystack_lower[after_idx..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || c == '-' || c == '_');
        if before_ok && after_ok {
            return true;
        }
        start = after_idx;
    }
    false
}

fn parse_bot_handoffs(
    speaking_bot: &BotProfile,
    reply_text: &str,
    all_bots: &[BotProfile],
    only_explicit_handoffs: bool,
) -> Vec<HandoffEvent> {
    // Quoted examples and code are data, not executable routing instructions.
    let mut fence: Option<char> = None;
    let actionable = reply_text
        .lines()
        .filter(|line| {
            let line = line.trim();
            if line.starts_with("```") || line.starts_with("~~~") {
                let marker = line.chars().next().unwrap();
                if fence == Some(marker) {
                    fence = None;
                } else if fence.is_none() {
                    fence = Some(marker);
                }
                return false;
            }
            fence.is_none() && !line.starts_with('>')
        })
        .collect::<Vec<_>>()
        .join("\n");
    let reply_text = actionable.as_str();
    let mut handoffs = Vec::new();
    let mut remaining = reply_text;
    while let Some(open) = remaining.find("<handoff ") {
        let prefix = &remaining[..open];
        let rest = &remaining[open + 9..];
        let Some(end) = rest.find('>') else {
            break;
        };
        let Some(close) = rest[end + 1..].find("</handoff>") else {
            break;
        };
        let body_end = end + 1 + close;
        let note = rest[end + 1..body_end].trim();
        let header = &rest[..end];
        remaining = &rest[body_end + 10..];
        // Only a standalone directive is actionable, never an inline example.
        if !prefix.rsplit('\n').next().unwrap_or("").trim().is_empty() || note.is_empty() {
            continue;
        }
        let Some(attributes) = shlex::split(header) else {
            continue;
        };
        let target = attributes.iter().find_map(|a| a.strip_prefix("to="));
        let mode = attributes
            .iter()
            .find_map(|a| a.strip_prefix("mode="))
            .unwrap_or("sequential");
        if !matches!(mode, "parallel" | "sequential") {
            continue;
        }
        let Some(target) = target else {
            continue;
        };
        let mut targets = Vec::new();
        for name in target.split(',').map(|s| s.trim().trim_start_matches('@')) {
            let matches: Vec<_> = all_bots
                .iter()
                .filter(|b| {
                    b.id != speaking_bot.id
                        && (b.name.eq_ignore_ascii_case(name)
                            || b.slug.eq_ignore_ascii_case(name)
                            || b.id == name)
                })
                .collect();
            if matches.len() == 1 && !targets.iter().any(|b: &&BotProfile| b.id == matches[0].id) {
                targets.push(matches[0]);
            }
        }
        if !targets.is_empty() {
            handoffs.push(HandoffEvent {
                from_bot_id: speaking_bot.id.clone(),
                from_bot_name: speaking_bot.name.clone(),
                to_bot_ids: targets.iter().map(|b| b.id.clone()).collect(),
                to_bot_names: targets.iter().map(|b| b.name.clone()).collect(),
                mode: mode.into(),
                note: note.chars().take(6000).collect(),
            });
        }
    }
    if !handoffs.is_empty() || only_explicit_handoffs {
        return handoffs;
    }

    // 2. Otherwise check the last 6 lines for an explicit directive handoff to another @Bot
    let tail_lines: Vec<&str> = reply_text
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut directive_lines = Vec::new();
    for line in &tail_lines {
        let l_trim = line.trim().to_lowercase();
        // Ignore passive acknowledgements ("thanks @Bot", "agree with @Bot", "@Bot's findings")
        if l_trim.contains("thanks @")
            || l_trim.contains("thank you @")
            || l_trim.contains("agree with @")
            || l_trim.contains("'s findings")
            || l_trim.contains("'s changes")
        {
            continue;
        }
        let is_directive = l_trim.starts_with('@')
            || l_trim.starts_with("- @")
            || l_trim.starts_with("* @")
            || l_trim.contains("hand off to @")
            || l_trim.contains("handing off to @")
            || l_trim.contains("passing to @")
            || l_trim.contains("pass to @")
            || l_trim.contains("over to @")
            || l_trim.contains("delegate to @")
            || l_trim.contains("ask @");
        if is_directive {
            directive_lines.push(*line);
        }
    }

    if directive_lines.is_empty() {
        return Vec::new();
    }

    let joined_directives = directive_lines.join("\n");
    let (mentioned_ids, _) =
        extract_mentioned_bots(&joined_directives, all_bots, Some(speaking_bot.id.as_str()));
    if mentioned_ids.is_empty() {
        return Vec::new();
    }

    let mut to_names = Vec::new();
    let mut clean_ids = HashSet::new();
    let mut ordered_ids = Vec::new();
    for id in mentioned_ids {
        if clean_ids.insert(id.clone()) {
            if let Some(b) = all_bots.iter().find(|x| x.id == id) {
                to_names.push(b.name.clone());
                ordered_ids.push(b.id.clone());
            }
        }
    }

    vec![HandoffEvent {
        from_bot_id: speaking_bot.id.clone(),
        from_bot_name: speaking_bot.name.clone(),
        to_bot_ids: ordered_ids.clone(),
        to_bot_names: to_names,
        mode: if ordered_ids.len() > 1 {
            "parallel".to_string()
        } else {
            "sequential".to_string()
        },
        note: joined_directives.chars().take(240).collect(),
    }]
}

fn record_handoff_on_message(
    state: &SharedOmniState,
    chat_id: &str,
    from_bot_id: &str,
    handoff: &HandoffEvent,
) {
    let Ok(mut guard) = state.write() else {
        return;
    };
    let mut target_msg_id = String::new();
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
        if let Some(msg) = chat
            .messages
            .iter_mut()
            .rev()
            .find(|m| m.author_bot_id.as_deref() == Some(from_bot_id))
        {
            target_msg_id = msg.id.clone();
            msg.handoffs.push(handoff.clone());
        }
    }
    guard.emit(OmniStreamEvent::Handoff {
        chat_id: chat_id.to_string(),
        message_id: target_msg_id,
        handoff: handoff.clone(),
    });
}

fn is_cancelled(state: &SharedOmniState, chat_id: &str) -> bool {
    state
        .read()
        .map(|g| g.cancelled_chats.contains(chat_id))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{bot, input, Fixture};

    #[test]
    fn mentions_match_whole_tokens() {
        let bots = vec![bot("Pi"), bot("Piper")];
        assert_eq!(
            extract_mentioned_bots("@Piper hello", &bots, None).0,
            vec!["Piper"]
        );
        assert!(!extract_mentioned_bots("x@all.com @alloy @everyone_else", &bots, None).1);
        assert!(extract_mentioned_bots("Hi @all!", &bots, None).1);
    }

    #[test]
    fn explicit_handoffs_are_exact_and_preserve_full_instructions() {
        let bots = vec![bot("Lead"), bot("Pi"), bot("Piper")];
        let note = "Check the complete specification. ".repeat(30);
        let text = format!("<handoff to=\"Piper\" mode=\"parallel\">{note}</handoff>\n<handoff to=\"Pi\">Check tests</handoff>");
        let handoffs = parse_bot_handoffs(&bots[0], &text, &bots, true);
        assert_eq!(handoffs.len(), 2);
        assert_eq!(handoffs[0].to_bot_ids, vec!["Piper"]);
        assert_eq!(handoffs[0].note, note.trim());
        assert_eq!(handoffs[1].to_bot_ids, vec!["Pi"]);
    }

    #[test]
    fn examples_malformed_and_self_handoffs_do_not_execute() {
        let bots = vec![bot("Lead"), bot("Pi")];
        for text in [
            "```xml\n<handoff to=\"Pi\">Go</handoff>\n```",
            "> <handoff to=\"Pi\">Go</handoff>",
            "Example: `<handoff to=\"Pi\">Go</handoff>`",
            "<handoff to=\"Pi\">unfinished",
            "<handoff to=\"Lead\">Go</handoff>",
            "<handoff to=\"unknown\">Ask @Pi</handoff>",
            "@Pi did excellent work",
        ] {
            assert!(
                parse_bot_handoffs(&bots[0], text, &bots, true).is_empty(),
                "{text}"
            );
        }
    }

    #[test]
    fn repeated_edges_and_exhausted_bots_are_blocked() {
        let bots = vec![bot("A"), bot("B")];
        let handoff =
            parse_bot_handoffs(&bots[0], "<handoff to=\"B\">Review</handoff>", &bots, true)
                .remove(0);
        let mut edges = HashSet::new();
        assert!(filter_handoff_against_loops(
            "A",
            handoff.clone(),
            &HashMap::new(),
            &mut edges,
            true
        )
        .is_some());
        assert!(filter_handoff_against_loops(
            "A",
            handoff.clone(),
            &HashMap::new(),
            &mut edges,
            true
        )
        .is_none());
        assert!(filter_handoff_against_loops(
            "A",
            handoff,
            &HashMap::from([("B".into(), 2)]),
            &mut HashSet::new(),
            true
        )
        .is_none());
    }

    #[tokio::test]
    async fn sequential_peers_see_prior_output_and_chat_stays_pinned() {
        let f = Fixture::new(&["A", "B"]);
        f.script("A", "echo FIRST_BOT_RESULT");
        f.script("B", "printf '%s' \"$1\" > seen.txt\necho SECOND_BOT_RESULT");
        f.state.write().unwrap().store.preferences.workspace_root = "/does/not/exist".into();
        dispatch_chat_turn(f.state.clone(), input("/group Do work"))
            .await
            .unwrap();
        f.wait().await;
        let prompt = fs::read_to_string(f.dir.join("seen.txt")).unwrap();
        assert!(prompt.contains("FIRST_BOT_RESULT"));
        let g = f.state.read().unwrap();
        assert_eq!(g.store.chats[0].workspace_path.as_deref(), f.dir.to_str());
        assert_eq!(
            g.store.chats[0]
                .messages
                .iter()
                .filter(|m| m.role == "assistant" && m.status == "complete")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn parallel_limit_batches_without_dropping_participants() {
        let f = Fixture::new(&["A", "B", "C", "D", "E"]);
        for name in ["A", "B", "C", "D", "E"] {
            f.script(name, "echo done");
        }
        dispatch_chat_turn(f.state.clone(), input("@all Work"))
            .await
            .unwrap();
        f.wait().await;
        let g = f.state.read().unwrap();
        assert_eq!(
            g.store.chats[0]
                .messages
                .iter()
                .filter(|m| m.role == "assistant")
                .count(),
            5
        );
    }

    #[tokio::test]
    async fn handoff_delivers_instructions_once_and_stops_at_round_limit() {
        let f = Fixture::new(&["A", "B"]);
        f.script("A", "echo '<handoff to=\"B\">VERIFY_THE_PATCH</handoff>'");
        f.script(
            "B",
            "printf '%s' \"$1\" > seen.txt\necho '<handoff to=\"A\">Review result</handoff>'",
        );
        f.state.write().unwrap().store.chats[0].max_swarm_turns = 2;
        dispatch_chat_turn(f.state.clone(), input("@A Start"))
            .await
            .unwrap();
        f.wait().await;
        assert!(fs::read_to_string(f.dir.join("seen.txt"))
            .unwrap()
            .contains("From @A: VERIFY_THE_PATCH"));
        let g = f.state.read().unwrap();
        assert_eq!(
            g.store.chats[0]
                .messages
                .iter()
                .filter(|m| m.role == "assistant")
                .count(),
            2
        );
        assert!(g.store.chats[0]
            .messages
            .iter()
            .any(|m| m.text.contains("round limit")));
    }

    #[tokio::test]
    async fn concurrent_send_and_live_chat_edits_are_rejected_then_stop_finishes() {
        let f = Fixture::new(&["A"]);
        // Closing both pipes must not disable cancellation while the process is alive.
        f.script("A", "exec 1>&- 2>&-\nsleep 30");
        dispatch_chat_turn(f.state.clone(), input("Start"))
            .await
            .unwrap();
        assert!(dispatch_chat_turn(f.state.clone(), input("Duplicate"))
            .await
            .is_err());
        assert!(crate::server::clear_chat_thread(&f.state, "room").is_err());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        crate::server::stop_chat_runs(&f.state, "room").unwrap();
        f.wait().await;
        assert!(f.state.read().unwrap().active_runs.is_empty());
        assert_eq!(
            f.state.read().unwrap().store.chats[0]
                .messages
                .last()
                .unwrap()
                .status,
            "stopped"
        );
    }

    #[tokio::test]
    async fn failed_cli_output_never_triggers_handoff() {
        let f = Fixture::new(&["A", "B"]);
        f.script(
            "A",
            "echo '<handoff to=\"B\">Do work</handoff>'\necho failure >&2\nexit 1",
        );
        f.script("B", "touch SHOULD_NOT_RUN");
        dispatch_chat_turn(f.state.clone(), input("@A Start"))
            .await
            .unwrap();
        f.wait().await;
        assert!(!f.dir.join("SHOULD_NOT_RUN").exists());
        assert_eq!(
            f.state.read().unwrap().store.chats[0]
                .messages
                .last()
                .unwrap()
                .status,
            "error"
        );
    }

    #[tokio::test]
    async fn native_resume_does_not_skip_parallel_peer_output() {
        let f = Fixture::new(&["A", "B"]);
        f.script("A", "printf '%s' \"$1\" > a-prompt.txt\necho '{\"type\":\"result\",\"session_id\":\"a-session\",\"result\":\"A_RESULT\"}'");
        f.script("B", "sleep 0.1\necho B_RESULT");
        dispatch_chat_turn(f.state.clone(), input("@all First"))
            .await
            .unwrap();
        f.wait().await;
        dispatch_chat_turn(f.state.clone(), input("@A Continue"))
            .await
            .unwrap();
        f.wait().await;
        let prompt = fs::read_to_string(f.dir.join("a-prompt.txt")).unwrap();
        assert!(prompt.contains("B_RESULT"));
        assert!(!prompt.contains("A_RESULT"));
    }
}
