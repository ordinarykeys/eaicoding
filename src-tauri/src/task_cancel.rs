use std::collections::HashMap;
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

// Keep early cancellation briefly: IPC cancellation can arrive before its task.
struct TaskEntry {
    cancel: watch::Sender<bool>,
    created: Instant,
}

static TASKS: LazyLock<Mutex<HashMap<String, TaskEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn new_entry() -> TaskEntry {
    TaskEntry {
        cancel: watch::channel(false).0,
        created: Instant::now(),
    }
}

struct TaskGuard(String);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Ok(mut tasks) = TASKS.lock() {
            tasks.remove(&self.0);
        }
    }
}

#[tauri::command]
pub fn cancel_agent_task(request_id: String) -> Result<(), String> {
    let mut tasks = TASKS.lock().map_err(|_| "Task registry lock failed")?;
    tasks.retain(|_, entry| {
        !*entry.cancel.borrow() || entry.created.elapsed() < Duration::from_secs(600)
    });
    tasks
        .entry(request_id)
        .or_insert_with(new_entry)
        .cancel
        .send_replace(true);
    Ok(())
}

pub async fn cancellable<T>(
    request_id: Option<String>,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let Some(id) = request_id else {
        return future.await;
    };
    let mut receiver = {
        let mut tasks = TASKS.lock().map_err(|_| "Task registry lock failed")?;
        tasks
            .entry(id.clone())
            .or_insert_with(new_entry)
            .cancel
            .subscribe()
    };
    let _guard = TaskGuard(id);
    if *receiver.borrow() {
        return Err("操作已取消".to_string());
    }
    tokio::select! {
        biased;
        _ = receiver.changed() => Err("操作已取消".to_string()),
        result = future => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_registration_does_not_start_task() {
        tauri::async_runtime::block_on(async {
            let id = "test-cancel-before-registration".to_string();
            cancel_agent_task(id.clone()).unwrap();
            let result =
                cancellable(Some(id.clone()), async { panic!("cancelled task polled") }).await;
            assert!(matches!(result, Err::<(), _>(_)));
            assert!(!TASKS.lock().unwrap().contains_key(&id));
        });
    }

    #[test]
    fn cancellation_drops_running_future() {
        tauri::async_runtime::block_on(async {
            let id = "test-cancel-running".to_string();
            let request_id = id.clone();
            let handle = tokio::spawn(async move {
                cancellable(Some(request_id), async {
                    std::future::pending::<Result<(), String>>().await
                })
                .await
            });
            tokio::task::yield_now().await;
            cancel_agent_task(id.clone()).unwrap();
            assert!(tokio::time::timeout(Duration::from_secs(1), handle)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert!(!TASKS.lock().unwrap().contains_key(&id));
        });
    }
}
