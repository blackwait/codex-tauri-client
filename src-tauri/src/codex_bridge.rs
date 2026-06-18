use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexConnectionStatus {
  pub running: bool,
  pub initialized: bool,
  pub transport: String,
  pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcEnvelope {
  pub id: Option<u64>,
  pub method: Option<String>,
  pub request_method: Option<String>,
  pub result: Option<Value>,
  pub error: Option<Value>,
  pub params: Option<Value>,
}

#[derive(Debug)]
struct CodexProcess {
  child: Child,
  stdin: ChildStdin,
}

pub fn codex_executable() -> String {
  if let Ok(value) = std::env::var("CODEX_BIN") {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
      return trimmed.to_string();
    }
  }
  for candidate in ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"] {
    if Path::new(candidate).exists() {
      return candidate.to_string();
    }
  }
  "codex".to_string()
}

fn enriched_path() -> String {
  let current = std::env::var("PATH").unwrap_or_default();
  let mut parts = vec![
    "/usr/local/bin".to_string(),
    "/opt/homebrew/bin".to_string(),
    "/usr/bin".to_string(),
    "/bin".to_string(),
  ];
  for segment in current.split(':') {
    if segment.is_empty() {
      continue;
    }
    if !parts.iter().any(|existing| existing == segment) {
      parts.push(segment.to_string());
    }
  }
  parts.join(":")
}

pub fn codex_command() -> Command {
  let mut command = Command::new(codex_executable());
  command.env("PATH", enriched_path());
  command
}

#[derive(Debug)]
pub struct CodexBridgeState {
  process: Mutex<Option<CodexProcess>>,
  pending: Mutex<HashMap<u64, String>>,
  response_waiters: Mutex<HashMap<u64, mpsc::Sender<RpcEnvelope>>>,
  next_id: AtomicU64,
  initialized: Mutex<bool>,
  last_error: Mutex<Option<String>>,
}

impl CodexBridgeState {
  pub fn new() -> Self {
    Self {
      process: Mutex::new(None),
      pending: Mutex::new(HashMap::new()),
      response_waiters: Mutex::new(HashMap::new()),
      next_id: AtomicU64::new(1),
      initialized: Mutex::new(false),
      last_error: Mutex::new(None),
    }
  }

  pub fn status(&self) -> CodexConnectionStatus {
    CodexConnectionStatus {
      running: self.process.lock().map(|guard| guard.is_some()).unwrap_or(false),
      initialized: self.initialized.lock().map(|guard| *guard).unwrap_or(false),
      transport: "stdio-jsonl".to_string(),
      last_error: self.last_error.lock().ok().and_then(|guard| guard.clone()),
    }
  }

  pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<CodexConnectionStatus, String> {
    if self.process.lock().map_err(lock_error)?.is_some() {
      return Ok(self.status());
    }

    let mut child = match codex_command()
      .arg("app-server")
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
    {
      Ok(child) => child,
      Err(err) => {
        let msg = format!(
          "failed to start codex app-server: {err}\n\
Make sure `codex` is installed and available on PATH."
        );
        self.set_error(msg.clone());
        let _ = app.emit("codex:status", self.status());
        return Err(msg);
      }
    };

    let stdin = child
      .stdin
      .take()
      .ok_or_else(|| "failed to open codex app-server stdin".to_string())?;
    let stdout = child
      .stdout
      .take()
      .ok_or_else(|| "failed to open codex app-server stdout".to_string())?;
    let stderr = child
      .stderr
      .take()
      .ok_or_else(|| "failed to open codex app-server stderr".to_string())?;

    {
      let mut guard = self.process.lock().map_err(lock_error)?;
      *guard = Some(CodexProcess { child, stdin });
    }
    *self.initialized.lock().map_err(lock_error)? = false;
    *self.last_error.lock().map_err(lock_error)? = None;

    let state_for_stdout = Arc::clone(self);
    let app_for_stdout = app.clone();
    thread::spawn(move || {
      let reader = BufReader::new(stdout);
      for line in reader.lines() {
        match line {
          Ok(line) if !line.trim().is_empty() => {
            state_for_stdout.handle_stdout_line(&app_for_stdout, line);
          }
          Ok(_) => {}
          Err(err) => {
            state_for_stdout.set_error(format!("codex stdout read failed: {err}"));
            let _ = app_for_stdout.emit("codex:status", state_for_stdout.status());
            break;
          }
        }
      }
      state_for_stdout.mark_stopped();
      let _ = app_for_stdout.emit("codex:status", state_for_stdout.status());
    });

    let state_for_stderr = Arc::clone(self);
    let app_for_stderr = app.clone();
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines().map_while(Result::ok) {
        if !line.trim().is_empty() {
          let payload = json!({ "line": line });
          let _ = app_for_stderr.emit("codex:stderr", payload);
        }
      }
      let _ = app_for_stderr.emit("codex:status", state_for_stderr.status());
    });

    let status = self.status();
    let _ = app.emit("codex:status", &status);
    Ok(status)
  }

  pub fn stop(&self) -> Result<CodexConnectionStatus, String> {
    let mut guard = self.process.lock().map_err(lock_error)?;
    if let Some(mut process) = guard.take() {
      let _ = process.child.kill();
      let _ = process.child.wait();
    }
    *self.initialized.lock().map_err(lock_error)? = false;
    Ok(self.status())
  }

  pub fn initialize(&self, client_name: Option<String>) -> Result<u64, String> {
    let name = client_name.unwrap_or_else(|| "codex_tauri_client".to_string());
    let id = self.send_request(
      "initialize",
      json!({
        "clientInfo": {
          "name": name,
          "title": "鱼泡codex",
          "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
          "experimentalApi": true,
          "requestAttestation": false,
          "optOutNotificationMethods": [
            "mcpServer/startupStatus/updated",
            "remoteControl/status/changed"
          ]
        }
      }),
    )?;
    self.send_notification("initialized", json!({}))?;
    *self.initialized.lock().map_err(lock_error)? = true;
    Ok(id)
  }

  pub fn start_thread(
    &self,
    cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox: Option<String>,
  ) -> Result<u64, String> {
    self.send_thread_start(cwd, model, approval_policy, approvals_reviewer, sandbox)
  }

  pub fn start_thread_sync(
    &self,
    cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox: Option<String>,
    timeout_secs: u64,
  ) -> Result<String, String> {
    let params = self.thread_start_params(cwd, model, approval_policy, approvals_reviewer, sandbox);
    let rx = self.send_request_with_waiter("thread/start", params)?;
    let envelope = rx
      .recv_timeout(Duration::from_secs(timeout_secs))
      .map_err(|_| format!("thread/start timed out after {timeout_secs}s"))?;
    thread_id_from_envelope(&envelope)
  }

  fn send_thread_start(
    &self,
    cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox: Option<String>,
  ) -> Result<u64, String> {
    let params = self.thread_start_params(cwd, model, approval_policy, approvals_reviewer, sandbox);
    self.send_request("thread/start", params)
  }

  fn thread_start_params(
    &self,
    cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox: Option<String>,
  ) -> Value {
    let mut params = json!({
      "developerInstructions": "你是企业聊天客户端。优先直接回答用户问题；仅在用户明确要求时使用技能、工具或 MCP。简单对话不要加载或执行技能流程。",
      "personality": "pragmatic"
    });
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    if let Some(model) = model {
      params["model"] = Value::String(model);
    }
    if let Some(approval_policy) = approval_policy {
      params["approvalPolicy"] = approval_policy;
    }
    if let Some(approvals_reviewer) = approvals_reviewer {
      params["approvalsReviewer"] = Value::String(approvals_reviewer);
    }
    if let Some(sandbox) = sandbox {
      params["sandbox"] = Value::String(sandbox);
    }
    params
  }

  pub fn list_threads(&self, cwd: Option<String>, search_term: Option<String>) -> Result<u64, String> {
    let mut params = json!({
      "limit": 50,
      "sortKey": "updated_at",
      "sortDirection": "desc",
      "archived": false
    });
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    if let Some(search_term) = search_term {
      if !search_term.trim().is_empty() {
        params["searchTerm"] = Value::String(search_term);
      }
    }
    self.send_request("thread/list", params)
  }

  pub fn resume_thread(&self, thread_id: String) -> Result<u64, String> {
    self.send_request("thread/resume", json!({ "threadId": thread_id }))
  }

  pub fn resume_thread_sync(&self, thread_id: String, timeout_secs: u64) -> Result<String, String> {
    let rx = self.send_request_with_waiter("thread/resume", json!({ "threadId": thread_id }))?;
    let envelope = rx
      .recv_timeout(Duration::from_secs(timeout_secs))
      .map_err(|_| format!("thread/resume timed out after {timeout_secs}s"))?;
    if let Some(error) = &envelope.error {
      return Err(error.to_string());
    }
    Ok(thread_id)
  }

  pub fn read_thread(&self, thread_id: String, include_turns: bool) -> Result<u64, String> {
    self.send_request(
      "thread/read",
      json!({
        "threadId": thread_id,
        "includeTurns": include_turns
      }),
    )
  }

  pub fn read_thread_sync(&self, thread_id: String, include_turns: bool, timeout_secs: u64) -> Result<Value, String> {
    let rx = self.send_request_with_waiter(
      "thread/read",
      json!({
        "threadId": thread_id,
        "includeTurns": include_turns
      }),
    )?;
    let envelope = rx
      .recv_timeout(Duration::from_secs(timeout_secs))
      .map_err(|_| format!("thread/read timed out after {timeout_secs}s"))?;
    if let Some(error) = &envelope.error {
      return Err(error.to_string());
    }
    envelope
      .result
      .ok_or_else(|| "thread/read returned no result".to_string())
  }

  pub fn start_turn(
    &self,
    thread_id: String,
    text: Option<String>,
    input: Option<Value>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox_policy: Option<Value>,
  ) -> Result<u64, String> {
    let params = Self::turn_start_params(
      thread_id,
      text,
      input,
      cwd,
      model,
      effort,
      approval_policy,
      approvals_reviewer,
      sandbox_policy,
    )?;
    self.send_request("turn/start", params)
  }

  fn turn_start_params(
    thread_id: String,
    text: Option<String>,
    input: Option<Value>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox_policy: Option<Value>,
  ) -> Result<Value, String> {
    let input_value = if let Some(input) = input {
      input
    } else if let Some(text) = text {
      json!([{ "type": "text", "text": text, "text_elements": [] }])
    } else {
      return Err("turn/start requires text or input".to_string());
    };

    let mut params = json!({
      "threadId": thread_id,
      "input": input_value,
      "developerInstructions": "优先直接回答。仅在用户明确要求时使用技能、工具或 MCP。"
    });
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    if let Some(model) = model {
      params["model"] = Value::String(model);
    }
    if let Some(effort) = effort {
      params["effort"] = Value::String(effort);
    }
    if let Some(approval_policy) = approval_policy {
      params["approvalPolicy"] = approval_policy;
    }
    if let Some(approvals_reviewer) = approvals_reviewer {
      params["approvalsReviewer"] = Value::String(approvals_reviewer);
    }
    if let Some(sandbox_policy) = sandbox_policy {
      params["sandboxPolicy"] = sandbox_policy;
    }
    Ok(params)
  }

  pub fn start_turn_sync(
    &self,
    thread_id: String,
    text: Option<String>,
    input: Option<Value>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    approval_policy: Option<Value>,
    approvals_reviewer: Option<String>,
    sandbox_policy: Option<Value>,
    timeout_secs: u64,
  ) -> Result<Value, String> {
    let params = Self::turn_start_params(
      thread_id,
      text,
      input,
      cwd,
      model,
      effort,
      approval_policy,
      approvals_reviewer,
      sandbox_policy,
    )?;
    let rx = self.send_request_with_waiter("turn/start", params)?;
    let envelope = rx
      .recv_timeout(Duration::from_secs(timeout_secs))
      .map_err(|_| format!("turn/start timed out after {timeout_secs}s"))?;
    if let Some(error) = &envelope.error {
      return Err(error.to_string());
    }
    Ok(envelope.result.unwrap_or(Value::Null))
  }

  pub fn update_thread_settings(
    &self,
    thread_id: String,
    thread_settings: Value,
    timeout_secs: u64,
  ) -> Result<Value, String> {
    let mut params = match thread_settings {
      Value::Object(map) => map,
      _ => serde_json::Map::new(),
    };
    params.insert("threadId".to_string(), Value::String(thread_id));
    let request_id = self.send_request("thread/settings/update", Value::Object(params))?;
    let (tx, rx) = mpsc::channel();
    self
      .response_waiters
      .lock()
      .map_err(lock_error)?
      .insert(request_id, tx);
    let envelope = rx
      .recv_timeout(Duration::from_secs(timeout_secs))
      .map_err(|_| format!("thread/settings/update timed out after {timeout_secs}s"))?;
    if let Some(error) = &envelope.error {
      return Err(error.to_string());
    }
    envelope
      .result
      .ok_or_else(|| "thread/settings/update returned no result".to_string())
  }

  pub fn list_models_sync(&self, timeout_secs: u64) -> Result<Value, String> {
    let request_id = self.send_request("model/list", json!({ "limit": 50 }))?;
    let (tx, rx) = mpsc::channel();
    self
      .response_waiters
      .lock()
      .map_err(lock_error)?
      .insert(request_id, tx);
    let envelope = rx
      .recv_timeout(Duration::from_secs(timeout_secs))
      .map_err(|_| format!("model/list timed out after {timeout_secs}s"))?;
    if let Some(error) = &envelope.error {
      return Err(error.to_string());
    }
    envelope
      .result
      .ok_or_else(|| "model/list returned no result".to_string())
  }

  pub fn steer_turn(&self, thread_id: String, text: String) -> Result<u64, String> {
    self.send_request(
      "turn/steer",
      json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": text }]
      }),
    )
  }

  pub fn interrupt_turn(&self, thread_id: String) -> Result<u64, String> {
    self.send_request("turn/interrupt", json!({ "threadId": thread_id }))
  }

  pub fn set_thread_name(&self, thread_id: String, name: String) -> Result<u64, String> {
    self.send_request("thread/name/set", json!({ "threadId": thread_id, "name": name }))
  }

  pub fn archive_thread(&self, thread_id: String) -> Result<u64, String> {
    self.send_request("thread/archive", json!({ "threadId": thread_id }))
  }

  pub fn unarchive_thread(&self, thread_id: String) -> Result<u64, String> {
    self.send_request("thread/unarchive", json!({ "threadId": thread_id }))
  }

  pub fn fork_thread(&self, thread_id: String, cwd: Option<String>) -> Result<u64, String> {
    let mut params = json!({ "threadId": thread_id });
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    self.send_request("thread/fork", params)
  }

  pub fn rollback_thread(&self, thread_id: String, num_turns: u64) -> Result<u64, String> {
    self.send_request("thread/rollback", json!({ "threadId": thread_id, "numTurns": num_turns }))
  }

  pub fn set_thread_goal(
    &self,
    thread_id: String,
    objective: Option<String>,
    status: Option<String>,
    token_budget: Option<u64>,
  ) -> Result<u64, String> {
    let mut params = json!({ "threadId": thread_id });
    if let Some(objective) = objective {
      params["objective"] = Value::String(objective);
    }
    if let Some(status) = status {
      params["status"] = Value::String(status);
    }
    if let Some(token_budget) = token_budget {
      params["tokenBudget"] = Value::Number(token_budget.into());
    }
    self.send_request("thread/goal/set", params)
  }

  pub fn get_thread_goal(&self, thread_id: String) -> Result<u64, String> {
    self.send_request("thread/goal/get", json!({ "threadId": thread_id }))
  }

  pub fn clear_thread_goal(&self, thread_id: String) -> Result<u64, String> {
    self.send_request("thread/goal/clear", json!({ "threadId": thread_id }))
  }

  pub fn update_thread_metadata_git(
    &self,
    thread_id: String,
    sha: Option<String>,
    branch: Option<String>,
    origin_url: Option<String>,
    clear_sha: bool,
    clear_branch: bool,
    clear_origin_url: bool,
  ) -> Result<u64, String> {
    let mut git_info = json!({});
    if clear_sha {
      git_info["sha"] = Value::Null;
    } else if let Some(sha) = sha {
      git_info["sha"] = Value::String(sha);
    }
    if clear_branch {
      git_info["branch"] = Value::Null;
    } else if let Some(branch) = branch {
      git_info["branch"] = Value::String(branch);
    }
    if clear_origin_url {
      git_info["originUrl"] = Value::Null;
    } else if let Some(origin_url) = origin_url {
      git_info["originUrl"] = Value::String(origin_url);
    }
    self.send_request(
      "thread/metadata/update",
      json!({
        "threadId": thread_id,
        "gitInfo": git_info
      }),
    )
  }

  pub fn start_review_uncommitted(&self, thread_id: String) -> Result<u64, String> {
    self.send_request(
      "review/start",
      json!({
        "threadId": thread_id,
        "target": { "type": "uncommittedChanges" }
      }),
    )
  }

  pub fn list_skills(&self, cwd: Option<String>, force_reload: bool) -> Result<u64, String> {
    let cwds = cwd.map(|value| vec![value]).unwrap_or_default();
    self.send_request("skills/list", json!({ "cwds": cwds, "forceReload": force_reload }))
  }

  pub fn list_mcp_servers(&self, thread_id: Option<String>) -> Result<u64, String> {
    let mut params = json!({ "limit": 100, "detail": "full" });
    if let Some(thread_id) = thread_id {
      params["threadId"] = Value::String(thread_id);
    }
    self.send_request("mcpServerStatus/list", params)
  }

  pub fn mcp_read_resource(&self, thread_id: Option<String>, server: String, uri: String) -> Result<u64, String> {
    let mut params = json!({
      "server": server,
      "uri": uri
    });
    if let Some(thread_id) = thread_id {
      params["threadId"] = Value::String(thread_id);
    }
    self.send_request("mcpServer/resource/read", params)
  }

  pub fn mcp_call_tool(
    &self,
    thread_id: String,
    server: String,
    tool: String,
    arguments: Option<Value>,
  ) -> Result<u64, String> {
    let mut params = json!({
      "threadId": thread_id,
      "server": server,
      "tool": tool
    });
    if let Some(arguments) = arguments {
      params["arguments"] = arguments;
    }
    self.send_request("mcpServer/tool/call", params)
  }

  pub fn command_exec(
    &self,
    process_id: String,
    command: Vec<String>,
    cwd: Option<String>,
    tty: bool,
    cols: Option<u64>,
    rows: Option<u64>,
  ) -> Result<u64, String> {
    let mut params = json!({
      "processId": process_id,
      "command": command,
      "tty": tty,
      "streamStdin": true,
      "streamStdoutStderr": true
    });
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    if tty {
      if let (Some(cols), Some(rows)) = (cols, rows) {
        params["size"] = json!({
          "cols": cols,
          "rows": rows
        });
      }
    }
    self.send_request("command/exec", params)
  }

  pub fn command_exec_write(
    &self,
    process_id: String,
    delta_base64: Option<String>,
    close_stdin: bool,
  ) -> Result<u64, String> {
    let mut params = json!({
      "processId": process_id,
      "closeStdin": close_stdin
    });
    if let Some(delta_base64) = delta_base64 {
      params["deltaBase64"] = Value::String(delta_base64);
    }
    self.send_request("command/exec/write", params)
  }

  pub fn command_exec_terminate(&self, process_id: String) -> Result<u64, String> {
    self.send_request("command/exec/terminate", json!({ "processId": process_id }))
  }

  pub fn command_exec_resize(&self, process_id: String, cols: u64, rows: u64) -> Result<u64, String> {
    self.send_request(
      "command/exec/resize",
      json!({
        "processId": process_id,
        "size": {
          "cols": cols,
          "rows": rows
        }
      }),
    )
  }

  pub fn respond_to_server_request(&self, id: u64, result: Value) -> Result<(), String> {
    self.write_message(json!({ "id": id, "result": result }))
  }

  pub fn reject_server_request(&self, id: u64, message: String) -> Result<(), String> {
    self.write_message(json!({ "id": id, "error": { "code": -32000, "message": message } }))
  }

  fn send_request(&self, method: &str, params: Value) -> Result<u64, String> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    self
      .pending
      .lock()
      .map_err(lock_error)?
      .insert(id, method.to_string());
    self.write_message(json!({ "id": id, "method": method, "params": params }))?;
    Ok(id)
  }

  fn send_request_with_waiter(&self, method: &str, params: Value) -> Result<mpsc::Receiver<RpcEnvelope>, String> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    self
      .pending
      .lock()
      .map_err(lock_error)?
      .insert(id, method.to_string());
    self
      .response_waiters
      .lock()
      .map_err(lock_error)?
      .insert(id, tx);
    if let Err(error) = self.write_message(json!({ "id": id, "method": method, "params": params })) {
      if let Ok(mut pending) = self.pending.lock() {
        pending.remove(&id);
      }
      if let Ok(mut waiters) = self.response_waiters.lock() {
        waiters.remove(&id);
      }
      return Err(error);
    }
    Ok(rx)
  }

  fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
    self.write_message(json!({ "method": method, "params": params }))
  }

  fn write_message(&self, message: Value) -> Result<(), String> {
    let mut guard = self.process.lock().map_err(lock_error)?;
    let process = guard
      .as_mut()
      .ok_or_else(|| "codex app-server is not running".to_string())?;
    let mut line = serde_json::to_vec(&message).map_err(|err| err.to_string())?;
    line.push(b'\n');
    process
      .stdin
      .write_all(&line)
      .and_then(|_| process.stdin.flush())
      .map_err(|err| format!("failed to write to codex app-server: {err}"))
  }

  fn handle_stdout_line(&self, app: &AppHandle, line: String) {
    match serde_json::from_str::<RpcEnvelope>(&line) {
      Ok(mut envelope) => {
        if let Some(id) = envelope.id {
          if let Ok(mut waiters) = self.response_waiters.lock() {
            if let Some(tx) = waiters.remove(&id) {
              let _ = tx.send(envelope.clone());
            }
          }
          if let Ok(mut pending) = self.pending.lock() {
            envelope.request_method = pending.remove(&id);
          }
        }
        let _ = app.emit("codex:message", envelope);
      }
      Err(err) => {
        let payload = json!({ "line": line, "error": err.to_string() });
        let _ = app.emit("codex:unparsed", payload);
      }
    }
  }

  fn set_error(&self, error: String) {
    if let Ok(mut guard) = self.last_error.lock() {
      *guard = Some(error);
    }
  }

  fn mark_stopped(&self) {
    if let Ok(mut guard) = self.process.lock() {
      *guard = None;
    }
    if let Ok(mut guard) = self.initialized.lock() {
      *guard = false;
    }
  }
}

fn lock_error<T>(err: std::sync::PoisonError<T>) -> String {
  format!("internal lock poisoned: {err}")
}

fn thread_id_from_envelope(envelope: &RpcEnvelope) -> Result<String, String> {
  if let Some(error) = &envelope.error {
    return Err(error.to_string());
  }
  let result = envelope.result.as_ref().ok_or_else(|| "thread/start returned no result".to_string())?;
  if let Some(thread) = result.get("thread") {
    if let Some(id) = thread.get("id").and_then(|value| value.as_str()) {
      return Ok(id.to_string());
    }
  }
  if let Some(id) = result.get("threadId").and_then(|value| value.as_str()) {
    return Ok(id.to_string());
  }
  Err(format!("thread/start result missing thread id: {result}"))
}
