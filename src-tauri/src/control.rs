//! Authenticated loopback transport. App windows own execution; callers never
//! receive arbitrary Tauri command access or direct database write access.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const APP_TURN_INACTIVE: &str = "MonoCode app access is inactive. Use /operator once in this thread to enable it, then call the CLI during an active agent turn. Retrying this request now will not enable access.";
const APP_REFERENCE_UNAUTHORIZED: &str =
    "Session references grant reading only for sent reference IDs; action is unauthorized";
const APP_REFERENCES_PENDING: &str =
    "Edited turn references are awaiting acceptance and durable save; retry with the same request ID";

#[derive(Clone)]
struct Grant {
    window: String,
    session: String,
    cwd: String,
    token: String,
}
struct Pending {
    window: String,
    session: String,
    namespace: String,
    action: String,
    request_id: String,
    reply: mpsc::Sender<Value>,
}
struct ActiveTurn {
    window: String,
    cwd: String,
    app_allowed: bool,
    reference_ids: std::collections::HashSet<String>,
    references_pending: bool,
    reference_turn_id: String,
}
#[derive(Default)]
struct Inner {
    grants: HashMap<String, Grant>,
    app_grants: HashMap<String, Grant>,
    pending: HashMap<String, Pending>,
    workers: HashMap<String, String>,
    scratch: HashMap<String, PathBuf>,
    active: HashMap<String, ActiveTurn>,
}
impl Inner {
    fn check_restore_window(&self, lead: &str, window: &str) -> Result<(), String> {
        if self
            .grants
            .get(lead)
            .is_some_and(|grant| grant.window != window)
            || self.active.iter().any(|(id, turn)| {
                (id == lead || self.workers.get(id).is_some_and(|parent| parent == lead))
                    && turn.window != window
            })
        {
            return Err("This orchestration is running in another window. Use its original window to manage it.".into());
        }
        Ok(())
    }

    fn enable(&mut self, session: &str, window: &str, cwd: &str) -> Result<(), String> {
        if self.workers.contains_key(session) {
            return Err("A worker cannot become an orchestrator".into());
        }
        if self
            .active
            .get(session)
            .is_some_and(|turn| turn.window != window)
        {
            return Err("This session is running in another window".into());
        }
        if self.grants.values().any(|grant| {
            paths_overlap(&grant.cwd, cwd) && (grant.session != session || grant.window != window)
        }) {
            return Err("This checkout already has an orchestrator in another session".into());
        }
        self.prepare_app_grant(session, window, cwd);
        self.grants.insert(
            session.into(),
            Grant {
                window: window.into(),
                session: session.into(),
                cwd: cwd.into(),
                token: format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple(),
                ),
            },
        );
        Ok(())
    }

    fn authorize_turn(
        &mut self,
        session: &str,
        window: &str,
        cwd: &str,
        app_access: bool,
    ) -> Result<(), String> {
        // Checkout reservations select the sole lead, not every conversation.
        // Credentials are still tied to session identity in configure_child.
        if self
            .active
            .get(session)
            .is_some_and(|turn| turn.window != window || turn.cwd != cwd)
        {
            return Err("This session is running in another window or checkout".into());
        }
        if self
            .grants
            .get(session)
            .is_some_and(|grant| grant.window != window || grant.cwd != cwd)
        {
            return Err(
                "Return the lead to its original checkout or stop orchestration first".into(),
            );
        }
        if let Some(lead) = self.workers.get(session) {
            if self
                .grants
                .get(lead)
                .is_none_or(|grant| grant.window != window)
            {
                return Err("Worker connection is inactive or belongs to another window".into());
            }
        }
        let eligible = self.prepare_app_grant(session, window, cwd);
        self.active.insert(
            session.into(),
            ActiveTurn {
                window: window.into(),
                cwd: cwd.into(),
                app_allowed: app_access && eligible,
                reference_ids: Default::default(),
                references_pending: false,
                reference_turn_id: uuid::Uuid::new_v4().to_string(),
            },
        );
        Ok(())
    }

    fn disable(&mut self, session: &str, window: &str, reply_request_id: Option<&str>) {
        if self
            .grants
            .get(session)
            .is_none_or(|grant| grant.window != window)
        {
            return;
        }
        let mut ids = vec![session.to_string()];
        ids.extend(
            self.workers
                .iter()
                .filter(|(_, parent)| *parent == session)
                .map(|(id, _)| id.clone()),
        );
        self.grants.remove(session);
        for id in &ids {
            self.workers.remove(id);
            self.scratch.remove(id);
            self.active.remove(id);
        }
        self.pending.retain(|_, pending| {
            if pending.namespace != "control" || !ids.contains(&pending.session) {
                return true;
            }
            // Revoke credentials now, but let the already committed finish
            // acknowledge itself through control_reply. Stop never preserves
            // a pending reply, and other requests are still cancelled.
            if pending.session == session
                && pending.window == window
                && pending.action == "finish"
                && reply_request_id == Some(pending.request_id.as_str())
            {
                return true;
            }
            let _ = pending
                .reply
                .send(json!({"ok":false,"error":"Connection revoked or unauthorized"}));
            false
        });
    }

    fn refresh_references(
        &mut self,
        session: &str,
        window: &str,
        ids: std::collections::HashSet<String>,
        turn_id: Option<&str>,
    ) -> bool {
        if self.workers.contains_key(session) || self.grants.contains_key(session) {
            return false;
        }
        if let Some(turn) = self.active.get_mut(session).filter(|turn| {
            turn.window == window
                && turn_id.is_none_or(|id| turn.reference_turn_id == id)
                && (!turn.references_pending || turn_id.is_some())
        }) {
            turn.reference_ids = ids;
            turn.references_pending = false;
            return true;
        }
        // A late save/acceptance callback must never reactivate a finished turn.
        false
    }

    fn hold_references(&mut self, session: &str, window: &str) {
        if self.workers.contains_key(session) || self.grants.contains_key(session) {
            return;
        }
        if let Some(turn) = self
            .active
            .get_mut(session)
            .filter(|turn| turn.window == window)
        {
            turn.reference_ids.clear();
            turn.references_pending = true;
        }
    }

    fn request(
        &mut self,
        id: &str,
        request: &Request,
        reply: mpsc::Sender<Value>,
    ) -> Result<Grant, String> {
        let grant = request_grant(self, &request.namespace, &request.token)?;
        if request.namespace == "app" {
            let turn = &self.active[&grant.session];
            if !turn.app_allowed
                && !(request.action == "sessions.references"
                    || (["sessions.read", "sessions.export"].contains(&request.action.as_str())
                        && request
                            .input
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .is_some_and(|id| turn.reference_ids.contains(id))))
            {
                return Err(APP_REFERENCE_UNAUTHORIZED.into());
            }
        }
        if self.pending.len() >= 24 {
            return Err("Too many pending control requests".into());
        }
        self.pending.insert(
            id.into(),
            Pending {
                window: grant.window.clone(),
                session: grant.session.clone(),
                namespace: request.namespace.clone(),
                action: request.action.clone(),
                request_id: request.request_id.clone(),
                reply,
            },
        );
        Ok(grant)
    }

    fn reply(&mut self, window: &str, id: &str, response: Value) {
        if self
            .pending
            .get(id)
            .is_some_and(|pending| pending.window == window)
        {
            if let Some(pending) = self.pending.remove(id) {
                let _ = pending.reply.send(response);
            }
        }
    }

    fn configure_child(&self, endpoint: &str, session: &str, cmd: &mut Command) {
        clear_child_credentials(cmd);
        if let Some(grant) = self.grants.get(session) {
            cmd.env("MONOCODE_CONTROL_ENDPOINT", endpoint)
                .env("MONOCODE_CONTROL_TOKEN", &grant.token);
        }
        if let Some(grant) = self.app_grants.get(session) {
            cmd.env("MONOCODE_APP_ENDPOINT", endpoint)
                .env("MONOCODE_APP_TOKEN", &grant.token);
        }
        if let Some(scratch) = self.scratch.get(session) {
            configure_worker_scratch(cmd, scratch);
        }
    }

    // Provider processes can stay alive between turns, so install the token
    // before their first spawn. request_grant still requires an opted-in turn.
    fn prepare_app_grant(&mut self, session: &str, window: &str, cwd: &str) -> bool {
        if self.workers.contains_key(session) || self.grants.contains_key(session) {
            return false;
        }
        let token = self
            .app_grants
            .get(session)
            .map(|grant| grant.token.clone())
            .unwrap_or_else(|| {
                format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                )
            });
        self.app_grants.insert(
            session.to_string(),
            Grant {
                window: window.to_string(),
                session: session.to_string(),
                cwd: cwd.to_string(),
                token,
            },
        );
        true
    }

    fn window_sessions(&self, label: &str) -> Vec<String> {
        let leads: Vec<String> = self
            .grants
            .values()
            .filter(|grant| grant.window == label)
            .map(|grant| grant.session.clone())
            .collect();
        let mut ids = leads.clone();
        ids.extend(
            self.app_grants
                .values()
                .filter(|grant| grant.window == label)
                .map(|grant| grant.session.clone()),
        );
        ids.extend(
            self.workers
                .iter()
                .filter(|(_, lead)| leads.contains(lead))
                .map(|(id, _)| id.clone()),
        );
        ids.extend(
            self.active
                .iter()
                .filter(|(_, turn)| turn.window == label)
                .map(|(id, _)| id.clone()),
        );
        ids.sort();
        ids.dedup();
        ids
    }
    fn close_window(&mut self, label: &str) -> Vec<String> {
        let ids = self.window_sessions(label);
        self.grants.retain(|id, _| !ids.contains(id));
        self.app_grants.retain(|id, _| !ids.contains(id));
        self.workers.retain(|id, _| !ids.contains(id));
        self.scratch.retain(|id, _| !ids.contains(id));
        self.active.retain(|id, _| !ids.contains(id));
        self.pending.retain(|_, pending| {
            if pending.window != label {
                return true;
            }
            let _ = pending
                .reply
                .send(json!({"ok":false,"error":"MonoCode window closed"}));
            false
        });
        ids
    }
}
pub struct ControlHost {
    endpoint: String,
    inner: Arc<Mutex<Inner>>,
    references_changed: Arc<Condvar>,
}

fn paths_overlap(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

/** Windows paths compare case-insensitively; POSIX paths must retain case. */
fn comparison_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    namespace: String,
    action: String,
    input: Value,
    request_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    namespace: String,
    session_id: String,
    request_id: String,
    action: String,
    input: Value,
}

fn request_grant(host: &Inner, namespace: &str, token: &str) -> Result<Grant, String> {
    let grant = match namespace {
        "control" => host.grants.values().find(|grant| grant.token == token),
        "app" => host.app_grants.values().find(|grant| grant.token == token),
        _ => return Err("Unknown control namespace".into()),
    }
    .cloned()
    .ok_or("Connection revoked or unauthorized")?;
    if namespace == "app"
        && (host.grants.contains_key(&grant.session)
            || host.workers.contains_key(&grant.session)
            || !host.active.get(&grant.session).is_some_and(|turn| {
                turn.window == grant.window
                    && (turn.app_allowed
                        || !turn.reference_ids.is_empty()
                        || turn.references_pending)
            }))
    {
        return Err(APP_TURN_INACTIVE.into());
    }
    if namespace == "app" && host.active[&grant.session].references_pending {
        return Err(APP_REFERENCES_PENDING.into());
    }
    Ok(grant)
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let endpoint = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let inner = Arc::new(Mutex::new(Inner::default()));
    let references_changed = Arc::new(Condvar::new());
    app.manage(ControlHost {
        endpoint,
        inner: inner.clone(),
        references_changed: references_changed.clone(),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        // Limit concurrent readers, including unauthenticated sockets.
        let (tx, rx) = mpsc::sync_channel::<TcpStream>(32);
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..8 {
            let rx = rx.clone();
            let app = app.clone();
            let inner = inner.clone();
            let references_changed = references_changed.clone();
            std::thread::spawn(move || loop {
                let stream = match rx.lock() {
                    Ok(rx) => rx.recv(),
                    Err(_) => return,
                };
                let Ok(stream) = stream else { return };
                serve(stream, &app, &inner, &references_changed);
            });
        }
        for stream in listener.incoming().flatten() {
            let _ = tx.try_send(stream);
        }
    });
    Ok(())
}

fn wait_for_reference_ready<'a>(
    inner: &'a Mutex<Inner>,
    changed: &Condvar,
    request: &Request,
) -> Result<MutexGuard<'a, Inner>, String> {
    let host = inner.lock().map_err(|_| "Control service unavailable")?;
    let (host, _) = changed
        .wait_timeout_while(host, Duration::from_secs(5), |host| {
            request_grant(host, &request.namespace, &request.token)
                .err()
                .as_deref()
                == Some(APP_REFERENCES_PENDING)
        })
        .map_err(|_| "Control service unavailable")?;
    Ok(host)
}

fn serve(
    mut stream: TcpStream,
    app: &AppHandle,
    inner: &Arc<Mutex<Inner>>,
    references_changed: &Condvar,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let result = (|| -> Result<Value, String> {
        let mut raw = String::new();
        BufReader::new(&mut stream)
            .take(262_145)
            .read_line(&mut raw)
            .map_err(|e| e.to_string())?;
        if raw.len() > 262_144 {
            return Err("Request exceeds 256 KiB".into());
        }
        let request: Request = serde_json::from_str(&raw).map_err(|_| "Invalid control request")?;
        if !request.input.is_object()
            || request.request_id.is_empty()
            || request.request_id.len() > 128
        {
            return Err("Invalid input or request ID".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let grant = {
            // No old or newly selected ID is authorized during an edited resend.
            // Release the mutex while the accepted block is durably saved; recheck
            // the credential and exact source scope after the barrier opens.
            let mut host = wait_for_reference_ready(inner, references_changed, &request)?;
            host.request(&id, &request, tx)?
        };
        let event = Event {
            id: id.clone(),
            namespace: request.namespace,
            session_id: grant.session,
            request_id: request.request_id,
            action: request.action,
            input: request.input,
        };
        let delivered = app.emit_to(grant.window.as_str(), "monocode-control-request", event);
        let result = if delivered.is_err() {
            Err("MonoCode executor is unavailable".into())
        } else {
            rx.recv_timeout(Duration::from_secs(35))
                .map_err(|_| "Control request timed out. Retry with the same request ID.".into())
        };
        if let Ok(mut host) = inner.lock() {
            host.pending.remove(&id);
        }
        result
    })();
    let response = result.unwrap_or_else(|error| {
        if error == APP_REFERENCES_PENDING {
            json!({"ok":false,"code":"SESSION_REFERENCES_PENDING","error":error,"retryable":true})
        } else if error == APP_TURN_INACTIVE || error == APP_REFERENCE_UNAUTHORIZED {
            json!({"ok": false, "error": error, "retryable": false})
        } else {
            json!({"ok": false, "error": error})
        }
    });
    let _ = writeln!(stream, "{response}");
}

#[tauri::command]
pub fn control_enable(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    session_id: String,
    cwd: String,
) -> Result<String, String> {
    let cwd = std::fs::canonicalize(crate::fs::expand_home(&cwd)).map_err(|e| e.to_string())?;
    if !cwd.is_dir() {
        return Err("Choose a project folder first".into());
    }
    let cwd = comparison_path(&cwd);
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Control service unavailable")?;
    inner.enable(&session_id, window.label(), &cwd)?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(executable.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn control_disable(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    session_id: String,
    reply_request_id: Option<String>,
) -> Result<(), String> {
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Control service unavailable")?;
    inner.disable(&session_id, window.label(), reply_request_id.as_deref());
    Ok(())
}

#[tauri::command]
pub fn control_attach_worker(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    lead_id: String,
    session_id: String,
) -> Result<String, String> {
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Control service unavailable")?;
    if inner
        .grants
        .get(&lead_id)
        .is_none_or(|grant| grant.window != window.label())
    {
        return Err("Lead connection is inactive".into());
    }
    if lead_id == session_id
        || inner.grants.contains_key(&session_id)
        || inner
            .workers
            .get(&session_id)
            .is_some_and(|parent| parent != &lead_id)
    {
        return Err("This session already belongs to another orchestrator".into());
    }
    let scratch = match inner.scratch.get(&session_id) {
        Some(path) if path.is_dir() => path.clone(),
        _ => create_worker_scratch()?,
    };
    inner.workers.insert(session_id.clone(), lead_id);
    inner.app_grants.remove(&session_id);
    inner.scratch.insert(session_id, scratch.clone());
    Ok(scratch.to_string_lossy().into_owned())
}

fn create_worker_scratch() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("monocode-worker-{}", uuid::Uuid::new_v4()));
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(&path).map_err(|e| e.to_string())?;
    std::fs::canonicalize(path).map_err(|e| e.to_string())
}

fn configure_worker_scratch(cmd: &mut Command, path: &Path) {
    // Native temp-file helpers and shell mktemp use the same private scope
    // that is named in the worker's assignment prompt.
    cmd.env("TMPDIR", path).env("TMP", path).env("TEMP", path);
}

#[tauri::command]
pub fn control_authorize_turn(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    store: State<'_, crate::session_store::SessionStore>,
    session_id: String,
    cwd: String,
    app_access: bool,
    references_pending: Option<bool>,
) -> Result<String, String> {
    let cwd = std::fs::canonicalize(crate::fs::expand_home(&cwd)).map_err(|e| e.to_string())?;
    let cwd = comparison_path(&cwd);
    let reference_ids =
        crate::session_references::sent_reference_ids(&*store.lock_conn()?, &session_id)?;
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Control service unavailable")?;
    inner.authorize_turn(&session_id, window.label(), &cwd, app_access)?;
    // Only durable, sent user blocks authorize reads. UI draft/queue data is
    // never accepted as a list of grants; workers/leads remain credential-isolated.
    if references_pending == Some(true) {
        inner.hold_references(&session_id, window.label());
    } else {
        inner.refresh_references(&session_id, window.label(), reference_ids, None);
    }
    Ok(inner.active[&session_id].reference_turn_id.clone())
}

#[tauri::command]
pub fn control_turn_finished(host: State<'_, ControlHost>, session_id: String) {
    if let Ok(mut inner) = host.inner.lock() {
        inner.active.remove(&session_id);
        host.references_changed.notify_all();
    }
}

#[tauri::command]
pub fn control_refresh_references(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    store: State<'_, crate::session_store::SessionStore>,
    session_id: String,
    turn_id: Option<String>,
) -> Result<bool, String> {
    let ids = crate::session_references::sent_reference_ids(&*store.lock_conn()?, &session_id)?;
    let refreshed = host
        .inner
        .lock()
        .map_err(|_| "Control service unavailable")?
        .refresh_references(&session_id, window.label(), ids, turn_id.as_deref());
    host.references_changed.notify_all();
    Ok(refreshed)
}

pub fn window_closed(app: &AppHandle, label: &str) {
    let host = app.state::<ControlHost>();
    let ids = {
        let Ok(inner) = host.inner.lock() else { return };
        inner.window_sessions(label)
    };
    for id in &ids {
        let _ = crate::harness::harness_kill(app.state(), id.clone());
    }
    if let Ok(mut inner) = host.inner.lock() {
        inner.close_window(label);
        host.references_changed.notify_all();
    };
}

fn clear_child_credentials(cmd: &mut Command) {
    cmd.env_remove("MONOCODE_CONTROL_ENDPOINT")
        .env_remove("MONOCODE_CONTROL_TOKEN")
        .env_remove("MONOCODE_APP_ENDPOINT")
        .env_remove("MONOCODE_APP_TOKEN");
}

pub fn configure_child(app: &AppHandle, session_id: &str, cmd: &mut Command) {
    clear_child_credentials(cmd);
    let Some(host) = app.try_state::<ControlHost>() else {
        return;
    };
    if let Ok(inner) = host.inner.lock() {
        inner.configure_child(&host.endpoint, session_id, cmd);
    };
}

#[tauri::command]
pub fn app_cli_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn control_reply(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    id: String,
    response: Value,
) -> Result<(), String> {
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "Control service unavailable")?;
    inner.reply(window.label(), &id, response);
    Ok(())
}

#[tauri::command]
pub fn control_save(
    store: State<'_, crate::session_store::SessionStore>,
    lead_id: String,
    state: String,
) -> Result<(), String> {
    if state.len() > 8_000_000 {
        return Err("Orchestration history is too large".into());
    }
    let run: Value = serde_json::from_str(&state).map_err(|_| "Invalid run state")?;
    let conn = store.lock_conn()?;
    crate::session_store::save_orchestration(&conn, &lead_id, &run).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn control_load(
    window: WebviewWindow,
    host: State<'_, ControlHost>,
    store: State<'_, crate::session_store::SessionStore>,
    lead_id: String,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    host.inner
        .lock()
        .map_err(|_| "Control service unavailable")?
        .check_restore_window(&lead_id, window.label())?;
    store
        .lock_conn()?
        .query_row(
            "SELECT state FROM orchestration_runs WHERE lead_id=?1",
            [lead_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn resolve_scope(root: &Path, value: &str) -> Result<String, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Write scopes must be project-relative paths without '..'".into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut existing = root.join(path);
    let mut missing = Vec::new();
    while !existing.exists() {
        missing.push(existing.file_name().ok_or("Invalid scope")?.to_os_string());
        if !existing.pop() {
            return Err("Invalid scope".into());
        }
    }
    existing = std::fs::canonicalize(existing).map_err(|e| e.to_string())?;
    if !existing.starts_with(&root) {
        return Err("Write scope points outside the project".into());
    }
    for part in missing.into_iter().rev() {
        existing.push(part);
    }
    Ok(comparison_path(&existing))
}

/// Resolve reported writes as well as scopes: aliases and symlinks must not
/// turn a private scratch directory into an exemption for another worker's files.
#[tauri::command]
pub fn control_write_path(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    if !path.is_absolute() {
        return Err("Reported write paths must be absolute".into());
    }
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.exists() {
        // A dangling symlink cannot be treated as a new ordinary file.
        if std::fs::symlink_metadata(existing).is_ok() {
            return Err("Reported write path contains a dangling symlink".into());
        }
        missing.push(
            existing
                .file_name()
                .ok_or("Invalid write path")?
                .to_os_string(),
        );
        existing = existing.parent().ok_or("Invalid write path")?;
    }
    let mut resolved = std::fs::canonicalize(existing).map_err(|e| e.to_string())?;
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
pub fn control_scopes(cwd: String, files: Vec<String>) -> Result<Vec<String>, String> {
    if files.len() > 64 {
        return Err("At most 64 write scopes per task".into());
    }
    files
        .iter()
        .map(|file| {
            resolve_scope(&crate::fs::expand_home(&cwd), file)
                .map_err(|error| format!("Invalid write scope \"{file}\": {error}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_cannot_take_over_a_live_run_in_another_window() {
        let mut inner = Inner::default();
        inner.enable("lead", "first", "/repo").unwrap();
        // An idle lead still owns its run and must not be revoked by hydration.
        assert!(inner.check_restore_window("lead", "second").is_err());
        assert!(inner.check_restore_window("lead", "first").is_ok());
        assert!(inner.grants.contains_key("lead"));
        inner.workers.insert("worker".into(), "lead".into());
        inner
            .authorize_turn("worker", "first", "/isolated", false)
            .unwrap();
        assert!(inner.check_restore_window("lead", "second").is_err());
        inner.close_window("first");
        assert!(inner.check_restore_window("lead", "second").is_ok());
    }

    #[test]
    fn ordinary_turns_and_orchestration_start_in_either_order_without_sharing_control() {
        for ordinary_first in [true, false] {
            let mut inner = Inner::default();
            if ordinary_first {
                inner
                    .authorize_turn("ordinary", "main", "/repo", true)
                    .unwrap();
            }
            inner.enable("lead", "main", "/repo").unwrap();
            if !ordinary_first {
                inner
                    .authorize_turn("ordinary", "main", "/repo", true)
                    .unwrap();
            }
            inner
                .authorize_turn("lead", "main", "/repo", false)
                .unwrap();
            assert!(inner.active.contains_key("ordinary"));
            assert!(inner.enable("second-lead", "main", "/repo").is_err());
            let token = inner.grants["lead"].token.clone();
            let mut child = Command::new("unused");
            child.env("MONOCODE_CONTROL_TOKEN", "inherited-secret");
            child.env("MONOCODE_CONTROL_ENDPOINT", "inherited-endpoint");
            inner.configure_child("endpoint", "ordinary", &mut child);
            for key in ["MONOCODE_CONTROL_TOKEN", "MONOCODE_CONTROL_ENDPOINT"] {
                assert!(child
                    .get_envs()
                    .any(|(name, value)| name == key && value.is_none()));
            }
            assert!(request_grant(&inner, "control", &token).is_ok());
            inner.active.remove("ordinary");
            assert!(inner.grants.contains_key("lead"));
            assert!(inner.active.contains_key("lead"));
        }
    }

    #[test]
    fn committed_finish_reply_survives_revocation_but_other_requests_do_not() {
        let mut inner = Inner::default();
        inner.enable("lead", "main", "/repo").unwrap();
        let token = inner.grants["lead"].token.clone();
        let request = |action: &str, request_id: &str| Request {
            token: token.clone(),
            namespace: "control".into(),
            action: action.into(),
            input: json!({}),
            request_id: request_id.into(),
        };
        let (reply, response) = mpsc::channel();
        inner
            .request("finish", &request("finish", "finish-id"), reply)
            .unwrap();
        let (reply, retry_response) = mpsc::channel();
        inner
            .request("finish-retry", &request("finish", "finish-id"), reply)
            .unwrap();
        let (reply, other_response) = mpsc::channel();
        inner
            .request("list", &request("list", "finish-id"), reply)
            .unwrap();
        let (reply, other_finish_response) = mpsc::channel();
        inner
            .request("other-finish", &request("finish", "other-id"), reply)
            .unwrap();

        // This is the native path invoked after the finished run is saved,
        // before App calls control_reply with the successful result.
        inner.disable("lead", "main", Some("finish-id"));
        assert!(request_grant(&inner, "control", &token).is_err());
        let (reply, _) = mpsc::channel();
        assert!(inner
            .request("later", &request("list", "later-id"), reply)
            .is_err());
        assert_eq!(other_response.try_recv().unwrap()["ok"], false);
        assert_eq!(other_finish_response.try_recv().unwrap()["ok"], false);
        assert!(response.try_recv().is_err());
        assert!(retry_response.try_recv().is_err());
        let finished = json!({"ok":true,"result":{"finished":true}});
        inner.reply("another-window", "finish", finished.clone());
        assert!(response.try_recv().is_err());
        inner.reply("main", "finish", finished.clone());
        inner.reply("main", "finish-retry", finished.clone());
        assert_eq!(response.try_recv().unwrap(), finished);
        assert_eq!(retry_response.try_recv().unwrap(), finished);
        assert!(inner.pending.is_empty());
    }

    #[test]
    fn stopping_revokes_lead_and_worker_connections_but_keeps_independent_turns_and_files() {
        let mut inner = Inner::default();
        inner.enable("lead", "main", "/repo").unwrap();
        let token = inner.grants["lead"].token.clone();
        inner.workers.insert("worker".into(), "lead".into());
        let scratch = create_worker_scratch().unwrap();
        let result = scratch.join("result.txt");
        std::fs::write(&result, "retained output").unwrap();
        inner.scratch.insert("worker".into(), scratch.clone());
        inner
            .authorize_turn("worker", "main", "/isolated", false)
            .unwrap();
        inner
            .authorize_turn("ordinary", "main", "/repo", true)
            .unwrap();
        inner
            .authorize_turn("lead", "main", "/repo", false)
            .unwrap();
        let app_token = inner.app_grants["ordinary"].token.clone();
        let (reply, response) = mpsc::channel();
        inner
            .request(
                "request",
                &Request {
                    token: token.clone(),
                    namespace: "control".into(),
                    action: "finish".into(),
                    input: json!({}),
                    request_id: "finish-stop-race".into(),
                },
                reply,
            )
            .unwrap();
        inner.disable("lead", "wrong-window", None);
        assert!(request_grant(&inner, "control", &token).is_ok());
        inner.disable("lead", "main", None);
        assert!(request_grant(&inner, "control", &token).is_err());
        assert!(request_grant(&inner, "app", &app_token).is_ok());
        assert!(!inner.active.contains_key("lead"));
        assert!(!inner.active.contains_key("worker"));
        assert!(inner.active.contains_key("ordinary"));
        assert!(inner.workers.is_empty());
        assert_eq!(response.try_recv().unwrap()["ok"], false);
        assert_eq!(std::fs::read_to_string(result).unwrap(), "retained output");
        inner.enable("second-lead", "main", "/repo").unwrap();
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn worker_identity_and_fresh_lead_tokens_survive_resume_without_cross_window_access() {
        let mut inner = Inner::default();
        inner.enable("lead", "main", "/repo").unwrap();
        let old = inner.grants["lead"].token.clone();
        inner.workers.insert("worker".into(), "lead".into());
        assert!(inner.enable("worker", "main", "/other").is_err());
        assert!(inner
            .authorize_turn("worker", "other-window", "/isolated", true)
            .is_err());
        inner
            .authorize_turn("worker", "main", "/isolated", true)
            .unwrap();
        assert!(!inner.active["worker"].app_allowed);
        assert!(!inner.app_grants.contains_key("worker"));
        inner.disable("lead", "main", None);
        inner.enable("lead", "main", "/repo").unwrap();
        let fresh = inner.grants["lead"].token.clone();
        assert_ne!(old, fresh);
        assert!(request_grant(&inner, "control", &old).is_err());
        let mut child = Command::new("unused");
        inner.configure_child("endpoint", "lead", &mut child);
        assert!(child
            .get_envs()
            .any(|(name, value)| name == "MONOCODE_CONTROL_TOKEN"
                && value == Some(std::ffi::OsStr::new(&fresh))));
        assert!(inner
            .authorize_turn("lead", "main", "/changed", false)
            .is_err());
    }
    #[test]
    fn app_tokens_are_bound_to_active_turns_and_cannot_control_orchestration() {
        let mut inner = Inner::default();
        inner.app_grants.insert(
            "ordinary".into(),
            Grant {
                window: "main".into(),
                session: "ordinary".into(),
                cwd: "/repo".into(),
                token: "app-token".into(),
            },
        );
        assert!(matches!(
            request_grant(&inner, "app", "app-token"),
            Err(error) if error == APP_TURN_INACTIVE
        ));
        inner.active.insert(
            "ordinary".into(),
            ActiveTurn {
                window: "main".into(),
                cwd: "/repo".into(),
                app_allowed: true,
                reference_ids: Default::default(),
                references_pending: false,
                reference_turn_id: uuid::Uuid::new_v4().to_string(),
            },
        );
        assert!(request_grant(&inner, "app", "app-token").is_ok());
        assert!(request_grant(&inner, "control", "app-token").is_err());
        inner.active.get_mut("ordinary").unwrap().app_allowed = false;
        assert!(request_grant(&inner, "app", "app-token").is_err());
        inner.active.remove("ordinary");
        assert!(request_grant(&inner, "app", "app-token").is_err());
    }
    #[test]
    fn app_token_survives_normal_turns_but_only_works_when_opted_in() {
        let mut inner = Inner::default();
        assert!(inner.prepare_app_grant("ordinary", "main", "/repo"));
        let token = inner.app_grants["ordinary"].token.clone();
        inner.active.insert(
            "ordinary".into(),
            ActiveTurn {
                window: "main".into(),
                cwd: "/repo".into(),
                app_allowed: false,
                reference_ids: Default::default(),
                references_pending: false,
                reference_turn_id: uuid::Uuid::new_v4().to_string(),
            },
        );
        assert!(request_grant(&inner, "app", &token).is_err());
        assert!(inner.prepare_app_grant("ordinary", "main", "/repo"));
        assert_eq!(inner.app_grants["ordinary"].token, token);
        inner.grants.insert(
            "ordinary".into(),
            Grant {
                window: "main".into(),
                session: "ordinary".into(),
                cwd: "/repo".into(),
                token: "control-token".into(),
            },
        );
        assert!(!inner.prepare_app_grant("ordinary", "main", "/repo"));
        inner.active.get_mut("ordinary").unwrap().app_allowed = true;
        assert!(request_grant(&inner, "app", &token).is_err());
        inner.grants.remove("ordinary");
        assert!(inner.prepare_app_grant("ordinary", "main", "/repo"));
        assert_eq!(inner.app_grants["ordinary"].token, token);
        inner.active.get_mut("ordinary").unwrap().app_allowed = true;
        assert!(request_grant(&inner, "app", &token).is_ok());
        inner.active.remove("ordinary");
        inner.refresh_references(
            "ordinary",
            "main",
            ["external".into()].into_iter().collect(),
            None,
        );
        assert!(!inner.active.contains_key("ordinary"));
        assert!(request_grant(&inner, "app", &token).is_err());
    }
    #[cfg(not(windows))]
    #[test]
    fn comparison_keys_preserve_posix_case() {
        assert_eq!(comparison_path(Path::new("/tmp/Foo")), "/tmp/Foo");
        assert_ne!(
            comparison_path(Path::new("/tmp/Foo")),
            comparison_path(Path::new("/tmp/foo"))
        );
    }

    #[test]
    fn workers_get_distinct_private_scratch_and_matching_temp_environment() {
        let first = create_worker_scratch().unwrap();
        let second = create_worker_scratch().unwrap();
        assert_ne!(first, second);
        assert!(first.is_absolute());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let mut cmd = Command::new("unused");
        configure_worker_scratch(&mut cmd, &first);
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert!(cmd
                .get_envs()
                .any(|(name, value)| name == key && value == Some(first.as_os_str())));
        }
        let new_file = first.join("new/helper.py");
        assert_eq!(
            control_write_path(new_file.to_string_lossy().into_owned()).unwrap(),
            new_file.to_string_lossy().replace('\\', "/")
        );
        assert!(control_write_path("relative.py".into()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&second, first.join("escape")).unwrap();
            let resolved = control_write_path(
                first
                    .join("escape/helper.py")
                    .to_string_lossy()
                    .into_owned(),
            )
            .unwrap();
            assert_eq!(resolved, second.join("helper.py").to_string_lossy());
            std::os::unix::fs::symlink(first.join("missing"), first.join("dangling")).unwrap();
            assert!(control_write_path(
                first
                    .join("dangling/helper.py")
                    .to_string_lossy()
                    .into_owned()
            )
            .is_err());
        }
        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn closing_a_window_releases_ordinary_turns_and_owned_orchestration() {
        let mut inner = Inner::default();
        for (id, window) in [
            ("ordinary", "closing"),
            ("lead", "closing"),
            ("other", "open"),
        ] {
            inner.active.insert(
                id.into(),
                ActiveTurn {
                    window: window.into(),
                    cwd: format!("/{id}"),
                    app_allowed: false,
                    reference_ids: Default::default(),
                    references_pending: false,
                    reference_turn_id: uuid::Uuid::new_v4().to_string(),
                },
            );
        }
        for (id, window) in [("lead", "closing"), ("other", "open")] {
            inner.grants.insert(
                id.into(),
                Grant {
                    window: window.into(),
                    session: id.into(),
                    cwd: format!("/{id}"),
                    token: id.into(),
                },
            );
        }
        inner.workers.insert("worker".into(), "lead".into());
        inner.workers.insert("other-worker".into(), "other".into());
        let (reply, response) = mpsc::channel();
        inner.pending.insert(
            "pending".into(),
            Pending {
                window: "closing".into(),
                session: "lead".into(),
                namespace: "control".into(),
                action: "list".into(),
                request_id: "closing-request".into(),
                reply,
            },
        );
        let (reply, other_response) = mpsc::channel();
        inner.pending.insert(
            "other-pending".into(),
            Pending {
                window: "open".into(),
                session: "other".into(),
                namespace: "control".into(),
                action: "list".into(),
                request_id: "open-request".into(),
                reply,
            },
        );

        assert_eq!(
            inner.close_window("closing"),
            ["lead", "ordinary", "worker"]
        );
        assert_eq!(inner.active.len(), 1);
        assert_eq!(inner.active["other"].window, "open");
        assert_eq!(inner.grants.len(), 1);
        assert!(inner.grants.contains_key("other"));
        assert_eq!(inner.workers.len(), 1);
        assert_eq!(inner.workers["other-worker"], "other");
        assert_eq!(response.try_recv().unwrap()["ok"], false);
        assert!(other_response.try_recv().is_err());
        assert!(inner.pending.contains_key("other-pending"));
        assert!(inner.close_window("closing").is_empty());
    }

    #[test]
    fn scopes_reject_escape_and_resolve_new_files() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        assert!(resolve_scope(&root, "../escape").is_err());
        assert!(resolve_scope(&root, "/absolute").is_err());
        assert!(control_scopes(
            root.to_string_lossy().into_owned(),
            vec!["../escape".into()]
        )
        .unwrap_err()
        .contains("Invalid write scope \"../escape\""));
        assert!(resolve_scope(&root, "src/new.ts")
            .unwrap()
            .ends_with("/src/new.ts"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), root.join("outside")).unwrap();
            assert!(resolve_scope(&root, "outside/file").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn checkout_reservations_include_nested_folders() {
        assert!(paths_overlap("/repo", "/repo/src"));
        assert!(paths_overlap("/repo/src", "/repo"));
        assert!(!paths_overlap("/repo", "/repo2"));
    }
    #[test]
    fn sent_reference_tokens_read_cross_project_ids_but_never_mutate_or_control() {
        let mut inner = Inner::default();
        inner
            .authorize_turn("ordinary", "main", "/repo", false)
            .unwrap();
        inner
            .active
            .get_mut("ordinary")
            .unwrap()
            .reference_ids
            .insert("external".into());
        let token = inner.app_grants["ordinary"].token.clone();
        for action in ["sessions.read", "sessions.export", "sessions.references"] {
            let request = Request {
                token: token.clone(),
                namespace: "app".into(),
                action: action.into(),
                input: json!({"sessionId":"external"}),
                request_id: "read".into(),
            };
            let (tx, _rx) = mpsc::channel();
            assert!(inner.request(action, &request, tx).is_ok());
        }
        for (namespace, action, target) in [
            ("app", "sessions.read", "unreferenced"),
            ("app", "sessions.export", "unreferenced"),
            ("app", "sessions.send", "external"),
            ("app", "sessions.stop", "external"),
            ("app", "sessions.start", "external"),
            ("app", "notes.write", "external"),
            ("control", "delegate", "external"),
        ] {
            let request = Request {
                token: token.clone(),
                namespace: namespace.into(),
                action: action.into(),
                input: json!({"sessionId":target}),
                request_id: "denied".into(),
            };
            let (tx, _rx) = mpsc::channel();
            assert!(inner.request("deny", &request, tx).is_err());
        }
        inner.active.remove("ordinary");
        assert!(request_grant(&inner, "app", &token).is_err());
        inner.workers.insert("worker".into(), "lead".into());
        assert!(!inner.prepare_app_grant("worker", "main", "/repo"));
    }

    #[test]
    fn edited_reference_requests_wait_for_saved_replacement_and_recheck_both_old_and_new_ids() {
        use crate::session_references::sent_reference_ids;
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let reference =
            |id: &str| json!({"sessionId":id,"title":id,"cwd":"/external","harness":"codex"});
        let old_blocks = json!([
            {"id":"prefix","role":"user","text":"keep","sessionReferences":[reference("kept")]},
            {"id":"edited","role":"user","text":"old prompt","sessionReferences":[reference("old")]},
            {"id":"draft","role":"user","draft":true,"sessionReferences":[reference("draft-only")]},
            {"id":"internal","role":"user","internal":true,"sessionReferences":[reference("internal-only")]}
        ]);
        conn.execute("INSERT INTO sessions(id,cwd,harness,model,runtime_mode,title,created_at,updated_at,blocks_json,user_turn_count,queued_messages_json)
          VALUES('ordinary','/project','codex','test','auto','ordinary',1,1,?1,2,?2)", rusqlite::params![old_blocks.to_string(),json!([{"id":"queue","text":"unsent","sessionReferences":[reference("queue-only")]}]).to_string()]).unwrap();
        let old = sent_reference_ids(&conn, "ordinary").unwrap();
        assert_eq!(old, ["old".into(), "kept".into()].into_iter().collect());
        let inner = Arc::new(Mutex::new(Inner::default()));
        let changed = Arc::new(Condvar::new());
        let (token, epoch) = {
            let mut host = inner.lock().unwrap();
            host.authorize_turn("ordinary", "main", "/project", false)
                .unwrap();
            host.hold_references("ordinary", "main");
            // An ungated/stale steer callback cannot release an edited turn.
            assert!(!host.refresh_references("ordinary", "main", old.clone(), None));
            (
                host.app_grants["ordinary"].token.clone(),
                host.active["ordinary"].reference_turn_id.clone(),
            )
        };
        let (tx, rx) = mpsc::channel();
        let mut readers = Vec::new();
        for target in [
            "old",
            "new",
            "kept",
            "queue-only",
            "draft-only",
            "internal-only",
        ] {
            let inner = inner.clone();
            let changed = changed.clone();
            let token = token.clone();
            let tx = tx.clone();
            readers.push(std::thread::spawn(move || {
                let request = Request {
                    token,
                    namespace: "app".into(),
                    action: "sessions.read".into(),
                    input: json!({"sessionId":target}),
                    request_id: target.into(),
                };
                let (reply, _received) = mpsc::channel();
                let result = wait_for_reference_ready(&inner, &changed, &request)
                    .unwrap()
                    .request(target, &request, reply);
                tx.send((target, result.is_ok())).unwrap();
            }));
        }
        // The actual server wait path forwards neither old nor new reads before acceptance/save.
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        let accepted_blocks = json!([
            {"id":"prefix","role":"user","text":"keep","sessionReferences":[reference("kept")]},
            {"id":"replacement","role":"user","text":"new prompt","sessionReferences":[reference("new")]}
        ]);
        conn.execute(
            "UPDATE sessions SET blocks_json=?1 WHERE id='ordinary'",
            [accepted_blocks.to_string()],
        )
        .unwrap();
        let new = sent_reference_ids(&conn, "ordinary").unwrap();
        {
            let mut host = inner.lock().unwrap();
            assert!(host.refresh_references("ordinary", "main", new, Some(&epoch)));
        }
        changed.notify_all();
        let results: HashMap<_, _> = (0..6)
            .map(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap())
            .collect();
        assert!(results["new"]);
        assert!(results["kept"]);
        for id in ["old", "queue-only", "draft-only", "internal-only"] {
            assert!(!results[id]);
        }
        for reader in readers {
            reader.join().unwrap();
        }
        let mut host = inner.lock().unwrap();
        // Removal of the last reference also revokes old reads.
        conn.execute("UPDATE sessions SET blocks_json='[{\"id\":\"replacement\",\"role\":\"user\",\"text\":\"no references\"}]' WHERE id='ordinary'", []).unwrap();
        assert!(host.refresh_references(
            "ordinary",
            "main",
            sent_reference_ids(&conn, "ordinary").unwrap(),
            Some(&epoch)
        ));
        assert!(request_grant(&host, "app", &token).is_err());
        // A late acceptance callback belongs to its exact turn, even if another turn has started.
        host.authorize_turn("ordinary", "main", "/project", false)
            .unwrap();
        host.hold_references("ordinary", "main");
        assert!(!host.refresh_references("ordinary", "main", old, Some(&epoch)));
        assert!(host.active["ordinary"].references_pending);
        host.active.remove("ordinary");
        assert!(!host.refresh_references(
            "ordinary",
            "main",
            ["new".into()].into_iter().collect(),
            Some(&epoch)
        ));
    }

    #[test]
    fn historical_lead_can_start_an_ordinary_reference_turn_after_credentials_are_disabled() {
        let mut inner = Inner::default();
        inner.enable("former-lead", "main", "/project").unwrap();
        inner.workers.insert("worker".into(), "former-lead".into());
        assert!(!inner.prepare_app_grant("worker", "main", "/project/worker"));
        inner
            .authorize_turn("former-lead", "main", "/project", false)
            .unwrap();
        assert!(!inner.refresh_references(
            "former-lead",
            "main",
            ["external".into()].into_iter().collect(),
            None
        ));
        let token = inner.app_grants["former-lead"].token.clone();
        assert!(request_grant(&inner, "app", &token).is_err());
        inner.disable("former-lead", "main", None);
        inner
            .authorize_turn("former-lead", "main", "/project", false)
            .unwrap();
        assert!(inner.refresh_references(
            "former-lead",
            "main",
            ["external".into()].into_iter().collect(),
            None
        ));
        let request = Request {
            token,
            namespace: "app".into(),
            action: "sessions.read".into(),
            input: json!({"sessionId":"external"}),
            request_id: "ordinary-continuation".into(),
        };
        let (tx, _rx) = mpsc::channel();
        assert!(inner.request("read", &request, tx).is_ok());
    }
}
