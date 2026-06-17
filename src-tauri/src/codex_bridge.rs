use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
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

#[derive(Debug)]
pub struct CodexBridgeState {
  process: Mutex<Option<CodexProcess>>,
  pending: Mutex<HashMap<u64, String>>,
  next_id: AtomicU64,
  initialized: Mutex<bool>,
  last_error: Mutex<Option<String>>,
}

impl CodexBridgeState {
  pub fn new() -> Self {
    Self {
      process: Mutex::new(None),
      pending: Mutex::new(HashMap::new()),
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

    let mut child = match Command::new("codex")
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
          "title": "Codex Tauri Client",
          "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
          "experimentalApi": true
        }
      }),
    )?;
    self.send_notification("initialized", json!({}))?;
    *self.initialized.lock().map_err(lock_error)? = true;
    Ok(id)
  }

  pub fn start_thread(&self, cwd: Option<String>, model: Option<String>) -> Result<u64, String> {
    let mut params = json!({});
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    if let Some(model) = model {
      params["model"] = Value::String(model);
    }
    self.send_request("thread/start", params)
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

  pub fn read_thread(&self, thread_id: String, include_turns: bool) -> Result<u64, String> {
    self.send_request(
      "thread/read",
      json!({
        "threadId": thread_id,
        "includeTurns": include_turns
      }),
    )
  }

  pub fn start_turn(&self, thread_id: String, text: String, cwd: Option<String>) -> Result<u64, String> {
    let mut params = json!({
      "threadId": thread_id,
      "input": [{ "type": "text", "text": text }]
    });
    if let Some(cwd) = cwd {
      params["cwd"] = Value::String(cwd);
    }
    self.send_request("turn/start", params)
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
