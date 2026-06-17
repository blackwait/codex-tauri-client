use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
  pub status: i32,
  pub stdout: String,
  pub stderr: String,
}

pub fn run_readonly(cwd: String, command: String) -> Result<CommandOutput, String> {
  let allowed = ["pwd", "git status --short", "git branch --show-current", "ls"];
  if !allowed.iter().any(|item| *item == command) {
    return Err("command is not allowlisted for the read-only terminal helper".to_string());
  }

  let shell = if cfg!(target_os = "windows") {
    "cmd"
  } else if cfg!(target_os = "macos") {
    "zsh"
  } else {
    "sh"
  };

  let output = if cfg!(target_os = "windows") {
    Command::new(shell)
      .args(["/C", &command])
      .current_dir(cwd)
      .output()
      .map_err(|err| format!("failed to run command: {err}"))?
  } else {
    Command::new(shell)
      .arg("-lc")
      .arg(command)
      .current_dir(cwd)
      .output()
      .map_err(|err| format!("failed to run command: {err}"))?
  };

  Ok(CommandOutput {
    status: output.status.code().unwrap_or(-1),
    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
  })
}
