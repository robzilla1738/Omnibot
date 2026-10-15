use crate::orchestrator::{dispatch_routine_turn, SendMessageInput};
use crate::state::{now_ms, OmniRuntimeState, OmniStreamEvent, RoutineEntry, SharedOmniState};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeDelta, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// Scheduled runs missed by sleep, App Nap, or a busy chat still start within this window.
const GRACE: TimeDelta = TimeDelta::minutes(60);
const WAITING: &str = "waiting";

fn occurrence_on<Tz: TimeZone>(
    schedule: &RoutineSchedule,
    date: NaiveDate,
    tz: &Tz,
) -> Option<DateTime<Tz>> {
    let weekday = date.weekday().num_days_from_sunday();
    if schedule.frequency == Frequency::Manual
        || (schedule.frequency == Frequency::Weekdays && (weekday == 0 || weekday == 6))
        || (schedule.frequency == Frequency::Weekly && weekday != schedule.weekday)
    {
        return None;
    }
    let local = date.and_time(NaiveTime::parse_from_str(&schedule.time, "%H:%M").ok()?);
    // A time skipped by DST runs an hour later; a repeated time counts once, at its first instance.
    tz.from_local_datetime(&local).earliest().or_else(|| {
        tz.from_local_datetime(&(local + TimeDelta::hours(1)))
            .earliest()
    })
}

/// The latest scheduled time at or before `now`, if it is within the grace window and no run
/// (scheduled or manual) has started since. Older missed occurrences are never replayed.
fn pending_occurrence<Tz: TimeZone>(
    routine: &RoutineEntry,
    now: &DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    let schedule = routine.schedule.as_ref().filter(|_| routine.enabled)?;
    let today = now.date_naive();
    let at = [Some(today), today.pred_opt()]
        .into_iter()
        .flatten()
        .filter_map(|date| occurrence_on(schedule, date, &now.timezone()))
        .find(|at| at <= now)?;
    let attempted = routine
        .last_attempt_ms
        .is_some_and(|ms| ms as i64 >= at.timestamp_millis());
    (!attempted && now.clone() - at.clone() < GRACE).then_some(at)
}

fn due(routine: &RoutineEntry, now: DateTime<Local>) -> bool {
    pending_occurrence(routine, &now).is_some()
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
    let mut watched = HashMap::new();
    loop {
        timer.tick().await;
        scheduler_tick(&state, &mut watched, Local::now()).await;
    }
}

/// Per routine: its schedule as last seen and when the scheduler started watching it. Only
/// occurrences from that minute on can fire, so creating or rescheduling a routine shortly
/// after its time doesn't start it immediately.
type Watched = HashMap<String, (String, DateTime<Local>)>;

fn update_routine(state: &SharedOmniState, id: &str, update: impl FnOnce(&mut RoutineEntry)) {
    if let Ok(mut guard) = state.write() {
        if let Some(routine) = guard.store.routines.iter_mut().find(|r| r.id == id) {
            update(routine);
        }
        guard.save_execution();
        guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    }
}

async fn scheduler_tick(state: &SharedOmniState, watched: &mut Watched, now: DateTime<Local>) {
    let mut ready = Vec::new();
    let mut expired = Vec::new();
    {
        let Ok(guard) = state.read() else {
            return;
        };
        watched.retain(|id, _| guard.store.routines.iter().any(|r| &r.id == id));
        for routine in &guard.store.routines {
            let signature =
                serde_json::to_string(&(&routine.schedule, routine.enabled)).unwrap_or_default();
            let entry = watched
                .entry(routine.id.clone())
                .or_insert_with(|| (signature.clone(), now));
            if entry.0 != signature {
                *entry = (signature, now);
            }
            let since = entry.1;
            match pending_occurrence(routine, &now) {
                Some(at) if at + TimeDelta::minutes(1) > since => {
                    let busy = routine
                        .chat_id
                        .as_ref()
                        .is_some_and(|chat| guard.active_workflows.contains(chat));
                    ready.push((routine.id.clone(), at, busy, routine.run_status.clone()));
                }
                _ if routine.run_status.as_deref() == Some(WAITING) => {
                    expired.push(routine.id.clone())
                }
                _ => {}
            }
        }
    }
    for id in expired {
        update_routine(state, &id, |routine| {
            routine.run_status = Some("skipped".into());
            routine.last_error =
                Some("Skipped: the chat stayed busy for an hour after the scheduled time.".into());
        });
    }
    for (id, at, busy, status) in ready {
        let wait = |routine: &mut RoutineEntry| {
            routine.run_status = Some(WAITING.into());
            routine.last_error = Some(format!(
                "The chat is busy. Retrying until {}.",
                (at + GRACE).format("%H:%M")
            ));
        };
        if busy {
            if status.as_deref() != Some(WAITING) {
                update_routine(state, &id, wait);
            }
            continue;
        }
        if let Err(error) = run(state.clone(), &id, None, true).await {
            let chat_busy = state.read().is_ok_and(|guard| {
                guard
                    .store
                    .routines
                    .iter()
                    .find(|r| r.id == id)
                    .and_then(|r| r.chat_id.as_ref())
                    .is_some_and(|chat| guard.active_workflows.contains(chat))
            });
            if chat_busy {
                update_routine(state, &id, wait);
            } else {
                update_routine(state, &id, |routine| {
                    routine.last_attempt_ms = Some(now_ms());
                    routine.run_status = Some("skipped".into());
                    routine.last_error = Some(error);
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    use chrono::TimeZone;
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
        assert!(!due(&r, monday - TimeDelta::minutes(1)));
        // A tick that misses the exact minute (sleep, App Nap) still fires within the window.
        assert!(due(&r, monday + TimeDelta::minutes(59)));
        assert!(!due(&r, monday + TimeDelta::minutes(61)));
        r.schedule.as_mut().unwrap().frequency = Frequency::Weekly;
        assert!(due(&r, monday));
        assert!(!due(&r, sunday));
        r.schedule.as_mut().unwrap().weekday = 0;
        assert!(!due(&r, monday));
        assert!(due(&r, sunday));
    }

    #[test]
    fn manual_runs_before_the_scheduled_time_do_not_cancel_it() {
        let nine = Local.with_ymd_and_hms(2026, 10, 12, 9, 0, 0).unwrap();
        let mut r = routine();
        r.schedule = Some(RoutineSchedule {
            frequency: Frequency::Daily,
            time: "09:00".into(),
            weekday: 0,
        });
        r.last_attempt_ms = Some((nine - TimeDelta::hours(1)).timestamp_millis() as u64);
        assert!(due(&r, nine));
        r.last_attempt_ms = Some((nine + TimeDelta::minutes(5)).timestamp_millis() as u64);
        assert!(!due(&r, nine + TimeDelta::minutes(10)));
        // Yesterday's attempt never blocks today, and a late run keeps its window past midnight.
        r.last_attempt_ms = Some((nine - TimeDelta::days(1)).timestamp_millis() as u64);
        assert!(due(&r, nine));
        r.schedule.as_mut().unwrap().time = "23:30".into();
        assert!(due(&r, nine + TimeDelta::minutes(15 * 60 + 10)));
    }

    /// US Eastern rules for 2026, so the DST test doesn't depend on the machine's time zone.
    #[derive(Clone, Copy, Debug)]
    struct Eastern;
    impl TimeZone for Eastern {
        type Offset = chrono::FixedOffset;
        fn from_offset(_: &chrono::FixedOffset) -> Self {
            Eastern
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> chrono::FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, utc: &chrono::NaiveDateTime) -> chrono::FixedOffset {
            let utc_at = |m, d, h| {
                NaiveDate::from_ymd_opt(2026, m, d)
                    .unwrap()
                    .and_hms_opt(h, 0, 0)
                    .unwrap()
            };
            let summer = *utc >= utc_at(3, 8, 7) && *utc < utc_at(11, 1, 6);
            chrono::FixedOffset::west_opt(if summer { 4 } else { 5 } * 3600).unwrap()
        }
        fn offset_from_local_date(
            &self,
            local: &NaiveDate,
        ) -> chrono::LocalResult<chrono::FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(
            &self,
            local: &chrono::NaiveDateTime,
        ) -> chrono::LocalResult<chrono::FixedOffset> {
            let valid: Vec<_> = [4, 5]
                .map(|hours| chrono::FixedOffset::west_opt(hours * 3600).unwrap())
                .into_iter()
                .filter(|offset| self.offset_from_utc_datetime(&(*local - *offset)) == *offset)
                .collect();
            match valid[..] {
                [] => chrono::LocalResult::None,
                [one] => chrono::LocalResult::Single(one),
                [first, second, ..] => chrono::LocalResult::Ambiguous(first, second),
            }
        }
    }

    #[test]
    fn daylight_saving_gaps_run_later_and_repeated_hours_run_once() {
        let at = |m, d, h, min| {
            Eastern
                .with_ymd_and_hms(2026, m, d, h, min, 0)
                .earliest()
                .unwrap()
        };
        let mut r = routine();
        r.schedule = Some(RoutineSchedule {
            frequency: Frequency::Daily,
            time: "02:30".into(),
            weekday: 0,
        });
        // 02:30 doesn't exist on March 8; it runs at 03:30 instead.
        assert_eq!(
            pending_occurrence(&r, &at(3, 8, 3, 35)),
            Some(at(3, 8, 3, 30))
        );
        assert!(pending_occurrence(&r, &at(3, 8, 3, 25)).is_none());
        r.schedule.as_mut().unwrap().time = "01:30".into();
        let first = at(11, 1, 1, 31);
        assert_eq!(pending_occurrence(&r, &first), Some(at(11, 1, 1, 30)));
        r.last_attempt_ms = Some(first.timestamp_millis() as u64);
        let repeated = first + TimeDelta::hours(1);
        assert_eq!(repeated.naive_local(), first.naive_local());
        assert!(pending_occurrence(&r, &repeated).is_none());
    }

    #[tokio::test]
    async fn scheduler_waits_for_busy_chats_and_ignores_times_before_it_started_watching() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo scheduled");
        let now = Local::now();
        let mut r = routine();
        r.chat_id = Some("room".into());
        r.schedule = Some(RoutineSchedule {
            frequency: Frequency::Daily,
            time: (now - TimeDelta::minutes(5)).format("%H:%M").to_string(),
            weekday: 0,
        });
        crate::server::upsert_routine_entry(&f.state, r).unwrap();
        let replies = || {
            f.state.read().unwrap().store.chats[0]
                .messages
                .iter()
                .filter(|m| m.role == "assistant")
                .count()
        };
        let status = || f.state.read().unwrap().store.routines[0].run_status.clone();

        // A routine first seen after its time (e.g. just created) waits for the next day.
        scheduler_tick(&f.state, &mut Watched::new(), now).await;
        assert!(status().is_none());

        let mut watched = Watched::new();
        scheduler_tick(&f.state, &mut watched, now - TimeDelta::minutes(10)).await;
        f.state
            .write()
            .unwrap()
            .active_workflows
            .insert("room".into());
        scheduler_tick(&f.state, &mut watched, now).await;
        assert_eq!(status().as_deref(), Some(WAITING));
        assert!(f.state.read().unwrap().store.routines[0]
            .last_attempt_ms
            .is_none());
        f.state.write().unwrap().active_workflows.remove("room");
        scheduler_tick(&f.state, &mut watched, now).await;
        f.wait().await;
        assert_eq!(replies(), 1);
        assert_eq!(status().as_deref(), Some("complete"));
        scheduler_tick(&f.state, &mut watched, now).await;
        f.wait().await;
        assert_eq!(replies(), 1);
    }

    #[tokio::test]
    async fn waiting_runs_are_reported_as_skipped_when_the_window_closes() {
        let f = Fixture::new(&["A"]);
        let now = Local::now();
        let mut r = routine();
        r.chat_id = Some("room".into());
        r.schedule = Some(RoutineSchedule {
            frequency: Frequency::Daily,
            time: (now - TimeDelta::minutes(5)).format("%H:%M").to_string(),
            weekday: 0,
        });
        crate::server::upsert_routine_entry(&f.state, r).unwrap();
        f.state.write().unwrap().store.routines[0].run_status = Some(WAITING.into());
        scheduler_tick(&f.state, &mut Watched::new(), now + TimeDelta::minutes(70)).await;
        let g = f.state.read().unwrap();
        assert_eq!(g.store.routines[0].run_status.as_deref(), Some("skipped"));
        assert!(g.store.chats[0].messages.is_empty());
    }
}
