//! Bounded task groups, persisted outcomes, and workflow cleanup.
use crate::orchestrator::{
    is_cancelled, record_handoff_on_message, run_single_bot_step, SingleBotStepResult, StepContext,
};
use crate::state::{now_ms, BotProfile, OmniStreamEvent, SharedOmniState, WorkflowTask};
use std::collections::{HashMap, HashSet};

struct QueuedTurn {
    bot: BotProfile,
    task_id: String,
    note: Option<String>,
}
struct TaskGroup {
    turns: Vec<QueuedTurn>,
    parallel: bool,
    hop: u32,
}

pub(crate) fn enqueue_task(state: &SharedOmniState, chat_id: &str, task: WorkflowTask) {
    if let Ok(mut guard) = state.write() {
        if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
            if task.status == "queued" && !chat.participant_bot_ids.contains(&task.bot_id) {
                chat.participant_bot_ids.push(task.bot_id.clone());
                chat.is_group =
                    !chat.is_bot_home && !chat.is_primary && chat.participant_bot_ids.len() > 1;
            }
            chat.tasks.push(task);
        }
        guard.save_execution();
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(chat_id.into()),
        });
    }
}

pub(crate) fn task_status(
    state: &SharedOmniState,
    chat_id: &str,
    task_id: &str,
    status: &str,
    reason: Option<String>,
) {
    if let Ok(mut guard) = state.write() {
        let mut workflow_id = None;
        if let Some(task) = guard
            .store
            .chats
            .iter_mut()
            .find(|c| c.id == chat_id)
            .and_then(|c| c.tasks.iter_mut().find(|t| t.id == task_id))
        {
            workflow_id = Some(task.workflow_id.clone());
            task.status = status.into();
            task.reason = reason;
        }
        if status == "running" {
            for routine in guard
                .store
                .routines
                .iter_mut()
                .filter(|r| r.workflow_id.is_some() && r.workflow_id == workflow_id)
            {
                routine.run_status = Some("running".into());
            }
        }
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(chat_id.into()),
        });
    }
}

// Cleanup also runs when the worker unwinds, so a failed task cannot leave a room busy.
struct WorkflowGuard {
    state: SharedOmniState,
    chat_id: String,
    workflow_id: String,
}
impl Drop for WorkflowGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.write() {
            let stopped = guard.cancelled_chats.contains(&self.chat_id);
            let mut outcome = if stopped { "stopped" } else { "complete" };
            if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == self.chat_id) {
                for task in chat
                    .tasks
                    .iter_mut()
                    .filter(|t| t.workflow_id == self.workflow_id)
                {
                    if matches!(task.status.as_str(), "queued" | "running") {
                        task.status = if stopped { "stopped" } else { "error" }.into();
                        task.reason = Some(
                            if stopped {
                                "Stopped by user."
                            } else {
                                "Workflow ended before this task finished."
                            }
                            .into(),
                        );
                    }
                    if matches!(task.status.as_str(), "error" | "skipped") && !stopped {
                        outcome = "error";
                    }
                }
            }
            for routine in guard
                .store
                .routines
                .iter_mut()
                .filter(|r| r.workflow_id.as_deref() == Some(&self.workflow_id))
            {
                routine.run_status = Some(outcome.into());
                routine.last_error = (outcome != "complete")
                    .then(|| format!("Run {outcome}. See task details in the conversation."));
                if outcome == "complete" {
                    routine.last_run_ms = Some(now_ms());
                }
            }
            guard.active_workflows.remove(&self.chat_id);
            guard.cancelled_chats.remove(&self.chat_id);
            guard.save_execution();
            guard.emit(OmniStreamEvent::StateUpdated {
                chat_id: Some(self.chat_id.clone()),
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_swarm_workflow(
    state: SharedOmniState,
    chat_id: String,
    workflow_id: String,
    original_user_prompt: String,
    skill_slug: Option<String>,
    initial_bots: Vec<BotProfile>,
    parallel_initial: bool,
    max_swarm_turns: u32,
    summarize: bool,
) {
    let _cleanup = WorkflowGuard {
        state: state.clone(),
        chat_id: chat_id.clone(),
        workflow_id: workflow_id.clone(),
    };
    let (prevent_loops, max_parallel, workflow_budget) = {
        let guard = state.read().expect("state lock");
        (
            guard.store.preferences.prevent_handoff_loops,
            guard.store.preferences.max_parallel_bots.clamp(1, 6) as usize,
            guard.store.preferences.workflow_budget_usd,
        )
    };
    let summary_bot = initial_bots.first().cloned();
    let mut initial_turns = Vec::new();
    for bot in initial_bots {
        let task_id = uuid::Uuid::new_v4().to_string();
        enqueue_task(
            &state,
            &chat_id,
            WorkflowTask {
                id: task_id.clone(),
                workflow_id: workflow_id.clone(),
                bot_id: bot.id.clone(),
                from_bot_id: None,
                instructions: original_user_prompt.clone(),
                mode: if parallel_initial {
                    "parallel"
                } else {
                    "sequential"
                }
                .into(),
                status: "queued".into(),
                reason: None,
                workspace_path: None,
            },
        );
        initial_turns.push(QueuedTurn {
            bot,
            task_id,
            note: None,
        });
    }
    let mut queue = std::collections::VecDeque::from([TaskGroup {
        turns: initial_turns,
        parallel: parallel_initial,
        hop: 0,
    }]);
    let mut seen_tasks = HashSet::new();
    let mut bot_turn_counts = HashMap::<String, u32>::new();
    let mut cumulative_cost = 0.0;
    while let Some(group) = queue.pop_front() {
        let history_end = state
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
        let mut predecessor_failed = false;
        for batch in group
            .turns
            .chunks(if group.parallel { max_parallel } else { 1 })
        {
            let reason = if is_cancelled(&state, &chat_id) {
                Some("Stopped by user.")
            } else if cumulative_cost >= workflow_budget {
                Some("Reported workflow cost reached the budget limit.")
            } else if predecessor_failed && !group.parallel {
                Some("The previous sequential task failed.")
            } else {
                None
            };
            if let Some(reason) = reason {
                for turn in batch {
                    task_status(
                        &state,
                        &chat_id,
                        &turn.task_id,
                        if is_cancelled(&state, &chat_id) {
                            "stopped"
                        } else {
                            "skipped"
                        },
                        Some(reason.into()),
                    );
                }
                continue;
            }
            let end = if group.parallel {
                history_end
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
            let mut futures = Vec::new();
            for turn in batch {
                let exhausted =
                    prevent_loops && bot_turn_counts.get(&turn.bot.id).copied().unwrap_or(0) >= 8;
                if !exhausted {
                    *bot_turn_counts.entry(turn.bot.id.clone()).or_default() += 1;
                }
                let state = state.clone();
                let chat_id = chat_id.clone();
                let context = StepContext {
                    allow_handoffs: true,
                    task_id: turn.task_id.clone(),
                    original_user_prompt: original_user_prompt.clone(),
                    skill_slug: if group.hop == 0 {
                        skill_slug.clone()
                    } else {
                        None
                    },
                    hop: group.hop,
                    incoming_handoff_note: turn.note.clone(),
                    history_end: end,
                };
                futures.push(async move {
                    if exhausted {
                        SingleBotStepResult {
                            status: "skipped".into(),
                            error: Some("Bot turn limit reached.".into()),
                            cost_usd: None,
                            handoffs: Vec::new(),
                        }
                    } else {
                        run_single_bot_step(state, chat_id, turn.bot.clone(), context).await
                    }
                });
            }
            for (turn, result) in batch
                .iter()
                .zip(futures_util::future::join_all(futures).await)
            {
                task_status(
                    &state,
                    &chat_id,
                    &turn.task_id,
                    &result.status,
                    result.error,
                );
                predecessor_failed |= result.status != "complete";
                cumulative_cost += result.cost_usd.unwrap_or(0.0);
                for (from_bot, handoff) in result.handoffs {
                    record_handoff_on_message(&state, &chat_id, &from_bot.id, &handoff);
                    let mut turns = Vec::new();
                    for id in &handoff.to_bot_ids {
                        let task_id = uuid::Uuid::new_v4().to_string();
                        let bot = state.read().ok().and_then(|g| {
                            g.store
                                .bots
                                .iter()
                                .find(|b| &b.id == id && !b.archived)
                                .cloned()
                        });
                        let duplicate = !seen_tasks.insert((
                            from_bot.id.clone(),
                            id.clone(),
                            handoff.note.clone(),
                        ));
                        let reason = if group.hop + 1 >= max_swarm_turns {
                            Some("Swarm round limit reached.")
                        } else if prevent_loops
                            && (duplicate || bot_turn_counts.get(id).copied().unwrap_or(0) >= 8)
                        {
                            Some("Duplicate handoff or bot turn limit reached.")
                        } else if bot.is_none() {
                            Some("Recipient is missing or archived.")
                        } else {
                            None
                        };
                        enqueue_task(
                            &state,
                            &chat_id,
                            WorkflowTask {
                                id: task_id.clone(),
                                workflow_id: workflow_id.clone(),
                                bot_id: id.clone(),
                                from_bot_id: Some(from_bot.id.clone()),
                                instructions: handoff.note.clone(),
                                mode: handoff.mode.clone(),
                                status: if reason.is_some() {
                                    "skipped"
                                } else {
                                    "queued"
                                }
                                .into(),
                                reason: reason.map(str::to_string),
                                workspace_path: None,
                            },
                        );
                        if let Some(reason) = reason {
                            workflow_notice(&state, &chat_id, reason);
                        } else if let Some(mut bot) = bot {
                            if let Some(model) = state.read().ok().and_then(|g| {
                                g.store
                                    .chats
                                    .iter()
                                    .find(|c| c.id == chat_id)
                                    .and_then(|c| c.model_overrides.get(id).cloned())
                            }) {
                                bot.model = model;
                            }
                            turns.push(QueuedTurn {
                                bot,
                                task_id,
                                note: Some(format!("From @{}: {}", from_bot.name, handoff.note)),
                            });
                        }
                    }
                    if !turns.is_empty() {
                        queue.push_back(TaskGroup {
                            turns,
                            parallel: handoff.mode == "parallel",
                            hop: group.hop + 1,
                        });
                    }
                }
            }
        }
    }
    if summarize {
        if let Some(bot) = summary_bot {
            let (history_end, outcomes) = state
                .read()
                .ok()
                .and_then(|g| {
                    g.store.chats.iter().find(|c| c.id == chat_id).map(|c| {
                        (
                            c.messages.len(),
                            c.tasks
                                .iter()
                                .filter(|t| t.workflow_id == workflow_id)
                                .map(|t| {
                                    format!(
                                        "{}: {} — {}",
                                        t.bot_id,
                                        t.status,
                                        t.reason.as_deref().unwrap_or("")
                                    )
                                })
                                .collect::<Vec<_>>(),
                        )
                    })
                })
                .unwrap_or_default();
            if outcomes.len() > 1 {
                let task_id = uuid::Uuid::new_v4().to_string();
                let reason = if is_cancelled(&state, &chat_id) {
                    Some("Stopped by user.")
                } else if cumulative_cost >= workflow_budget {
                    Some("Workflow cost limit reached before summary.")
                } else {
                    None
                };
                let note = format!("Summarize the team's completed work, unresolved issues, and failures for the user. Do not delegate or edit files in this summary. Task outcomes:\n{}", outcomes.join("\n"));
                enqueue_task(
                    &state,
                    &chat_id,
                    WorkflowTask {
                        id: task_id.clone(),
                        workflow_id: workflow_id.clone(),
                        bot_id: bot.id.clone(),
                        from_bot_id: None,
                        instructions: note.clone(),
                        mode: "summary".into(),
                        status: if reason.is_some() {
                            "skipped"
                        } else {
                            "queued"
                        }
                        .into(),
                        reason: reason.map(str::to_string),
                        workspace_path: None,
                    },
                );
                if reason.is_none() {
                    let result = run_single_bot_step(
                        state.clone(),
                        chat_id.clone(),
                        bot,
                        StepContext {
                            task_id: task_id.clone(),
                            original_user_prompt,
                            skill_slug: None,
                            hop: 1,
                            incoming_handoff_note: Some(note),
                            history_end,
                            allow_handoffs: false,
                        },
                    )
                    .await;
                    task_status(&state, &chat_id, &task_id, &result.status, result.error);
                }
            }
        }
    }
}

pub(crate) fn workflow_notice(state: &SharedOmniState, chat_id: &str, text: &str) {
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
