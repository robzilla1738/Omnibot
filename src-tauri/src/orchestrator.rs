use crate::drivers::{execute_bot_turn, DriverTurnRequest};
use crate::git_ops::ensure_bot_worktree;
use crate::state::{
    now_ms, BotProfile, ChatMessage, HandoffEvent, OmniStreamEvent, SharedOmniState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
            status: "complete".to_string(),
            created_at_ms: now_ms(),
        };
        chat.messages.push(user_msg);
        chat.updated_at_ms = now_ms();

        // Auto-title untitled sidechat from first user message
        if (chat.title == "New sidechat" || chat.title == "New Swarm Room")
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

        let target_bot_ids: Vec<String> = if is_all_mention
            || input.parallel_mode.unwrap_or(false)
            || trimmed_text.starts_with("/race ")
            || trimmed_text.starts_with("/swarm ")
        {
            if chat.participant_bot_ids.len() > 1 {
                chat.participant_bot_ids.clone()
            } else {
                all_bots
                    .iter()
                    .filter(|b| !b.is_primary)
                    .take(3)
                    .map(|b| b.id.clone())
                    .collect()
            }
        } else if !mentioned_ids.is_empty() {
            mentioned_ids
        } else if let Some(override_id) = &input.override_bot_id {
            vec![override_id.clone()]
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

    while !current_wave.is_empty() && hop < max_swarm_turns {
        if is_cancelled(&state, &chat_id) {
            break;
        }

        let mut next_wave_ids: Vec<String> = Vec::new();
        let mut next_wave_parallel = false;

        if run_in_parallel && current_wave.len() > 1 {
            // Execute all bots in current_wave concurrently
            let mut handles = Vec::new();
            for bot in &current_wave {
                let st = state.clone();
                let cid = chat_id.clone();
                let b = bot.clone();
                let u_prompt = original_user_prompt.clone();
                let sk = skill_slug.clone();
                handles.push(tokio::spawn(async move {
                    run_single_bot_step(st, cid, b, u_prompt, sk, hop).await
                }));
            }
            for h in handles {
                if let Ok(Some((from_bot, handoff))) = h.await {
                    record_handoff_on_message(&state, &chat_id, &from_bot.id, &handoff);
                    if handoff.mode == "parallel" {
                        next_wave_parallel = true;
                    }
                    for tid in handoff.to_bot_ids {
                        if !next_wave_ids.contains(&tid) {
                            next_wave_ids.push(tid);
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
                if let Some((from_bot, handoff)) = run_single_bot_step(
                    state.clone(),
                    chat_id.clone(),
                    bot.clone(),
                    original_user_prompt.clone(),
                    skill_slug.clone(),
                    hop,
                )
                .await
                {
                    record_handoff_on_message(&state, &chat_id, &from_bot.id, &handoff);
                    if handoff.mode == "parallel" {
                        next_wave_parallel = true;
                    }
                    for tid in handoff.to_bot_ids {
                        if !next_wave_ids.contains(&tid) {
                            next_wave_ids.push(tid);
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

async fn run_single_bot_step(
    state: SharedOmniState,
    chat_id: String,
    bot: BotProfile,
    original_user_prompt: String,
    skill_slug: Option<String>,
    hop: u32,
) -> Option<(BotProfile, HandoffEvent)> {
    let msg_id = format!("msg_a_{}_{}", bot.slug, now_ms());

    // Prepare placeholder streaming message & build context
    let (prompt, system_context, cwd, resume_session_id, approve_all, all_bots) = {
        let mut guard = state.write().ok()?;
        let approve_all = guard.store.preferences.approve_all_tools;
        let global_instructions = guard.store.preferences.global_instructions.clone();
        let shared_memories = guard.store.preferences.shared_memories.clone();
        let default_ws_root = guard.store.preferences.workspace_root.clone();
        let all_bots = guard.store.bots.clone();
        let skills = guard.skills.clone();

        let chat = guard.store.chats.iter_mut().find(|c| c.id == chat_id)?;
        let base_ws = chat
            .workspace_path
            .clone()
            .unwrap_or_else(|| default_ws_root.clone());

        let effective_cwd = if chat.use_worktrees {
            ensure_bot_worktree(&base_ws, &chat_id, &bot.slug).unwrap_or(base_ws)
        } else {
            base_ws
        };

        let resume_sid = chat.native_sessions.get(&bot.id).cloned();

        // Build transcript snippet from recent messages
        let recent_history = build_recent_transcript(&chat.messages, &bot.id);

        // Build prompt for this turn
        let turn_prompt = if hop == 0 && recent_history.is_empty() {
            original_user_prompt.clone()
        } else if hop == 0 {
            format!(
                "Recent conversation context:\n{}\n\nLatest user request:\n{}",
                recent_history, original_user_prompt
            )
        } else {
            format!(
                "Multi-Bot Swarm Handoff (Hop #{}).\nOriginal user goal:\n{}\n\nRecent Bot conversation & handoff to you (@{}):\n{}\n\nNow respond as @{} ({}) and execute your part of the task.",
                hop + 1,
                original_user_prompt,
                bot.name,
                recent_history,
                bot.name,
                bot.role_title
            )
        };

        // Build system context with teammate roster & optional skill
        let mut sys_parts = Vec::new();
        sys_parts.push(format!(
            "You are @{} ({}), running inside Omni Bot on macOS via the `{}` CLI harness.",
            bot.name,
            bot.role_title,
            bot.cli_driver.as_str()
        ));
        if !bot.system_prompt.trim().is_empty() {
            sys_parts.push(bot.system_prompt.trim().to_string());
        }
        if !global_instructions.trim().is_empty() {
            sys_parts.push(format!("Global instructions: {}", global_instructions.trim()));
        }
        if !shared_memories.is_empty() || !bot.memories.is_empty() {
            let mut mems = shared_memories;
            mems.extend(bot.memories.clone());
            sys_parts.push(format!("Memories:\n- {}", mems.join("\n- ")));
        }

        let roster_lines: Vec<String> = all_bots
            .iter()
            .filter(|b| b.id != bot.id)
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
                "Teammate Bots available in this workspace:\n{}\n\nBot-to-Bot Collaboration Protocol:\nIf the user asks you to coordinate with, ask, or hand off work to another Bot (or if another Bot's review/implementation is needed next), include `<handoff to=\"BotName\" mode=\"sequential\">Clear instructions for that Bot</handoff>` at the end of your response (or mention `@BotName` directly). Only trigger a handoff when genuinely helpful or requested.",
                roster_lines.join("\n")
            ));
        }

        if let Some(slug) = &skill_slug {
            if let Some(skill) = skills.iter().find(|s| &s.slug == slug) {
                if let Ok(skill_body) = fs::read_to_string(&skill.path) {
                    let snippet: String = skill_body.chars().take(6000).collect();
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
            worktree_path: if chat.use_worktrees {
                Some(effective_cwd.clone())
            } else {
                None
            },
            duration_ms: None,
            cost_usd: None,
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
            all_bots,
        )
    };

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
        },
    )
    .await;

    // Save native session ID for future `--resume`
    if let Some(sid) = &output.native_session_id {
        if let Ok(mut guard) = state.write() {
            if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
                chat.native_sessions.insert(bot.id.clone(), sid.clone());
                if let Some(msg) = chat.messages.iter_mut().find(|m| m.id == msg_id) {
                    msg.cost_usd = output.cost_usd;
                }
            }
        }
    }

    if output.status != "complete" || output.text.trim().is_empty() {
        return None;
    }

    // Parse any outgoing `<handoff to="...">` or `@BotName` mentions from this Bot's reply
    parse_bot_handoff(&bot, &output.text, &all_bots).map(|h| (bot, h))
}

fn build_recent_transcript(messages: &[ChatMessage], current_bot_id: &str) -> String {
    let len = messages.len();
    let slice = if len > 8 {
        &messages[len - 8..]
    } else {
        messages
    };
    let mut lines = Vec::new();
    for m in slice {
        if m.text.trim().is_empty() {
            continue;
        }
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
        let snippet: String = m.text.chars().take(1200).collect();
        lines.push(format!("[{speaker}]: {snippet}"));
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
                    note: note.chars().take(240).collect(),
                });
            }
        }
    }

    // 2. Otherwise check for @BotName mentions in the last paragraph / lines of the reply
    let tail_lines: String = reply_text
        .lines()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let (mentioned_ids, _) =
        extract_mentioned_bots(&tail_lines, all_bots, Some(speaking_bot.id.as_str()));
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
        note: format!("Handed off to @{}", ordered_ids.join(", ")),
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
