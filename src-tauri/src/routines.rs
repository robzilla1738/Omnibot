use crate::orchestrator::{dispatch_routine_turn, SendMessageInput};
use crate::state::{now_ms, OmniRuntimeState, OmniStreamEvent, RoutineEntry, SharedOmniState};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSchedule {
    pub frequency: Frequency,
    pub time: String,
    pub weekday: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Frequency {
    Manual,
    Daily,
    Weekdays,
    Weekly,
}

pub fn validate(state: &OmniRuntimeState, routine: &RoutineEntry) -> Result<(), String> {
    if routine.name.trim().is_empty()
        || routine.name.chars().count() > 100
        || routine.prompt.trim().is_empty()
        || routine.prompt.len() > 50_000
    {
        return Err("Add a routine name (up to 100 characters) and instructions.".into());
    }
    if !state
        .store
        .bots
        .iter()
        .any(|b| b.id == routine.bot_id && !b.archived)
    {
        return Err("Choose an existing bot.".into());
    }
    if let Some(id) = &routine.chat_id {
        if !state.store.chats.iter().any(|c| &c.id == id) {
            return Err("This routine's chat no longer exists.".into());
        }
    }
    if let Some(schedule) = &routine.schedule {
        if schedule.frequency != Frequency::Manual {
            if routine.chat_id.is_none() {
                return Err("Choose a chat for scheduled runs.".into());
            }
            if chrono::NaiveTime::parse_from_str(&schedule.time, "%H:%M").is_err()
                || schedule.weekday > 6
            {
                return Err("Choose a valid time and day.".into());
            }
        }
    }
    if routine
        .model
        .as_deref()
        .is_some_and(|m| !crate::lifecycle::valid_model_id(m))
    {
        return Err("Use a valid CLI model ID.".into());
    }
    Ok(())
}

fn due(routine: &RoutineEntry, now: DateTime<Local>) -> bool {
    let Some(schedule) = &routine.schedule else {
        return false;
    };
    if !routine.enabled || schedule.frequency == Frequency::Manual {
        return false;
    }
    let weekday = now.weekday().num_days_from_sunday();
    if (schedule.frequency == Frequency::Weekdays && (weekday == 0 || weekday == 6))
        || (schedule.frequency == Frequency::Weekly && weekday != schedule.weekday)
    {
        return false;
    }
    if schedule.time != format!("{:02}:{:02}", now.hour(), now.minute()) {
        return false;
    }
    // Once per local day, including repeated DST hours and app restarts.
    !routine
        .last_attempt_ms
        .and_then(|ms| DateTime::from_timestamp_millis(ms as i64))
        .is_some_and(|last| last.with_timezone(&Local).date_naive() >= now.date_naive())
}

async fn run(
    state: SharedOmniState,
    id: &str,
    fallback_chat: Option<String>,
    scheduled: bool,
) -> Result<String, String> {
    let (routine, chat_id) = {
        let mut guard = state.write().map_err(|_| "State lock poisoned")?;
        let routine = guard
            .store
            .routines
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or("Routine not found")?;
        validate(&guard, &routine)?;
        if scheduled && !due(&routine, Local::now()) {
            return Err("Routine is not due.".into());
        }
        let chat_id = routine
            .chat_id
            .clone()
            .or(fallback_chat)
            .ok_or("Choose a chat for this routine.")?;
        if guard.active_workflows.contains(&chat_id) {
            return Err("This chat is busy. Wait for its current task to finish.".into());
        }
        if routine
            .last_attempt_ms
            .is_some_and(|last| now_ms().saturating_sub(last) < 2000)
        {
            return Err("This routine is already starting.".into());
        }
        let previous = guard.store.clone();
        guard
            .store
            .routines
            .iter_mut()
            .find(|r| r.id == id)
            .unwrap()
            .last_attempt_ms = Some(now_ms());
        if let Err(error) = guard.persist() {
            guard.store = previous;
            return Err(error);
        }
        (routine, chat_id)
    };
    let result = dispatch_routine_turn(
        state.clone(),
        SendMessageInput {
            summarize: false,
            chat_id,
            text: routine.prompt,
            skill_slug: None,
            override_bot_id: Some(routine.bot_id),
            override_model: routine.model,
            override_effort: None,
            parallel_mode: Some(false),
        },
        id.to_string(),
    )
    .await;
    if let Ok(mut guard) = state.write() {
        if let Some(routine) = guard.store.routines.iter_mut().find(|r| r.id == id) {
            if let Err(error) = &result {
                routine.last_error = Some(error.clone());
                routine.run_status = Some("error".into());
            }
            guard.save_execution();
            guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
        }
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    id: String,
    chat_id: Option<String>,
}
pub async fn http_run(
    State(state): State<SharedOmniState>,
    Json(input): Json<RunInput>,
) -> axum::response::Response {
    match run(state, &input.id, input.chat_id, false).await {
        Ok(message_id) => Json(serde_json::json!({ "messageId": message_id })).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

pub async fn scheduler(state: SharedOmniState) {
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(15));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        let ids: Vec<_> = match state.read() {
            Ok(guard) => guard
                .store
                .routines
                .iter()
                .filter(|r| due(r, Local::now()))
                .map(|r| r.id.clone())
                .collect(),
            Err(_) => continue,
        };
        for id in ids {
            if let Err(error) = run(state.clone(), &id, None, true).await {
                if let Ok(mut guard) = state.write() {
                    if let Some(routine) = guard.store.routines.iter_mut().find(|r| r.id == id) {
                        routine.last_attempt_ms = Some(now_ms());
                        routine.run_status = Some("skipped".into());
                        routine.last_error = Some(error);
                    }
                    guard.save_execution();
                    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    fn routine() -> RoutineEntry {
        serde_json::from_value(serde_json::json!({"id":"r", "name":"Review", "prompt":"Review changes", "botId":"A", "enabled":true, "lastRunMs":null})).unwrap()
    }
    #[test]
    fn legacy_routines_stay_manual_and_schedules_run_once() {
        let mut r = routine();
        let now = Local::now();
        assert!(!due(&r, now));
        r.schedule = Some(RoutineSchedule {
            frequency: Frequency::Daily,
            time: now.format("%H:%M").to_string(),
            weekday: 1,
        });
        assert!(due(&r, now));
        r.last_attempt_ms = Some(now.timestamp_millis() as u64);
        assert!(!due(&r, now));
        r.last_attempt_ms = None;
        r.enabled = false;
        assert!(!due(&r, now));
    }
    #[test]
    fn invalid_routines_do_not_persist() {
        let f = Fixture::new(&["A"]);
        let mut r = routine();
        r.model = Some("-p".into());
        assert!(crate::server::upsert_routine_entry(&f.state, r.clone()).is_err());
        r.model = None;
        r.bot_id = "missing".into();
        assert!(crate::server::upsert_routine_entry(&f.state, r).is_err());
        assert!(f.state.read().unwrap().store.routines.is_empty());
    }
    #[tokio::test]
    async fn run_uses_saved_bot_model_prompt_and_chat() {
        let f = Fixture::new(&["A", "B"]);
        f.script("A", "echo WRONG_BOT");
        f.script("B", "echo SAVED_BOT");
        let mut r = routine();
        r.prompt = "Ask @A about changes".into();
        r.bot_id = "B".into();
        r.model = Some("fixture-small".into());
        r.chat_id = Some("room".into());
        crate::server::upsert_routine_entry(&f.state, r).unwrap();
        run(f.state.clone(), "r", Some("wrong-fallback".into()), false)
            .await
            .unwrap();
        f.wait().await;
        {
            let guard = f.state.read().unwrap();
            let messages = &guard.store.chats[0].messages;
            assert!(messages
                .iter()
                .any(|m| m.role == "user" && m.text == "Ask @A about changes"));
            let replies: Vec<_> = messages.iter().filter(|m| m.role == "assistant").collect();
            assert_eq!(replies.len(), 1);
            assert_eq!(replies[0].author_bot_id.as_deref(), Some("B"));
            assert_eq!(replies[0].model.as_deref(), Some("fixture-small"));
            assert!(replies[0].text.contains("SAVED_BOT"));
            assert!(guard.store.routines[0].last_run_ms.is_some());
            assert!(guard.store.routines[0].last_error.is_none());
        }
        assert!(run(f.state.clone(), "r", None, false).await.is_err());
    }

    #[tokio::test]
    async fn routine_failure_is_an_execution_outcome_not_a_successful_dispatch() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo failed-request; exit 1");
        let mut r = routine();
        r.chat_id = Some("room".into());
        crate::server::upsert_routine_entry(&f.state, r).unwrap();
        let workflow_id = run(f.state.clone(), "r", None, false).await.unwrap();
        f.wait().await;
        let g = f.state.read().unwrap();
        let r = &g.store.routines[0];
        assert_eq!(r.workflow_id.as_deref(), Some(workflow_id.as_str()));
        assert_eq!(r.run_status.as_deref(), Some("error"));
        assert!(r.last_error.is_some());
        assert!(r.last_run_ms.is_none());
    }
    #[tokio::test]
    async fn failed_persistence_never_launches_a_routine() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo SHOULD_NOT_RUN");
        let mut r = routine();
        r.chat_id = Some("room".into());
        crate::server::upsert_routine_entry(&f.state, r).unwrap();
        let blocked = f.dir.join("not-a-directory");
        std::fs::write(&blocked, "blocked").unwrap();
        f.state.write().unwrap().data_dir = blocked;
        assert!(run(f.state.clone(), "r", None, false).await.is_err());
        let guard = f.state.read().unwrap();
        assert!(guard.store.chats[0].messages.is_empty());
        assert!(guard.store.routines[0].last_attempt_ms.is_none());
    }
    #[test]
    fn weekdays_weekly_and_missed_minutes_are_respected() {
        use chrono::TimeZone;
        let monday = Local.with_ymd_and_hms(2026, 10, 12, 9, 0, 0).unwrap();
        let sunday = Local.with_ymd_and_hms(2026, 10, 11, 9, 0, 0).unwrap();
        let mut r = routine();
        r.schedule = Some(RoutineSchedule {
            frequency: Frequency::Weekdays,
            time: "09:00".into(),
            weekday: 1,
        });
        assert!(due(&r, monday));
        assert!(!due(&r, sunday));
        assert!(!due(&r, monday + chrono::Duration::minutes(1)));
        r.schedule.as_mut().unwrap().frequency = Frequency::Weekly;
        assert!(due(&r, monday));
        assert!(!due(&r, sunday));
        r.schedule.as_mut().unwrap().weekday = 0;
        assert!(!due(&r, monday));
        assert!(due(&r, sunday));
    }
}
