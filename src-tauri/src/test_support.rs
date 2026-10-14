//! Local fixtures: never load personal state, discover CLIs, or call a model.
use crate::state::*;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Arc, RwLock},
};

pub struct Fixture {
    pub dir: PathBuf,
    pub state: SharedOmniState,
}

impl Fixture {
    pub fn new(names: &[&str]) -> Self {
        let dir = std::env::temp_dir().join(format!("omni-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let bots: Vec<_> = names.iter().map(|name| bot(name)).collect();
        let store: PersistedStore = serde_json::from_value(json!({
            "preferences": {"workspaceRoot": dir, "defaultMaxSwarmTurns": 4,
                "approveAllTools": false, "globalInstructions": "", "sharedMemories": [],
                "onlyExplicitHandoffs": true, "maxParallelBots": 2},
            "bots": bots,
            "chats": [{"id":"room", "title":"Test", "subtitle":"", "isPrimary":false,
                "isGroup": names.len() > 1, "participantBotIds": names,
                "workspaceId":null, "workspacePath":dir, "useWorktrees":false,
                "maxSwarmTurns":4, "messages":[], "updatedAtMs":0}],
            "workspaces":[], "routines":[]
        }))
        .unwrap();
        let (event_tx, _) = tokio::sync::broadcast::channel(512);
        let state = Arc::new(RwLock::new(OmniRuntimeState {
            server_port: 4321,
            store_lock: None,
            data_dir: dir.join("state"),
            store,
            harnesses: vec![],
            skills: vec![],
            mcp_servers: vec![],
            computer_activity: vec![],
            active_runs: HashMap::new(),
            cancelled_chats: HashSet::new(),
            active_workflows: HashSet::new(),
            event_tx,
        }));
        Self { dir, state }
    }

    pub fn script(&self, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = self.dir.join(format!("{name} driver.sh"));
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        self.state
            .write()
            .unwrap()
            .store
            .bots
            .iter_mut()
            .find(|b| b.id == name)
            .unwrap()
            .custom_command = Some(format!("'{}'", path.display()));
    }

    pub async fn wait(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !self.state.read().unwrap().active_workflows.is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("workflow did not finish");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

pub fn bot(name: &str) -> BotProfile {
    serde_json::from_value(json!({
        "id":name,"name":name,"slug":name.to_lowercase(),"roleTitle":"Tester", "description":"",
        "shape":"blob","color":"cyan","isPrimary":false,"cliDriver":"custom","model":null,
        "reasoningEffort":"low","permissionMode":"plan","systemPrompt":"","memories":[],
        "autoCreatedForCli":false
    }))
    .unwrap()
}

pub fn input(text: &str) -> crate::orchestrator::SendMessageInput {
    crate::orchestrator::SendMessageInput {
        chat_id: "room".into(),
        text: text.into(),
        skill_slug: None,
        override_bot_id: None,
        override_model: None,
        override_effort: None,
        parallel_mode: None,
    }
}
