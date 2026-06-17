mod codex_bridge;
mod config;
mod db;
mod git;
mod paths;
mod terminal;

use codex_bridge::{CodexBridgeState, CodexConnectionStatus};
use config::CodexConfigSnapshot;
use db::{DbPath, ProjectRow, SessionRow};
use git::{GitChangedFile, GitSnapshot};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use terminal::CommandOutput;

struct SharedCodexBridge(Arc<CodexBridgeState>);
struct SharedDb(DbPath);

#[tauri::command]
fn ping() -> &'static str {
  "pong"
}

#[tauri::command]
fn codex_status(state: State<'_, SharedCodexBridge>) -> CodexConnectionStatus {
  state.0.status()
}

#[tauri::command]
fn codex_start(app: AppHandle, state: State<'_, SharedCodexBridge>) -> Result<CodexConnectionStatus, String> {
  state.0.start(app)
}

#[tauri::command]
fn codex_stop(state: State<'_, SharedCodexBridge>) -> Result<CodexConnectionStatus, String> {
  state.0.stop()
}

#[tauri::command]
fn codex_initialize(state: State<'_, SharedCodexBridge>, client_name: Option<String>) -> Result<u64, String> {
  state.0.initialize(client_name)
}

#[tauri::command]
fn codex_start_thread(state: State<'_, SharedCodexBridge>, cwd: Option<String>, model: Option<String>) -> Result<u64, String> {
  state.0.start_thread(cwd, model)
}

#[tauri::command]
fn codex_start_thread_sync(state: State<'_, SharedCodexBridge>, cwd: Option<String>, model: Option<String>) -> Result<String, String> {
  state.0.start_thread_sync(cwd, model, 120)
}

#[tauri::command]
fn codex_list_threads(state: State<'_, SharedCodexBridge>, cwd: Option<String>, search_term: Option<String>) -> Result<u64, String> {
  state.0.list_threads(cwd, search_term)
}

#[tauri::command]
fn codex_resume_thread(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.resume_thread(thread_id)
}

#[tauri::command]
fn codex_read_thread(state: State<'_, SharedCodexBridge>, thread_id: String, include_turns: bool) -> Result<u64, String> {
  state.0.read_thread(thread_id, include_turns)
}

#[tauri::command]
fn codex_read_thread_sync(state: State<'_, SharedCodexBridge>, thread_id: String, include_turns: bool) -> Result<serde_json::Value, String> {
  state.0.read_thread_sync(thread_id, include_turns, 30)
}

#[tauri::command]
fn codex_start_turn(state: State<'_, SharedCodexBridge>, thread_id: String, text: String, cwd: Option<String>) -> Result<u64, String> {
  state.0.start_turn(thread_id, text, cwd)
}

#[tauri::command]
fn codex_steer_turn(state: State<'_, SharedCodexBridge>, thread_id: String, text: String) -> Result<u64, String> {
  state.0.steer_turn(thread_id, text)
}

#[tauri::command]
fn codex_interrupt_turn(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.interrupt_turn(thread_id)
}

#[tauri::command]
fn codex_set_thread_name(state: State<'_, SharedCodexBridge>, thread_id: String, name: String) -> Result<u64, String> {
  state.0.set_thread_name(thread_id, name)
}

#[tauri::command]
fn codex_archive_thread(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.archive_thread(thread_id)
}

#[tauri::command]
fn codex_unarchive_thread(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.unarchive_thread(thread_id)
}

#[tauri::command]
fn codex_fork_thread(state: State<'_, SharedCodexBridge>, thread_id: String, cwd: Option<String>) -> Result<u64, String> {
  state.0.fork_thread(thread_id, cwd)
}

#[tauri::command]
fn codex_rollback_thread(state: State<'_, SharedCodexBridge>, thread_id: String, num_turns: u64) -> Result<u64, String> {
  state.0.rollback_thread(thread_id, num_turns)
}

#[tauri::command]
fn codex_set_thread_goal(
  state: State<'_, SharedCodexBridge>,
  thread_id: String,
  objective: Option<String>,
  status: Option<String>,
  token_budget: Option<u64>,
) -> Result<u64, String> {
  state.0.set_thread_goal(thread_id, objective, status, token_budget)
}

#[tauri::command]
fn codex_get_thread_goal(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.get_thread_goal(thread_id)
}

#[tauri::command]
fn codex_clear_thread_goal(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.clear_thread_goal(thread_id)
}

#[tauri::command]
fn codex_update_thread_metadata_git(
  state: State<'_, SharedCodexBridge>,
  thread_id: String,
  sha: Option<String>,
  branch: Option<String>,
  origin_url: Option<String>,
  clear_sha: bool,
  clear_branch: bool,
  clear_origin_url: bool,
) -> Result<u64, String> {
  state.0.update_thread_metadata_git(
    thread_id,
    sha,
    branch,
    origin_url,
    clear_sha,
    clear_branch,
    clear_origin_url,
  )
}

#[tauri::command]
fn codex_start_review_uncommitted(state: State<'_, SharedCodexBridge>, thread_id: String) -> Result<u64, String> {
  state.0.start_review_uncommitted(thread_id)
}

#[tauri::command]
fn codex_list_skills(state: State<'_, SharedCodexBridge>, cwd: Option<String>, force_reload: bool) -> Result<u64, String> {
  state.0.list_skills(cwd, force_reload)
}

#[tauri::command]
fn codex_list_mcp_servers(state: State<'_, SharedCodexBridge>, thread_id: Option<String>) -> Result<u64, String> {
  state.0.list_mcp_servers(thread_id)
}

#[tauri::command]
fn codex_mcp_read_resource(
  state: State<'_, SharedCodexBridge>,
  thread_id: Option<String>,
  server: String,
  uri: String,
) -> Result<u64, String> {
  state.0.mcp_read_resource(thread_id, server, uri)
}

#[tauri::command]
fn codex_mcp_call_tool(
  state: State<'_, SharedCodexBridge>,
  thread_id: String,
  server: String,
  tool: String,
  arguments: Option<Value>,
) -> Result<u64, String> {
  state.0.mcp_call_tool(thread_id, server, tool, arguments)
}

#[tauri::command]
fn codex_command_exec(
  state: State<'_, SharedCodexBridge>,
  process_id: String,
  command: Vec<String>,
  cwd: Option<String>,
  tty: bool,
  cols: Option<u64>,
  rows: Option<u64>,
) -> Result<u64, String> {
  state.0.command_exec(process_id, command, cwd, tty, cols, rows)
}

#[tauri::command]
fn codex_command_exec_write(
  state: State<'_, SharedCodexBridge>,
  process_id: String,
  delta_base64: Option<String>,
  close_stdin: bool,
) -> Result<u64, String> {
  state.0.command_exec_write(process_id, delta_base64, close_stdin)
}

#[tauri::command]
fn codex_command_exec_terminate(state: State<'_, SharedCodexBridge>, process_id: String) -> Result<u64, String> {
  state.0.command_exec_terminate(process_id)
}

#[tauri::command]
fn codex_command_exec_resize(
  state: State<'_, SharedCodexBridge>,
  process_id: String,
  cols: u64,
  rows: u64,
) -> Result<u64, String> {
  state.0.command_exec_resize(process_id, cols, rows)
}

#[tauri::command]
fn codex_respond_to_server_request(state: State<'_, SharedCodexBridge>, id: u64, result: Value) -> Result<(), String> {
  state.0.respond_to_server_request(id, result)
}

#[tauri::command]
fn codex_reject_server_request(state: State<'_, SharedCodexBridge>, id: u64, message: String) -> Result<(), String> {
  state.0.reject_server_request(id, message)
}

#[tauri::command]
fn git_snapshot(cwd: String) -> Result<GitSnapshot, String> {
  git::snapshot(cwd)
}

#[tauri::command]
fn git_diff(cwd: String) -> Result<String, String> {
  git::diff(cwd)
}

#[tauri::command]
fn git_diff_staged(cwd: String) -> Result<String, String> {
  git::diff_staged(cwd)
}

#[tauri::command]
fn git_stage_all(cwd: String) -> Result<(), String> {
  git::stage_all(cwd)
}

#[tauri::command]
fn git_unstage_all(cwd: String) -> Result<(), String> {
  git::unstage_all(cwd)
}

#[tauri::command]
fn git_revert_all(cwd: String) -> Result<(), String> {
  git::revert_all(cwd)
}

#[tauri::command]
fn git_commit(cwd: String, message: String) -> Result<String, String> {
  git::commit(cwd, message)
}

#[tauri::command]
fn git_changed_files(cwd: String) -> Result<Vec<GitChangedFile>, String> {
  git::changed_files(cwd)
}

#[tauri::command]
fn git_stage_path(cwd: String, path: String) -> Result<(), String> {
  git::stage_path(cwd, path)
}

#[tauri::command]
fn git_unstage_path(cwd: String, path: String) -> Result<(), String> {
  git::unstage_path(cwd, path)
}

#[tauri::command]
fn git_revert_path(cwd: String, path: String) -> Result<(), String> {
  git::revert_path(cwd, path)
}

#[tauri::command]
fn codex_read_config() -> Result<CodexConfigSnapshot, String> {
  config::read_config()
}

#[tauri::command]
fn codex_write_config(contents: String) -> Result<CodexConfigSnapshot, String> {
  config::write_config(contents)
}

#[tauri::command]
fn terminal_run_readonly(cwd: String, command: String) -> Result<CommandOutput, String> {
  terminal::run_readonly(cwd, command)
}

#[derive(serde::Serialize)]
struct CodexCheckResult {
  installed: bool,
  version: Option<String>,
  error: Option<String>,
}

#[tauri::command]
fn codex_check() -> CodexCheckResult {
  let output = codex_bridge::codex_command().arg("--version").output();
  match output {
    Ok(out) if out.status.success() => CodexCheckResult {
      installed: true,
      version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
      error: None,
    },
    Ok(out) => CodexCheckResult {
      installed: false,
      version: None,
      error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    },
    Err(err) => CodexCheckResult {
      installed: false,
      version: None,
      error: Some(err.to_string()),
    },
  }
}

#[tauri::command]
fn project_add(state: State<'_, SharedDb>, path: String, name: Option<String>, now: i64) -> Result<ProjectRow, String> {
  db::add_project(&state.0, path, name, now)
}

#[tauri::command]
fn projects_list(state: State<'_, SharedDb>) -> Result<Vec<ProjectRow>, String> {
  db::list_projects(&state.0)
}

#[tauri::command]
fn sessions_for_project(state: State<'_, SharedDb>, project_id: i64) -> Result<Vec<SessionRow>, String> {
  db::list_sessions_for_project(&state.0, project_id)
}

#[tauri::command]
fn session_upsert(
  state: State<'_, SharedDb>,
  project_id: i64,
  thread_id: String,
  mode: Option<String>,
  worktree_path: Option<String>,
  title: Option<String>,
  updated_at: Option<i64>,
  status: Option<String>,
) -> Result<SessionRow, String> {
  db::upsert_session(&state.0, project_id, thread_id, mode, worktree_path, title, updated_at, status)
}

#[tauri::command]
fn worktree_create(app: AppHandle, project_path: String, session_thread_id: String) -> Result<String, String> {
  let app_data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("resolve app_data_dir failed: {e}"))?;
  let base = app_data_dir.join("worktrees");
  std::fs::create_dir_all(&base).map_err(|e| format!("create worktrees dir failed: {e}"))?;
  let target = base.join(&session_thread_id);
  if target.exists() {
    return Ok(target.to_string_lossy().to_string());
  }
  let target_str = target.to_string_lossy().to_string();

  let output = std::process::Command::new("git")
    .current_dir(&project_path)
    .args(["worktree", "add", "--detach", &target_str])
    .output()
    .map_err(|e| format!("git worktree add failed: {e}"))?;
  if !output.status.success() {
    return Err(String::from_utf8_lossy(&output.stderr).to_string());
  }
  Ok(target_str)
}

#[tauri::command]
fn worktree_remove(_app: AppHandle, project_path: String, worktree_path: String) -> Result<(), String> {
  let output = std::process::Command::new("git")
    .current_dir(&project_path)
    .args(["worktree", "remove", "--force", &worktree_path])
    .output()
    .map_err(|e| format!("git worktree remove failed: {e}"))?;
  if !output.status.success() {
    return Err(String::from_utf8_lossy(&output.stderr).to_string());
  }
  let _ = std::fs::remove_dir_all(&worktree_path);
  Ok(())
}

#[tauri::command]
fn project_touch(state: State<'_, SharedDb>, project_id: i64, now: i64) -> Result<(), String> {
  db::touch_project(&state.0, project_id, now)
}

#[tauri::command]
fn project_rename(state: State<'_, SharedDb>, project_id: i64, name: String) -> Result<(), String> {
  db::rename_project(&state.0, project_id, name)
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(SharedCodexBridge(Arc::new(CodexBridgeState::new())))
    .setup(|app| {
      let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir failed: {e}"))?;
      std::fs::create_dir_all(&app_data_dir).map_err(|e| format!("create app_data_dir failed: {e}"))?;
      let db_path = app_data_dir.join("codex_client.db");
      db::init_db(&db_path)?;
      app.manage(SharedDb(DbPath(db_path)));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      ping,
      codex_status,
      codex_start,
      codex_stop,
      codex_initialize,
      codex_start_thread,
      codex_start_thread_sync,
      codex_list_threads,
      codex_resume_thread,
      codex_read_thread,
      codex_read_thread_sync,
      codex_start_turn,
      codex_steer_turn,
      codex_interrupt_turn,
      codex_set_thread_name,
      codex_archive_thread,
      codex_unarchive_thread,
      codex_fork_thread,
      codex_rollback_thread,
      codex_set_thread_goal,
      codex_get_thread_goal,
      codex_clear_thread_goal,
      codex_update_thread_metadata_git,
      codex_start_review_uncommitted,
      codex_list_skills,
      codex_list_mcp_servers,
      codex_mcp_read_resource,
      codex_mcp_call_tool,
      codex_command_exec,
      codex_command_exec_write,
      codex_command_exec_terminate,
      codex_command_exec_resize,
      codex_respond_to_server_request,
      codex_reject_server_request,
      git_snapshot,
      git_diff,
      git_diff_staged,
      git_stage_all,
      git_unstage_all,
      git_revert_all,
      git_commit,
      git_changed_files,
      git_stage_path,
      git_unstage_path,
      git_revert_path,
      codex_read_config,
      codex_write_config,
      terminal_run_readonly,
      codex_check,
      project_add,
      projects_list,
      sessions_for_project,
      session_upsert,
      project_rename,
      project_touch,
      worktree_create,
      worktree_remove,
    ])
    .run(tauri::generate_context!())
    .expect("failed to run codex-tauri-client");
}
