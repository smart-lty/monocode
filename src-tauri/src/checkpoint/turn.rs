//! Git-backed recordings of workspace changes during a turn. These snapshots
//! record what changed, without inferring which process owns a line.
use super::*;
use std::io::Write;

#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedTurn {
    id: String,
    before: Option<String>,
    after: Option<String>,
    head: Option<String>,
    shared: bool,
    error: Option<String>,
    #[serde(default)]
    dismissed: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
struct TurnReview {
    cwd: String,
    repo: String,
    active: Option<RecordedTurn>,
    latest: Option<RecordedTurn>,
    /// Immutable initial before state and the latest settled worker result.
    /// Ordinary sessions continue to review one turn at a time.
    #[serde(default)]
    worker: Option<RecordedTurn>,
    #[serde(default)]
    worker_retired: bool,
}

#[derive(Serialize, Deserialize)]
struct SavedTurn {
    cwd: String,
    repo: String,
    turn: RecordedTurn,
}

#[derive(Clone, PartialEq, Eq)]
struct Blob {
    mode: String,
    oid: String,
}

struct Change {
    relative: String,
    before: Option<Blob>,
    after: Option<Blob>,
    status: String,
    additions: i64,
    deletions: i64,
}

impl CheckpointStore {
    pub(super) fn retire_worker(&self, session: &str, cwd: &str) -> Result<(), String> {
        if let Some(mut review) = self.matching_turn_review(session, cwd)? {
            // Retain the original baseline/result for manual review, but never
            // append independent conversation turns to the worker's result.
            review.worker_retired = true;
            write_review(&self.session_dir(session), &review)?;
        }
        Ok(())
    }

    pub(super) fn begin_turn(&self, session_id: &str, cwd: &str, id: &str) -> Result<(), String> {
        let root = std::fs::canonicalize(project_root(cwd)?).map_err(|e| e.to_string())?;
        let discovered = run_git(&root, &["rev-parse", "--show-toplevel"]);
        if let Err(error) = &discovered {
            if error.contains("not a git repository")
                && read_review(&self.session_dir(session_id))?.is_none()
            {
                // Preserve structured-edit review for folders without Git.
                return self.ensure(session_id, cwd);
            }
        }
        let dir = self.session_dir(session_id);
        let mut review = read_review(&dir)?
            .filter(|saved| saved.cwd == path_to_js(&root))
            .unwrap_or(TurnReview {
                cwd: path_to_js(&root),
                repo: String::new(),
                active: None,
                latest: None,
                worker: None,
                worker_retired: false,
            });
        let mut turn = RecordedTurn {
            id: id.into(),
            before: None,
            after: None,
            head: run_git(&root, &["rev-parse", "--verify", "HEAD"])
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string()),
            shared: false,
            error: None,
            dismissed: BTreeSet::new(),
        };
        // Publish the pending state first. A failed baseline must not leave the
        // previous turn's card underneath the new response.
        review.active = Some(turn.clone());
        write_review(&dir, &review)?;
        let capture = (|| {
            review.repo = String::from_utf8(discovered?)
                .map_err(|e| e.to_string())?
                .trim_end_matches(['\r', '\n'])
                .to_string();
            // Shared checkouts can include another session's writes. Keep the
            // recorded diff exact, but never offer to restore those turns.
            turn.shared = self.mark_active_turns_shared(&root, session_id)?;
            capture_workspace(&root, &turn_ref(session_id, id, "before"))
        })();
        match capture {
            Ok(oid) => turn.before = Some(oid),
            Err(error) => turn.error = Some(error),
        }
        if let Some(worker) = review.worker.as_mut().filter(|_| !review.worker_retired) {
            if let Some(error) = &worker.error {
                return Err(error.clone());
            }
            if turn.error.is_none()
                && (turn.shared
                    || turn.head != worker.head
                    || !same_tree(&root, turn.before.as_deref(), worker.after.as_deref())?)
            {
                let error = "The worker checkout changed between recorded turns. Its original baseline and files were kept for manual review.".to_string();
                worker.error = Some(error.clone());
                turn.error = Some(error);
            }
        }
        review.active = Some(turn.clone());
        write_review(&dir, &review)?;
        match turn.error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub(super) fn finish_turn(&self, session_id: &str, cwd: &str, id: &str) -> Result<(), String> {
        let dir = self.session_dir(session_id);
        let Some(mut review) = self.matching_turn_review(session_id, cwd)? else {
            return Ok(());
        };
        let Some(mut turn) = review.active.take().filter(|turn| turn.id == id) else {
            return Ok(());
        };
        if turn.before.is_some() {
            match capture_workspace(Path::new(&review.cwd), &turn_ref(session_id, id, "after")) {
                Ok(oid) => turn.after = Some(oid),
                Err(error) => turn.error = Some(error),
            }
        }
        let error = turn.error.clone();
        write_json(
            &dir.join("turns").join(format!("{id}.json")),
            &SavedTurn {
                cwd: review.cwd.clone(),
                repo: review.repo.clone(),
                turn: turn.clone(),
            },
        )?;
        if let Some(worker) = review.worker.as_mut().filter(|_| !review.worker_retired) {
            if worker.error.is_none() {
                worker.after = turn.after.clone();
                worker.shared |= turn.shared;
                worker.error = turn.error.clone();
            }
        }
        review.latest = Some(turn);
        write_review(&dir, &review)?;
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub(super) fn finish_saved_turn(
        &self,
        session: &str,
        cwd: &str,
        id: Option<&str>,
    ) -> Result<(), String> {
        let Some(review) = self.matching_turn_review(session, cwd)? else {
            return Ok(());
        };
        let Some(active) = review.active else {
            return Ok(());
        };
        if id.is_some_and(|id| id != active.id) {
            return Ok(());
        }
        validate_id(&active.id, "turn")?;
        // The caller first stops the provider. A renderer reload can lose its
        // token, but only this already saved turn may have its after captured.
        self.finish_turn(session, cwd, &active.id)
    }

    pub(super) fn ensure_worker(
        &self,
        session: &str,
        cwd: &str,
        fresh: bool,
    ) -> Result<(), String> {
        if let Some(review) = self.matching_turn_review(session, cwd)? {
            if review.worker_retired {
                return Err("This worker was continued independently. Its original result was retained for manual review.".into());
            }
            if let Some(worker) = review.worker {
                if let Some(error) = worker.error {
                    return Err(error);
                }
                if worker.before.is_none() {
                    return Err(NO_WORKER_BASELINE.into());
                }
                return Ok(());
            }
            if fresh {
                return Err(
                    "This worker already has recordings. Its initial baseline was not replaced."
                        .into(),
                );
            }
            // The only legacy turn migration we can establish without guessing
            // order is a single real saved turn. Multiple turns without an
            // initial worker recording are retained for manual review.
            let worker = self.single_worker_turn(session, &review)?;
            write_review(
                &self.session_dir(session),
                &TurnReview {
                    worker: Some(worker),
                    ..review
                },
            )?;
            return Ok(());
        }
        let dir = self.session_dir(session);
        if !fresh || read_manifest(&dir)?.is_some() || read_review(&dir)?.is_some() {
            return Err(NO_WORKER_BASELINE.into());
        }
        // createWorker has just seeded this checkout; this completes before
        // attachment or any provider write. Later turns never change before.
        self.begin_turn(session, cwd, "worker-baseline")?;
        self.finish_turn(session, cwd, "worker-baseline")?;
        let mut review = self
            .matching_turn_review(session, cwd)?
            .ok_or(NO_WORKER_BASELINE)?;
        review.worker = Some(completed_turn(&review)?.clone());
        write_review(&self.session_dir(session), &review)
    }

    fn single_worker_turn(
        &self,
        session: &str,
        review: &TurnReview,
    ) -> Result<RecordedTurn, String> {
        let turn = completed_turn(review)?;
        let history = self.session_dir(session).join("turns");
        if !history.is_dir() {
            return Err(NO_WORKER_BASELINE.into());
        }
        let mut found = false;
        for entry in std::fs::read_dir(history).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let saved: SavedTurn =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if saved.cwd != review.cwd
                || saved.turn.id != turn.id
                || saved.turn.before != turn.before
                || saved.turn.after != turn.after
            {
                return Err("The original worker baseline cannot be established from multiple legacy turns. Its recordings and files were kept for manual review.".into());
            }
            found = true;
        }
        if !found {
            return Err(NO_WORKER_BASELINE.into());
        }
        Ok(turn.clone())
    }

    pub(super) fn recorded_worker_delta(
        &self,
        session: &str,
        cwd: &str,
    ) -> Result<Option<WorkerDelta>, String> {
        let Some(review) = self.matching_turn_review(session, cwd)? else {
            return Ok(None);
        };
        if review.worker_retired {
            return Err("This worker was continued independently. Its original result was retained for manual review.".into());
        }
        let latest = completed_turn(&review)?;
        let worker = match &review.worker {
            Some(worker) => worker.clone(),
            None => self.single_worker_turn(session, &review)?,
        };
        if let Some(error) = &worker.error {
            return Err(format!("Cannot safely integrate worker changes: {error}"));
        }
        let root = Path::new(&review.cwd);
        if worker.shared
            || latest.shared
            || worker.after != latest.after
            || worker.head != latest.head
            || worker.head.as_ref().is_none_or(|head| {
                run_git(root, &["rev-parse", "--verify", "HEAD"])
                    .map_or(true, |bytes| String::from_utf8_lossy(&bytes).trim() != head)
            })
        {
            return Err("Cannot integrate a shared, moved or incomplete worker checkpoint. Its files were kept.".into());
        }
        let changed = changes(root, &worker)?;
        // Verify inherited dirty files too, using blob hashes and modes. Do
        // not read their contents or impose the text-size limit on unchanged
        // inherited files; only actual changes will be materialized below.
        let head_to_result = RecordedTurn {
            before: worker.head.clone(),
            ..worker.clone()
        };
        let mut verify: BTreeMap<_, _> = changes(root, &head_to_result)?
            .into_iter()
            .map(|change| (change.relative.clone(), change))
            .collect();
        for args in [
            vec![
                "diff",
                "--name-only",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "-z",
                "HEAD",
                "--",
            ],
            vec!["ls-files", "--others", "--exclude-standard", "-z"],
        ] {
            for path in run_git(root, &args)?
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                let relative =
                    resolve_turn_path(std::str::from_utf8(path).map_err(|e| e.to_string())?)?;
                if !verify.contains_key(&relative) {
                    let blob = blob_at(
                        root,
                        worker.after.as_deref().ok_or(NO_WORKER_BASELINE)?,
                        &relative,
                    )?;
                    verify.insert(
                        relative.clone(),
                        Change {
                            relative,
                            before: None,
                            after: blob,
                            status: String::new(),
                            additions: 0,
                            deletions: 0,
                        },
                    );
                }
            }
        }
        if let Some(change) = verify.values().find(|change| !restorable(root, change)) {
            return Err(format!("Cannot safely integrate {}: it changed after the worker checkpoint. The worker worktree was kept.", change.relative));
        }
        let mut files = Vec::new();
        for change in changed {
            let state = |blob: Option<&Blob>| -> Result<_, String> {
                let contents = read_blob(root, blob)?;
                if matches!(contents, FileState::Skipped)
                    || blob.is_some_and(|blob| !matches!(blob.mode.as_str(), "100644" | "100755"))
                {
                    return Err(format!("Cannot integrate {}: unsupported file type or size. The worker worktree was kept.", change.relative));
                }
                let mode = if cfg!(unix) {
                    blob.map(|blob| if blob.mode == "100755" { 0o755 } else { 0o644 })
                } else {
                    None
                };
                Ok((contents, mode))
            };
            files.push(WorkerChange {
                before: state(change.before.as_ref())?,
                after: state(change.after.as_ref())?,
                relative: change.relative,
            });
        }
        Ok(Some(WorkerDelta {
            files,
            git_modes: true,
        }))
    }

    pub(super) fn has_turn_review(&self, session_id: &str, cwd: &str) -> Result<bool, String> {
        Ok(self.matching_turn_review(session_id, cwd)?.is_some())
    }

    fn matching_turn_review(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<Option<TurnReview>, String> {
        let Some(review) = read_review(&self.session_dir(session_id))? else {
            return Ok(None);
        };
        let root = std::fs::canonicalize(project_root(cwd)?).map_err(|e| e.to_string())?;
        Ok((review.cwd == path_to_js(&root)).then_some(review))
    }

    fn active_turns(
        &self,
        root: &Path,
        except: &str,
    ) -> Result<Vec<(PathBuf, TurnReview)>, String> {
        // Turn records store canonical cwd; integration may arrive through a
        // checkout alias (including macOS /var -> /private/var).
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let root = review_comparison_path(&root);
        let mut active = Vec::new();
        if !self.root.exists() {
            return Ok(active);
        }
        for entry in std::fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == except {
                continue;
            }
            if let Some(review) = read_review(&entry.path())? {
                let other = review_comparison_path(Path::new(&review.cwd));
                if review.active.is_some() && (root.starts_with(&other) || other.starts_with(&root))
                {
                    active.push((entry.path(), review));
                }
            }
        }
        Ok(active)
    }

    pub(super) fn mark_active_turns_shared(
        &self,
        root: &Path,
        except: &str,
    ) -> Result<bool, String> {
        let active = self.active_turns(root, except)?;
        let shared = !active.is_empty();
        for (dir, mut review) in active {
            if let Some(turn) = review.active.as_mut() {
                turn.shared = true;
            }
            write_review(&dir, &review)?;
        }
        Ok(shared)
    }

    pub(super) fn turn_status(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<Option<CheckpointStatus>, String> {
        let Some(review) = self.matching_turn_review(session_id, cwd)? else {
            return Ok(None);
        };
        let turn = completed_turn(&review)?;
        let root = Path::new(&review.cwd);
        let head = run_git(root, &["rev-parse", "--verify", "HEAD"])
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string());
        let can_restore =
            !turn.shared && head == turn.head && self.active_turns(root, session_id)?.is_empty();
        let files = changes(root, turn)?
            .into_iter()
            .filter(|change| !turn.dismissed.contains(&change.relative))
            .map(|change| {
                let undoable = can_restore && restorable(root, &change);
                CheckpointFile {
                    path: path_to_js(&root.join(&change.relative)),
                    relative: change.relative,
                    status: change.status,
                    additions: change.additions,
                    deletions: change.deletions,
                    exact: true,
                    undoable,
                }
            })
            .collect();
        Ok(Some(CheckpointStatus { files }))
    }

    pub(super) fn turn_file_diff(
        &self,
        session_id: &str,
        cwd: &str,
        relative: &str,
    ) -> Result<Option<CheckpointFileDiff>, String> {
        let Some(review) = self.matching_turn_review(session_id, cwd)? else {
            return Ok(None);
        };
        let turn = completed_turn(&review)?;
        let root = Path::new(&review.cwd);
        let relative = resolve_turn_path(relative)?;
        let change = changes(root, turn)?
            .into_iter()
            .find(|change| change.relative == relative)
            .ok_or("This file did not change during the recorded turn")?;
        let original = read_blob(root, change.before.as_ref())?;
        let current = read_blob(root, change.after.as_ref())?;
        let too_large =
            matches!(original, FileState::Skipped) || matches!(current, FileState::Skipped);
        let binary = state_is_binary(&original) || state_is_binary(&current);
        let (original, current) = if too_large || binary {
            (String::new(), String::new())
        } else {
            (state_text(original), state_text(current))
        };
        Ok(Some(CheckpointFileDiff {
            path: path_to_js(&root.join(&relative)),
            relative,
            status: change.status,
            original,
            current,
            binary,
            too_large,
        }))
    }

    pub(super) fn keep_turn(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<Option<CheckpointStatus>, String> {
        let Some(mut review) = self.matching_turn_review(session_id, cwd)? else {
            return Ok(None);
        };
        let recorded = completed_turn(&review)?;
        let root = Path::new(&review.cwd);
        let dismissed = match relative {
            Some(relative) => vec![resolve_turn_path(relative)?],
            None => changes(root, recorded)?
                .into_iter()
                .map(|change| change.relative)
                .collect(),
        };
        review.latest.as_mut().unwrap().dismissed.extend(dismissed);
        write_review(&self.session_dir(session_id), &review)?;
        self.turn_status(session_id, cwd)
    }

    pub(super) fn undo_turn(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<Option<CheckpointStatus>, String> {
        let Some(review) = self.matching_turn_review(session_id, cwd)? else {
            return Ok(None);
        };
        let status = self.turn_status(session_id, cwd)?.unwrap();
        let root = Path::new(&review.cwd);
        let relative = relative.map(resolve_turn_path).transpose()?;
        let selected: Vec<_> = status
            .files
            .iter()
            .filter(|file| {
                relative
                    .as_ref()
                    .is_none_or(|relative| *relative == file.relative)
            })
            .collect();
        if selected.iter().any(|file| !file.undoable) {
            return Err("Cannot safely undo this turn: the workspace was shared, the branch moved, or a recorded file changed afterward".into());
        }
        let turn = completed_turn(&review)?;
        let selected: HashSet<_> = selected.iter().map(|file| file.relative.as_str()).collect();
        let changes: Vec<_> = changes(root, turn)?
            .into_iter()
            .filter(|change| selected.contains(change.relative.as_str()))
            .collect();
        // Validate all paths again before restoring any, preserving later edits
        // and refusing symlink traversal. The user's Git index is never reset.
        if changes.iter().any(|change| !restorable(root, change)) {
            return Err("Cannot safely undo: a recorded file changed after the checkpoint".into());
        }
        for change in changes {
            if change.before.is_some() {
                run_git(
                    root,
                    &[
                        "restore",
                        "--source",
                        turn.before.as_deref().unwrap(),
                        "--worktree",
                        "--",
                        &change.relative,
                    ],
                )?;
            } else {
                std::fs::remove_file(root.join(&change.relative)).map_err(|e| e.to_string())?;
            }
        }
        self.keep_turn(session_id, cwd, relative.as_deref())
    }

    pub(super) fn forget_turns(&self, session_id: &str) -> Result<(), String> {
        let dir = self.session_dir(session_id);
        let mut repos = BTreeSet::new();
        if let Some(review) = read_review(&dir)? {
            repos.insert(review.repo);
        }
        let history = dir.join("turns");
        if history.exists() {
            for entry in std::fs::read_dir(history).map_err(|e| e.to_string())? {
                let saved: SavedTurn = serde_json::from_slice(
                    &std::fs::read(entry.map_err(|e| e.to_string())?.path())
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                repos.insert(saved.repo);
            }
        }
        let prefix = format!("refs/monocode/checkpoints/{session_id}/");
        for repo in repos {
            if !Path::new(&repo).is_dir() {
                continue;
            }
            let refs = run_git(
                Path::new(&repo),
                &["for-each-ref", "--format=%(refname)", &prefix],
            )?;
            for reference in String::from_utf8_lossy(&refs)
                .lines()
                .filter(|reference| reference.starts_with(&prefix))
            {
                run_git(Path::new(&repo), &["update-ref", "-d", reference])?;
            }
        }
        Ok(())
    }
}

fn review_comparison_path(path: &Path) -> PathBuf {
    // path_to_js replaces Windows separators, including in canonical verbatim
    // paths. Restore native separators before comparing path components.
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().replace('/', "\\"))
    } else {
        path.to_path_buf()
    }
}

fn completed_turn(review: &TurnReview) -> Result<&RecordedTurn, String> {
    let turn = review
        .active
        .as_ref()
        .or(review.latest.as_ref())
        .ok_or("No recorded turn is available")?;
    if let Some(error) = &turn.error {
        return Err(format!("Could not record workspace changes: {error}"));
    }
    if review.active.is_some() {
        return Err("The turn ended without a final workspace checkpoint".into());
    }
    if turn.before.is_none() || turn.after.is_none() {
        return Err("The turn's workspace checkpoints are incomplete".into());
    }
    Ok(turn)
}

fn turn_ref(session: &str, turn: &str, side: &str) -> String {
    format!("refs/monocode/checkpoints/{session}/{turn}/{side}")
}

fn same_tree(root: &Path, left: Option<&str>, right: Option<&str>) -> Result<bool, String> {
    let tree = |oid: Option<&str>| {
        let oid = oid.ok_or(NO_WORKER_BASELINE)?;
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid saved checkpoint object".into());
        }
        run_git(root, &["rev-parse", "--verify", &format!("{oid}^{{tree}}")])
    };
    Ok(tree(left)? == tree(right)?)
}

fn blob_at(root: &Path, commit: &str, relative: &str) -> Result<Option<Blob>, String> {
    let output = run_git(root, &["ls-tree", "-z", commit, "--", relative])?;
    let Some(row) = output.split(|byte| *byte == 0).find(|row| !row.is_empty()) else {
        return Ok(None);
    };
    let mut fields = row.splitn(2, |byte| *byte == b'\t');
    let header = std::str::from_utf8(fields.next().unwrap()).map_err(|e| e.to_string())?;
    if fields.next() != Some(relative.as_bytes()) {
        return Err("Invalid checkpoint path".into());
    }
    let parts: Vec<_> = header.split_whitespace().collect();
    if parts.len() != 3 {
        return Err("Invalid checkpoint object".into());
    }
    Ok(Some(Blob {
        mode: parts[0].into(),
        oid: parts[2].into(),
    }))
}

// Git's NUL-delimited output already contains literal paths. Never trim them
// or interpret rename notation: those characters can be part of a filename.
fn resolve_turn_path(relative: &str) -> Result<String, String> {
    if relative.is_empty()
        || relative.contains('\0')
        || Path::new(relative).is_absolute()
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        || relative
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".." | ".git"))
    {
        return Err("Invalid checkpoint path".into());
    }
    Ok(relative.into())
}

fn git_command(root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    command
        .args(["--no-pager", "-C"])
        .arg(root)
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("PATH", crate::harness::gui_search_path());
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
    ] {
        command.env_remove(name);
    }
    command
}

fn checked_output(command: &mut Command) -> Result<Vec<u8>, String> {
    let output = command.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn run_git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    checked_output(&mut git_command(root, args))
}

struct PrivateIndex(PathBuf);
impl Drop for PrivateIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

fn capture_workspace(root: &Path, reference: &str) -> Result<String, String> {
    if run_git(root, &["config", "--bool", "core.sparseCheckout"])
        .ok()
        .is_some_and(|bytes| bytes.starts_with(b"true"))
    {
        return Err("Workspace checkpoints are unavailable for sparse checkouts".into());
    }
    let index = PrivateIndex(
        std::env::temp_dir().join(format!("monocode-checkpoint-{}", uuid::Uuid::new_v4())),
    );
    let run = |args: &[&str]| {
        checked_output(
            git_command(root, args)
                .env("GIT_INDEX_FILE", &index.0)
                .env("GIT_AUTHOR_NAME", "MonoCode")
                .env("GIT_AUTHOR_EMAIL", "checkpoint@monocode.local")
                .env("GIT_COMMITTER_NAME", "MonoCode")
                .env("GIT_COMMITTER_EMAIL", "checkpoint@monocode.local"),
        )
    };
    if run_git(root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        run(&["read-tree", "HEAD"])?;
    } else {
        run(&["read-tree", "--empty"])?;
    }
    let durable = [
        "-c",
        "core.fsync=objects,reference",
        "-c",
        "core.fsyncMethod=fsync",
    ];
    run(&[durable.as_slice(), &["add", "-A", "--", "."]].concat())?;
    let tree = String::from_utf8(run(&[durable.as_slice(), &["write-tree"]].concat())?)
        .map_err(|e| e.to_string())?;
    let commit = String::from_utf8(run(&[
        durable.as_slice(),
        &[
            "commit-tree",
            tree.trim(),
            "-m",
            "MonoCode workspace checkpoint",
        ],
    ]
    .concat())?)
    .map_err(|e| e.to_string())?;
    run(&[
        durable.as_slice(),
        &["update-ref", reference, commit.trim()],
    ]
    .concat())?;
    Ok(commit.trim().to_string())
}

fn changes(root: &Path, turn: &RecordedTurn) -> Result<Vec<Change>, String> {
    let before = turn.before.as_deref().ok_or("Missing turn baseline")?;
    let after = turn.after.as_deref().ok_or("Missing turn result")?;
    let args = [
        "diff",
        "--relative",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-abbrev",
        "-z",
    ];
    let raw = run_git(
        root,
        &[args.as_slice(), &["--raw", before, after, "--", "."]].concat(),
    )?;
    let numstat = run_git(
        root,
        &[args.as_slice(), &["--numstat", before, after, "--", "."]].concat(),
    )?;
    let mut stats = BTreeMap::new();
    for row in numstat
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let mut fields = row.splitn(3, |byte| *byte == b'\t');
        let additions = fields.next().ok_or("Invalid checkpoint line counts")?;
        let deletions = fields.next().ok_or("Invalid checkpoint line counts")?;
        let path = fields.next().ok_or("Invalid checkpoint path")?;
        let count = |bytes: &[u8]| -> Result<i64, String> {
            if bytes == b"-" {
                return Ok(0);
            }
            String::from_utf8_lossy(bytes)
                .parse()
                .map_err(|_| "Invalid checkpoint line counts".into())
        };
        stats.insert(path.to_vec(), (count(additions)?, count(deletions)?));
    }
    let mut records = raw.split(|byte| *byte == 0).filter(|row| !row.is_empty());
    let mut out = Vec::new();
    while let Some(header) = records.next() {
        let path = records.next().ok_or("Invalid checkpoint path")?;
        let fields: Vec<_> = std::str::from_utf8(header)
            .map_err(|e| e.to_string())?
            .split_whitespace()
            .collect();
        if fields.len() != 5 || !fields[0].starts_with(':') {
            return Err("Invalid checkpoint file status".into());
        }
        let blob = |mode: &str, oid: &str| {
            (mode != "000000").then(|| Blob {
                mode: mode.into(),
                oid: oid.into(),
            })
        };
        let (additions, deletions) = stats.remove(path).ok_or("Missing checkpoint line counts")?;
        out.push(Change {
            relative: String::from_utf8(path.to_vec()).map_err(|e| e.to_string())?,
            before: blob(&fields[0][1..], fields[2]),
            after: blob(fields[1], fields[3]),
            status: match fields[4] {
                "A" => "added",
                "D" => "deleted",
                _ => "modified",
            }
            .into(),
            additions,
            deletions,
        });
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

fn restorable(root: &Path, change: &Change) -> bool {
    if path_contains_symlink(root, &change.relative)
        || [change.before.as_ref(), change.after.as_ref()]
            .into_iter()
            .flatten()
            .any(|blob| !matches!(blob.mode.as_str(), "100644" | "100755"))
    {
        return false;
    }
    let path = root.join(&change.relative);
    match (&change.after, std::fs::symlink_metadata(&path)) {
        (None, Err(error)) => error.kind() == std::io::ErrorKind::NotFound,
        (Some(after), Ok(meta)) if meta.is_file() => {
            let mode = if file_mode(&path).is_some_and(|mode| mode & 0o111 != 0) {
                "100755"
            } else {
                "100644"
            };
            mode == after.mode
                && run_git(
                    root,
                    &[
                        "hash-object",
                        &format!("--path={}", change.relative),
                        "--",
                        &change.relative,
                    ],
                )
                .is_ok_and(|bytes| String::from_utf8_lossy(&bytes).trim() == after.oid)
        }
        _ => false,
    }
}

fn read_blob(root: &Path, blob: Option<&Blob>) -> Result<FileState, String> {
    let Some(blob) = blob else {
        return Ok(FileState::Missing);
    };
    if blob.mode == "160000" {
        return Ok(FileState::Contents(
            format!("Subproject commit {}\n", blob.oid).into_bytes(),
        ));
    }
    let size = run_git(root, &["cat-file", "-s", &blob.oid])?;
    let size: u64 = String::from_utf8_lossy(&size)
        .trim()
        .parse()
        .map_err(|_| "Invalid checkpoint blob size")?;
    if size > MAX_TEXT_FILE_BYTES {
        return Ok(FileState::Skipped);
    }
    Ok(FileState::Contents(run_git(
        root,
        &["cat-file", "blob", &blob.oid],
    )?))
}

fn read_review(dir: &Path) -> Result<Option<TurnReview>, String> {
    match std::fs::read(dir.join("turn-review.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_review(dir: &Path, review: &TurnReview) -> Result<(), String> {
    write_json(&dir.join("turn-review.json"), review)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid checkpoint metadata path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(tmp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
