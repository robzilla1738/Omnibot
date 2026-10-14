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
    saw_partial_deltas: bool,
    needs_paragraph_break: bool,
    tool_calls: Vec<ToolInvocation>,
    native_session_id: Option<String>,
    cost_usd: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

fn resolve_driver_binary(bot: &BotProfile) -> Option<(String, Vec<String>)> {
    if let Some(custom) = bot.custom_command.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let parts: Vec<&str> = custom.split_whitespace().collect();
        if let Some((first, rest)) = parts.split_first() {
            if let Some(bin) = find_binary(&[first]) {
                return Some((bin, rest.iter().map(|s| (*s).to_string()).collect()));
            }
        }
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

pub async fn execute_bot_turn(
    state: SharedOmniState,
    req: DriverTurnRequest,
) -> DriverTurnOutput {
    let start = Instant::now();
    let kind = req.bot.cli_driver;

    let Some((binary_path, extra_custom_args)) = resolve_driver_binary(&req.bot) else {
        let err_msg = format!(
            "Local CLI binary for **{}** (`{}`) was not found on your PATH. Open **CLI Harnesses** in the sidebar to inspect or switch {}'s driver.",
            kind.display_name(),
            kind.as_str(),
            req.bot.name
        );
        update_message_delta(&state, &req.chat_id, &req.message_id, &req.bot.id, &err_msg, false);
        finish_active_run(&state, &req.chat_id, &req.message_id, &req.bot.id, "error", 0, None, None, None);
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
            if matches!(
                req.bot.reasoning_effort.as_str(),
                "low" | "medium" | "high"
            ) {
                cmd.args(["--effort", &req.bot.reasoning_effort]);
            }
            if req.bot.permission_mode == "plan" {
                cmd.args(["--permission-mode", "plan"]);
            } else if req.approve_all || req.bot.permission_mode == "bypassPermissions" {
                cmd.arg("--dangerously-skip-permissions");
            } else {
                cmd.args(["--permission-mode", "acceptEdits"]);
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
                cmd.args(["-s", "read-only"]);
            } else if req.approve_all {
                cmd.args(["-s", "workspace-write"]);
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
                cmd.args(["--session-id", sid]);
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
        }
        CliDriverKind::Aider => {
            cmd.args(["--yes", "--no-pretty", "--message", &combined_prompt]);
        }
        CliDriverKind::Ollama => {
            let model = req
                .bot
                .model
                .clone()
                .unwrap_or_else(|| "qwen2.5-coder:32b".to_string());
            cmd.args(["run", &model, &combined_prompt]);
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
            update_message_delta(&state, &req.chat_id, &req.message_id, &req.bot.id, &err_text, false);
            finish_active_run(&state, &req.chat_id, &req.message_id, &req.bot.id, "error", 0, None, None, None);
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
    let mut hit_guardrail: Option<String> = None;

    let timeout_limit = Duration::from_secs(req.turn_timeout_secs.clamp(30, 1800));
    let budget_limit = req
        .bot
        .max_turn_budget_usd
        .or(req.max_budget_usd)
        .filter(|b| *b > 0.0);

    loop {
        if is_chat_cancelled(&state, &req.chat_id) {
            was_cancelled = true;
            let _ = child.kill().await;
            break;
        }

        if start.elapsed() > timeout_limit {
            hit_guardrail = Some(format!(
                "\n\n> **Guardrail triggered**: Turn exceeded {}s timeout limit.",
                timeout_limit.as_secs()
            ));
            let _ = child.kill().await;
            break;
        }

        if let (Some(limit), Some(actual_cost)) = (budget_limit, parser.cost_usd) {
            if actual_cost > limit {
                hit_guardrail = Some(format!(
                    "\n\n> **Budget guardrail triggered**: Turn cost (${:.3}) exceeded max turn budget (${:.2}).",
                    actual_cost, limit
                ));
                let _ = child.kill().await;
                break;
            }
        }

        tokio::select! {
            line_res = stdout_lines.next_line() => {
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
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            err_res = stderr_lines.next_line() => {
                if let Ok(Some(err_line)) = err_res {
                    let clean = strip_ansi(&err_line);
                    if !clean.trim().is_empty() && stderr_buf.len() < 40 {
                        stderr_buf.push(clean);
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(160)) => {
                if is_chat_cancelled(&state, &req.chat_id) {
                    was_cancelled = true;
                    let _ = child.kill().await;
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

    if parser.accumulated_text.trim().is_empty() && !stderr_buf.is_empty() && !was_cancelled {
        let joined_err = stderr_buf.join("\n");
        // Check if session resume failed (e.g. expired or invalid session ID)
        let formatted_err = format!("```\n{}\n```", joined_err.trim());
        parser.accumulated_text = formatted_err.clone();
        update_message_delta(
            &state,
            &req.chat_id,
            &req.message_id,
            &req.bot.id,
            &formatted_err,
            false,
        );
    }

    // Fallback token estimation when CLI does not emit explicit token usage
    let est_in = parser.input_tokens.unwrap_or_else(|| {
        ((req.prompt.len() + req.system_context.len()) as u64 / 4).max(1)
    });
    let est_out = parser.output_tokens.unwrap_or_else(|| {
        ((parser.accumulated_text.len() + parser.accumulated_thinking.len()) as u64 / 4).max(1)
    });

    let final_status = if was_cancelled || hit_guardrail.is_some() {
        "stopped"
    } else if exit_status.is_some_and(|s| s.success()) || !parser.accumulated_text.trim().is_empty() {
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
        Some(est_in),
        Some(est_out),
    );

    if let Ok(mut guard) = state.write() {
        guard.record_activity(
            &format!("{} ({})", req.bot.name, kind.as_str()),
            format!(
                "Completed turn in {} (~{} in / {} out tok, {} tools)",
                req.cwd,
                est_in,
                est_out,
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
        input_tokens: Some(est_in),
        output_tokens: Some(est_out),
        status: final_status.to_string(),
    }
}

fn is_chat_cancelled(state: &SharedOmniState, chat_id: &str) -> bool {
    state
        .read()
        .map(|g| g.cancelled_chats.contains(chat_id))
        .unwrap_or(false)
}

fn extract_usage_tokens(val: &Value, parser: &mut StreamParserState) {
    let usage = val
        .get("usage")
        .or_else(|| val.get("message").and_then(|m| m.get("usage")))
        .or_else(|| val.get("event").and_then(|e| e.get("usage")))
        .or_else(|| {
            val.get("event")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.get("usage"))
        })
        .or_else(|| val.get("part").and_then(|p| p.get("tokens")));

    if let Some(u) = usage {
        if let Some(inp) = u
            .get("input_tokens")
            .or_else(|| u.get("input"))
            .or_else(|| u.get("prompt_tokens"))
            .and_then(|v| v.as_u64())
        {
            let cached = u
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            parser.input_tokens = Some(inp + cached);
        }
        if let Some(out) = u
            .get("output_tokens")
            .or_else(|| u.get("output"))
            .or_else(|| u.get("completion_tokens"))
            .and_then(|v| v.as_u64())
        {
            parser.output_tokens = Some(out);
        }
    }

    if let Some(c) = val
        .get("total_cost_usd")
        .or_else(|| val.get("cost_usd"))
        .or_else(|| val.get("part").and_then(|p| p.get("cost")))
        .and_then(|v| v.as_f64())
    {
        if c > 0.0 {
            parser.cost_usd = Some(c);
        }
    }
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

    extract_usage_tokens(&val, parser);

    let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event_type {
        // 1. Anthropic / Claude Code / Grok / Cursor partial stream_event
        "stream_event" => {
            if let Some(ev) = val.get("event") {
                handle_anthropic_stream_event(state, chat_id, message_id, bot_id, ev, parser);
            }
        }
        "content_block_start" | "content_block_delta" => {
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
                            if !parser.saw_partial_deltas {
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
                            if !parser.saw_partial_deltas {
                                if let Some(th) = block.get("thinking").and_then(|v| v.as_str()) {
                                    if !th.is_empty() {
                                        let delta = if th.starts_with(&parser.current_block_thinking)
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
                        let status = if event_type == "item.completed" {
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
                        let status = if event_type == "item.completed" {
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
                        parser.saw_partial_deltas = true;
                        parser.accumulated_text.push_str(d);
                        update_message_delta(state, chat_id, message_id, bot_id, d, false);
                    }
                } else if sub == "thinking_delta" {
                    if let Some(d) = ame.get("delta").and_then(|v| v.as_str()) {
                        parser.saw_partial_deltas = true;
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
            let status = if event_type == "tool_execution_end" {
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

    if ev_type == "content_block_start" {
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
                        parser.saw_partial_deltas = true;
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
                        parser.saw_partial_deltas = true;
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

fn complete_tool_call(
    state: &SharedOmniState,
    chat_id: &str,
    message_id: &str,
    bot_id: &str,
    local_tools: &mut Vec<ToolInvocation>,
    tool_id: &str,
    output_summary: Option<String>,
) {
    let updated = if let Some(t) = local_tools.iter_mut().find(|t| t.id == tool_id) {
        t.status = "completed".to_string();
        if output_summary.is_some() {
            t.output_summary = output_summary;
        }
        Some(t.clone())
    } else if let Some(last) = local_tools.last_mut() {
        last.status = "completed".to_string();
        if output_summary.is_some() {
            last.output_summary = output_summary;
        }
        Some(last.clone())
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
                    t.status = "completed".to_string();
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
