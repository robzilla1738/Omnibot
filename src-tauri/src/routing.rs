use crate::orchestrator::SendMessageInput;
use crate::state::{BotProfile, PersistedStore};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub bot_ids: Vec<String>,
    pub parallel: bool,
    pub prompt: String,
}

pub fn unquoted_text(text: &str) -> String {
    let mut fence: Option<(char, usize)> = None;
    text.lines()
        .filter(|line| {
            if line.starts_with("    ") || line.starts_with('\t') {
                return false;
            }
            let line = line.trim();
            let marker = line.chars().next().unwrap_or(' ');
            let length = line.chars().take_while(|c| *c == marker).count();
            if matches!(marker, '`' | '~') && length >= 3 {
                if let Some((open, count)) = fence {
                    if marker == open && length >= count && line[length..].trim().is_empty() {
                        fence = None;
                    }
                } else {
                    fence = Some((marker, length));
                }
                return false;
            }
            fence.is_none() && !line.starts_with('>')
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn actionable_text(text: &str) -> String {
    unquoted_text(text)
        .lines()
        .map(|line| line.split('`').step_by(2).collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn mention_position(text: &str, token: &str) -> Option<usize> {
    text.match_indices(token).find_map(|(pos, _)| {
        let before = text[..pos].chars().next_back();
        let after = text[pos + token.len()..].chars().next();
        let boundary = |c: char| c.is_alphanumeric() || c == '-' || c == '_';
        (!before.is_some_and(boundary) && !after.is_some_and(boundary)).then_some(pos)
    })
}

pub fn mentions(text: &str, bots: &[BotProfile], exclude: Option<&str>) -> (Vec<String>, bool) {
    let text = actionable_text(text).to_lowercase();
    let all = ["@all", "@everyone", "@swarm"]
        .iter()
        .any(|t| mention_position(&text, t).is_some());
    let mut candidates = Vec::new();
    for bot in bots.iter().filter(|b| exclude != Some(b.id.as_str())) {
        for token in [
            format!("@{}", bot.name.to_lowercase()),
            format!("@{}", bot.slug.to_lowercase()),
        ] {
            if let Some(position) = mention_position(&text, &token) {
                candidates.push((position, token.len(), bot.id.clone()));
            }
        }
    }
    candidates.sort_by_key(|(position, length, _)| (*position, std::cmp::Reverse(*length)));
    let mut found = Vec::new();
    let mut end = 0;
    for (position, length, id) in candidates {
        if position < end {
            continue;
        }
        end = position + length;
        if !found.contains(&id) {
            found.push(id);
        }
    }
    (found, all)
}

pub fn resolve(
    store: &PersistedStore,
    input: &SendMessageInput,
    fixed_target: bool,
) -> Result<RoutePlan, String> {
    let chat = store
        .chats
        .iter()
        .find(|c| c.id == input.chat_id)
        .ok_or("Chat not found")?;
    let text = input.text.trim();
    let (command, body) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let is_command = matches!(command, "/group" | "/swarm" | "/race" | "/team");
    let prompt = if is_command { body.trim() } else { text };
    if prompt.is_empty() {
        return Err("Add instructions for the bots after the command.".into());
    }
    let (mentioned, all) = mentions(prompt, &store.bots, None);
    let bot_ids = if fixed_target {
        vec![input
            .override_bot_id
            .clone()
            .ok_or("Choose a bot for this routine.")?]
    } else if command == "/team" {
        let project = store
            .workspaces
            .iter()
            .find(|p| Some(&p.path) == chat.workspace_path.as_ref())
            .ok_or("Choose a project with an assigned team first.")?;
        project.assigned_bot_ids.clone()
    } else if all || input.parallel_mode == Some(true) || is_command {
        chat.participant_bot_ids
            .iter()
            .filter(|id| store.bots.iter().any(|b| &b.id == *id && !b.archived))
            .cloned()
            .collect()
    } else if !mentioned.is_empty() {
        mentioned
    } else {
        vec![input
            .override_bot_id
            .as_ref()
            .or(chat.owner_bot_id.as_ref())
            .or(chat.participant_bot_ids.first())
            .cloned()
            .ok_or("Choose a participant for this chat.")?]
    };
    let mut unique = Vec::new();
    for id in bot_ids {
        if !store.bots.iter().any(|b| b.id == id && !b.archived) {
            return Err("Selected bot is missing or archived. Choose an active bot.".into());
        }
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.is_empty() {
        return Err("Choose at least one active bot for this task.".into());
    }
    for id in &unique {
        let mut bot = store
            .bots
            .iter()
            .find(|b| &b.id == id)
            .expect("validated recipient")
            .clone();
        if let Some(model) = chat.model_overrides.get(id) {
            bot.model = model.clone();
        }
        if input
            .override_bot_id
            .as_ref()
            .map_or(unique.len() == 1, |selected| selected == id)
        {
            if let Some(model) = input
                .override_model
                .as_ref()
                .filter(|m| !m.trim().is_empty())
            {
                bot.model = Some(model.clone());
            }
        }
        crate::execution::validate(&bot)?;
    }
    let parallel = !fixed_target
        && unique.len() > 1
        && (all || input.parallel_mode == Some(true) || command == "/race");
    Ok(RoutePlan {
        bot_ids: unique,
        parallel,
        prompt: prompt.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{input, Fixture};
    #[test]
    fn broadcasts_stay_in_room_and_mentions_keep_textual_order() {
        let f = Fixture::new(&["A", "B", "C"]);
        f.state.write().unwrap().store.chats[0].participant_bot_ids = vec!["A".into()];
        let g = f.state.read().unwrap();
        assert_eq!(
            resolve(&g.store, &input("@all Review"), false)
                .unwrap()
                .bot_ids,
            ["A"]
        );
        assert_eq!(
            resolve(&g.store, &input("@C then @B"), false)
                .unwrap()
                .bot_ids,
            ["C", "B"]
        );
        assert_eq!(
            resolve(&g.store, &input("Explain `@B`\n```\n@C\n```"), false)
                .unwrap()
                .bot_ids,
            ["A"]
        );
    }
    #[test]
    fn control_commands_are_stripped_and_empty_commands_rejected() {
        let f = Fixture::new(&["A", "B"]);
        let g = f.state.read().unwrap();
        let plan = resolve(&g.store, &input("/race\tReview this"), false).unwrap();
        assert!(plan.parallel);
        assert_eq!(plan.prompt, "Review this");
        assert!(resolve(&g.store, &input("/group"), false).is_err());
        assert!(resolve(&g.store, &input("/team Review"), false).is_err());
    }
}
