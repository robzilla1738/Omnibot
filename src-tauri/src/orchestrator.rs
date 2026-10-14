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
    let trimmed_text = input.text.trim().to_string();
    if trimmed_text.is_empty() {
        return Err("Message text cannot be empty.".to_string());
    }

    let user_msg_id = format!("msg_u_{}", now_ms());

    // 1. Record user message and determine initial target Bot(s)
    let (initial_bots, parallel_initial, max_swarm_turns) = {
        let mut guard = state
            .write()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.cancelled_chats.remove(&input.chat_id);

        let all_bots = guard.store.bots.clone();
        let max_parallel = guard.store.preferences.max_parallel_bots.clamp(1, 6) as usize;
        let active_ws_root = guard.store.preferences.workspace_root.clone();
        let active_project = guard
            .store
            .workspaces
            .iter()
            .find(|w| w.path == active_ws_root)
            .cloned();

        let (mentioned_ids, is_all_mention) =
            extract_mentioned_bots(&trimmed_text, &all_bots, None);

        let Some(chat) = guard
            .store
            .chats
            .iter_mut()
            .find(|c| c.id == input.chat_id)
        else {
            return Err(format!("Chat '{}' not found.", input.chat_id));
        };

        // Keep chat's workspace synchronized with active project if not explicitly pinned elsewhere
        if chat.workspace_path.as_deref() != Some(active_ws_root.as_str()) {
            chat.workspace_path = Some(active_ws_root.clone());
            if let Some(proj) = &active_project {
                chat.workspace_id = Some(proj.id.clone());
            }
        }

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

        let target_bot_ids: Vec<String> = if is_all_mention
            || input.parallel_mode.unwrap_or(false)
            || trimmed_text.starts_with("/race ")
            || trimmed_text.starts_with("/swarm ")
        {
            if chat.participant_bot_ids.len() > 1 {
                chat.participant_bot_ids
                    .iter()
                    .take(max_parallel)
                    .cloned()
                    .collect()
            } else if !project_assigned_ids.is_empty() {
                project_assigned_ids
                    .iter()
                    .take(max_parallel)
                    .cloned()
                    .collect()
            } else {
                all_bots
                    .iter()
                    .filter(|b| !b.is_primary)
                    .take(max_parallel)
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

        let resolved_bots: Vec<BotProfile> = target_bot_ids
            .iter()
            .filter_map(|id| all_bots.iter().find(|b| &b.id == id).cloned())
            .map(|mut b| {
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
                b
            })
            .collect();

        let max_turns = chat.max_swarm_turns.clamp(1, 8);
        let is_parallel = resolved_bots.len() > 1
            && (is_all_mention
                || input.parallel_mode.unwrap_or(false)
                || trimmed_text.starts_with("/race "));

        let _ = guard.persist();
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
    let mut hop: u32 = 0;

    // Loop & Token Guardrail Trackers
    let mut bot_turn_counts: HashMap<String, u32> = HashMap::new();
    let mut seen_handoff_edges: HashSet<(String, String)> = HashSet::new();
    let mut incoming_handoff_notes: HashMap<String, String> = HashMap::new();
    let mut cumulative_cost_usd: f64 = 0.0;

    let (prevent_loops, max_parallel_bots, max_workflow_budget_usd) = state
        .read()
        .map(|g| {
            (
                g.store.preferences.prevent_handoff_loops,
                g.store.preferences.max_parallel_bots.clamp(1, 6) as usize,
                (g.store.preferences.max_turn_budget_usd * 2.5).max(0.50),
            )
        })
        .unwrap_or((true, 3, 3.75));

    while !current_wave.is_empty() && hop < max_swarm_turns {
        if is_cancelled(&state, &chat_id) {
            break;
        }

        if cumulative_cost_usd > max_workflow_budget_usd {
            break;
        }

        let mut next_wave_ids: Vec<String> = Vec::new();
        let mut next_wave_parallel = false;

        for b in &current_wave {
            *bot_turn_counts.entry(b.id.clone()).or_insert(0) += 1;
        }

        if run_in_parallel && current_wave.len() > 1 {
            // Cap concurrent bots to max_parallel_bots guardrail
            let wave_slice: Vec<BotProfile> = current_wave
                .into_iter()
                .take(max_parallel_bots)
                .collect();
            let mut handles = Vec::new();
            for bot in &wave_slice {
                let st = state.clone();
                let cid = chat_id.clone();
                let b = bot.clone();
                let u_prompt = original_user_prompt.clone();
                let sk = if hop == 0 { skill_slug.clone() } else { None };
                let handoff_note = incoming_handoff_notes.get(&b.id).cloned();
                handles.push(tokio::spawn(async move {
                    run_single_bot_step(st, cid, b, u_prompt, sk, hop, handoff_note).await
                }));
            }
            for h in handles {
                if let Ok(step_res) = h.await {
                    if let Some(cost) = step_res.cost_usd {
                        cumulative_cost_usd += cost;
                    }
                    if let Some((from_bot, handoff)) = step_res.handoff {
                        let filtered_handoff = filter_handoff_against_loops(
                            &from_bot.id,
                            handoff,
                            &bot_turn_counts,
                            &mut seen_handoff_edges,
                            prevent_loops,
                        );
                        if let Some(valid_handoff) = filtered_handoff {
                            record_handoff_on_message(&state, &chat_id, &from_bot.id, &valid_handoff);
                            if valid_handoff.mode == "parallel" {
                                next_wave_parallel = true;
                            }
                            for tid in valid_handoff.to_bot_ids {
                                incoming_handoff_notes
                                    .insert(tid.clone(), valid_handoff.note.clone());
                                if !next_wave_ids.contains(&tid) {
                                    next_wave_ids.push(tid);
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // Execute sequentially so each bot in the wave sees the previous bot's output
            for bot in &current_wave {
                if is_cancelled(&state, &chat_id) {
                    break;
                }
                let sk = if hop == 0 { skill_slug.clone() } else { None };
                let handoff_note = incoming_handoff_notes.get(&bot.id).cloned();
                let step_res = run_single_bot_step(
                    state.clone(),
                    chat_id.clone(),
                    bot.clone(),
                    original_user_prompt.clone(),
                    sk,
                    hop,
                    handoff_note,
                )
                .await;

                if let Some(cost) = step_res.cost_usd {
                    cumulative_cost_usd += cost;
                }

                if let Some((from_bot, handoff)) = step_res.handoff {
                    let filtered_handoff = filter_handoff_against_loops(
                        &from_bot.id,
                        handoff,
                        &bot_turn_counts,
                        &mut seen_handoff_edges,
                        prevent_loops,
                    );
                    if let Some(valid_handoff) = filtered_handoff {
                        record_handoff_on_message(&state, &chat_id, &from_bot.id, &valid_handoff);
                        if valid_handoff.mode == "parallel" {
                            next_wave_parallel = true;
                        }
                        for tid in valid_handoff.to_bot_ids {
                            incoming_handoff_notes
                                .insert(tid.clone(), valid_handoff.note.clone());
                            if !next_wave_ids.contains(&tid) {
                                next_wave_ids.push(tid);
                            }
                        }
                    }
                }
            }
        }

        hop += 1;
        if next_wave_ids.is_empty() || hop >= max_swarm_turns {
            break;
        }

        // Resolve next wave BotProfiles
        current_wave = {
            let Ok(mut guard) = state.write() else {
                break;
            };
            if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
                for tid in &next_wave_ids {
                    if !chat.participant_bot_ids.contains(tid) {
                        chat.participant_bot_ids.push(tid.clone());
                    }
                }
                if chat.participant_bot_ids.len() > 1 && !chat.is_primary {
                    chat.is_group = true;
                }
            }
            let bots = guard.store.bots.clone();
            next_wave_ids
                .iter()
                .filter_map(|id| bots.iter().find(|b| &b.id == id).cloned())
                .collect()
        };
        run_in_parallel = next_wave_parallel;
    }

    if let Ok(guard) = state.read() {
        let _ = guard.persist();
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(chat_id),
        });
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
    handoff: Option<(BotProfile, HandoffEvent)>,
}

async fn run_single_bot_step(
    state: SharedOmniState,
    chat_id: String,
    bot: BotProfile,
    original_user_prompt: String,
    skill_slug: Option<String>,
    hop: u32,
    incoming_handoff_note: Option<String>,
) -> SingleBotStepResult {
    let msg_id = format!("msg_a_{}_{}", bot.slug, now_ms());

    // Prepare placeholder streaming message & build delta-aware context
    let prep = {
        let Ok(mut guard) = state.write() else {
            return SingleBotStepResult {
                cost_usd: None,
                handoff: None,
            };
        };
        let prefs = guard.store.preferences.clone();
        let approve_all = prefs.approve_all_tools;
        let global_instructions = prefs.global_instructions.clone();
        let shared_memories = prefs.shared_memories.clone();
        let default_ws_root = prefs.workspace_root.clone();
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
                handoff: None,
            };
        };

        let base_ws = chat
            .workspace_path
            .clone()
            .unwrap_or_else(|| default_ws_root.clone());

        let active_project = workspaces
            .iter()
            .find(|w| Some(w.id.as_str()) == chat.workspace_id.as_deref() || w.path == base_ws)
            .cloned();

        let use_worktrees = chat.use_worktrees
            || active_project
                .as_ref()
                .is_some_and(|p| p.use_worktrees_default && chat.is_group);

        let effective_cwd = if use_worktrees {
            ensure_bot_worktree(&base_ws, &chat_id, &bot.slug).unwrap_or(base_ws)
        } else {
            base_ws
        };

        let resume_sid = chat.native_sessions.get(&bot.id).cloned();
        let last_synced_idx = chat.last_synced_msg_index.get(&bot.id).copied().unwrap_or(0);

        // Exclude the trailing user message on hop 0 so we don't duplicate original_user_prompt
        let prior_messages_end = if hop == 0 && !chat.messages.is_empty() {
            chat.messages.len().saturating_sub(1)
        } else {
            chat.messages.len()
        };
        let prior_slice = &chat.messages[..prior_messages_end];

        // Delta-aware transcript:
        // If resuming a native CLI session, only include messages that occurred AFTER this Bot's last turn!
        let recent_history = if resume_sid.is_some() && last_synced_idx > 0 && last_synced_idx <= prior_slice.len() {
            let delta_slice = &prior_slice[last_synced_idx..];
            build_recent_transcript(delta_slice, &bot.id, max_context_messages, max_message_chars)
        } else {
            build_recent_transcript(prior_slice, &bot.id, max_context_messages, max_message_chars)
        };

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
            "You are @{} ({}), running inside Botfinity on macOS via the `{}` CLI harness.",
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
            sys_parts.push(format!("Global instructions: {}", global_instructions.trim()));
        }
        if !shared_memories.is_empty() || !bot.memories.is_empty() {
            let mut mems = shared_memories;
            mems.extend(bot.memories.clone());
            sys_parts.push(format!("Memories:\n- {}", mems.join("\n- ")));
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
                "Teammate Bots available in this project:\n{}\n\nBot-to-Bot Collaboration Protocol:\nIf the user asks you to coordinate with, ask, or hand off work to another Bot (or if another Bot's review/implementation is needed next), include `<handoff to=\"BotName\" mode=\"sequential\">Specific instructions for that Bot</handoff>` at the end of your response. Only trigger a handoff when genuinely helpful or requested — never hand off just to say thank you or acknowledge completion.",
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
    ) = prep;

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
            if output.status == "error" && had_resume {
                // Clear stale native session so next retry starts cleanly
                chat.native_sessions.remove(&bot.id);
                chat.last_synced_msg_index.remove(&bot.id);
            } else if let Some(sid) = &output.native_session_id {
                chat.native_sessions.insert(bot.id.clone(), sid.clone());
                chat.last_synced_msg_index
                    .insert(bot.id.clone(), chat.messages.len());
            }
        }
    }

    if output.status != "complete" || output.text.trim().is_empty() {
        return SingleBotStepResult {
            cost_usd: output.cost_usd,
            handoff: None,
        };
    }

    // Parse any outgoing `<handoff to="...">` or actionable `@BotName` directive from this Bot's reply
    let handoff =
        parse_bot_handoff(&bot, &output.text, &all_bots, only_explicit_handoffs).map(|h| (bot, h));

    SingleBotStepResult {
        cost_usd: output.cost_usd,
        handoff,
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
        .filter(|m| !m.text.trim().is_empty())
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
            let names: Vec<&str> = m.tool_calls.iter().take(4).map(|t| t.name.as_str()).collect();
            format!(" [ran tools: {}]", names.join(", "))
        } else {
            String::new()
        };
        lines.push(format!("[{speaker}{tool_note}]: {clean}"));
    }
    lines.join("\n\n")
}

fn extract_mentioned_bots(
    text: &str,
    all_bots: &[BotProfile],
    exclude_bot_id: Option<&str>,
) -> (Vec<String>, bool) {
    let lower = text.to_lowercase();
    let is_all = lower.contains("@all") || lower.contains("@everyone") || lower.contains("@swarm");

    let mut found = Vec::new();
    for b in all_bots {
        if exclude_bot_id == Some(b.id.as_str()) {
            continue;
        }
        let name_tok = format!("@{}", b.name.to_lowercase());
        let slug_tok = format!("@{}", b.slug.to_lowercase());
        if contains_mention_token(&lower, &name_tok) || contains_mention_token(&lower, &slug_tok) {
            if !found.contains(&b.id) {
                found.push(b.id.clone());
            }
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

fn parse_bot_handoff(
    speaking_bot: &BotProfile,
    reply_text: &str,
    all_bots: &[BotProfile],
    only_explicit_handoffs: bool,
) -> Option<HandoffEvent> {
    // 1. Check explicit <handoff to="...">...</handoff> block first
    if let Some(open_idx) = reply_text.find("<handoff") {
        let rest = &reply_text[open_idx..];
        if let Some(tag_end) = rest.find('>') {
            let tag_header = &rest[..tag_end];
            let mode = if tag_header.to_lowercase().contains("parallel") {
                "parallel".to_string()
            } else {
                "sequential".to_string()
            };
            let body_rest = &rest[tag_end + 1..];
            let note = body_rest
                .split("</handoff>")
                .next()
                .unwrap_or(body_rest)
                .trim()
                .to_string();

            let mut to_ids = Vec::new();
            let mut to_names = Vec::new();
            let header_lower = tag_header.to_lowercase();
            for b in all_bots {
                if b.id == speaking_bot.id {
                    continue;
                }
                if header_lower.contains(&b.name.to_lowercase())
                    || header_lower.contains(&b.slug.to_lowercase())
                {
                    to_ids.push(b.id.clone());
                    to_names.push(b.name.clone());
                }
            }
            if to_ids.is_empty() {
                let (m_ids, _) =
                    extract_mentioned_bots(&note, all_bots, Some(speaking_bot.id.as_str()));
                for id in m_ids {
                    if let Some(b) = all_bots.iter().find(|x| x.id == id) {
                        to_ids.push(b.id.clone());
                        to_names.push(b.name.clone());
                    }
                }
            }
            if !to_ids.is_empty() {
                return Some(HandoffEvent {
                    from_bot_id: speaking_bot.id.clone(),
                    from_bot_name: speaking_bot.name.clone(),
                    to_bot_ids: to_ids,
                    to_bot_names: to_names,
                    mode,
                    note: note.chars().take(280).collect(),
                });
            }
        }
    }

    if only_explicit_handoffs {
        return None;
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
        return None;
    }

    let joined_directives = directive_lines.join("\n");
    let (mentioned_ids, _) = extract_mentioned_bots(
        &joined_directives,
        all_bots,
        Some(speaking_bot.id.as_str()),
    );
    if mentioned_ids.is_empty() {
        return None;
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

    Some(HandoffEvent {
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
    })
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
