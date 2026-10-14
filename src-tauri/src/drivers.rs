use crate::scanner::{augmented_path_env, find_binary, CliDriverKind};
use crate::state::{
    now_ms, ActiveBotRun, BotProfile, OmniStreamEvent, SharedOmniState, ToolInvocation,
};
use serde_json::Value;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub struct DriverTurnOutput {
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolInvocation>,
    pub native_session_id: Option<String>,
    pub duration_ms: u64,
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub status: String,
}

pub struct DriverTurnRequest {
    pub chat_id: String,
    pub message_id: String,
    pub bot: BotProfile,
    pub prompt: String,
    pub system_context: String,
    pub cwd: String,
    pub resume_session_id: Option<String>,
    pub approve_all: bool,
    pub turn_timeout_secs: u64,
    pub max_budget_usd: Option<f64>,
}

#[derive(Default)]
struct StreamParserState {
    accumulated_text: String,
    accumulated_thinking: String,
    current_block_text: String,
    current_block_thinking: String,
    last_part_id: String,
    saw_text_deltas: bool,
    saw_thinking_deltas: bool,
    needs_paragraph_break: bool,
    tool_calls: Vec<ToolInvocation>,
    native_session_id: Option<String>,
    cost_usd: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    usage_events: std::collections::HashSet<String>,
    incomplete_input: bool,
    incomplete_output: bool,
    incomplete_cost: bool,
    failed: bool,
}

fn resolve_driver_binary(bot: &BotProfile) -> Option<(String, Vec<String>)> {
    if let Some(custom) = bot
        .custom_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let parts = shlex::split(custom)?;
        if let Some((first, rest)) = parts.split_first() {
            if let Some(bin) = find_binary(&[first.as_str()]) {
                return Some((bin, rest.to_vec()));
            }
        }
        return None;
    }

    let bin = match bot.cli_driver {
        CliDriverKind::Claude => find_binary(&["claude"]),
        CliDriverKind::Codex => find_binary(&["codex"]),
        CliDriverKind::Opencode => find_binary(&["opencode"]),
        CliDriverKind::Cursor => find_binary(&["agent", "cursor-agent"]),
        CliDriverKind::Grok => find_binary(&["grok"]),
        CliDriverKind::Pi => find_binary(&["pi"]),
        CliDriverKind::Antigravity => find_binary(&["antigravity", "agy"]),
        CliDriverKind::Muse => find_binary(&["muse"]),
        CliDriverKind::Acp => find_binary(&["acp"]),
        CliDriverKind::Gemini => find_binary(&["gemini"]),
        CliDriverKind::Aider => find_binary(&["aider"]),
        CliDriverKind::Ollama => find_binary(&["ollama"]),
        CliDriverKind::Custom => None,
    }?;
    Some((bin, Vec::new()))
}

pub async fn execute_bot_turn(state: SharedOmniState, req: DriverTurnRequest) -> DriverTurnOutput {
    let start = Instant::now();
    let kind = req.bot.cli_driver;

    let Some((binary_path, extra_custom_args)) = resolve_driver_binary(&req.bot) else {
        let err_msg = format!(
            "Local CLI binary for **{}** (`{}`) was not found on your PATH. Open **CLI Harnesses** in the sidebar to inspect or switch {}'s driver.",
            kind.display_name(),
            kind.as_str(),
            req.bot.name
        );
        update_message_delta(
            &state,
            &req.chat_id,
            &req.message_id,
            &req.bot.id,
            &err_msg,
            false,
        );
        finish_active_run(
            &state,
            &req.chat_id,
            &req.message_id,
            &req.bot.id,
            "error",
            0,
            None,
            None,
            None,
        );
        return DriverTurnOutput {
            text: err_msg,
            thinking: String::new(),
            tool_calls: Vec::new(),
            native_session_id: None,
            duration_ms: start.elapsed().as_millis() as u64,
            cost_usd: None,
            input_tokens: None,
            output_tokens: None,
            status: "error".to_string(),
        };
    };

    let combined_prompt = if req.system_context.trim().is_empty() {
        req.prompt.clone()
    } else {
        format!("{}\n\n{}", req.system_context.trim(), req.prompt.trim())
    };

    let mut cmd = Command::new(&binary_path);
    cmd.current_dir(&req.cwd)
        .env("PATH", augmented_path_env())
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if !extra_custom_args.is_empty() {
        cmd.args(&extra_custom_args);
    }

    #[cfg(unix)]
    cmd.process_group(0);

    match kind {
        CliDriverKind::Claude => {
            cmd.args([
                "-p",
                &req.prompt,
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
            ]);
            if !req.system_context.trim().is_empty() {
                cmd.args(["--append-system-prompt", req.system_context.trim()]);
            }
            if let Some(sid) = req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
                cmd.args(["--resume", sid]);
            }
            if let Some(m) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["--model", m]);
            }
            if matches!(req.bot.reasoning_effort.as_str(), "low" | "medium" | "high") {
                cmd.args(["--effort", &req.bot.reasoning_effort]);
            }
            if req.bot.permission_mode == "plan" {
                cmd.args(["--permission-mode", "plan"]);
            } else if req.approve_all || req.bot.permission_mode == "bypassPermissions" {
                cmd.arg("--dangerously-skip-permissions");
            }
        }
        CliDriverKind::Codex => {
            cmd.arg("exec");
            if let Some(sid) = req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
                cmd.args(["resume", sid, "--json", "--skip-git-repo-check"]);
            } else {
                cmd.args(["--json", "--skip-git-repo-check", "-C", &req.cwd]);
            }
            if let Some(m) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["-m", m]);
            }
            if req.bot.permission_mode == "plan" {
                cmd.args(["-c", "sandbox_mode=\"read-only\""]);
            } else if req.approve_all {
                cmd.args(["-c", "sandbox_mode=\"workspace-write\""]);
            }
            if matches!(
                req.bot.reasoning_effort.as_str(),
                "low" | "medium" | "high" | "xhigh"
            ) {
                cmd.args([
                    "-c",
                    &format!("model_reasoning_effort={:?}", req.bot.reasoning_effort),
                ]);
            }
            cmd.arg(&combined_prompt);
        }
        CliDriverKind::Opencode => {
            cmd.args(["run", "--format", "json", "--thinking"]);
            if let Some(sid) = req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
                cmd.args(["--session", sid]);
            }
            if let Some(m) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["-m", m]);
            }
            cmd.arg(&combined_prompt);
        }
        CliDriverKind::Cursor => {
            cmd.args([
                "-p",
                "--output-format",
                "stream-json",
                "--stream-partial-output",
            ]);
            if req.bot.permission_mode == "plan" {
                cmd.arg("--plan");
            } else if req.approve_all {
                cmd.arg("-f");
            } else {
                cmd.arg("--auto-review");
            }
            if let Some(sid) = req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
                cmd.args(["--resume", sid]);
            }
            if let Some(m) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["--model", m]);
            }
            cmd.arg(&combined_prompt);
        }
        CliDriverKind::Grok => {
            cmd.args([
                "-p",
                &combined_prompt,
                "--output-format",
                "streaming-messages-json",
                "--include-partial-messages",
                "--cwd",
                &req.cwd,
            ]);
            if let Some(sid) = req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
                cmd.args(["-r", sid]);
            }
            if let Some(m) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["-m", m]);
            }
            if req.bot.permission_mode == "plan" {
                cmd.args(["--permission-mode", "plan"]);
            } else if req.approve_all {
                cmd.arg("--always-approve");
            } else {
                cmd.args(["--permission-mode", "auto"]);
            }
        }
        CliDriverKind::Pi => {
            cmd.args(["-p", "--mode", "json"]);
            if !req.system_context.trim().is_empty() {
                cmd.args(["--append-system-prompt", req.system_context.trim()]);
            }
            if let Some(sid) = req.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
                cmd.args(["--session", sid]);
            }
            if let Some(m) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["--model", m]);
            }
            cmd.arg(&req.prompt);
        }
        CliDriverKind::Gemini | CliDriverKind::Antigravity | CliDriverKind::Muse => {
            cmd.args(["-p", &combined_prompt]);
            if let Some(model) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["--model", model]);
            }
        }
        CliDriverKind::Aider => {
            cmd.args(["--no-pretty", "--message", &combined_prompt]);
            if req.approve_all {
                cmd.arg("--yes-always");
            }
            if req.bot.permission_mode == "plan" {
                cmd.args(["--chat-mode", "ask"]);
            }
            if let Some(model) = req
                .bot
                .model
                .as_deref()
                .filter(|m| !m.is_empty() && *m != "default")
            {
                cmd.args(["--model", model]);
            }
        }
        CliDriverKind::Ollama => {
            let Some(model) = req
                .bot
                .model
                .as_deref()
                .filter(|model| !model.trim().is_empty() && *model != "default")
            else {
                let error = "Choose an installed Ollama model in this bot's settings before sending a message.";
                update_message_delta(
                    &state,
                    &req.chat_id,
                    &req.message_id,
                    &req.bot.id,
                    error,
                    false,
                );
                finish_active_run(
                    &state,
                    &req.chat_id,
                    &req.message_id,
                    &req.bot.id,
                    "error",
                    0,
                    None,
                    None,
                    None,
                );
                return DriverTurnOutput {
                    text: error.into(),
                    thinking: String::new(),
                    tool_calls: Vec::new(),
                    native_session_id: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                    cost_usd: None,
                    input_tokens: None,
                    output_tokens: None,
                    status: "error".into(),
                };
            };
            cmd.args(["run", model, &combined_prompt]);
        }
        CliDriverKind::Acp | CliDriverKind::Custom => {
            cmd.arg(&combined_prompt);
        }
    }

    // Register active run
    if let Ok(mut guard) = state.write() {
        guard.active_runs.insert(
            req.message_id.clone(),
            ActiveBotRun {
                chat_id: req.chat_id.clone(),
                message_id: req.message_id.clone(),
                bot_id: req.bot.id.clone(),
                bot_name: req.bot.name.clone(),
                cli_driver: kind,
                activity: "thinking".to_string(),
                started_at_ms: now_ms(),
            },
        );
        guard.emit(OmniStreamEvent::TurnStarted {
            chat_id: req.chat_id.clone(),
            message_id: req.message_id.clone(),
            bot_id: req.bot.id.clone(),
            bot_name: req.bot.name.clone(),
            cli_driver: kind,
            model: req.bot.model.clone(),
        });
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let err_text = format!("Failed to spawn `{}`: {e}", binary_path);
            update_message_delta(
                &state,
                &req.chat_id,
                &req.message_id,
                &req.bot.id,
                &err_text,
                false,
            );
            finish_active_run(
                &state,
                &req.chat_id,
                &req.message_id,
                &req.bot.id,
                "error",
                0,
                None,
                None,
                None,
            );
            return DriverTurnOutput {
                text: err_text,
                thinking: String::new(),
                tool_calls: Vec::new(),
                native_session_id: None,
                duration_ms: 0,
                cost_usd: None,
                input_tokens: None,
                output_tokens: None,
                status: "error".to_string(),
            };
        }
    };

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();

    let mut parser = StreamParserState::default();
    let mut stderr_buf = Vec::new();
    let mut was_cancelled = false;
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut hit_guardrail: Option<String> = None;

    let timeout_limit = Duration::from_secs(req.turn_timeout_secs.clamp(30, 1800));
    let budget_limit = req
        .bot
        .max_turn_budget_usd
        .or(req.max_budget_usd)
        .filter(|b| *b > 0.0);

    loop {
        if !stdout_open && !stderr_open && child.try_wait().ok().flatten().is_some() {
            break;
        }
        if is_chat_cancelled(&state, &req.chat_id) {
            was_cancelled = true;
            terminate_process_tree(&mut child).await;
            break;
        }

        if start.elapsed() > timeout_limit {
            hit_guardrail = Some(format!(
                "\n\n> **Guardrail triggered**: Turn exceeded {}s timeout limit.",
                timeout_limit.as_secs()
            ));
            terminate_process_tree(&mut child).await;
            break;
        }

        if let (Some(limit), Some(actual_cost)) = (budget_limit, parser.cost_usd) {
            if actual_cost > limit {
                hit_guardrail = Some(format!(
                    "\n\n> **Budget guardrail triggered**: Turn cost (${:.3}) exceeded max turn budget (${:.2}).",
                    actual_cost, limit
                ));
                terminate_process_tree(&mut child).await;
                break;
            }
        }

        tokio::select! {
            line_res = stdout_lines.next_line(), if stdout_open => {
                match line_res {
                    Ok(Some(line)) => {
                        parse_cli_output_line(
                            &state,
                            &req.chat_id,
                            &req.message_id,
                            &req.bot.id,
                            &line,
                            &mut parser,
                        );
                    }
                    Ok(None) => stdout_open = false,
                    Err(_) => { stdout_open = false; parser.failed = true; },
                }
            }
            err_res = stderr_lines.next_line(), if stderr_open => {
                match err_res {
                    Ok(Some(line)) => {
                        let clean = strip_ansi(&line);
                        if !clean.trim().is_empty() && stderr_buf.len() < 40 {
                            stderr_buf.push(clean.chars().take(4000).collect::<String>());
                        }
                    }
                    _ => stderr_open = false,
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(160)) => {
                if is_chat_cancelled(&state, &req.chat_id) {
                    was_cancelled = true;
                    terminate_process_tree(&mut child).await;
                    break;
                }
            }
        }
    }

    if let Some(notice) = &hit_guardrail {
        parser.accumulated_text.push_str(notice);
        update_message_delta(
            &state,
            &req.chat_id,
            &req.message_id,
            &req.bot.id,
            notice,
            false,
        );
    }

    let exit_status = child.wait().await.ok();
    let duration_ms = start.elapsed().as_millis() as u64;

    if !exit_status.is_some_and(|s| s.success())
        && stderr_buf.is_empty()
        && !was_cancelled
        && hit_guardrail.is_none()
    {
        stderr_buf.push(format!("CLI exited unsuccessfully: {exit_status:?}"));
    }
    if !stderr_buf.is_empty() && !was_cancelled && !exit_status.is_some_and(|s| s.success()) {
        let joined_err = stderr_buf.join("\n");
        // Check if session resume failed (e.g. expired or invalid session ID)
        let formatted_err = format!("\n\n```\n{}\n```", joined_err.trim());
        parser.accumulated_text.push_str(&formatted_err);
        update_message_delta(
            &state,
            &req.chat_id,
            &req.message_id,
            &req.bot.id,
            &formatted_err,
            false,
        );
    }

    let final_status = if was_cancelled || hit_guardrail.is_some() {
        "stopped"
    } else if exit_status.is_some_and(|s| s.success()) && !parser.failed {
        "complete"
    } else {
        "error"
    };

    finish_active_run(
        &state,
        &req.chat_id,
        &req.message_id,
        &req.bot.id,
        final_status,
        duration_ms,
        parser.cost_usd,
        parser.input_tokens,
        parser.output_tokens,
    );

    if let Ok(mut guard) = state.write() {
        guard.record_activity(
            &format!("{} ({})", req.bot.name, kind.as_str()),
            format!(
                "Completed turn in {} ({} tools)",
                req.cwd,
                parser.tool_calls.len()
            ),
            final_status,
            duration_ms,
        );
    }

    DriverTurnOutput {
        text: parser.accumulated_text,
        thinking: parser.accumulated_thinking,
        tool_calls: parser.tool_calls,
        native_session_id: parser.native_session_id,
        duration_ms,
        cost_usd: parser.cost_usd,
        input_tokens: parser.input_tokens,
        output_tokens: parser.output_tokens,
        status: final_status.to_string(),
    }
}

async fn terminate_process_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The child starts in a new process group, so this cannot signal the app's group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

fn is_chat_cancelled(state: &SharedOmniState, chat_id: &str) -> bool {
    state
        .read()
        .map(|g| g.cancelled_chats.contains(chat_id))
        .unwrap_or(false)
}

// Accept terminal usage envelopes only. Streaming snapshots can repeat, refer to
// individual API calls, or omit cache tokens; they are not turn totals.
fn extract_usage_tokens(val: &Value, parser: &mut StreamParserState) {
    let kind = val.get("type").and_then(Value::as_str).unwrap_or("");
    let (usage, additive, id, cost) = match kind {
        "result" | "turn.completed" => (
            val.get("usage"),
            false,
            None,
            val.get("total_cost_usd").or_else(|| val.get("cost_usd")),
        ),
        "step_finish" => {
            let part = &val["part"];
            (
                part.get("tokens"),
                true,
                part.get("id").and_then(Value::as_str),
                part.get("cost"),
            )
        }
        // Pi reports one completed assistant message per API step.
        "message_end" if val["message"]["role"] == "assistant" => {
            let message = &val["message"];
            (
                message.get("usage"),
                true,
                message.get("id").and_then(Value::as_str),
                message.pointer("/usage/cost/total"),
            )
        }
        _ => return,
    };
    if let Some(id) = id {
        if !parser.usage_events.insert(format!("{kind}:{id}")) {
            return;
        }
    }
    let mut input = usage
        .and_then(|u| {
            u.get("input_tokens")
                .or_else(|| u.get("input"))
                .or_else(|| u.get("prompt_tokens"))
        })
        .and_then(Value::as_u64);
    let output = usage
        .and_then(|u| {
            u.get("output_tokens")
                .or_else(|| u.get("output"))
                .or_else(|| u.get("completion_tokens"))
        })
        .and_then(Value::as_u64);
    if let (Some(count), Some(u)) = (input, usage) {
        // Anthropic and Pi report cache reads/writes separately. Codex's
        // cached_input_tokens is already a subset of input_tokens.
        let cache = if kind == "step_finish" {
            u.pointer("/cache/read")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .checked_add(
                    u.pointer("/cache/write")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
        } else {
            u.get("cache_read_input_tokens")
                .or_else(|| u.get("cacheRead"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .checked_add(
                    u.get("cache_creation_input_tokens")
                        .or_else(|| u.get("cacheWrite"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
        };
        input = cache.and_then(|cache| count.checked_add(cache));
    }
    if !additive {
        parser.incomplete_input = false;
        parser.incomplete_output = false;
        parser.incomplete_cost = false;
    }
    parser.incomplete_input |= input.is_none();
    parser.incomplete_output |= output.is_none();
    let cost = cost
        .and_then(Value::as_f64)
        .filter(|c| c.is_finite() && *c >= 0.0);
    parser.incomplete_cost |= cost.is_none();
    fn assign(target: &mut Option<u64>, value: Option<u64>, additive: bool) {
        if let Some(value) = value {
            *target = if additive {
                target.unwrap_or(0).checked_add(value)
            } else {
                Some(value)
            };
        }
    }
    assign(&mut parser.input_tokens, input, additive);
    assign(&mut parser.output_tokens, output, additive);
    if let Some(cost) = cost {
        let cost = if additive {
            parser.cost_usd.unwrap_or(0.0) + cost
        } else {
            cost
        };
        parser.cost_usd = cost.is_finite().then_some(cost);
    }
    if parser.incomplete_input {
        parser.input_tokens = None;
    }
    if parser.incomplete_output {
        parser.output_tokens = None;
    }
    if parser.incomplete_cost {
        parser.cost_usd = None;
    }
}

fn reported_model(val: &Value) -> Option<String> {
    let kind = val.get("type").and_then(Value::as_str)?;
    if ![
        "system",
        "assistant",
        "result",
        "message_start",
        "stream_event",
        "message_end",
    ]
    .contains(&kind)
    {
        return None;
    }
    if let Some(models) = val
        .get("modelUsage")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty())
    {
        return Some(models.keys().cloned().collect::<Vec<_>>().join(" + "));
    }
    val.get("model")
        .or_else(|| val.pointer("/message/model"))
        .or_else(|| val.pointer("/event/message/model"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

fn parse_cli_output_line(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    raw_line: &str,
    parser: &mut StreamParserState,
) {
    let trimmed = raw_line.trim();
    if trimmed.is_empty() {
        return;
    }

    let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
        let clean = strip_ansi(raw_line);
        if !clean.trim().is_empty() {
            let chunk = if parser.accumulated_text.is_empty() {
                clean
            } else {
                format!("\n{clean}")
            };
            parser.accumulated_text.push_str(&chunk);
            update_message_delta(state, chat_id, message_id, bot_id, &chunk, false);
        }
        return;
    };

    // Capture session_id / thread_id / sessionID across Claude, Grok, Codex, OpenCode, Cursor, Pi
    for key in ["session_id", "thread_id", "sessionID", "chatId"] {
        if let Some(sid) = val.get(key).and_then(|v| v.as_str()) {
            if !sid.is_empty() {
                parser.native_session_id = Some(sid.to_string());
            }
        }
    }
    if val.get("type").and_then(|v| v.as_str()) == Some("session") {
        if let Some(sid) = val.get("id").and_then(|v| v.as_str()) {
            parser.native_session_id = Some(sid.to_string());
        }
    }

    // Provider-level failure envelopes can arrive even when the CLI exits zero.
    let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type == "turn.failed"
        || event_type == "error"
        || val
            .get("message")
            .and_then(|m| m.get("stopReason"))
            .and_then(Value::as_str)
            .is_some_and(|s| s == "error" || s == "aborted")
        || val.get("is_error").and_then(Value::as_bool) == Some(true)
    {
        parser.failed = true;
        let error = val
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .or_else(|| val.get("message"))
            .or_else(|| val.get("result"));
        let description = error
            .and_then(Value::as_str)
            .unwrap_or("Provider reported a failed turn.");
        let chunk = format!("\n\n{description}");
        parser.accumulated_text.push_str(&chunk);
        update_message_delta(state, chat_id, message_id, bot_id, &chunk, false);
    }
    extract_usage_tokens(&val, parser);
    if let Some(model) = reported_model(&val) {
        if let Ok(mut guard) = state.write() {
            if let Some(message) = guard
                .store
                .chats
                .iter_mut()
                .find(|c| c.id == chat_id)
                .and_then(|c| c.messages.iter_mut().find(|m| m.id == message_id))
            {
                message.model = Some(model);
                message.model_reported = true;
            }
        }
    }

    let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if event_type.is_empty() {
        let chunk = if parser.accumulated_text.is_empty() {
            trimmed.to_string()
        } else {
            format!("\n{trimmed}")
        };
        parser.accumulated_text.push_str(&chunk);
        update_message_delta(state, chat_id, message_id, bot_id, &chunk, false);
        return;
    }

    match event_type {
        // 1. Anthropic / Claude Code / Grok / Cursor partial stream_event
        "stream_event" => {
            if let Some(ev) = val.get("event") {
                handle_anthropic_stream_event(state, chat_id, message_id, bot_id, ev, parser);
            }
        }
        "message_start" | "content_block_start" | "content_block_delta" => {
            handle_anthropic_stream_event(state, chat_id, message_id, bot_id, &val, parser);
        }
        // 2. Claude / Grok / Cursor assistant message frame
        "assistant" => {
            let msg_obj = val.get("message");
            let frame_id = msg_obj
                .and_then(|m| m.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !frame_id.is_empty() && frame_id != parser.last_part_id {
                if !parser.last_part_id.is_empty() {
                    parser.current_block_text.clear();
                    parser.current_block_thinking.clear();
                    parser.needs_paragraph_break = true;
                }
                parser.last_part_id = frame_id.to_string();
            }

            if let Some(content_arr) = msg_obj
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in content_arr {
                    let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match btype {
                        "text" => {
                            if !parser.saw_text_deltas {
                                if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                                    if !txt.is_empty() {
                                        let delta = if txt.starts_with(&parser.current_block_text) {
                                            let slice = &txt[parser.current_block_text.len()..];
                                            if parser.needs_paragraph_break
                                                && !parser.accumulated_text.is_empty()
                                                && !slice.is_empty()
                                            {
                                                parser.needs_paragraph_break = false;
                                                format!("\n\n{slice}")
                                            } else {
                                                slice.to_string()
                                            }
                                        } else if parser.accumulated_text.is_empty() {
                                            txt.to_string()
                                        } else {
                                            format!("\n\n{txt}")
                                        };
                                        parser.current_block_text = txt.to_string();
                                        if !delta.is_empty() {
                                            parser.accumulated_text.push_str(&delta);
                                            update_message_delta(
                                                state, chat_id, message_id, bot_id, &delta, false,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        "thinking" => {
                            if !parser.saw_thinking_deltas {
                                if let Some(th) = block.get("thinking").and_then(|v| v.as_str()) {
                                    if !th.is_empty() {
                                        let delta = if th
                                            .starts_with(&parser.current_block_thinking)
                                        {
                                            th[parser.current_block_thinking.len()..].to_string()
                                        } else {
                                            th.to_string()
                                        };
                                        parser.current_block_thinking = th.to_string();
                                        if !delta.is_empty() {
                                            parser.accumulated_thinking.push_str(&delta);
                                            update_message_delta(
                                                state, chat_id, message_id, bot_id, &delta, true,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        "tool_use" => {
                            parser.current_block_text.clear();
                            parser.needs_paragraph_break = true;
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let input = block.get("input").cloned().unwrap_or(Value::Null);
                            let tool = build_tool_invocation(&id, &name, &input, "running", None);
                            upsert_tool_call(
                                state,
                                chat_id,
                                message_id,
                                bot_id,
                                &mut parser.tool_calls,
                                tool,
                            );
                        }
                        _ => {}
                    }
                }
            }
        }
        // 3. Tool results in Claude / Grok
        "user" => {
            parser.current_block_text.clear();
            parser.needs_paragraph_break = true;
            if let Some(content_arr) = val
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in content_arr {
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                        let tool_id = block
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let out_summary = summarize_json_value(block.get("content"));
                        complete_tool_call(
                            state,
                            chat_id,
                            message_id,
                            bot_id,
                            &mut parser.tool_calls,
                            tool_id,
                            block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            out_summary,
                        );
                    }
                }
            }
        }
        // 4. Final result envelope in Claude / Cursor / Grok
        "result" => {
            if parser.accumulated_text.trim().is_empty() {
                if let Some(res_txt) = val.get("result").and_then(|v| v.as_str()) {
                    if !res_txt.is_empty() {
                        parser.accumulated_text.push_str(res_txt);
                        update_message_delta(state, chat_id, message_id, bot_id, res_txt, false);
                    }
                }
            }
        }
        // 5. Codex JSONL item events (`item.started`, `item.updated`, `item.completed`)
        "item.started" | "item.updated" | "item.completed" => {
            if let Some(item) = val.get("item") {
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("codex_item")
                    .to_string();
                match item_type {
                    "agent_message" | "message" => {
                        if item_id != parser.last_part_id {
                            if !parser.last_part_id.is_empty() {
                                parser.current_block_text.clear();
                                parser.needs_paragraph_break = true;
                            }
                            parser.last_part_id = item_id.clone();
                        }
                        if let Some(txt) = item.get("text").and_then(|v| v.as_str()) {
                            let delta = if txt.starts_with(&parser.current_block_text) {
                                let slice = &txt[parser.current_block_text.len()..];
                                if parser.needs_paragraph_break
                                    && !parser.accumulated_text.is_empty()
                                    && !slice.is_empty()
                                {
                                    parser.needs_paragraph_break = false;
                                    format!("\n\n{slice}")
                                } else {
                                    slice.to_string()
                                }
                            } else if event_type == "item.completed"
                                && parser.current_block_text.is_empty()
                            {
                                if parser.accumulated_text.is_empty() {
                                    txt.to_string()
                                } else {
                                    format!("\n\n{txt}")
                                }
                            } else {
                                String::new()
                            };
                            parser.current_block_text = txt.to_string();
                            if !delta.is_empty() {
                                parser.accumulated_text.push_str(&delta);
                                update_message_delta(
                                    state, chat_id, message_id, bot_id, &delta, false,
                                );
                            }
                        }
                    }
                    "reasoning" => {
                        if let Some(th) = item.get("text").and_then(|v| v.as_str()) {
                            if !th.is_empty() && !parser.accumulated_thinking.contains(th) {
                                let chunk = if parser.accumulated_thinking.is_empty() {
                                    th.to_string()
                                } else {
                                    format!("\n{th}")
                                };
                                parser.accumulated_thinking.push_str(&chunk);
                                update_message_delta(
                                    state, chat_id, message_id, bot_id, &chunk, true,
                                );
                            }
                        }
                    }
                    "command_execution" => {
                        let cmd_str = item
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("shell command")
                            .to_string();
                        let status = if item.get("status").and_then(Value::as_str) == Some("failed")
                            || item
                                .get("exit_code")
                                .and_then(Value::as_i64)
                                .is_some_and(|code| code != 0)
                        {
                            "error"
                        } else if event_type == "item.completed" {
                            "completed"
                        } else {
                            "running"
                        };
                        let output_summary = item
                            .get("aggregated_output")
                            .and_then(|v| v.as_str())
                            .map(|s| s.lines().next().unwrap_or("").chars().take(100).collect());
                        let tool = ToolInvocation {
                            id: item_id,
                            name: "bash".to_string(),
                            input_summary: cmd_str.chars().take(120).collect(),
                            command: Some(cmd_str),
                            output_summary,
                            status: status.to_string(),
                        };
                        upsert_tool_call(
                            state,
                            chat_id,
                            message_id,
                            bot_id,
                            &mut parser.tool_calls,
                            tool,
                        );
                    }
                    "file_change" | "mcp_tool_call" => {
                        let name = item
                            .get("tool")
                            .or_else(|| item.get("type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or(item_type)
                            .to_string();
                        let status = if item.get("status").and_then(Value::as_str) == Some("failed")
                            || item
                                .get("exit_code")
                                .and_then(Value::as_i64)
                                .is_some_and(|code| code != 0)
                        {
                            "error"
                        } else if event_type == "item.completed" {
                            "completed"
                        } else {
                            "running"
                        };
                        let tool = build_tool_invocation(&item_id, &name, item, status, None);
                        upsert_tool_call(
                            state,
                            chat_id,
                            message_id,
                            bot_id,
                            &mut parser.tool_calls,
                            tool,
                        );
                    }
                    _ => {}
                }
            }
        }
        // 6. OpenCode JSONL events (`text`, `reasoning`, `tool_use`, `step_finish`)
        "text" => {
            let part_id = val
                .get("part")
                .and_then(|p| p.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !part_id.is_empty() && part_id != parser.last_part_id {
                if !parser.last_part_id.is_empty() {
                    parser.current_block_text.clear();
                    parser.needs_paragraph_break = true;
                }
                parser.last_part_id = part_id.to_string();
            }
            let txt = val
                .get("part")
                .and_then(|p| p.get("text"))
                .or_else(|| val.get("text"))
                .and_then(|v| v.as_str());
            if let Some(t) = txt.filter(|s| !s.is_empty()) {
                let delta = if t.starts_with(&parser.current_block_text) {
                    let slice = &t[parser.current_block_text.len()..];
                    if parser.needs_paragraph_break
                        && !parser.accumulated_text.is_empty()
                        && !slice.is_empty()
                    {
                        parser.needs_paragraph_break = false;
                        format!("\n\n{slice}")
                    } else {
                        slice.to_string()
                    }
                } else {
                    t.to_string()
                };
                parser.current_block_text = t.to_string();
                if !delta.is_empty() {
                    parser.accumulated_text.push_str(&delta);
                    update_message_delta(state, chat_id, message_id, bot_id, &delta, false);
                }
            }
        }
        "reasoning" | "thinking" => {
            let th = val
                .get("part")
                .and_then(|p| p.get("text"))
                .or_else(|| val.get("text"))
                .or_else(|| val.get("thinking"))
                .and_then(|v| v.as_str());
            if let Some(t) = th.filter(|s| !s.is_empty()) {
                parser.accumulated_thinking.push_str(t);
                update_message_delta(state, chat_id, message_id, bot_id, t, true);
            }
        }
        "tool_use" => {
            parser.current_block_text.clear();
            parser.needs_paragraph_break = true;
            if let Some(part) = val.get("part") {
                let id = part
                    .get("callID")
                    .or_else(|| part.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let name = part
                    .get("tool")
                    .or_else(|| part.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let state_obj = part.get("state");
                let status_raw = state_obj
                    .and_then(|s| s.get("status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed");
                let input = state_obj
                    .and_then(|s| s.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let out_summary = summarize_json_value(state_obj.and_then(|s| s.get("output")));
                let tool = build_tool_invocation(&id, &name, &input, status_raw, out_summary);
                upsert_tool_call(
                    state,
                    chat_id,
                    message_id,
                    bot_id,
                    &mut parser.tool_calls,
                    tool,
                );
            }
        }
        // 7. Pi JSONL events (`message_update`, `tool_execution_start`, `tool_execution_end`)
        "message_update" => {
            if let Some(ame) = val.get("assistantMessageEvent") {
                let sub = ame.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if sub == "text_delta" {
                    if let Some(d) = ame.get("delta").and_then(|v| v.as_str()) {
                        parser.saw_text_deltas = true;
                        parser.accumulated_text.push_str(d);
                        update_message_delta(state, chat_id, message_id, bot_id, d, false);
                    }
                } else if sub == "thinking_delta" {
                    if let Some(d) = ame.get("delta").and_then(|v| v.as_str()) {
                        parser.saw_thinking_deltas = true;
                        parser.accumulated_thinking.push_str(d);
                        update_message_delta(state, chat_id, message_id, bot_id, d, true);
                    }
                }
            }
        }
        "tool_execution_start" | "tool_execution_end" => {
            let id = val
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("pi_tool")
                .to_string();
            let name = val
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let status = if val.get("isError").and_then(Value::as_bool) == Some(true) {
                "error"
            } else if event_type == "tool_execution_end" {
                "completed"
            } else {
                "running"
            };
            let input = val.get("args").cloned().unwrap_or(Value::Null);
            let out_summary = summarize_json_value(val.get("result"));
            let tool = build_tool_invocation(&id, &name, &input, status, out_summary);
            upsert_tool_call(
                state,
                chat_id,
                message_id,
                bot_id,
                &mut parser.tool_calls,
                tool,
            );
        }
        _ => {}
    }
}

fn handle_anthropic_stream_event(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    ev: &Value,
    parser: &mut StreamParserState,
) {
    extract_usage_tokens(ev, parser);
    let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if ev_type == "message_start" {
        parser.saw_text_deltas = false;
        parser.saw_thinking_deltas = false;
        parser.current_block_text.clear();
        parser.current_block_thinking.clear();
    } else if ev_type == "content_block_start" {
        if let Some(cb) = ev.get("content_block") {
            let cb_type = cb.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if cb_type == "text" && !parser.accumulated_text.is_empty() {
                parser.needs_paragraph_break = true;
            }
        }
    } else if ev_type == "content_block_delta" {
        if let Some(delta) = ev.get("delta") {
            let dtype = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if dtype == "text_delta" {
                if let Some(txt) = delta.get("text").and_then(|v| v.as_str()) {
                    if !txt.is_empty() {
                        parser.saw_text_deltas = true;
                        let out_chunk = if parser.needs_paragraph_break
                            && !parser.accumulated_text.ends_with('\n')
                            && !txt.starts_with('\n')
                        {
                            parser.needs_paragraph_break = false;
                            format!("\n\n{txt}")
                        } else {
                            parser.needs_paragraph_break = false;
                            txt.to_string()
                        };
                        parser.accumulated_text.push_str(&out_chunk);
                        update_message_delta(state, chat_id, message_id, bot_id, &out_chunk, false);
                    }
                }
            } else if dtype == "thinking_delta" {
                if let Some(th) = delta.get("thinking").and_then(|v| v.as_str()) {
                    if !th.is_empty() {
                        parser.saw_thinking_deltas = true;
                        parser.accumulated_thinking.push_str(th);
                        update_message_delta(state, chat_id, message_id, bot_id, th, true);
                    }
                }
            }
        }
    }
}

fn build_tool_invocation(
    id: &str,
    name: &str,
    input: &Value,
    status: &str,
    output_summary: Option<String>,
) -> ToolInvocation {
    let cmd = input
        .get("command")
        .or_else(|| input.get("cmd"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let input_summary = if let Some(p) = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("pattern"))
        .or_else(|| input.get("query"))
        .or_else(|| input.get("description"))
        .and_then(|v| v.as_str())
    {
        p.chars().take(120).collect()
    } else if let Some(c) = &cmd {
        c.chars().take(120).collect()
    } else {
        summarize_json_value(Some(input)).unwrap_or_default()
    };

    ToolInvocation {
        id: id.to_string(),
        name: name.to_string(),
        input_summary,
        command: cmd,
        output_summary,
        status: status.to_string(),
    }
}

fn summarize_json_value(val: Option<&Value>) -> Option<String> {
    let v = val?;
    if let Some(s) = v.as_str() {
        let first = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Some(first.chars().take(110).collect());
    }
    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                let first = t.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                return Some(first.chars().take(110).collect());
            }
        }
    }
    let raw = v.to_string();
    if raw == "null" || raw == "{}" {
        None
    } else {
        Some(raw.chars().take(100).collect())
    }
}

fn update_message_delta(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    delta: &str,
    is_thinking: bool,
) {
    let Ok(mut guard) = state.write() else {
        return;
    };
    if let Some(run) = guard.active_runs.get_mut(message_id) {
        run.activity = if is_thinking {
            "thinking".to_string()
        } else {
            "writing".to_string()
        };
    }
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
        if let Some(msg) = chat.messages.iter_mut().find(|m| m.id == message_id) {
            if is_thinking {
                msg.thinking.push_str(delta);
            } else {
                msg.text.push_str(delta);
            }
        }
        chat.updated_at_ms = now_ms();
    }
    let ev = if is_thinking {
        OmniStreamEvent::ThinkingDelta {
            chat_id: chat_id.to_string(),
            message_id: message_id.to_string(),
            bot_id: bot_id.to_string(),
            delta: delta.to_string(),
        }
    } else {
        OmniStreamEvent::TextDelta {
            chat_id: chat_id.to_string(),
            message_id: message_id.to_string(),
            bot_id: bot_id.to_string(),
            delta: delta.to_string(),
        }
    };
    guard.emit(ev);
}

fn upsert_tool_call(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    local_tools: &mut Vec<ToolInvocation>,
    tool: ToolInvocation,
) {
    if let Some(existing) = local_tools.iter_mut().find(|t| t.id == tool.id) {
        existing.status = tool.status.clone();
        if tool.output_summary.is_some() {
            existing.output_summary = tool.output_summary.clone();
        }
    } else {
        local_tools.push(tool.clone());
    }

    let Ok(mut guard) = state.write() else {
        return;
    };
    if let Some(run) = guard.active_runs.get_mut(message_id) {
        run.activity = format!("tool:{}", tool.name);
    }
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
        if let Some(msg) = chat.messages.iter_mut().find(|m| m.id == message_id) {
            if let Some(existing) = msg.tool_calls.iter_mut().find(|t| t.id == tool.id) {
                existing.status = tool.status.clone();
                if tool.output_summary.is_some() {
                    existing.output_summary = tool.output_summary.clone();
                }
            } else {
                msg.tool_calls.push(tool.clone());
            }
        }
    }
    guard.emit(OmniStreamEvent::ToolCall {
        chat_id: chat_id.to_string(),
        message_id: message_id.to_string(),
        bot_id: bot_id.to_string(),
        tool,
    });
}

#[allow(clippy::too_many_arguments)]
fn complete_tool_call(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    local_tools: &mut Vec<ToolInvocation>,
    tool_id: &str,
    failed: bool,
    output_summary: Option<String>,
) {
    let updated = if let Some(t) = local_tools.iter_mut().find(|t| t.id == tool_id) {
        t.status = if failed { "error" } else { "completed" }.to_string();
        if output_summary.is_some() {
            t.output_summary = output_summary;
        }
        Some(t.clone())
    } else {
        None
    };

    if let Some(tool) = updated {
        upsert_tool_call(state, chat_id, message_id, bot_id, local_tools, tool);
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_active_run(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    status: &str,
    duration_ms: u64,
    cost_usd: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
) {
    let Ok(mut guard) = state.write() else {
        return;
    };
    guard.active_runs.remove(message_id);
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
        if let Some(msg) = chat.messages.iter_mut().find(|m| m.id == message_id) {
            msg.status = status.to_string();
            msg.duration_ms = Some(duration_ms);
            msg.usage_reported = true;
            if cost_usd.is_some() {
                msg.cost_usd = cost_usd;
            }
            if input_tokens.is_some() {
                msg.input_tokens = input_tokens;
            }
            if output_tokens.is_some() {
                msg.output_tokens = output_tokens;
            }
            for t in &mut msg.tool_calls {
                if t.status == "running" {
                    t.status = if status == "complete" {
                        "completed"
                    } else {
                        status
                    }
                    .to_string();
                }
            }
        }
        chat.updated_at_ms = now_ms();
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::TurnFinished {
        chat_id: chat_id.to_string(),
        message_id: message_id.to_string(),
        bot_id: bot_id.to_string(),
        status: status.to_string(),
        duration_ms,
    });
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some(&'[') => {
                    let _ = chars.next();
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(&']') => {
                    let _ = chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            let _ = chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c != '\r' && c != '\x08' {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    use serde_json::json;

    fn feed(f: &Fixture, parser: &mut StreamParserState, event: Value) {
        parse_cli_output_line(&f.state, "room", "message", "A", &event.to_string(), parser);
    }

    #[test]
    fn streamed_thinking_does_not_swallow_final_text() {
        let f = Fixture::new(&["A"]);
        let mut p = StreamParserState::default();
        feed(
            &f,
            &mut p,
            json!({"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Reason"}}),
        );
        feed(
            &f,
            &mut p,
            json!({"type":"assistant","message":{"id":"one","content":[{"type":"thinking","thinking":"Reason"},{"type":"text","text":"Answer"}]}}),
        );
        assert_eq!(p.accumulated_text, "Answer");
        assert_eq!(p.accumulated_thinking, "Reason");
    }

    #[test]
    fn streamed_text_is_not_duplicated_by_final_message() {
        let f = Fixture::new(&["A"]);
        let mut p = StreamParserState::default();
        feed(
            &f,
            &mut p,
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}),
        );
        feed(
            &f,
            &mut p,
            json!({"type":"assistant","message":{"id":"one","content":[{"type":"text","text":"Hello"}]}}),
        );
        feed(&f, &mut p, json!({"type":"result","result":"Hello"}));
        assert_eq!(p.accumulated_text, "Hello");
    }

    #[test]
    fn codex_incremental_items_and_provider_errors() {
        let f = Fixture::new(&["A"]);
        let mut p = StreamParserState::default();
        for (kind, text) in [
            ("item.started", "H"),
            ("item.updated", "Hello"),
            ("item.completed", "Hello"),
        ] {
            feed(
                &f,
                &mut p,
                json!({"type":kind,"item":{"id":"item1","type":"agent_message","text":text}}),
            );
        }
        assert_eq!(p.accumulated_text, "Hello");
        feed(
            &f,
            &mut p,
            json!({"type":"turn.failed","error":{"message":"Rate limit"}}),
        );
        assert!(p.failed);
        assert!(p.accumulated_text.contains("Rate limit"));
    }

    #[test]
    fn opencode_costs_accumulate_across_steps() {
        let mut p = StreamParserState::default();
        for cost in [0.1, 0.2] {
            extract_usage_tokens(&json!({"type":"step_finish","part":{"cost":cost}}), &mut p);
        }
        assert!((p.cost_usd.unwrap() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn terminal_usage_replaces_stream_snapshots_and_includes_cache_without_double_counting() {
        let mut p = StreamParserState::default();
        extract_usage_tokens(
            &json!({"type":"assistant","message":{"usage":{"input_tokens":99,"output_tokens":1}}}),
            &mut p,
        );
        assert!(p.input_tokens.is_none());
        let result = json!({"type":"result","usage":{"input_tokens":100,"cache_read_input_tokens":200,"cache_creation_input_tokens":50,"output_tokens":25},"total_cost_usd":0.012345});
        extract_usage_tokens(&result, &mut p);
        extract_usage_tokens(&result, &mut p);
        assert_eq!(p.input_tokens, Some(350));
        assert_eq!(p.output_tokens, Some(25));
        assert_eq!(p.cost_usd, Some(0.012345));
        extract_usage_tokens(
            &json!({"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10}}),
            &mut p,
        );
        assert_eq!(p.input_tokens, Some(100));
        assert_eq!(p.output_tokens, Some(10));
        assert_eq!(p.cost_usd, None);
    }

    #[test]
    fn steps_sum_once_and_missing_usage_is_never_filled_with_guesses() {
        let mut p = StreamParserState::default();
        let step = json!({"type":"step_finish","part":{"id":"one","cost":0.1,"tokens":{"input":10,"output":5,"cache":{"read":20,"write":3}}}});
        extract_usage_tokens(&step, &mut p);
        extract_usage_tokens(&step, &mut p);
        extract_usage_tokens(
            &json!({"type":"step_finish","part":{"id":"two","cost":0.2,"tokens":{"input":7,"output":2}}}),
            &mut p,
        );
        assert_eq!(p.input_tokens, Some(40));
        assert_eq!(p.output_tokens, Some(7));
        assert!((p.cost_usd.unwrap() - 0.3).abs() < 1e-9);
        extract_usage_tokens(
            &json!({"type":"step_finish","part":{"id":"missing"}}),
            &mut p,
        );
        extract_usage_tokens(
            &json!({"type":"step_finish","part":{"id":"later","cost":0.1,"tokens":{"input":1,"output":1}}}),
            &mut p,
        );
        assert!(p.input_tokens.is_none() && p.output_tokens.is_none() && p.cost_usd.is_none());
    }

    #[test]
    fn pi_completed_usage_and_reported_model_are_preserved() {
        let mut p = StreamParserState::default();
        extract_usage_tokens(
            &json!({"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":20,"cacheWrite":3,"cost":{"total":0.0}}}}),
            &mut p,
        );
        assert_eq!(p.input_tokens, Some(33));
        assert_eq!(p.output_tokens, Some(5));
        assert_eq!(p.cost_usd, Some(0.0));
        assert_eq!(
            reported_model(&json!({"type":"assistant","message":{"model":"actual-model"}})),
            Some("actual-model".into())
        );
        assert_eq!(
            reported_model(&json!({"type":"result","modelUsage":{"first":{},"second":{}}})),
            Some("first + second".into())
        );
        assert_eq!(
            reported_model(&json!({"type":"user","model":"not-provider-metadata"})),
            None
        );
    }

    #[tokio::test]
    async fn claude_standard_permissions_do_not_enable_auto_editing() {
        for (mode, approve, expected) in [
            ("auto", false, None),
            ("plan", false, Some("plan")),
            ("auto", true, Some("--dangerously-skip-permissions")),
        ] {
            let f = Fixture::new(&["A"]);
            f.script("A", "printf '%s\\n' \"$@\" > cli-args.txt\necho Done");
            let mut bot = f.state.read().unwrap().store.bots[0].clone();
            bot.cli_driver = CliDriverKind::Claude;
            bot.permission_mode = mode.into();
            let result = execute_bot_turn(
                f.state.clone(),
                DriverTurnRequest {
                    chat_id: "room".into(),
                    message_id: "message".into(),
                    bot,
                    prompt: "Hello".into(),
                    system_context: String::new(),
                    cwd: f.dir.to_string_lossy().into_owned(),
                    resume_session_id: None,
                    approve_all: approve,
                    turn_timeout_secs: 5,
                    max_budget_usd: None,
                },
            )
            .await;
            assert_eq!(result.status, "complete");
            let args = std::fs::read_to_string(f.dir.join("cli-args.txt")).unwrap();
            assert!(!args.lines().any(|arg| arg == "acceptEdits"));
            if let Some(expected) = expected {
                assert!(args.lines().any(|arg| arg == expected));
            } else {
                assert!(!args.contains("--permission-mode"));
                assert!(!args.contains("--dangerously-skip-permissions"));
            }
        }
    }

    #[tokio::test]
    async fn plain_output_has_no_invented_tokens_or_cost() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo 'Hello from a local fixture'");
        crate::orchestrator::dispatch_chat_turn(f.state.clone(), crate::test_support::input("Hi"))
            .await
            .unwrap();
        f.wait().await;
        let guard = f.state.read().unwrap();
        let reply = guard.store.chats[0]
            .messages
            .iter()
            .find(|m| m.role == "assistant")
            .unwrap();
        assert!(reply.usage_reported);
        assert!(
            reply.input_tokens.is_none()
                && reply.output_tokens.is_none()
                && reply.cost_usd.is_none()
        );
        assert!(reply.duration_ms.is_some());
    }

    #[test]
    fn unknown_tool_result_does_not_complete_another_tool() {
        let f = Fixture::new(&["A"]);
        let mut tools = vec![build_tool_invocation(
            "one",
            "bash",
            &Value::Null,
            "running",
            None,
        )];
        complete_tool_call(
            &f.state, "room", "message", "A", &mut tools, "missing", false, None,
        );
        assert_eq!(tools[0].status, "running");
    }

    #[test]
    fn plain_json_answers_are_preserved() {
        let f = Fixture::new(&["A"]);
        let mut p = StreamParserState::default();
        feed(&f, &mut p, json!({"answer": 42}));
        assert_eq!(p.accumulated_text, "{\"answer\":42}");
    }

    #[test]
    fn failed_tool_results_remain_failed() {
        let f = Fixture::new(&["A"]);
        let mut p = StreamParserState::default();
        feed(
            &f,
            &mut p,
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"one","name":"bash","input":{}}]}}),
        );
        feed(
            &f,
            &mut p,
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"one","is_error":true,"content":"command failed"}]}}),
        );
        assert_eq!(p.tool_calls[0].status, "error");
    }

    #[tokio::test]
    async fn zero_exit_provider_error_is_failed() {
        let f = Fixture::new(&["A"]);
        f.script(
            "A",
            "echo '{\"type\":\"result\",\"is_error\":true,\"result\":\"Provider error\"}'",
        );
        crate::orchestrator::dispatch_chat_turn(
            f.state.clone(),
            crate::test_support::input("Start"),
        )
        .await
        .unwrap();
        f.wait().await;
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
    async fn stderr_eof_does_not_starve_stdout_or_timer() {
        let f = Fixture::new(&["A"]);
        f.script("A", "exec 2>&-\nsleep 0.05\necho EXPECTED");
        crate::orchestrator::dispatch_chat_turn(
            f.state.clone(),
            crate::test_support::input("Start"),
        )
        .await
        .unwrap();
        f.wait().await;
        let g = f.state.read().unwrap();
        assert_eq!(g.store.chats[0].messages.last().unwrap().text, "EXPECTED");
        assert_eq!(g.store.chats[0].messages.last().unwrap().status, "complete");
    }
    #[tokio::test]
    async fn ollama_without_a_model_never_starts_or_downloads_one() {
        let f = Fixture::new(&["A"]);
        f.script("A", "touch should-not-run");
        f.state.write().unwrap().store.bots[0].cli_driver = CliDriverKind::Ollama;
        crate::orchestrator::dispatch_chat_turn(
            f.state.clone(),
            crate::test_support::input("Start"),
        )
        .await
        .unwrap();
        f.wait().await;
        assert!(!f.dir.join("should-not-run").exists());
        let guard = f.state.read().unwrap();
        let message = guard.store.chats[0].messages.last().unwrap();
        assert_eq!(message.status, "error");
        assert!(message.text.contains("Choose an installed Ollama model"));
    }
}
