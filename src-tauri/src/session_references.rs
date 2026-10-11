//! Saved ordinary-session selection and immutable exports. No native hidden state.
use crate::session_store::{validate_id, SessionStore};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Write, path::Path};
use tauri::{AppHandle, Manager, State};

const REGULAR: &str = "user_turn_count > 0 AND sidebar_hidden = 0 AND inbox_ask IS NULL
 AND id NOT IN (SELECT session_id FROM orchestration_workers)
 AND id NOT IN (SELECT session_id FROM mono_transcripts)";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCandidate {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub harness: String,
    pub model: String,
    pub updated_at: i64,
    pub user_turn_count: i64,
    pub relevance: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferencePickerOptions {
    pub current_session_id: String,
    /// Project path, never the worker/harness execution cwd. None = all projects.
    pub cwd: Option<String>,
    #[serde(default)]
    pub query: String,
    #[serde(default = "title_mode")]
    pub search: String,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    /// Unconverted legacy Mono IDs still held by the app roster.
    #[serde(default)]
    pub excluded_session_ids: Vec<String>,
}
fn title_mode() -> String {
    "title".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCandidatesPage {
    pub items: Vec<ReferenceCandidate>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PickerCursor {
    scope: String,
    score: i64,
    updated: i64,
    id: String,
}

fn scope(options: &ReferencePickerOptions) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([
                options.current_session_id,
                options.cwd,
                options.query.trim().to_lowercase(),
                options.search,
                options.excluded_session_ids
            ]))
            .unwrap()
        )
    )
}

// Relevance tiers dominate recency. Unicode lowercase works for CJK too.
fn title_score(title: &str, query: &str) -> i64 {
    let title = title.to_lowercase();
    if title == query {
        return 6000;
    }
    if title.starts_with(query) {
        return 5000;
    }
    if let Some(pos) = title.find(query) {
        let boundary = title[..pos]
            .chars()
            .next_back()
            .is_none_or(|c| c.is_whitespace() || "-_/".contains(c) || (c as u32 >= 0x2e80));
        return if boundary { 4000 } else { 3000 };
    }
    if query.chars().count() < 3
        || query.chars().all(|c| c.is_ascii_digit())
        || ([3, 4, 6, 8].contains(&query.len()) && query.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return 0;
    }
    let mut remaining = query.chars();
    let mut wanted = remaining.next();
    let mut gaps = 0;
    for c in title.chars() {
        if Some(c) == wanted {
            wanted = remaining.next();
            if wanted.is_none() {
                return 2000 - gaps.min(900);
            }
        } else {
            gaps += 1;
        }
    }
    0
}

fn content_match(raw: &str, query: &str) -> Option<(i64, String)> {
    let blocks: Value = serde_json::from_str(raw).ok()?;
    let mut matches = 0i64;
    let mut snippet = None;
    for block in blocks.as_array()? {
        if !visible(block) {
            continue;
        }
        for text in [
            block.get("text"),
            block.pointer("/tool/input"),
            block.pointer("/tool/detail"),
            block.pointer("/tool/title"),
        ] {
            let Some(text) = text.and_then(Value::as_str) else {
                continue;
            };
            let lower = text.to_lowercase();
            if lower.contains(query) {
                matches += lower.matches(query).count() as i64;
                if snippet.is_none() {
                    // Character coordinates remain safe even for Unicode lowercase expansions.
                    let position = lower.find(query).unwrap();
                    let start = lower[..position].chars().count().saturating_sub(60);
                    snippet = Some(text.chars().skip(start).take(240).collect());
                }
            }
        }
    }
    snippet.map(|text| (matches.min(999), text))
}

fn after(item: &ReferenceCandidate, cursor: &PickerCursor) -> bool {
    item.relevance < cursor.score
        || (item.relevance == cursor.score
            && (item.updated_at < cursor.updated
                || (item.updated_at == cursor.updated && item.session_id > cursor.id)))
}

pub(crate) fn candidates(
    conn: &Connection,
    options: ReferencePickerOptions,
) -> Result<ReferenceCandidatesPage, String> {
    validate_id(&options.current_session_id, "current session")?;
    let limit = options.limit.unwrap_or(100);
    if !(1..=100).contains(&limit) {
        return Err("limit must be from 1 to 100".into());
    }
    if !["title", "content"].contains(&options.search.as_str()) || options.query.len() > 2048 {
        return Err("search must be title or content; query must be under 2048 bytes".into());
    }
    if options
        .cwd
        .as_ref()
        .is_some_and(|cwd| cwd.trim().is_empty() || cwd == "~")
    {
        return Err("cwd must be a project path".into());
    }
    let scope = scope(&options);
    let cursor: Option<PickerCursor> = options
        .cursor
        .as_deref()
        .map(|raw| {
            if raw.len() > 2048 {
                return Err("Invalid picker cursor".to_string());
            }
            let value: PickerCursor =
                serde_json::from_str(raw).map_err(|_| "Invalid picker cursor")?;
            if value.scope != scope {
                return Err("Picker scope changed; restart from the first page".into());
            }
            Ok(value)
        })
        .transpose()?;
    let query = options.query.trim().to_lowercase();
    let excluded: HashSet<&str> = options
        .excluded_session_ids
        .iter()
        .map(String::as_str)
        .collect();
    // Blank pages use the activity index. Search scans the WHOLE selected scope,
    // then ranks before paging; neither 400 sessions nor the first screen is a cap.
    let content = options.search == "content" && !query.is_empty();
    let sql = format!(
        "SELECT id,cwd,title,harness,model,updated_at,user_turn_count,{} FROM sessions
      WHERE {REGULAR} AND archived = 0 AND id != ?1 AND {}
      {} ORDER BY updated_at DESC,id ASC",
        if content { "blocks_json" } else { "NULL" },
        if options.cwd.is_some() {
            "cwd = ?2"
        } else {
            "?2 IS NULL"
        },
        if query.is_empty() {
            "AND (?3 IS NULL OR updated_at < ?3 OR (updated_at = ?3 AND id > ?4))"
        } else {
            ""
        }
    );
    let mut bindings = vec![
        SqlValue::from(options.current_session_id.clone()),
        options
            .cwd
            .clone()
            .map(SqlValue::from)
            .unwrap_or(SqlValue::Null),
    ];
    if query.is_empty() {
        bindings.push(
            cursor
                .as_ref()
                .map(|c| SqlValue::from(c.updated))
                .unwrap_or(SqlValue::Null),
        );
        bindings.push(
            cursor
                .as_ref()
                .map(|c| SqlValue::from(c.id.clone()))
                .unwrap_or(SqlValue::Null),
        );
    }
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(bindings), |row| {
            Ok((
                ReferenceCandidate {
                    session_id: row.get(0)?,
                    cwd: row.get(1)?,
                    title: row.get(2)?,
                    harness: row.get(3)?,
                    model: row.get(4)?,
                    updated_at: row.get(5)?,
                    user_turn_count: row.get(6)?,
                    relevance: 0,
                    snippet: None,
                },
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let (mut item, raw) = row.map_err(|e| e.to_string())?;
        if excluded.contains(item.session_id.as_str()) {
            continue;
        }
        if !query.is_empty() {
            if content {
                let Some((score, snippet)) = content_match(raw.as_deref().unwrap_or("[]"), &query)
                else {
                    continue;
                };
                item.relevance = title_score(&item.title, &query) * 1000 + score;
                item.snippet = Some(snippet);
            } else {
                item.relevance = title_score(&item.title, &query);
                if item.relevance == 0
                    && options.cwd.is_none()
                    && item
                        .cwd
                        .rsplit(['/', '\\'])
                        .find(|name| !name.is_empty())
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
                {
                    item.relevance = 1000;
                }
                if item.relevance == 0 {
                    continue;
                }
            }
            if cursor.as_ref().is_some_and(|c| !after(&item, c)) {
                continue;
            }
        }
        items.push(item);
        if query.is_empty() && items.len() > limit {
            break;
        }
    }
    items.sort_by(|a, b| {
        b.relevance
            .cmp(&a.relevance)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.session_id.cmp(&b.session_id))
    });
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = if more {
        items.last().map(|last| {
            serde_json::to_string(&PickerCursor {
                scope,
                score: last.relevance,
                updated: last.updated_at,
                id: last.session_id.clone(),
            })
            .unwrap()
        })
    } else {
        None
    };
    Ok(ReferenceCandidatesPage { items, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(conn: &Connection, id: &str, cwd: &str, title: &str, time: i64, blocks: Value) {
        conn.execute("INSERT INTO sessions(id,cwd,title,harness,model,runtime_mode,created_at,updated_at,blocks_json,user_turn_count) VALUES(?1,?2,?3,'codex','test','supervised',1,?4,?5,1)",
            params![id,cwd,title,time,blocks.to_string()]).unwrap();
    }
    fn options(query: &str, search: &str) -> ReferencePickerOptions {
        ReferencePickerOptions {
            current_session_id: "current".into(),
            cwd: None,
            query: query.into(),
            search: search.into(),
            cursor: None,
            limit: Some(37),
            excluded_session_ids: vec![],
        }
    }
    #[test]
    fn pages_all_projects_and_filters_every_private_or_unsent_source() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        for i in 0..510 {
            insert(
                &conn,
                &format!("s-{i:04}"),
                if i % 2 == 0 { "/project" } else { "/other" },
                "Chinese 中文",
                i,
                json!([{"id":"u","role":"user","text":"sent"}]),
            );
        }
        for id in [
            "current",
            "archived",
            "hidden",
            "mono",
            "worker",
            "internal",
            "draft",
            "inbox",
            "legacy-mono",
        ] {
            insert(
                &conn,
                id,
                "/project",
                "Private",
                9999,
                json!([{"id":"u","role":"user","text":"private"}]),
            );
        }
        conn.execute_batch("UPDATE sessions SET archived=1 WHERE id='archived'; UPDATE sessions SET sidebar_hidden=1 WHERE id='hidden'; UPDATE sessions SET user_turn_count=0 WHERE id IN('internal','draft'); UPDATE sessions SET inbox_ask='{}' WHERE id='inbox'; INSERT INTO mono_transcripts(session_id) VALUES('mono'); INSERT INTO orchestration_workers(session_id,lead_id) VALUES('worker','lead');").unwrap();
        let mut opts = options("", "title");
        opts.excluded_session_ids = vec!["legacy-mono".into()];
        let mut ids = Vec::new();
        loop {
            let page = candidates(&conn, opts).unwrap();
            ids.extend(page.items.iter().map(|item| item.session_id.clone()));
            opts = options("", "title");
            opts.excluded_session_ids = vec!["legacy-mono".into()];
            opts.cursor = page.next_cursor;
            if opts.cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 510);
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 510);
        assert_eq!(ids.first().unwrap(), "s-0509");
        assert_eq!(ids.last().unwrap(), "s-0000");
        let mut opts = options("", "title");
        opts.cwd = Some("/project".into());
        opts.excluded_session_ids = vec!["legacy-mono".into()];
        let page = candidates(&conn, opts).unwrap();
        assert!(page.items.iter().all(|s| s.cwd == "/project"));
        let mut wrong = options("", "title");
        wrong.cwd = Some("/worker-execution-cwd".into());
        assert!(candidates(&conn, wrong).unwrap().items.is_empty());
        let mut changed = options("query", "title");
        changed.cursor = page.next_cursor;
        assert!(candidates(&conn, changed)
            .unwrap_err()
            .contains("scope changed"));
    }

    #[test]
    fn title_and_independent_content_search_cover_the_whole_scope_and_rank_before_activity() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        for i in 0..550 {
            insert(
                &conn,
                &format!("filler-{i}"),
                "/project",
                "No title match",
                i + 10,
                json!([{"id":"u","role":"user","text":"unrelated"}]),
            );
        }
        insert(
            &conn,
            "old-exact",
            "/other",
            "修订计划",
            1,
            json!([{"id":"u","role":"user","text":"完整关键词"}]),
        );
        insert(
            &conn,
            "new-weak",
            "/project",
            "Earlier 修订计划 later",
            9999,
            json!([{"id":"u","role":"user","text":"完整关键词"}]),
        );
        let page = candidates(&conn, options("修订计划", "title")).unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|s| s.session_id.as_str())
                .collect::<Vec<_>>(),
            ["old-exact", "new-weak"]
        );
        let page = candidates(&conn, options("完整关键词", "content")).unwrap();
        assert_eq!(page.items.len(), 2);
        // Content search isn't constrained to title hits, including an old tool input.
        insert(
            &conn,
            "old-tool",
            "/other",
            "Unrelated title",
            0,
            json!([{"id":"u","role":"user","text":"sent"},{"id":"t","role":"tool","text":"result","tool":{"input":"OnlyToolNeedle"}},{"id":"d","role":"user","text":"draftNeedle","draft":true}]),
        );
        assert_eq!(
            candidates(&conn, options("OnlyToolNeedle", "content"))
                .unwrap()
                .items[0]
                .session_id,
            "old-tool"
        );
        assert!(candidates(&conn, options("draftNeedle", "content"))
            .unwrap()
            .items
            .is_empty());
        // More than a screen of ranked hits remain pageable to the last source.
        for i in 0..120 {
            insert(
                &conn,
                &format!("match-{i:03}"),
                "/other",
                "Needle",
                i,
                json!([{"id":"u","role":"user","text":"Needle"}]),
            );
        }
        for search in ["title", "content"] {
            let mut opts = options("Needle", search);
            let mut ids = HashSet::new();
            loop {
                let page = candidates(&conn, opts).unwrap();
                for item in page.items {
                    assert!(ids.insert(item.session_id));
                }
                opts = options("Needle", search);
                opts.cursor = page.next_cursor;
                if opts.cursor.is_none() {
                    break;
                }
            }
            // The old tool has a content hit and its title has a fuzzy hit.
            assert_eq!(ids.len(), 121);
        }
    }

    #[test]
    fn saved_revision_changes_even_without_activity_timestamp_and_exports_are_fixed_and_complete() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let long = "中文😀\"\\\n".repeat(20000);
        insert(
            &conn,
            "target",
            "/other",
            "Export",
            42,
            json!([
                {"id":"u","role":"user","text":long,"attachments":[{"id":"a","name":"image","kind":"image","mimeType":"image/png","path":"/saved/image.png","size":100,"data":"hidden-media-bytes"}]},
                {"id":"t","role":"tool","text":"result","tool":{"title":"run","input":long,"detail":"saved detail"}},
                {"id":"p","role":"plan","text":"saved plan","plan":{"approvedText":"saved approved plan"}},
                {"id":"draft","role":"user","text":"unsent","draft":true},{"id":"internal","role":"user","text":"hidden","internal":true}
            ]),
        );
        let first = snapshot(&conn, "target").unwrap().unwrap();
        let dir = std::env::var_os("MONOCODE_TEST_TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("monocode-session-export-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let manifest = export_snapshot(&first, &dir).unwrap();
        let path = dir.join("transcript.json");
        let original = std::fs::read(&path).unwrap();
        let transcript: Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(manifest["blockCount"], 3);
        assert_eq!(manifest["attachmentCount"], 1);
        assert_eq!(transcript["blocks"][0]["text"], long);
        assert_eq!(transcript["blocks"][1]["tool"]["input"], long);
        assert_eq!(
            transcript["blocks"][2]["plan"]["approvedText"],
            "saved approved plan"
        );
        assert!(transcript["blocks"][0]["attachments"][0]
            .get("data")
            .is_none());
        assert!(manifest.to_string().len() < 2000);
        assert_eq!(manifest["bytes"].as_u64().unwrap() as usize, original.len());
        conn.execute(
            "UPDATE sessions SET blocks_json=?1 WHERE id='target'",
            [json!([{"id":"u","role":"user","text":"updated"}]).to_string()],
        )
        .unwrap();
        let second = snapshot(&conn, "target").unwrap().unwrap();
        assert_ne!(first.read_version, second.read_version);
        assert_eq!(first.updated_at, second.updated_at);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(export_snapshot(&second, &dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_and_read_ids_come_only_from_sent_user_references_not_drafts_or_queues() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let reference =
            json!({"sessionId":"target","title":"Target","cwd":"/other","harness":"codex"});
        insert(
            &conn,
            "target",
            "/other",
            "Target",
            1,
            json!([{"id":"u","role":"user","text":"saved"}]),
        );
        insert(
            &conn,
            "source",
            "/project",
            "Source",
            1,
            json!([
                {"id":"d","role":"user","text":"draft","draft":true,"sessionReferences":[reference]},
                {"id":"i","role":"user","text":"internal","internal":true,"sessionReferences":[reference]},
                {"id":"a","role":"assistant","text":"quoted","sessionReferences":[reference]}
            ]),
        );
        conn.execute(
            "UPDATE sessions SET queued_messages_json=?1 WHERE id='source'",
            [json!([{"sessionReferences":[reference]}]).to_string()],
        )
        .unwrap();
        let target = snapshot(&conn, "target").unwrap().unwrap();
        assert!(sent_reference_ids(&conn, "source").unwrap().is_empty());
        assert!(!can_export(&conn, "source", &target).unwrap());
        conn.execute("UPDATE sessions SET blocks_json=?1 WHERE id='source'",[json!([{"id":"u","role":"user","text":"sent","sessionReferences":[reference,reference]}]).to_string()]).unwrap();
        assert_eq!(sent_reference_ids(&conn, "source").unwrap().len(), 1);
        assert!(can_export(&conn, "source", &target).unwrap());
        conn.execute(
            "INSERT INTO orchestration_workers(session_id,lead_id) VALUES('source','lead')",
            [],
        )
        .unwrap();
        assert!(!can_export(&conn, "source", &target).unwrap());
        assert!(snapshot(&conn, "source").unwrap().is_none());
    }
}

#[tauri::command(async)]
pub fn session_reference_candidates(
    store: State<'_, SessionStore>,
    options: ReferencePickerOptions,
) -> Result<ReferenceCandidatesPage, String> {
    candidates(&*store.lock_conn()?, options)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSnapshot {
    id: String,
    title: String,
    cwd: String,
    harness: String,
    model: String,
    updated_at: i64,
    read_version: String,
    blocks: Value,
}

pub(crate) fn snapshot(conn: &Connection, id: &str) -> Result<Option<ReferenceSnapshot>, String> {
    validate_id(id, "session")?;
    let sql = format!("SELECT id,title,cwd,harness,model,updated_at,blocks_json FROM sessions WHERE id=?1 AND {REGULAR}");
    conn.query_row(&sql, [id], |row| {
        let raw: String = row.get(6)?;
        let blocks: Value = serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
        })?;
        let mut source = ReferenceSnapshot {
            id: row.get(0)?,
            title: row.get(1)?,
            cwd: row.get(2)?,
            harness: row.get(3)?,
            model: row.get(4)?,
            updated_at: row.get(5)?,
            read_version: String::new(),
            blocks,
        };
        // Content revision, not just activity time (metadata-only saves can share a timestamp).
        source.read_version = format!("{:x}", Sha256::digest(serde_json::to_vec(&source).unwrap()));
        Ok(source)
    })
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn session_reference_snapshot(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Option<ReferenceSnapshot>, String> {
    snapshot(&*store.lock_conn()?, &session_id)
}

fn visible(block: &Value) -> bool {
    block.get("draft").and_then(Value::as_bool) != Some(true)
        && block.get("internal").and_then(Value::as_bool) != Some(true)
}

pub(crate) fn sent_reference_ids(conn: &Connection, id: &str) -> Result<HashSet<String>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT blocks_json FROM sessions WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let blocks: Value =
        serde_json::from_str(raw.as_deref().unwrap_or("[]")).map_err(|e| e.to_string())?;
    Ok(blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| visible(block) && block.get("role").and_then(Value::as_str) == Some("user"))
        .flat_map(|block| {
            block
                .get("sessionReferences")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|reference| {
            reference.get("title").and_then(Value::as_str).is_some()
                && reference
                    .get("cwd")
                    .and_then(Value::as_str)
                    .is_some_and(|cwd| !cwd.trim().is_empty())
                && reference
                    .get("harness")
                    .and_then(Value::as_str)
                    .is_some_and(|h| {
                        [
                            "claude",
                            "codex",
                            "cursor",
                            "grok",
                            "opencode",
                            "pi",
                            "omp",
                            "fx",
                            "hermes",
                            "antigravity",
                        ]
                        .contains(&h)
                    })
        })
        .filter_map(|reference| reference.get("sessionId").and_then(Value::as_str))
        .filter(|id| id.len() <= 256 && validate_id(id, "reference").is_ok())
        .map(str::to_owned)
        .collect())
}

fn can_export(conn: &Connection, source: &str, target: &ReferenceSnapshot) -> Result<bool, String> {
    // A reference-bearing worker/hidden session cannot acquire app credentials.
    if snapshot(conn, source)?.is_none() {
        return Ok(false);
    }
    if sent_reference_ids(conn, source)?.contains(&target.id) {
        return Ok(true);
    }
    // /operator compatibility remains project-scoped. References never enable it.
    let operator: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions s, json_each(s.blocks_json) b
      WHERE s.id=?1 AND s.cwd=?2 AND s.sidebar_hidden=0 AND s.id NOT IN(SELECT session_id FROM orchestration_workers)
      AND json_extract(b.value,'$.role')='user' AND json_extract(b.value,'$.monocode')=1
      AND COALESCE(json_extract(b.value,'$.draft'),0)!=1 AND COALESCE(json_extract(b.value,'$.internal'),0)!=1)",
      params![source,target.cwd], |row| row.get(0)).map_err(|e| e.to_string())?;
    Ok(operator)
}

fn export_block(block: &Value) -> Value {
    let mut out = serde_json::Map::new();
    // No live approvals, executable state, app credentials, raw hidden native history,
    // or attachment/media bytes. Persisted visible text is retained without truncation.
    for key in [
        "id",
        "role",
        "text",
        "startedAt",
        "sentAt",
        "durationMs",
        "turnModel",
        "tool",
        "plan",
        "taskList",
        "agentRun",
        "sessionReferences",
        "noteCard",
        "secondOpinion",
        "handoff",
        "artifactCards",
    ] {
        if let Some(value) = block.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    for key in ["attachments", "image"] {
        if let Some(value) = block.get(key) {
            let metadata = |file: &Value| {
                let mut row = serde_json::Map::new();
                for field in ["id", "name", "mimeType", "size", "kind", "path", "alt"] {
                    if let Some(value) = file.get(field) {
                        row.insert(field.into(), value.clone());
                    }
                }
                Value::Object(row)
            };
            out.insert(
                key.into(),
                if let Some(files) = value.as_array() {
                    Value::Array(files.iter().map(metadata).collect())
                } else {
                    metadata(value)
                },
            );
        }
    }
    Value::Object(out)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

fn export_snapshot(source: &ReferenceSnapshot, directory: &Path) -> Result<Value, String> {
    let blocks: Vec<Value> = source
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| visible(b))
        .map(export_block)
        .collect();
    let attachment_count: usize = blocks
        .iter()
        .map(|b| {
            b.get("attachments")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
                + usize::from(b.get("image").is_some())
        })
        .sum();
    let transcript = json!({"schemaVersion":1,"sessionId":source.id,"title":source.title,"cwd":source.cwd,"harness":source.harness,"model":source.model,"updatedAt":source.updated_at,"readVersion":source.read_version,"blocks":blocks});
    let bytes = serde_json::to_vec(&transcript).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let path = directory.join("transcript.json");
    let manifest_path = directory.join("manifest.json");
    let manifest = json!({"schemaVersion":1,"sessionId":source.id,"updatedAt":source.updated_at,"readVersion":source.read_version,
        "path":path,"manifestPath":manifest_path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),
        "blockCount":blocks.len(),"attachmentCount":attachment_count,"fixed":true,
        "scope":"All saved visible blocks, including tool/plan text and attachment metadata.",
        "omissions":["Drafts and internal messages","Live approvals and private app state","Attachment/media bytes (paths may be unavailable)","Hidden, unsaved or upstream-pruned provider state"]});
    write_new(&path, &bytes)?;
    write_new(
        &manifest_path,
        &serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
    )?;
    Ok(manifest)
}

#[tauri::command(async)]
pub fn session_reference_export(
    app: AppHandle,
    store: State<'_, SessionStore>,
    source_session_id: String,
    session_id: String,
) -> Result<Value, String> {
    validate_id(&source_session_id, "source session")?;
    let source = {
        let conn = store.lock_conn()?;
        let source = snapshot(&conn, &session_id)?.ok_or("Referenced session is unavailable")?;
        if !can_export(&conn, &source_session_id, &source)? {
            return Err("Session reference export is unauthorized".into());
        }
        source
    }; // One consistent saved record; writes cannot alter this snapshot afterwards.
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("context-exports")
        .join(uuid::Uuid::new_v4().to_string());
    export_snapshot(&source, &directory)
}
