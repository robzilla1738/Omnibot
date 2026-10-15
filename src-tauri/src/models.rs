//! Model metadata only: no sessions, prompts, or inference requests.
use crate::scanner::{path_env_for_binary, user_environment, CliDriverKind};
use crate::state::{OmniStreamEvent, SharedOmniState};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Default, Debug)]
struct Catalog {
    models: Vec<String>,
    labels: BTreeMap<String, String>,
}
impl Catalog {
    fn add(&mut self, id: &str, label: Option<&str>) {
        if id.is_empty()
            || id.len() > 256
            || id.chars().any(char::is_control)
            || id.contains(char::is_whitespace)
        {
            return;
        }
        if !self.models.iter().any(|model| model == id) {
            self.models.push(id.to_string());
            if let Some(label) = label {
                self.labels.insert(id.into(), label.into());
            }
        }
    }
}

struct MetadataProcess(Child);
impl Drop for MetadataProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.0.id() {
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
        let _ = self.0.start_kill();
    }
}

fn parse_rows(kind: CliDriverKind, value: &Value) -> Option<Catalog> {
    let (rows, id_key, label_key) = match kind {
        CliDriverKind::Claude => (
            value.pointer("/response/response/models")?.as_array()?,
            "value",
            "displayName",
        ),
        CliDriverKind::Codex => (
            value.pointer("/result/data")?.as_array()?,
            "model",
            "displayName",
        ),
        CliDriverKind::Muse => (
            value.pointer("/result/models")?.as_array()?,
            "modelId",
            "displayLabel",
        ),
        _ => return None,
    };
    let mut catalog = Catalog::default();
    for row in rows {
        if let Some(id) = row.get(id_key).and_then(Value::as_str) {
            if kind == CliDriverKind::Claude && id == "default" {
                continue;
            }
            catalog.add(id, row.get(label_key).and_then(Value::as_str));
        }
    }
    Some(catalog)
}

fn parse_text(kind: CliDriverKind, text: &str) -> Catalog {
    let mut catalog = Catalog::default();
    for line in text.lines().map(str::trim) {
        match kind {
            CliDriverKind::Grok => {
                if let Some(row) = line.strip_prefix("* ").or_else(|| line.strip_prefix("- ")) {
                    if let Some(id) = row.split_whitespace().next() {
                        catalog.add(id, None);
                    }
                }
            }
            CliDriverKind::Cursor => {
                if let Some((id, label)) = line.split_once(" - ") {
                    catalog.add(id, Some(label));
                }
            }
            CliDriverKind::Opencode => {
                if line.contains('/') && !line.contains(char::is_whitespace) {
                    catalog.add(line, None);
                }
            }
            CliDriverKind::Pi => {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() >= 6
                    && fields[0] != "provider"
                    && ["yes", "no"].contains(&fields[4])
                {
                    catalog.add(&format!("{}/{}", fields[0], fields[1]), None);
                }
            }
            CliDriverKind::Ollama => {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() >= 4 && fields[0] != "NAME" {
                    catalog.add(fields[0], None);
                }
            }
            _ => {}
        }
    }
    catalog
}

async fn discover(kind: CliDriverKind, binary: &str) -> Result<Catalog, ()> {
    let args: &[&str] = match kind {
        CliDriverKind::Claude => &[
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--settings",
            "{\"disableAllHooks\":true}",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
        ],
        CliDriverKind::Codex => &["app-server"],
        CliDriverKind::Muse => &[
            "serve",
            "--no-session-log",
            "--disable-write",
            "--disable-shell",
        ],
        CliDriverKind::Grok | CliDriverKind::Cursor | CliDriverKind::Opencode => &["models"],
        CliDriverKind::Pi => &["--no-extensions", "--no-mcp", "--list-models"],
        CliDriverKind::Ollama => &["list"],
        _ => return Err(()),
    };
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(std::env::temp_dir())
        .envs(user_environment().iter().map(|(k, v)| (k, v)))
        .env("PATH", path_env_for_binary(binary))
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("PI_OFFLINE", "1")
        .env("PI_TELEMETRY", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut process = MetadataProcess(command.spawn().map_err(|_| ())?);
    let stdout = process.0.stdout.take().ok_or(())?;
    let mut input = process.0.stdin.take().ok_or(())?;
    let protocol = matches!(
        kind,
        CliDriverKind::Claude | CliDriverKind::Codex | CliDriverKind::Muse
    );
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        if protocol {
            let init = if kind == CliDriverKind::Claude {
                json!({"type":"control_request","request_id":"models","request":{"subtype":"initialize"}})
            } else { json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"omnibot","version":env!("CARGO_PKG_VERSION")}}}) };
            input.write_all(format!("{init}\n").as_bytes()).await.map_err(|_| ())?;
        }
        let mut lines = BufReader::new(stdout.take(2 * 1024 * 1024)).lines();
        let mut text = String::new();
        let mut combined = Catalog::default();
        while let Some(line) = lines.next_line().await.map_err(|_| ())? {
            if !protocol { text.push_str(&line); text.push('\n'); continue; }
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
            if value.get("error").is_some() { return Err(()); }
            if value.get("id").and_then(Value::as_u64) == Some(1) {
                let params = if kind == CliDriverKind::Codex { json!({"limit":100,"includeHidden":false}) } else { json!({}) };
                input.write_all(format!("{}\n{}\n", json!({"jsonrpc":"2.0","method":"initialized"}), json!({"jsonrpc":"2.0","id":2,"method":"model/list","params":params})).as_bytes()).await.map_err(|_| ())?;
            }
            if let Some(catalog) = parse_rows(kind, &value) {
                for id in catalog.models { combined.add(&id, catalog.labels.get(&id).map(String::as_str)); }
                if let Some(cursor) = value.pointer("/result/nextCursor").and_then(Value::as_str) {
                    input.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":2,"method":"model/list","params":{"cursor":cursor,"limit":100,"includeHidden":false}})).as_bytes()).await.map_err(|_| ())?;
                } else { return Ok(combined); }
            }
        }
        if protocol || !process.0.wait().await.map_err(|_| ())?.success() { return Err(()); }
        Ok(parse_text(kind, &text))
    }).await.map_err(|_| ())?
}

pub async fn refresh(state: SharedOmniState) {
    // Coalesce simultaneous rescans; each result is merged into current state, never a stale snapshot.
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _refresh = REFRESH.lock().await;
    let harnesses = match state.read() {
        Ok(guard) => guard.harnesses.clone(),
        Err(_) => return,
    };
    let mut tasks = tokio::task::JoinSet::new();
    for harness in harnesses
        .into_iter()
        .filter(|h| h.installed && h.models_status == "loading")
    {
        tasks.spawn(async move {
            let catalog = match harness.binary_path.as_deref() {
                Some(binary) => discover(harness.kind, binary).await,
                None => Err(()),
            };
            (harness, catalog)
        });
    }
    while let Some(result) = tasks.join_next().await {
        let Ok((previous, catalog)) = result else {
            continue;
        };
        let Ok(mut guard) = state.write() else {
            return;
        };
        let Some(harness) = guard.harnesses.iter_mut().find(|h| {
            h.kind == previous.kind
                && h.binary_path == previous.binary_path
                && h.version == previous.version
        }) else {
            continue;
        };
        harness.models.clear();
        harness.model_labels.clear();
        harness.models_source = None;
        match catalog {
            Ok(catalog) => {
                harness.models = catalog.models;
                harness.model_labels = catalog.labels;
                harness.models_status = "ready".into();
                harness.models_source = Some("CLI model catalog".into());
            }
            Err(()) => {
                harness.models_status = "unavailable".into();
            }
        }
        guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogs_use_cli_rows_not_headers_or_guesses() {
        assert_eq!(
            parse_text(
                CliDriverKind::Grok,
                "Default model: current\nAvailable models:\n * current (default)\n - fast\n"
            )
            .models,
            ["current", "fast"]
        );
        assert_eq!(
            parse_text(
                CliDriverKind::Cursor,
                "Available models\nauto - Auto\nfixture-small - Small\nTip: switch models"
            )
            .models,
            ["auto", "fixture-small"]
        );
        assert_eq!(
            parse_text(
                CliDriverKind::Pi,
                "provider model context max-out thinking images\nprovider-a model-b 128K 4K yes no"
            )
            .models,
            ["provider-a/model-b"]
        );
        assert_eq!(parse_rows(CliDriverKind::Claude, &json!({"response":{"response":{"models":[{"value":"opus","displayName":"Current Opus"}]}}})).unwrap().labels["opus"], "Current Opus");
        assert_eq!(
            parse_rows(
                CliDriverKind::Codex,
                &json!({"result":{"data":[{"model":"current","displayName":"Current"}]}})
            )
            .unwrap()
            .models,
            ["current"]
        );
        assert!(parse_text(CliDriverKind::Grok, "Please sign in")
            .models
            .is_empty());
    }
    #[tokio::test]
    async fn model_discovery_only_sends_metadata_requests() {
        let f = crate::test_support::Fixture::new(&["A"]);
        f.script("A", r#"
[ "$1" = "app-server" ] || exit 1
read -r init
printf '%s' "$init" | /usr/bin/grep -q '"method":"initialize"' || exit 1
printf '%s\n' '{"id":1,"result":{}}'
read -r ready
read -r request
printf '%s' "$request" | /usr/bin/grep -q '"method":"model/list"' || exit 1
printf '%s\n' '{"id":2,"result":{"data":[{"model":"fixture-current","displayName":"Current fixture"}],"nextCursor":null}}'
"#);
        let catalog = discover(
            CliDriverKind::Codex,
            f.dir.join("A driver.sh").to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(catalog.models, ["fixture-current"]);
        assert_eq!(catalog.labels["fixture-current"], "Current fixture");
    }
}
