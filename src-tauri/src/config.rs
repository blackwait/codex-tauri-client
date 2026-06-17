use crate::paths;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexConfigSnapshot {
  pub path: String,
  pub exists: bool,
  pub contents: String,
}

pub fn read_config() -> Result<CodexConfigSnapshot, String> {
  let path = paths::codex_config_path()?;
  let exists = path.exists();
  let contents = if exists {
    fs::read_to_string(&path).map_err(|err| format!("failed to read {}: {err}", path.display()))?
  } else {
    String::new()
  };

  Ok(CodexConfigSnapshot {
    path: path.display().to_string(),
    exists,
    contents,
  })
}

pub fn write_config(contents: String) -> Result<CodexConfigSnapshot, String> {
  let path = paths::codex_config_path()?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
  }
  fs::write(&path, &contents).map_err(|err| format!("failed to write {}: {err}", path.display()))?;
  read_config()
}
