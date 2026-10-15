use crate::drivers::{execute_bot_turn, DriverTurnRequest};
use crate::state::{
    now_ms, BotProfile, ChatMessage, HandoffEvent, OmniStreamEvent, SharedOmniState, WorkflowTask,
};
use crate::workflow::{enqueue_task, run_swarm_workflow, task_status, workflow_notice};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    #[serde(default)]
    pub summarize: bool,
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
    dispatch_turn(state, input, None).await
}

/// Saved routines keep their selected first speaker even when instructions mention teammates.
pub async fn dispatch_routine_turn(
    state: SharedOmniState,
    input: SendMessageInput,
    routine_id: String,
) -> Result<String, String> {
    dispatch_turn(state, input, Some(routine_id)).await
}

async fn dispatch_turn(
    state: SharedOmniState,
    input: SendMessageInput,
    routine_id: Option<String>,
) -> Result<String, String> {
    let fixed_target = routine_id.is_some();
    let mut trimmed_text = input.text.trim().to_string();
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
        let route = crate::routing::resolve(&guard.store, &input, fixed_target)?;
        let target_bot_ids = route.bot_ids;
        trimmed_text = route.prompt;
        if routine_id
            .as_ref()
            .is_some_and(|id| !guard.store.routines.iter().any(|r| &r.id == id))
        {
            return Err("Routine no longer exists".into());
        }
        let previous_store = guard.store.clone();
        guard.cancelled_chats.remove(&input.chat_id);

        let all_bots = guard.store.bots.clone();
        let (mentioned_ids, _) = extract_mentioned_bots(&trimmed_text, &all_bots, None);
        let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == input.chat_id) else {
            return Err(format!("Chat '{}' not found.", input.chat_id));
        };

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
                if let Some(model) = chat.model_overrides.get(&b.id) {
                    b.model = model.clone();
                }
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

        for bot in &resolved_bots {
            if let Err(error) = crate::execution::validate(bot)
                .and_then(|_| crate::drivers::validate_available(bot))
            {
                guard.store = previous_store;
                return Err(error);
            }
        }
        let chat = guard
            .store
            .chats
            .iter_mut()
            .find(|c| c.id == input.chat_id)
            .expect("validated chat");
        let max_turns = chat.max_swarm_turns.clamp(1, 8);
        chat.is_group = chat.participant_bot_ids.len() > 1 && !chat.is_primary && !chat.is_bot_home;
        let is_parallel = route.parallel;

        if resolved_bots.is_empty() {
            guard.store = previous_store;
            return Err("No valid bots are available for this chat.".into());
        }
        if let Some(id) = &routine_id {
            let routine = guard
                .store
                .routines
                .iter_mut()
                .find(|r| &r.id == id)
                .ok_or("Routine no longer exists")?;
            routine.workflow_id = Some(user_msg_id.clone());
            routine.run_status = Some("queued".into());
            routine.last_error = None;
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

    let workflow_id = user_msg_id.clone();
    tokio::spawn(async move {
        run_swarm_workflow(
            bg_state,
            chat_id,
            workflow_id,
            trimmed_text,
            skill_slug,
            initial_bots,
            parallel_initial,
            max_swarm_turns,
            input.summarize,
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

pub(crate) struct SingleBotStepResult {
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) cost_usd: Option<f64>,
    pub(crate) handoffs: Vec<(BotProfile, HandoffEvent)>,
}

pub(crate) struct StepContext {
    pub(crate) allow_handoffs: bool,
    pub(crate) task_id: String,
    pub(crate) original_user_prompt: String,
    pub(crate) skill_slug: Option<String>,
    pub(crate) hop: u32,
    pub(crate) incoming_handoff_note: Option<String>,
    pub(crate) history_end: usize,
}

pub(crate) async fn run_single_bot_step(
    state: SharedOmniState,
    chat_id: String,
    mut bot: BotProfile,
    context: StepContext,
) -> SingleBotStepResult {
    let StepContext {
        allow_handoffs,
        task_id,
        original_user_prompt,
        skill_slug,
        hop,
        incoming_handoff_note,
        history_end,
    } = context;
    if let Err(error) = crate::execution::validate(&bot) {
        return SingleBotStepResult {
            status: "error".into(),
            error: Some(error),
            cost_usd: None,
            handoffs: Vec::new(),
        };
    }
    let msg_id = format!("msg_a_{}", uuid::Uuid::new_v4());

    // Prepare placeholder streaming message & build delta-aware context
    if is_cancelled(&state, &chat_id) {
        return SingleBotStepResult {
            status: "stopped".into(),
            error: None,
            cost_usd: None,
            handoffs: Vec::new(),
        };
    }
    let worktree_result = crate::execution::workspace(&state, &chat_id, &bot.id).await;
    let prep = {
        let Ok(mut guard) = state.write() else {
            return SingleBotStepResult {
                status: "error".into(),
                error: Some("Could not access chat state.".into()),
                cost_usd: None,
                handoffs: Vec::new(),
            };
        };
        let prefs = guard.store.preferences.clone();

        let global_instructions = prefs.global_instructions.clone();
        let shared_memories = prefs.shared_memories.clone();
        let max_context_messages = prefs.max_context_messages.clamp(2, 24) as usize;
        let max_message_chars = prefs.max_message_chars.clamp(400, 6000);
        let turn_timeout_secs = prefs.turn_timeout_secs.clamp(30, 1800);
        let max_turn_budget_usd = Some(prefs.max_turn_budget_usd);
        let only_explicit_handoffs = prefs.only_explicit_handoffs;

        let all_bots = guard.store.bots.clone();
        let harness_identity = guard
            .harnesses
            .iter()
            .find(|h| h.kind == bot.cli_driver)
            .map(|h| (h.binary_path.clone(), h.version.clone()));
        let skills = guard.skills.clone();
        let workspaces = guard.store.workspaces.clone();

        let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) else {
            return SingleBotStepResult {
                status: "error".into(),
                error: Some("Could not access chat state.".into()),
                cost_usd: None,
                handoffs: Vec::new(),
            };
        };

        let active_project = chat
            .workspace_path
            .as_ref()
            .and_then(|path| workspaces.iter().find(|w| &w.path == path))
            .cloned();
        let eligible_ids = active_project
            .as_ref()
            .map(|p| p.assigned_bot_ids.clone())
            .unwrap_or_default();
        let all_bots: Vec<_> = all_bots
            .into_iter()
            .filter(|b| {
                !b.archived
                    && (b.id == bot.id
                        || chat.participant_bot_ids.contains(&b.id)
                        || eligible_ids.contains(&b.id))
            })
            .collect();
        let is_home = chat.workspace_path.is_none();
        let approve_all = active_project.as_ref().is_some_and(|p| p.approve_all_tools);
        if is_home && bot.permission_mode == "bypassPermissions" {
            bot.permission_mode = "auto".into();
        }
        let use_worktrees = !is_home
            && (chat.use_worktrees
                || active_project.as_ref().is_some_and(|p| {
                    p.use_worktrees_default && chat.participant_bot_ids.len() > 1
                }));
        let effective_cwd = worktree_result.clone().unwrap_or_default();

        let fingerprint = serde_json::json!({ "bot": bot, "harness": harness_identity, "cwd": effective_cwd, "project": active_project, "instructions": global_instructions, "shared": shared_memories,
            "roster": all_bots.iter().map(|b| (&b.id, &b.name, &b.slug)).collect::<Vec<_>>() }).to_string();
        if chat.session_contexts.get(&bot.id) != Some(&fingerprint) {
            chat.native_sessions.remove(&bot.id);
            chat.last_synced_msg_index.remove(&bot.id);
        }
        chat.session_contexts.insert(bot.id.clone(), fingerprint);
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
            status: "queued".to_string(),
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
            status: "error".into(),
            error: Some(error),
            cost_usd: None,
            handoffs: Vec::new(),
        };
    }

    let lease = crate::execution::acquire(state.clone(), &chat_id, &task_id, &cwd).await;
    let _lease = match lease {
        Ok(lease) => lease,
        Err(error) => {
            if let Ok(mut guard) = state.write() {
                if let Some(message) = guard
                    .store
                    .chats
                    .iter_mut()
                    .find(|c| c.id == chat_id)
                    .and_then(|c| c.messages.iter_mut().find(|m| m.id == msg_id))
                {
                    message.status = "stopped".into();
                }
            }
            return SingleBotStepResult {
                status: "stopped".into(),
                error: Some(error),
                cost_usd: None,
                handoffs: Vec::new(),
            };
        }
    };
    if let Ok(mut guard) = state.write() {
        if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
            if let Some(message) = chat.messages.iter_mut().find(|m| m.id == msg_id) {
                message.status = "streaming".into();
            }
            if let Some(task) = chat.tasks.iter_mut().find(|t| t.id == task_id) {
                task.workspace_path = Some(cwd.clone());
            }
        }
    }
    task_status(&state, &chat_id, &task_id, "running", None);
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

    if output.status != "complete" || output.text.trim().is_empty() || !allow_handoffs {
        return SingleBotStepResult {
            status: output.status.clone(),
            error: (output.status != "complete").then(|| output.text.clone()),
            cost_usd: output.cost_usd,
            handoffs: Vec::new(),
        };
    }

    // Parse any outgoing `<handoff to="...">` or actionable `@BotName` directive from this Bot's reply
    let handoffs: Vec<_> =
        parse_bot_handoffs(&bot, &output.text, &all_bots, only_explicit_handoffs)
            .into_iter()
            .map(|h| (bot.clone(), h))
            .collect();

    let actionable = crate::routing::actionable_text(&output.text);
    let mut unresolved = Vec::new();
    for line in actionable
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("<handoff "))
    {
        if let Some((header, _)) = line[9..].split_once('>') {
            if let Some(attributes) = shlex::split(header) {
                if let Some(target) = attributes.iter().find_map(|a| a.strip_prefix("to=")) {
                    for name in target
                        .split(',')
                        .map(|name| name.trim().trim_start_matches('@'))
                    {
                        let count = all_bots
                            .iter()
                            .filter(|b| {
                                b.id != bot.id
                                    && (b.name.eq_ignore_ascii_case(name)
                                        || b.slug.eq_ignore_ascii_case(name)
                                        || b.id == name)
                            })
                            .count();
                        if count != 1 {
                            unresolved.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    for recipient in unresolved {
        let workflow_id = state
            .read()
            .ok()
            .and_then(|g| {
                g.store
                    .chats
                    .iter()
                    .find(|c| c.id == chat_id)
                    .and_then(|c| {
                        c.tasks
                            .iter()
                            .find(|t| t.id == task_id)
                            .map(|t| t.workflow_id.clone())
                    })
            })
            .unwrap_or_default();
        enqueue_task(&state, &chat_id, WorkflowTask { id: uuid::Uuid::new_v4().to_string(), workflow_id, bot_id: recipient,
            from_bot_id: Some(bot.id.clone()), instructions: "Unresolved handoff".into(), mode: "sequential".into(), status: "skipped".into(),
            reason: Some("Recipient is missing, ambiguous, archived, or outside this conversation's team.".into()), workspace_path: None });
    }
    if handoffs.is_empty() && crate::routing::actionable_text(&output.text).contains("<handoff ") {
        workflow_notice(&state, &chat_id, "Handoff skipped: use a complete standalone block addressed to an eligible teammate's exact handle.");
    }
    SingleBotStepResult {
        status: output.status,
        error: None,
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
    crate::routing::mentions(text, all_bots, exclude_bot_id)
}

fn parse_bot_handoffs(
    speaking_bot: &BotProfile,
    reply_text: &str,
    all_bots: &[BotProfile],
    only_explicit_handoffs: bool,
) -> Vec<HandoffEvent> {
    // Quoted examples and code are data, not executable routing instructions.
    let actionable = crate::routing::unquoted_text(reply_text);
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
                    !b.archived
                        && b.id != speaking_bot.id
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

pub(crate) fn record_handoff_on_message(
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

pub(crate) fn is_cancelled(state: &SharedOmniState, chat_id: &str) -> bool {
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
        let handoffs: Vec<_> = parse_bot_handoffs(&bots[0], &text, &bots, true);
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
            "    <handoff to=\"Pi\">Go</handoff>",
            "````xml\n```\n<handoff to=\"Pi\">Go</handoff>\n````",
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

#[cfg(test)]
mod workflow_regressions {
    use super::*;
    use crate::test_support::{input, Fixture};

    #[tokio::test]
    async fn duplicate_handoffs_are_visible_and_optional_summary_runs_once() {
        let f = Fixture::new(&["A", "B"]);
        f.script("A", "echo '<handoff to=\"B\">Review once</handoff>'\necho '<handoff to=\"B\">Review once</handoff>'");
        f.script("B", "echo reviewed");
        let mut request = input("@A Begin");
        request.summarize = true;
        dispatch_chat_turn(f.state.clone(), request).await.unwrap();
        f.wait().await;
        let g = f.state.read().unwrap();
        let tasks = &g.store.chats[0].tasks;
        assert_eq!(
            tasks
                .iter()
                .filter(|t| t.bot_id == "B" && t.status == "complete")
                .count(),
            1
        );
        assert_eq!(tasks.iter().filter(|t| t.status == "skipped").count(), 1);
        assert_eq!(
            tasks
                .iter()
                .filter(|t| t.mode == "summary" && t.status == "complete")
                .count(),
            1
        );
        assert_eq!(tasks.len(), 4);
    }
    #[tokio::test]
    async fn mixed_modes_and_distinct_same_recipient_tasks_keep_their_instructions() {
        let f = Fixture::new(&["A", "B", "C", "D"]);
        f.script("A", "echo '<handoff to=\"B,C\" mode=\"sequential\">FIRST_TASK</handoff>'\necho '<handoff to=\"D\" mode=\"parallel\">INDEPENDENT_TASK</handoff>'\necho '<handoff to=\"B\" mode=\"sequential\">SECOND_TASK</handoff>'");
        f.script("B", "printf '%s\\n' \"$1\" >> b-prompts\necho B_FINISHED");
        f.script("C", "printf '%s' \"$1\" > c-prompt\necho C_FINISHED");
        f.script("D", "echo D_FINISHED");
        dispatch_chat_turn(f.state.clone(), input("@A Begin"))
            .await
            .unwrap();
        f.wait().await;
        assert!(fs::read_to_string(f.dir.join("c-prompt"))
            .unwrap()
            .contains("B_FINISHED"));
        let prompts = fs::read_to_string(f.dir.join("b-prompts")).unwrap();
        assert!(prompts.contains("From @A: SECOND_TASK"));
        let g = f.state.read().unwrap();
        assert_eq!(
            g.store.chats[0]
                .tasks
                .iter()
                .filter(|t| t.bot_id == "B" && t.status == "complete")
                .count(),
            2
        );
        assert_eq!(
            g.store.chats[0]
                .tasks
                .iter()
                .find(|t| t.bot_id == "C")
                .unwrap()
                .mode,
            "sequential"
        );
    }

    #[tokio::test]
    async fn failure_skips_dependent_sequential_peers_but_parallel_peers_finish() {
        for parallel in [false, true] {
            let f = Fixture::new(&["A", "B"]);
            f.script("A", "echo failed\nexit 1");
            f.script("B", "touch b-ran\necho ok");
            dispatch_chat_turn(
                f.state.clone(),
                input(if parallel {
                    "/race begin"
                } else {
                    "/group begin"
                }),
            )
            .await
            .unwrap();
            f.wait().await;
            assert_eq!(f.dir.join("b-ran").exists(), parallel);
            let g = f.state.read().unwrap();
            assert_eq!(
                g.store.chats[0].tasks[1].status,
                if parallel { "complete" } else { "skipped" }
            );
        }
    }

    #[tokio::test]
    async fn handoff_outside_visible_team_is_reported_and_does_not_run() {
        let f = Fixture::new(&["A", "B"]);
        f.script("A", "echo '<handoff to=\"B\">Secret task</handoff>'");
        f.script("B", "touch should-not-run");
        f.state.write().unwrap().store.chats[0].participant_bot_ids = vec!["A".into()];
        dispatch_chat_turn(f.state.clone(), input("Begin"))
            .await
            .unwrap();
        f.wait().await;
        assert!(!f.dir.join("should-not-run").exists());
        assert!(f.state.read().unwrap().store.chats[0]
            .tasks
            .iter()
            .any(|t| t.status == "skipped" && t.reason.as_deref().unwrap().contains("outside")));
    }

    #[tokio::test]
    async fn changed_message_model_invalidates_native_session() {
        let f = Fixture::new(&["A"]);
        f.script(
            "A",
            "echo '{\"type\":\"result\",\"session_id\":\"session-one\",\"result\":\"ok\"}'",
        );
        dispatch_chat_turn(f.state.clone(), input("First"))
            .await
            .unwrap();
        f.wait().await;
        let first = f.state.read().unwrap().store.chats[0].session_contexts["A"].clone();
        let mut next = input("Second");
        next.override_model = Some("different-model".into());
        dispatch_chat_turn(f.state.clone(), next).await.unwrap();
        f.wait().await;
        let g = f.state.read().unwrap();
        assert_ne!(first, g.store.chats[0].session_contexts["A"]);
        assert_eq!(
            g.store.chats[0].messages.last().unwrap().model.as_deref(),
            Some("different-model")
        );
    }

    #[tokio::test]
    async fn cost_limit_skips_queued_work_and_missing_cost_does_not_invent_a_limit() {
        let f = Fixture::new(&["A", "B"]);
        f.script(
            "A",
            "echo '{\"type\":\"result\",\"result\":\"done\",\"total_cost_usd\":2}'",
        );
        f.script("B", "touch should-not-run");
        {
            let mut g = f.state.write().unwrap();
            g.store.preferences.workflow_budget_usd = 1.0;
            g.store.preferences.max_turn_budget_usd = 5.0;
        }
        dispatch_chat_turn(f.state.clone(), input("/group begin"))
            .await
            .unwrap();
        f.wait().await;
        assert!(!f.dir.join("should-not-run").exists());
        assert!(f.state.read().unwrap().store.chats[0].tasks[1]
            .reason
            .as_deref()
            .unwrap()
            .contains("budget"));
    }
}
