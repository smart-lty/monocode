use super::*;

struct Fixture {
    dir: PathBuf,
    repo: PathBuf,
    store: CheckpointStore,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("monocode-turn-test-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.name", "Test"]).unwrap();
        run_git(&repo, &["config", "user.email", "test@example.invalid"]).unwrap();
        run_git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(repo.join("a.txt"), "original\n").unwrap();
        std::fs::write(repo.join("delete.txt"), "remove me\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();
        Self {
            store: CheckpointStore::new(dir.join("checkpoints")),
            dir,
            repo,
        }
    }
    fn cwd(&self) -> &str {
        self.repo.to_str().unwrap()
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.repo.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn clone_target(&self) -> PathBuf {
        let target = self.dir.join("target");
        run_git(&self.repo, &["clone", self.cwd(), target.to_str().unwrap()]).unwrap();
        target
    }
}

#[test]
fn worker_integrates_new_files_and_later_turns_from_its_original_baseline() {
    let f = Fixture::new();
    let target = f.clone_target();
    f.write("a.txt", "seeded user work\n");
    std::fs::write(target.join("a.txt"), "seeded user work\n").unwrap();
    let index = std::fs::read(f.repo.join(".git/index")).unwrap();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    let initial = read_review(&f.store.session_dir("worker"))
        .unwrap()
        .unwrap()
        .worker
        .unwrap()
        .before;
    f.store.begin_turn("worker", f.cwd(), "first").unwrap();
    f.write("a.txt", "first edit\n");
    f.write("new.txt", "first version\n");
    f.write("first-only.txt", "kept across the correction\n");
    f.store.finish_turn("worker", f.cwd(), "first").unwrap();
    f.store.ensure_worker("worker", f.cwd(), false).unwrap();
    f.store.begin_turn("worker", f.cwd(), "correction").unwrap();
    f.write("a.txt", "corrected edit\n");
    f.write("new.txt", "corrected new file\n");
    f.store
        .finish_turn("worker", f.cwd(), "correction")
        .unwrap();
    let saved = read_review(&f.store.session_dir("worker"))
        .unwrap()
        .unwrap();
    assert_eq!(saved.worker.unwrap().before, initial);
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index);
    let applied = f
        .store
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(applied.files, ["a.txt", "first-only.txt", "new.txt"]);
    assert_eq!(
        std::fs::read_to_string(target.join("new.txt")).unwrap(),
        "corrected new file\n"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("first-only.txt")).unwrap(),
        "kept across the correction\n"
    );
    assert_eq!(
        f.store
            .apply("worker", f.cwd(), target.to_str().unwrap(), None)
            .unwrap()
            .already_applied,
        3
    );
}

#[test]
fn worker_preserves_inherited_large_files_and_limits_only_actual_changes() {
    let f = Fixture::new();
    let target = f.clone_target();
    let large = vec![b'x'; MAX_TEXT_FILE_BYTES as usize + 1];
    for relative in ["a.txt", "inherited-untracked.bin"] {
        std::fs::write(f.repo.join(relative), &large).unwrap();
        std::fs::write(target.join(relative), &large).unwrap();
    }
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    assert!(f.store.cleanup_safe("worker", f.cwd()).unwrap());
    f.store.begin_turn("worker", f.cwd(), "edit").unwrap();
    f.write("small.txt", "the actual task result\n");
    f.store.finish_turn("worker", f.cwd(), "edit").unwrap();
    assert_eq!(
        f.store
            .apply("worker", f.cwd(), target.to_str().unwrap(), None)
            .unwrap()
            .files,
        ["small.txt"]
    );
    assert_eq!(
        std::fs::read(target.join("inherited-untracked.bin")).unwrap(),
        large
    );
    f.store.begin_turn("worker", f.cwd(), "large-edit").unwrap();
    std::fs::write(
        f.repo.join("inherited-untracked.bin"),
        vec![b'y'; large.len()],
    )
    .unwrap();
    f.store
        .finish_turn("worker", f.cwd(), "large-edit")
        .unwrap();
    assert!(f
        .store
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("size"));
    assert_eq!(
        std::fs::read(target.join("inherited-untracked.bin")).unwrap(),
        large
    );
    assert!(!f.store.cleanup_safe("worker", f.cwd()).unwrap());
}

#[test]
fn worker_conflict_preflight_writes_nothing_and_retains_all_recordings() {
    let f = Fixture::new();
    let target = f.clone_target();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    f.store.begin_turn("worker", f.cwd(), "edit").unwrap();
    f.write("0-new.txt", "new result\n");
    f.write("a.txt", "worker result\n");
    f.store.finish_turn("worker", f.cwd(), "edit").unwrap();
    std::fs::write(target.join("a.txt"), "independent session result\n").unwrap();
    let recording = std::fs::read(f.store.session_dir("worker").join("turn-review.json")).unwrap();
    assert!(f
        .store
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("lead checkout changed"));
    assert!(!target.join("0-new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).unwrap(),
        "independent session result\n"
    );
    assert_eq!(
        std::fs::read(f.store.session_dir("worker").join("turn-review.json")).unwrap(),
        recording
    );
    assert!(f.repo.join("0-new.txt").exists());
}

#[test]
fn worker_recovers_a_stopped_turn_only_from_its_saved_before() {
    let f = Fixture::new();
    let target = f.clone_target();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    f.store
        .begin_turn("worker", f.cwd(), "interrupted")
        .unwrap();
    f.write("stopped.txt", "last write before the provider stopped\n");
    let reopened = CheckpointStore::new(f.store.root.clone());
    assert!(reopened
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .is_err());
    // Explicit stop recovery has lost the renderer token but keeps the real
    // pre-execution recording. It may only capture this turn's result.
    reopened.finish_saved_turn("worker", f.cwd(), None).unwrap();
    reopened.finish_saved_turn("worker", f.cwd(), None).unwrap();
    assert_eq!(
        reopened
            .apply("worker", f.cwd(), target.to_str().unwrap(), None)
            .unwrap()
            .files,
        ["stopped.txt"]
    );
    reopened.ensure_worker("worker", f.cwd(), false).unwrap();
    reopened.begin_turn("worker", f.cwd(), "continued").unwrap();
    f.write("stopped.txt", "continued result\n");
    reopened
        .finish_turn("worker", f.cwd(), "continued")
        .unwrap();
    // The previous integration changed the target: a new final result is not
    // allowed to overwrite it without a matching initial/final state.
    assert!(reopened
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .is_err());
    assert_eq!(
        std::fs::read_to_string(target.join("stopped.txt")).unwrap(),
        "last write before the provider stopped\n"
    );
}

#[test]
fn worker_integration_preflights_scope_and_preserves_an_independent_turn() {
    let f = Fixture::new();
    let target = f.clone_target();
    let cwd = target.to_str().unwrap();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    f.store.begin_turn("worker", f.cwd(), "first").unwrap();
    f.write("a.txt", "integrated worker change\n");
    f.write("outside.txt", "out of scope\n");
    f.store.finish_turn("worker", f.cwd(), "first").unwrap();
    f.store.begin_turn("ordinary", cwd, "parallel").unwrap();
    std::fs::write(target.join("ordinary.txt"), "independent change\n").unwrap();

    let scopes = ["a.txt".into()];
    assert!(f
        .store
        .apply("worker", f.cwd(), cwd, Some(&scopes))
        .unwrap_err()
        .contains("write scope"));
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).unwrap(),
        "original\n"
    );
    assert!(!target.join("outside.txt").exists());
    assert!(
        !read_review(&f.store.session_dir("ordinary"))
            .unwrap()
            .unwrap()
            .active
            .unwrap()
            .shared
    );
    // After the lead explicitly expands the assignment, integration may run
    // alongside this independent turn. Its combined diff is not undoable.
    f.store
        .apply("worker", f.cwd(), cwd, Some(&[".".into()]))
        .unwrap();
    assert!(read_review(&f.store.session_dir("ordinary"))
        .unwrap()
        .unwrap()
        .active
        .is_some());
    f.store.finish_turn("ordinary", cwd, "parallel").unwrap();
    assert!(f
        .store
        .status("ordinary", cwd)
        .unwrap()
        .files
        .iter()
        .all(|file| !file.undoable));
    assert!(f.store.undo("ordinary", cwd, None).is_err());
    assert!(target.join("ordinary.txt").exists());
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).unwrap(),
        "integrated worker change\n"
    );
}

#[cfg(unix)]
#[test]
fn worker_integration_marks_sessions_shared_through_checkout_alias() {
    let f = Fixture::new();
    let target = f.clone_target();
    let alias = f.dir.join("target-alias");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    f.store.begin_turn("worker", f.cwd(), "first").unwrap();
    f.write("a.txt", "worker result\n");
    f.store.finish_turn("worker", f.cwd(), "first").unwrap();
    f.store
        .begin_turn("ordinary", target.to_str().unwrap(), "parallel")
        .unwrap();
    f.store
        .apply("worker", f.cwd(), alias.to_str().unwrap(), None)
        .unwrap();
    f.store
        .finish_turn("ordinary", target.to_str().unwrap(), "parallel")
        .unwrap();
    assert!(f
        .store
        .undo("ordinary", alias.to_str().unwrap(), None)
        .is_err());
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).unwrap(),
        "worker result\n"
    );
}

#[test]
fn missing_worker_baseline_never_uses_current_results_as_initial_state() {
    let f = Fixture::new();
    let target = f.clone_target();
    f.write("uncaptured.txt", "completed legacy result\n");
    assert!(f
        .store
        .ensure_worker("worker", f.cwd(), false)
        .unwrap_err()
        .contains("trusted initial"));
    f.store.finish_saved_turn("worker", f.cwd(), None).unwrap();
    assert!(f
        .store
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("trusted initial"));
    assert!(!f.store.cleanup_safe("worker", f.cwd()).unwrap());
    assert!(!f.store.session_dir("worker").exists());
    assert!(f.repo.join("uncaptured.txt").exists());
    assert!(!target.join("uncaptured.txt").exists());
    // Even an explicit fresh request must not replace an existing recording
    // that belongs to another checkout with today's result files.
    let other_cwd = target.to_str().unwrap();
    f.store
        .begin_turn("worker", other_cwd, "other-checkout")
        .unwrap();
    f.store
        .finish_turn("worker", other_cwd, "other-checkout")
        .unwrap();
    let path = f.store.session_dir("worker").join("turn-review.json");
    let original = std::fs::read(&path).unwrap();
    assert!(f.store.ensure_worker("worker", f.cwd(), true).is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn worker_rejects_between_turn_and_post_checkpoint_edits_without_rebaselining() {
    let f = Fixture::new();
    let target = f.clone_target();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    f.store.begin_turn("worker", f.cwd(), "first").unwrap();
    f.write("a.txt", "worker\n");
    f.store.finish_turn("worker", f.cwd(), "first").unwrap();
    let before = read_review(&f.store.session_dir("worker"))
        .unwrap()
        .unwrap()
        .worker
        .unwrap()
        .before;
    f.write("later.txt", "external change\n");
    assert!(f
        .store
        .apply("worker", f.cwd(), target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("after the worker checkpoint"));
    assert!(f
        .store
        .begin_turn("worker", f.cwd(), "next")
        .unwrap_err()
        .contains("between recorded turns"));
    assert!(f.store.ensure_worker("worker", f.cwd(), true).is_err());
    assert_eq!(
        read_review(&f.store.session_dir("worker"))
            .unwrap()
            .unwrap()
            .worker
            .unwrap()
            .before,
        before
    );
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).unwrap(),
        "original\n"
    );
    assert!(f.repo.join("later.txt").exists());
}

#[test]
fn legacy_single_turn_can_integrate_but_ambiguous_multiple_turns_are_retained() {
    let f = Fixture::new();
    let target = f.clone_target();
    f.store.begin_turn("legacy", f.cwd(), "first").unwrap();
    f.write("a.txt", "legacy first\n");
    f.store.finish_turn("legacy", f.cwd(), "first").unwrap();
    assert_eq!(
        f.store
            .apply("legacy", f.cwd(), target.to_str().unwrap(), None)
            .unwrap()
            .files,
        ["a.txt"]
    );
    f.store.begin_turn("legacy", f.cwd(), "second").unwrap();
    f.write("a.txt", "legacy correction\n");
    f.store.finish_turn("legacy", f.cwd(), "second").unwrap();
    assert!(f
        .store
        .apply("legacy", f.cwd(), target.to_str().unwrap(), None)
        .unwrap_err()
        .contains("multiple legacy turns"));
    assert!(f
        .store
        .session_dir("legacy")
        .join("turns/first.json")
        .exists());
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "legacy correction\n"
    );
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn records_shell_changes_and_preserves_the_index_head_and_saved_result() {
    let f = Fixture::new();
    f.write("a.txt", "user change\n");
    f.write("user.txt", "existing untracked work\n");
    run_git(&f.repo, &["add", "a.txt"]).unwrap();
    let index = std::fs::read(f.repo.join(".git/index")).unwrap();
    let head = run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    // No structured edit events: the actual file state is authoritative.
    f.write("a.txt", "user change\nagent change\n");
    f.write("new.txt", "one\ntwo\n");
    std::fs::remove_file(f.repo.join("delete.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(
        status
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect::<Vec<_>>(),
        ["a.txt", "delete.txt", "new.txt"]
    );
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (1, 0)
    );
    assert!(status.files.iter().all(|file| file.exact && file.undoable));
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap(), head);

    f.write("a.txt", "a later editor change\n");
    // Reopening the store proves the review survives a restart and never reads
    // later contents as though they were this turn's result.
    let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
    let diff = reopened.file_diff("session", f.cwd(), "a.txt").unwrap();
    assert_eq!(diff.original, "user change\n");
    assert_eq!(diff.current, "user change\nagent change\n");
    let status = reopened.status("session", f.cwd()).unwrap();
    assert!(status.files[0].exact);
    assert!(!status.files[0].undoable);
    assert!(reopened.undo("session", f.cwd(), None).is_err());
    assert!(f.repo.join("new.txt").exists());
    assert!(!f.repo.join("delete.txt").exists());
}

#[test]
fn each_turn_has_a_fresh_baseline_and_noop_turns_clear_the_old_card() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "first turn\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "external edit between turns\n");
    f.store.begin_turn("session", f.cwd(), "second").unwrap();
    f.write("a.txt", "external edit between turns\nsecond turn\n");
    f.store.finish_turn("session", f.cwd(), "second").unwrap();
    let diff = f.store.file_diff("session", f.cwd(), "a.txt").unwrap();
    assert_eq!(diff.original, "external edit between turns\n");
    assert_eq!(diff.current, "external edit between turns\nsecond turn\n");
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (1, 0)
    );
    f.store.begin_turn("session", f.cwd(), "third").unwrap();
    f.store.finish_turn("session", f.cwd(), "third").unwrap();
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
    assert!(f.dir.join("checkpoints/session/turns/first.json").exists());
    assert!(run_git(
        &f.repo,
        &["rev-parse", &turn_ref("session", "first", "after")]
    )
    .is_ok());
}

#[test]
fn overlapping_turns_keep_exact_diffs_but_cannot_restore_shared_work() {
    let f = Fixture::new();
    f.write("a.txt", "top\n\nbottom\n");
    f.store.begin_turn("a", f.cwd(), "first").unwrap();
    f.store.begin_turn("b", f.cwd(), "second").unwrap();
    f.write("a.txt", "top edited by a\n\nbottom edited by b\n");
    f.store.finish_turn("a", f.cwd(), "first").unwrap();
    f.store.finish_turn("b", f.cwd(), "second").unwrap();
    for id in ["a", "b"] {
        let status = f.store.status(id, f.cwd()).unwrap();
        assert_eq!(
            (status.files[0].additions, status.files[0].deletions),
            (2, 2)
        );
        assert!(status.files[0].exact);
        assert!(!status.files[0].undoable);
        assert!(f.store.undo(id, f.cwd(), None).is_err());
        assert_eq!(
            f.store.file_diff(id, f.cwd(), "a.txt").unwrap().current,
            "top edited by a\n\nbottom edited by b\n"
        );
    }
}

#[test]
fn nested_turns_share_work_but_sibling_path_prefixes_do_not() {
    let f = Fixture::new();
    f.write("nested/a.txt", "child baseline\n");
    f.write("nested-other/a.txt", "sibling baseline\n");
    let child = f.repo.join("nested");
    let sibling = f.repo.join("nested-other");
    let child_cwd = child.to_str().unwrap();
    let sibling_cwd = sibling.to_str().unwrap();

    f.store.begin_turn("child", child_cwd, "first").unwrap();
    f.store.begin_turn("sibling", sibling_cwd, "first").unwrap();
    f.write("nested/a.txt", "independent child change\n");
    f.store.finish_turn("child", child_cwd, "first").unwrap();
    let status = f.store.status("child", child_cwd).unwrap();
    assert_eq!(status.files.len(), 1);
    assert!(status.files[0].undoable);
    f.store
        .finish_turn("sibling", sibling_cwd, "first")
        .unwrap();

    f.store.begin_turn("parent", f.cwd(), "second").unwrap();
    f.store.begin_turn("child", child_cwd, "second").unwrap();
    f.write("nested/a.txt", "shared parent and child change\n");
    f.store.finish_turn("parent", f.cwd(), "second").unwrap();
    f.store.finish_turn("child", child_cwd, "second").unwrap();
    for (id, cwd) in [("parent", f.cwd()), ("child", child_cwd)] {
        let status = f.store.status(id, cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert!(status.files[0].exact);
        assert!(!status.files[0].undoable);
        assert!(f.store.undo(id, cwd, None).is_err());
    }
}

#[test]
fn undo_restores_only_recorded_files_and_keep_retains_history() {
    let f = Fixture::new();
    f.write("user.txt", "user baseline\n");
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "agent\n");
    f.write("user.txt", "user baseline\nagent addition\n");
    f.write("new.txt", "created\n");
    std::fs::remove_file(f.repo.join("delete.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.write("unrelated.txt", "later work\n");
    let index = std::fs::read(f.repo.join(".git/index")).unwrap();
    f.store.keep("session", f.cwd(), Some("a.txt")).unwrap();
    f.store.undo("session", f.cwd(), None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "agent\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repo.join("user.txt")).unwrap(),
        "user baseline\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repo.join("delete.txt")).unwrap(),
        "remove me\n"
    );
    assert!(f.repo.join("unrelated.txt").exists());
    assert!(!f.repo.join("new.txt").exists());
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert!(f.dir.join("checkpoints/session/turns/first.json").exists());
    f.store.forget("session").unwrap();
    assert!(run_git(
        &f.repo,
        &["for-each-ref", "refs/monocode/checkpoints/session/"]
    )
    .unwrap()
    .is_empty());
}

#[test]
fn failures_and_incomplete_turns_never_fall_back_to_the_previous_result() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "first\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.store.begin_turn("session", f.cwd(), "second").unwrap();
    assert!(f
        .store
        .status("session", f.cwd())
        .unwrap_err()
        .contains("without a final"));
    // Stale completion from a cancelled turn must not settle a newer turn.
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    assert!(f.store.status("session", f.cwd()).is_err());
    run_git(&f.repo, &["config", "core.sparseCheckout", "true"]).unwrap();
    assert!(f.store.finish_turn("session", f.cwd(), "second").is_err());
    assert!(f
        .store
        .status("session", f.cwd())
        .unwrap_err()
        .contains("sparse"));
    run_git(&f.repo, &["config", "core.sparseCheckout", "false"]).unwrap();
    f.store.begin_turn("session", f.cwd(), "third").unwrap();
    f.store.finish_turn("session", f.cwd(), "third").unwrap();
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
}

#[test]
fn records_empty_binary_and_unusual_paths_without_the_old_file_limit() {
    let f = Fixture::new();
    f.write(".gitignore", "ignored/\n");
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("ignored/file.txt", "ignored\n");
    for index in 0..501 {
        f.write(&format!("new/{index}.txt"), "");
    }
    f.write("binary.bin", "\0binary");
    let path = if cfg!(windows) {
        "café name.txt"
    } else {
        "café\tname\n.txt"
    };
    f.write(path, "new\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 503);
    assert!(status
        .files
        .iter()
        .any(|file| file.relative == path && file.additions == 1));
    assert!(
        f.store
            .file_diff("session", f.cwd(), "binary.bin")
            .unwrap()
            .binary
    );
    assert_eq!(
        f.store.file_diff("session", f.cwd(), path).unwrap().current,
        "new\n"
    );
}

#[test]
fn records_committed_changes_without_reading_the_current_git_status() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "committed during the turn\n");
    run_git(&f.repo, &["add", "."]).unwrap();
    run_git(&f.repo, &["commit", "-m", "agent changes"]).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    assert!(run_git(&f.repo, &["status", "--porcelain"])
        .unwrap()
        .is_empty());
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (1, 1)
    );
    assert!(status.files[0].exact);
    assert!(!status.files[0].undoable);
    assert!(f.store.undo("session", f.cwd(), None).is_err());
}

#[test]
fn linked_worktrees_have_independent_recordings_and_indexes() {
    let f = Fixture::new();
    let linked = f.dir.join("linked");
    run_git(
        &f.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    )
    .unwrap();
    let cwd = linked.to_str().unwrap();
    let git_dir = run_git(&linked, &["rev-parse", "--absolute-git-dir"]).unwrap();
    let index_path = PathBuf::from(String::from_utf8(git_dir).unwrap().trim()).join("index");
    let index = std::fs::read(&index_path).unwrap();
    f.store.begin_turn("main", f.cwd(), "first").unwrap();
    f.store.begin_turn("linked", cwd, "second").unwrap();
    f.write("a.txt", "main change\n");
    std::fs::write(linked.join("delete.txt"), "linked change\n").unwrap();
    f.store.finish_turn("main", f.cwd(), "first").unwrap();
    f.store.finish_turn("linked", cwd, "second").unwrap();
    assert_eq!(
        f.store.status("main", f.cwd()).unwrap().files[0].relative,
        "a.txt"
    );
    let status = f.store.status("linked", cwd).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "delete.txt");
    assert!(status.files[0].undoable);
    assert_eq!(std::fs::read(&index_path).unwrap(), index);
    f.store.undo("linked", cwd, None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "main change\n"
    );
}

#[cfg(unix)]
#[test]
fn preserves_literal_paths_and_records_modes_and_symlinks_safely() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new();
    run_git(&f.repo, &["config", "core.fileMode", "true"]).unwrap();
    let path = " literal => name .txt ";
    f.write(path, "baseline\n");
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write(path, "changed\n");
    std::fs::set_permissions(f.repo.join("a.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(f.repo.join("delete.txt"), f.repo.join("renamed.txt")).unwrap();
    symlink("a.txt", f.repo.join("link.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 5);
    let link = status
        .files
        .iter()
        .find(|file| file.relative == "link.txt")
        .unwrap();
    assert!(link.exact);
    assert!(!link.undoable);
    let diff = f.store.file_diff("session", f.cwd(), path).unwrap();
    assert_eq!(diff.original, "baseline\n");
    assert_eq!(diff.current, "changed\n");
    f.store.undo("session", f.cwd(), Some(path)).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join(path)).unwrap(),
        "baseline\n"
    );
    f.store.undo("session", f.cwd(), Some("a.txt")).unwrap();
    assert_eq!(file_mode(&f.repo.join("a.txt")).unwrap() & 0o111, 0);
    for path in ["../a.txt", "/a.txt", "a/../a.txt", "./a.txt", ".git/config"] {
        assert!(f.store.file_diff("session", f.cwd(), path).is_err());
    }
}

#[test]
fn checkpoints_scope_nested_workspaces_and_repositories_without_head() {
    let f = Fixture::new();
    f.write("nested/a.txt", "nested\n");
    let cwd = f.repo.join("nested");
    let cwd = cwd.to_str().unwrap();
    f.store.begin_turn("nested", cwd, "first").unwrap();
    f.write("nested/a.txt", "nested\nchanged\n");
    f.write("a.txt", "outside scope\n");
    f.store.finish_turn("nested", cwd, "first").unwrap();
    let status = f.store.status("nested", cwd).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "a.txt");
    assert_eq!(
        f.store.file_diff("nested", cwd, "a.txt").unwrap().current,
        "nested\nchanged\n"
    );
    f.store.undo("nested", cwd, None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "outside scope\n"
    );

    let unborn = f.dir.join("unborn");
    std::fs::create_dir(&unborn).unwrap();
    run_git(&unborn, &["init"]).unwrap();
    let cwd = unborn.to_str().unwrap();
    f.store.begin_turn("unborn", cwd, "first").unwrap();
    std::fs::write(unborn.join("new.txt"), "new\n").unwrap();
    f.store.finish_turn("unborn", cwd, "first").unwrap();
    assert_eq!(f.store.status("unborn", cwd).unwrap().files[0].additions, 1);
    f.store.undo("unborn", cwd, None).unwrap();
    assert!(!unborn.join("new.txt").exists());
}

#[test]
fn terminal_worker_continues_as_ordinary_without_overwriting_worker_evidence() {
    let f = Fixture::new();
    f.store.ensure_worker("worker", f.cwd(), true).unwrap();
    f.store.begin_turn("worker", f.cwd(), "work").unwrap();
    f.write("a.txt", "worker edit\n");
    f.store.finish_turn("worker", f.cwd(), "work").unwrap();
    let before = read_review(&f.store.session_dir("worker"))
        .unwrap()
        .unwrap()
        .worker
        .unwrap();
    f.write("a.txt", "manual edit\n");
    assert!(f.store.begin_turn("worker", f.cwd(), "blocked").is_err());
    f.store.retire_worker("worker", f.cwd()).unwrap();
    f.store.begin_turn("worker", f.cwd(), "ordinary").unwrap();
    f.write("a.txt", "ordinary edit\n");
    f.store.finish_turn("worker", f.cwd(), "ordinary").unwrap();
    let saved = read_review(&f.store.session_dir("worker"))
        .unwrap()
        .unwrap();
    let worker = saved.worker.unwrap();
    assert_eq!(worker.before, before.before);
    assert_eq!(worker.after, before.after);
    assert!(worker.error.is_some());
    assert!(f
        .store
        .recorded_worker_delta("worker", f.cwd())
        .err()
        .unwrap()
        .contains("independently"));
    let status = f.store.status("worker", f.cwd()).unwrap();
    assert!(status
        .files
        .iter()
        .any(|file| file.relative == "a.txt" && file.undoable));
    f.store.undo_turn("worker", f.cwd(), None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "manual edit\n"
    );
}
