//! Bounded, in-memory process output and explicitly owned interactive PTYs.
use crate::drivers::{resolve_driver_binary, DriverTurnRequest};
use crate::execution;
use crate::scanner::{augmented_path_env, CliDriverKind};
use crate::state::{now_ms, OmniRuntimeState, OmniStreamEvent, SharedOmniState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard, PoisonError, RwLockReadGuard, RwLockWriteGuard,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, ReadBuf};

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const SESSION_LIMIT: usize = 32;
const CHUNK_LIMIT: usize = 64 * 1024;
/// How long to keep draining output after the process exits before giving up on a
/// detached grandchild that still holds the PTY open.
const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(250);

// Session data stays usable even if a panicking thread poisoned a lock.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn read(state: &SharedOmniState) -> RwLockReadGuard<'_, OmniRuntimeState> {
    state.read().unwrap_or_else(PoisonError::into_inner)
}
fn write(state: &SharedOmniState) -> RwLockWriteGuard<'_, OmniRuntimeState> {
    state.write().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub chat_id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub mode: &'static str,
    pub status: String,
    pub cwd: String,
    pub started_at_ms: u64,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
    pub resumed: bool,
}

#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    end: u64,
}

pub struct TerminalSession {
    info: Mutex<TerminalInfo>,
    output: Mutex<Output>,
    commands: Mutex<Option<mpsc::SyncSender<Input>>>,
    stop: AtomicBool,
}

enum Input {
    Write(Vec<u8>),
    Resize(u16, u16),
}

impl TerminalSession {
    fn new(info: TerminalInfo) -> Arc<Self> {
        Arc::new(Self {
            info: Mutex::new(info),
            output: Mutex::new(Output::default()),
            commands: Mutex::new(None),
            stop: AtomicBool::new(false),
        })
    }

    pub fn append(&self, bytes: &[u8]) {
        let mut output = lock(&self.output);
        output.end += bytes.len() as u64;
        if bytes.len() >= OUTPUT_LIMIT {
            output.bytes.clear();
            output.bytes.extend(&bytes[bytes.len() - OUTPUT_LIMIT..]);
        } else {
            let excess = (output.bytes.len() + bytes.len()).saturating_sub(OUTPUT_LIMIT);
            output.bytes.drain(..excess);
            output.bytes.extend(bytes);
        }
    }

    pub fn finish(&self, status: &str, code: Option<u32>, error: Option<String>) {
        let mut info = lock(&self.info);
        info.status = status.into();
        info.exit_code = code;
        info.error = error.or_else(|| {
            (status == "error").then(|| {
                code.map(|code| format!("Process exited with code {code}."))
                    .unwrap_or_else(|| "Process failed.".into())
            })
        });
        lock(&self.commands).take();
    }

    fn is_active(&self) -> bool {
        matches!(lock(&self.info).status.as_str(), "queued" | "running")
    }

    fn send(&self, input: Input) -> Result<(), String> {
        lock(&self.commands)
            .as_ref()
            .ok_or("This terminal is not accepting input.")?
            .try_send(input)
            .map_err(|_| "Terminal input is busy or the process exited. Try again.".into())
    }
}

fn register(guard: &mut OmniRuntimeState, session: Arc<TerminalSession>) -> Result<(), String> {
    while guard.terminals.len() >= SESSION_LIMIT {
        let oldest = guard
            .terminals
            .iter()
            .filter(|(_, session)| !session.is_active())
            .min_by_key(|(_, session)| lock(&session.info).started_at_ms)
            .map(|(id, _)| id.clone());
        let Some(oldest) = oldest else {
            return Err(format!(
                "{SESSION_LIMIT} terminals are already running. Stop one before starting another."
            ));
        };
        guard.terminals.remove(&oldest);
    }
    let id = lock(&session.info).id.clone();
    guard.terminals.insert(id, session);
    Ok(())
}

pub fn has_active_session(guard: &OmniRuntimeState, chat_id: &str) -> bool {
    guard
        .terminals
        .values()
        .any(|session| session.is_active() && lock(&session.info).chat_id == chat_id)
}

/// Stops and forgets every terminal that belongs to a deleted chat.
pub fn remove_chat_sessions(guard: &mut OmniRuntimeState, chat_id: &str) {
    // Called from chat deletion, which already requires the chat to be idle.
    guard.terminals.retain(|_, session| {
        if lock(&session.info).chat_id != chat_id {
            return true;
        }
        session.stop.store(true, Ordering::Relaxed);
        false
    });
}

pub fn record_run(state: &SharedOmniState, req: &DriverTurnRequest) -> Arc<TerminalSession> {
    let session = TerminalSession::new(TerminalInfo {
        id: req.message_id.clone(),
        chat_id: req.chat_id.clone(),
        bot_id: req.bot.id.clone(),
        bot_name: req.bot.name.clone(),
        mode: "output",
        status: "running".into(),
        cwd: req.cwd.clone(),
        started_at_ms: now_ms(),
        exit_code: None,
        error: None,
        resumed: req.resume_session_id.is_some(),
    });
    // At capacity the run still records output; it just isn't listed in the panel.
    if let Err(error) = register(&mut write(state), session.clone()) {
        eprintln!(
            "Terminal output for {} is not listed: {error}",
            req.message_id
        );
    }
    session
}

/// Tap bytes before line parsing, including prompts that have no trailing newline.
pub struct RecordedReader<R> {
    reader: R,
    session: Arc<TerminalSession>,
}
impl<R> RecordedReader<R> {
    pub fn new(reader: R, session: Arc<TerminalSession>) -> Self {
        Self { reader, session }
    }
}
impl<R: AsyncRead + Unpin> AsyncRead for RecordedReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.reader).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            self.session.append(&buf.filled()[before..]);
        }
        result
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub chat_id: String,
    pub bot_id: String,
    pub cols: u16,
    pub rows: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuery {
    pub id: String,
    #[serde(default)]
    pub offset: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuery {
    pub chat_id: String,
}
#[derive(Deserialize)]
pub struct WriteInput {
    pub id: String,
    /// Standard base64 with padding.
    pub data: String,
}
#[derive(Deserialize)]
pub struct ResizeInput {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

fn dimensions(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("Invalid terminal dimensions.".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn session(state: &SharedOmniState, id: &str) -> Result<Arc<TerminalSession>, String> {
    state
        .read()
        .map_err(|_| "State lock poisoned")?
        .terminals
        .get(id)
        .cloned()
        .ok_or("Terminal is no longer available.".into())
}

// Holding the chat's workflow ownership also blocks profile/workspace edits and routines.
struct InteractiveOwner {
    state: SharedOmniState,
    session: Arc<TerminalSession>,
    chat_id: String,
    bot_id: String,
}
impl Drop for InteractiveOwner {
    fn drop(&mut self) {
        let mut guard = write(&self.state);
        if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == self.chat_id) {
            // Terminal conversations are not parsed as chat messages. A new automated
            // turn must rebuild context instead of silently trusting an unseen transcript.
            chat.native_sessions.remove(&self.bot_id);
            chat.session_contexts.remove(&self.bot_id);
            chat.last_synced_msg_index.remove(&self.bot_id);
        }
        guard.active_workflows.remove(&self.chat_id);
        guard.cancelled_chats.remove(&self.chat_id);
        let mut info = lock(&self.session.info);
        if matches!(info.status.as_str(), "queued" | "running") {
            info.status = "error".into();
            info.error = Some("The terminal ended unexpectedly.".into());
        }
        if let Some(task) = guard
            .store
            .chats
            .iter_mut()
            .find(|chat| chat.id == self.chat_id)
            .and_then(|chat| chat.tasks.iter_mut().find(|task| task.id == info.id))
        {
            task.status = if info.status == "exited" {
                "complete".into()
            } else {
                info.status.clone()
            };
            task.reason = Some(info.error.clone().unwrap_or_else(|| format!("Terminal {}{}. Its transcript stays in the terminal; the next chat turn rebuilds context.", info.status, info.exit_code.map(|code| format!(" with exit code {code}")).unwrap_or_default())));
        }
        drop(info);
        guard.save_execution();
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(self.chat_id.clone()),
        });
    }
}

pub fn start(state: SharedOmniState, input: StartInput) -> Result<TerminalInfo, String> {
    dimensions(input.cols, input.rows)?;
    let terminal_id = format!("terminal-{}", uuid::Uuid::new_v4());
    let (bot, resume, instructions, old_cwd, info, session) = {
        let mut guard = state.write().map_err(|_| "State lock poisoned")?;
        if guard.active_workflows.contains(&input.chat_id) {
            return Err("Stop this chat and wait for its workflow to finish before taking terminal control.".into());
        }
        let chat = guard
            .store
            .chats
            .iter()
            .find(|c| c.id == input.chat_id)
            .ok_or("Chat not found")?;
        if !chat.participant_bot_ids.contains(&input.bot_id) {
            return Err("Choose a bot in this conversation.".into());
        }
        let mut bot = guard
            .store
            .bots
            .iter()
            .find(|b| b.id == input.bot_id && !b.archived)
            .cloned()
            .ok_or("Bot is not available")?;
        if !matches!(
            bot.cli_driver,
            CliDriverKind::Claude | CliDriverKind::Custom
        ) {
            return Err("Interactive control is available for Claude Code and custom commands. This adapter supports live output only.".into());
        }
        if let Some(model) = chat.model_overrides.get(&bot.id) {
            bot.model = model.clone();
        }
        if chat.workspace_path.is_none() && bot.permission_mode == "bypassPermissions" {
            bot.permission_mode = "auto".into();
        }
        execution::validate(&bot)?;
        crate::drivers::validate_available(&bot)?;
        let context = chat
            .session_contexts
            .get(&bot.id)
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
        let compatible = context
            .as_ref()
            .is_some_and(|value| value["bot"] == serde_json::to_value(&bot).unwrap());
        let resume = compatible
            .then(|| chat.native_sessions.get(&bot.id).cloned())
            .flatten();
        let old_cwd = context
            .as_ref()
            .and_then(|value| value["cwd"].as_str())
            .map(str::to_owned);
        let prefs = &guard.store.preferences;
        let mut instructions = format!(
            "{}\n{}\nPersonal memory:\n{}\nShared memory:\n{}",
            bot.system_prompt,
            prefs.global_instructions,
            bot.memories.join("\n"),
            prefs.shared_memories.join("\n")
        );
        if let Some(project) = guard
            .store
            .workspaces
            .iter()
            .find(|p| Some(&p.path) == chat.workspace_path.as_ref())
        {
            instructions.push_str(&format!(
                "\nProject memory:\n{}",
                project.memories.join("\n")
            ));
        }
        instructions.push_str("\nYou are in a user-controlled terminal. Respond directly to the user. Automatic teammate handoffs are disabled here.\nRecent app conversation:\n");
        for message in chat
            .messages
            .iter()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            instructions.push_str(&format!(
                "{}: {}\n",
                message.author_name.as_deref().unwrap_or(&message.role),
                message.text.chars().take(2000).collect::<String>()
            ));
        }
        let info = TerminalInfo {
            id: terminal_id.clone(),
            chat_id: input.chat_id.clone(),
            bot_id: bot.id.clone(),
            bot_name: bot.name.clone(),
            mode: "interactive",
            status: "queued".into(),
            cwd: String::new(),
            started_at_ms: now_ms(),
            exit_code: None,
            error: None,
            resumed: false,
        };
        let session = TerminalSession::new(info.clone());
        register(&mut guard, session.clone())?;
        let previous = guard.store.clone();
        let chat = guard
            .store
            .chats
            .iter_mut()
            .find(|chat| chat.id == input.chat_id)
            .ok_or("Chat not found")?;
        chat.tasks.push(crate::state::WorkflowTask {
            id: terminal_id.clone(),
            workflow_id: terminal_id.clone(),
            bot_id: bot.id.clone(),
            from_bot_id: None,
            instructions: "User-controlled terminal session".into(),
            mode: "interactive".into(),
            status: "queued".into(),
            reason: Some("Automatic handoffs are paused during terminal control.".into()),
            workspace_path: None,
        });
        if let Err(error) = guard.persist_or_restore(previous) {
            guard.terminals.remove(&terminal_id);
            return Err(error);
        }
        guard.cancelled_chats.remove(&input.chat_id);
        guard.active_workflows.insert(input.chat_id.clone());
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(input.chat_id.clone()),
        });
        (bot, resume, instructions, old_cwd, info, session)
    };
    let owner = InteractiveOwner {
        state: state.clone(),
        session: session.clone(),
        chat_id: input.chat_id.clone(),
        bot_id: bot.id.clone(),
    };
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            let cwd = execution::workspace(&state, &input.chat_id, &input.bot_id).await?;
            lock(&session.info).cwd = cwd.clone();
            if let Some(task) = write(&state)
                .store
                .chats
                .iter_mut()
                .find(|c| c.id == input.chat_id)
                .and_then(|c| c.tasks.iter_mut().find(|t| t.id == terminal_id))
            {
                task.workspace_path = Some(cwd.clone());
            }
            let lease =
                execution::acquire(state.clone(), &input.chat_id, &terminal_id, &cwd).await?;
            if session.stop.load(Ordering::Relaxed) {
                return Err("Stopped before the terminal started.".into());
            }
            let (binary, args) =
                resolve_driver_binary(&bot).ok_or("CLI command is no longer available")?;
            let mut command = CommandBuilder::new(binary);
            command.args(args);
            command.cwd(&cwd);
            command.env("PATH", augmented_path_env());
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            // Finder-launched apps have no locale, which makes CLIs print non-ASCII as `?`.
            if std::env::var_os("LANG").is_none() {
                command.env("LANG", "en_US.UTF-8");
            }
            command.env_remove("NO_COLOR");
            command.env_remove("CLAUDECODE");
            command.env_remove("CLAUDE_CODE_ENTRYPOINT");
            if bot.cli_driver == CliDriverKind::Claude {
                if old_cwd.as_deref() == Some(&cwd) {
                    if let Some(resume) = resume {
                        command.args(["--resume", &resume]);
                        lock(&session.info).resumed = true;
                    }
                }
                command.args(["--append-system-prompt", &instructions]);
                if let Some(model) = bot
                    .model
                    .as_deref()
                    .filter(|m| !m.is_empty() && *m != "default")
                {
                    command.args(["--model", model]);
                }
                if matches!(bot.reasoning_effort.as_str(), "low" | "medium" | "high") {
                    command.args(["--effort", &bot.reasoning_effort]);
                }
                match bot.permission_mode.as_str() {
                    "plan" | "acceptEdits" => {
                        command.args(["--permission-mode", &bot.permission_mode]);
                    }
                    "bypassPermissions" => {
                        command.arg("--dangerously-skip-permissions");
                    }
                    _ => {}
                }
            }
            let process_session = session.clone();
            tokio::task::spawn_blocking(move || {
                let _lease = lease;
                run_pty(
                    state.clone(),
                    process_session,
                    command,
                    input.cols,
                    input.rows,
                )
            })
            .await
            .map_err(|e| e.to_string())?
        }
        .await;
        if let Err(error) = result {
            let status = if session.stop.load(Ordering::Relaxed)
                || read(&owner.state).cancelled_chats.contains(&owner.chat_id)
            {
                "stopped"
            } else {
                "error"
            };
            session.finish(status, None, Some(error));
        }
        drop(owner);
    });
    Ok(info)
}

struct PtyProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    reader_done: Arc<AtomicBool>,
}
impl Drop for PtyProcess {
    fn drop(&mut self) {
        // Job-control shells can move the foreground command to its own group.
        #[cfg(unix)]
        {
            if let Some(group) = self.master.process_group_leader() {
                if group > 0 && group != unsafe { libc::getpgrp() } {
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                }
            }
            if let Some(pid) = self.child.process_id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reader_done.store(true, Ordering::Relaxed);
    }
}

fn run_pty(
    state: SharedOmniState,
    session: Arc<TerminalSession>,
    command: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(dimensions(cols, rows)?)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Some(fd) = pair.master.as_raw_fd() {
        // Nonblocking I/O keeps Stop responsive even if a child never reads a paste.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader_done = Arc::new(AtomicBool::new(false));
    let mut process = PtyProcess {
        child,
        master: pair.master,
        reader_done: reader_done.clone(),
    };
    let (sender, receiver) = mpsc::sync_channel(64);
    *lock(&session.commands) = Some(sender);
    lock(&session.info).status = "running".into();
    {
        let info = lock(&session.info).clone();
        let mut guard = write(&state);
        if let Some(task) = guard
            .store
            .chats
            .iter_mut()
            .find(|chat| chat.id == info.chat_id)
            .and_then(|chat| chat.tasks.iter_mut().find(|task| task.id == info.id))
        {
            task.status = "running".into();
        }
        guard.save_execution();
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(info.chat_id),
        });
    }
    let reader_finished = reader_done.clone();
    let output_session = session.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        let mut drain_until = None;
        loop {
            // A detached grandchild can keep the PTY open and busy after the child exits.
            if reader_finished.load(Ordering::Relaxed)
                && Instant::now()
                    >= *drain_until.get_or_insert_with(|| Instant::now() + DRAIN_AFTER_EXIT)
            {
                break;
            }
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => output_session.append(&bytes[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if reader_finished.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(8));
                }
                // PTYs on Linux report EIO when the slave closes.
                Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                Err(error) => {
                    output_session
                        .append(format!("\r\nTerminal read failed: {error}\r\n").as_bytes());
                    break;
                }
            }
        }
    });
    let chat_id = lock(&session.info).chat_id.clone();
    let mut pending = VecDeque::<u8>::new();
    let result = loop {
        let cancelled =
            session.stop.load(Ordering::Relaxed) || read(&state).cancelled_chats.contains(&chat_id);
        if cancelled {
            break Ok(("stopped", None));
        }
        match process.child.try_wait() {
            Ok(Some(exit)) => {
                break Ok((
                    if exit.success() { "exited" } else { "error" },
                    Some(exit.exit_code()),
                ))
            }
            Err(error) => break Err(error.to_string()),
            Ok(None) => {}
        }
        if !pending.is_empty() {
            match writer.write(pending.make_contiguous()) {
                Ok(0) => break Err("Terminal input closed.".into()),
                Ok(count) => {
                    pending.drain(..count);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => break Err(error.to_string()),
            }
            if !pending.is_empty() {
                std::thread::sleep(Duration::from_millis(8));
                continue;
            }
        }
        let result = match receiver.recv_timeout(Duration::from_millis(40)) {
            Ok(Input::Write(bytes)) => {
                pending.extend(bytes);
                Ok(())
            }
            Ok(Input::Resize(cols, rows)) => dimensions(cols, rows)
                .and_then(|size| process.master.resize(size).map_err(|e| e.to_string())),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(("stopped", None)),
        };
        if let Err(error) = result {
            break Err(error);
        }
    };
    drop(process);
    drop(writer);
    reader_thread.join().map_err(|_| "Terminal reader failed")?;
    let (status, code) = result?;
    session.finish(status, code, None);
    Ok(())
}

pub fn shutdown(state: &SharedOmniState) {
    let sessions: Vec<_> = read(state).terminals.values().cloned().collect();
    for session in &sessions {
        let info = lock(&session.info).clone();
        if info.mode == "interactive" {
            let _ = stop(state, &info.id);
        }
    }
    // Let workers reap their process groups before the runtime exits.
    for _ in 0..50 {
        if sessions
            .iter()
            .all(|s| lock(&s.info).mode != "interactive" || !s.is_active())
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn response<T: Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub async fn http_list(
    State(state): State<SharedOmniState>,
    Query(query): Query<ChatQuery>,
) -> Response {
    let guard = read(&state);
    let mut sessions: Vec<_> = guard
        .terminals
        .values()
        .filter_map(|s| {
            let info = lock(&s.info);
            (info.chat_id == query.chat_id).then(|| info.clone())
        })
        .collect();
    sessions.sort_by_key(|s| s.started_at_ms);
    Json(sessions).into_response()
}
pub async fn http_start(
    State(state): State<SharedOmniState>,
    Json(input): Json<StartInput>,
) -> Response {
    response(start(state, input))
}

#[derive(Serialize)]
pub struct OutputChunk {
    /// Standard base64 with padding.
    data: String,
    offset: u64,
    truncated: bool,
    status: String,
}

fn read_output(session: &TerminalSession, requested: u64) -> OutputChunk {
    let output = lock(&session.output);
    let start = output.end - output.bytes.len() as u64;
    let offset = requested.clamp(start, output.end);
    let skip = (offset - start) as usize;
    let take = (output.bytes.len() - skip).min(CHUNK_LIMIT);
    let bytes: Vec<u8> = output.bytes.range(skip..skip + take).copied().collect();
    drop(output);
    OutputChunk {
        data: BASE64.encode(&bytes),
        offset: offset + bytes.len() as u64,
        truncated: requested < start,
        status: lock(&session.info).status.clone(),
    }
}

pub async fn http_output(
    State(state): State<SharedOmniState>,
    Query(query): Query<SessionQuery>,
) -> Response {
    response(session(&state, &query.id).map(|session| read_output(&session, query.offset)))
}
pub async fn http_write(
    State(state): State<SharedOmniState>,
    Json(input): Json<WriteInput>,
) -> Response {
    response((|| {
        // Base64 is 4/3 the decoded size; reject oversized input before decoding it.
        if input.data.len() > CHUNK_LIMIT.div_ceil(3) * 4 {
            return Err("Paste at most 64 KiB at a time.".into());
        }
        let data = BASE64
            .decode(input.data.as_bytes())
            .map_err(|_| "Terminal input must be base64 encoded.")?;
        session(&state, &input.id)?.send(Input::Write(data))
    })())
}
pub async fn http_resize(
    State(state): State<SharedOmniState>,
    Json(input): Json<ResizeInput>,
) -> Response {
    response((|| {
        dimensions(input.cols, input.rows)?;
        session(&state, &input.id)?.send(Input::Resize(input.cols, input.rows))
    })())
}
pub async fn http_stop(
    State(state): State<SharedOmniState>,
    Json(input): Json<SessionQuery>,
) -> Response {
    response(stop(&state, &input.id))
}

pub fn stop(state: &SharedOmniState, id: &str) -> Result<(), String> {
    let mut guard = state.write().map_err(|_| "State lock poisoned")?;
    let session = guard
        .terminals
        .get(id)
        .cloned()
        .ok_or("Terminal is no longer available.")?;
    let info = lock(&session.info);
    if info.mode != "interactive" {
        return Err("Use Stop response to stop an automated workflow.".into());
    }
    if !matches!(info.status.as_str(), "running" | "queued") {
        return Ok(());
    }
    session.stop.store(true, Ordering::Relaxed);
    guard.cancelled_chats.insert(info.chat_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{input, Fixture};

    fn request() -> StartInput {
        StartInput {
            chat_id: "room".into(),
            bot_id: "A".into(),
            cols: 80,
            rows: 24,
        }
    }
    fn output(session: &TerminalSession) -> String {
        String::from_utf8_lossy(
            &session
                .output
                .lock()
                .unwrap()
                .bytes
                .iter()
                .copied()
                .collect::<Vec<_>>(),
        )
        .into_owned()
    }
    async fn wait_for(session: &TerminalSession, text: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !output(session).contains(text) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Expected {text:?}; got {:?}", output(session)));
    }

    #[tokio::test]
    async fn pty_accepts_unicode_input_resize_and_releases_workflow_on_exit() {
        let f = Fixture::new(&["A"]);
        f.script(
            "A",
            "printf READY; IFS= read -r line; printf '<%s>\\n' \"$line\"; stty size; exit 7",
        );
        let info = start(f.state.clone(), request()).unwrap();
        let terminal = session(&f.state, &info.id).unwrap();
        wait_for(&terminal, "READY").await;
        assert!(
            crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("race"))
                .await
                .is_err()
        );
        assert!(crate::server::delete_bot_profile(&f.state, "A").is_err());
        terminal.send(Input::Resize(101, 37)).unwrap();
        terminal
            .send(Input::Write("héllo 世界\r".as_bytes().to_vec()))
            .unwrap();
        f.wait().await;
        assert!(output(&terminal).contains("<héllo 世界>"));
        assert!(output(&terminal).contains("37 101"));
        let info = terminal.info.lock().unwrap();
        assert_eq!(info.exit_code, Some(7));
        assert_eq!(info.status, "error");
        let guard = f.state.read().unwrap();
        assert!(guard.execution_slots.is_empty());
        assert_eq!(guard.store.chats[0].tasks[0].status, "error");
    }

    #[tokio::test]
    async fn queued_terminal_can_be_stopped_and_old_stop_cannot_cancel_new_work() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo SHOULD_NOT_START; sleep 20");
        f.state.write().unwrap().store.preferences.max_parallel_bots = 1;
        let lease = execution::acquire(f.state.clone(), "other", "held", "/other")
            .await
            .unwrap();
        let info = start(f.state.clone(), request()).unwrap();
        stop(&f.state, &info.id).unwrap();
        f.wait().await;
        let terminal = session(&f.state, &info.id).unwrap();
        assert!(output(&terminal).is_empty());
        assert_eq!(terminal.info.lock().unwrap().status, "stopped");
        stop(&f.state, &info.id).unwrap();
        assert!(!f.state.read().unwrap().cancelled_chats.contains("room"));
        drop(lease);
    }

    #[tokio::test]
    async fn stop_remains_responsive_when_process_never_reads_input() {
        let f = Fixture::new(&["A"]);
        f.script("A", "stty -echo; printf READY; sleep 30");
        let info = start(f.state.clone(), request()).unwrap();
        let terminal = session(&f.state, &info.id).unwrap();
        wait_for(&terminal, "READY").await;
        terminal.send(Input::Write(vec![b'x'; 65536])).unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        stop(&f.state, &info.id).unwrap();
        tokio::time::timeout(Duration::from_secs(2), f.wait())
            .await
            .unwrap();
        assert_eq!(terminal.info.lock().unwrap().status, "stopped");
        assert!(terminal.send(Input::Write(vec![b'a'])).is_err());
    }

    #[tokio::test]
    async fn automated_output_is_tapped_before_newlines_and_is_read_only() {
        let f = Fixture::new(&["A"]);
        f.script(
            "A",
            "printf partial; sleep 0.2; echo finished; echo diagnostic >&2",
        );
        crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("hello"))
            .await
            .unwrap();
        let terminal = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(terminal) = f.state.read().unwrap().terminals.values().next().cloned() {
                    break terminal;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        wait_for(&terminal, "partial").await;
        assert_eq!(terminal.info.lock().unwrap().status, "running");
        assert!(terminal.send(Input::Write(b"bad".to_vec())).is_err());
        f.wait().await;
        let captured = output(&terminal);
        assert!(captured.contains("partialfinished"));
        assert!(captured.contains("diagnostic"));
    }

    #[tokio::test]
    async fn failed_spawn_releases_ownership_and_records_error() {
        let f = Fixture::new(&["A"]);
        f.script("A", "exit 0");
        let command = f.state.read().unwrap().store.bots[0]
            .custom_command
            .clone()
            .unwrap();
        let path = shlex::split(&command).unwrap()[0].clone();
        std::fs::write(path, "#!/missing-interpreter\n").unwrap();
        let info = start(f.state.clone(), request()).unwrap();
        f.wait().await;
        let terminal = session(&f.state, &info.id).unwrap();
        assert_eq!(terminal.info.lock().unwrap().status, "error");
        assert!(terminal.info.lock().unwrap().error.is_some());
        assert!(f.state.read().unwrap().execution_slots.is_empty());
    }

    #[tokio::test]
    async fn claude_control_uses_interactive_resume_and_invalidates_automated_context_afterward() {
        let f = Fixture::new(&["A"]);
        f.script("A", "printf '%s\\n' \"$@\"; printf READY; read -r line");
        let cwd = execution::workspace(&f.state, "room", "A").await.unwrap();
        {
            let mut guard = f.state.write().unwrap();
            guard.store.bots[0].cli_driver = CliDriverKind::Claude;
            guard.store.bots[0].permission_mode = "plan".into();
            let bot = guard.store.bots[0].clone();
            guard.store.chats[0]
                .native_sessions
                .insert("A".into(), "fixture-session".into());
            guard.store.chats[0].session_contexts.insert(
                "A".into(),
                serde_json::json!({"bot": bot, "cwd": cwd}).to_string(),
            );
        }
        let info = start(f.state.clone(), request()).unwrap();
        let terminal = session(&f.state, &info.id).unwrap();
        wait_for(&terminal, "READY").await;
        let text = output(&terminal).replace('\r', "");
        assert!(text.contains("--resume\nfixture-session"));
        assert!(text.contains("--permission-mode\nplan"));
        assert!(!text.contains("--output-format"));
        assert!(terminal.info.lock().unwrap().resumed);
        terminal.send(Input::Write(b"done\r".to_vec())).unwrap();
        f.wait().await;
        assert!(f.state.read().unwrap().store.chats[0]
            .native_sessions
            .is_empty());
    }

    #[tokio::test]
    async fn invalid_terminal_requests_never_reserve_the_chat() {
        let f = Fixture::new(&["A"]);
        f.script("A", "exit 0");
        let mut invalid = request();
        invalid.cols = 0;
        assert!(start(f.state.clone(), invalid).is_err());
        let mut invalid = request();
        invalid.bot_id = "outside".into();
        assert!(start(f.state.clone(), invalid).is_err());
        f.state.write().unwrap().store.bots[0].cli_driver = CliDriverKind::Codex;
        assert!(start(f.state.clone(), request()).is_err());
        assert!(f.state.read().unwrap().active_workflows.is_empty());
        assert!(f.state.read().unwrap().terminals.is_empty());
    }

    #[test]
    fn output_retention_is_bounded_and_offsets_do_not_restart() {
        let session = TerminalSession::new(TerminalInfo {
            id: "test".into(),
            chat_id: "room".into(),
            bot_id: "A".into(),
            bot_name: "A".into(),
            mode: "output",
            status: "complete".into(),
            cwd: "/tmp".into(),
            started_at_ms: 0,
            exit_code: None,
            error: None,
            resumed: false,
        });
        session.append(&vec![b'a'; OUTPUT_LIMIT + 100]);
        session.append(b"tail");
        let output = session.output.lock().unwrap();
        assert_eq!(output.bytes.len(), OUTPUT_LIMIT);
        assert_eq!(output.end, (OUTPUT_LIMIT + 104) as u64);
        assert_eq!(
            output
                .bytes
                .iter()
                .rev()
                .take(4)
                .copied()
                .collect::<Vec<_>>(),
            b"liat"
        );
    }

    fn fixture_session(
        id: &str,
        chat_id: &str,
        status: &str,
        started_at_ms: u64,
    ) -> Arc<TerminalSession> {
        TerminalSession::new(TerminalInfo {
            id: id.into(),
            chat_id: chat_id.into(),
            bot_id: "A".into(),
            bot_name: "A".into(),
            mode: "output",
            status: status.into(),
            cwd: "/tmp".into(),
            started_at_ms,
            exit_code: None,
            error: None,
            resumed: false,
        })
    }

    #[test]
    fn output_chunks_are_base64_and_resume_from_offsets() {
        let session = fixture_session("t", "room", "running", 0);
        session.append("héllo".as_bytes());
        let chunk = read_output(&session, 0);
        assert_eq!(BASE64.decode(&chunk.data).unwrap(), "héllo".as_bytes());
        assert_eq!(chunk.offset, 6);
        assert!(!chunk.truncated);
        session.append(b"!");
        let next = read_output(&session, chunk.offset);
        assert_eq!(BASE64.decode(&next.data).unwrap(), b"!");
        assert_eq!(read_output(&session, 99).data, "");
        session.append(&vec![b'x'; OUTPUT_LIMIT]);
        let late = read_output(&session, 0);
        assert!(late.truncated);
        assert_eq!(BASE64.decode(&late.data).unwrap().len(), CHUNK_LIMIT);
    }

    #[test]
    fn session_limit_evicts_finished_sessions_and_refuses_when_all_are_active() {
        let f = Fixture::new(&["A"]);
        let mut guard = f.state.write().unwrap();
        for index in 0..SESSION_LIMIT {
            let status = if index == 3 { "exited" } else { "running" };
            register(
                &mut guard,
                fixture_session(&format!("t{index}"), "room", status, index as u64),
            )
            .unwrap();
        }
        register(&mut guard, fixture_session("new", "room", "running", 100)).unwrap();
        assert_eq!(guard.terminals.len(), SESSION_LIMIT);
        assert!(!guard.terminals.contains_key("t3"));
        let error =
            register(&mut guard, fixture_session("extra", "room", "running", 101)).unwrap_err();
        assert!(error.contains("Stop one"), "{error}");
        assert_eq!(guard.terminals.len(), SESSION_LIMIT);
    }

    #[test]
    fn deleting_a_chat_forgets_only_its_terminals() {
        let f = Fixture::new(&["A"]);
        let mut guard = f.state.write().unwrap();
        let mine = fixture_session("mine", "room", "running", 0);
        register(&mut guard, mine.clone()).unwrap();
        register(
            &mut guard,
            fixture_session("other", "elsewhere", "exited", 0),
        )
        .unwrap();
        remove_chat_sessions(&mut guard, "room");
        assert!(mine.stop.load(Ordering::Relaxed));
        assert_eq!(guard.terminals.keys().collect::<Vec<_>>(), ["other"]);
    }

    #[tokio::test]
    async fn detached_grandchild_holding_the_pty_does_not_hang_exit() {
        let f = Fixture::new(&["A"]);
        f.script(
            "A",
            "perl -MPOSIX -e 'POSIX::setsid(); exec \"yes\"' & sleep 0.3; printf DONE; exit 0",
        );
        let info = start(f.state.clone(), request()).unwrap();
        let terminal = session(&f.state, &info.id).unwrap();
        tokio::time::timeout(Duration::from_secs(5), f.wait())
            .await
            .expect("terminal exit hung on a detached grandchild");
        assert_eq!(terminal.info.lock().unwrap().status, "exited");
    }
}
