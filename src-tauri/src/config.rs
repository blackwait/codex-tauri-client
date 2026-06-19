use crate::paths;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexConfigSnapshot {
  pub path: String,
  pub exists: bool,
  pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClientConfig {
  #[serde(default)]
  pub infinite_retry: bool,
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

pub fn infinite_retry_enabled() -> bool {
  read_client_config().map(|config| config.infinite_retry).unwrap_or(false)
}

pub fn set_infinite_retry_enabled(enabled: bool) -> Result<ClientConfig, String> {
  let mut config = read_client_config()?;
  config.infinite_retry = enabled;
  write_client_config(&config)?;
  Ok(config)
}

fn read_client_config() -> Result<ClientConfig, String> {
  let path = paths::client_config_path()?;
  if !path.exists() {
    return Ok(ClientConfig::default());
  }
  let contents = fs::read_to_string(&path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
  serde_json::from_str(&contents).map_err(|err| format!("failed to parse {}: {err}", path.display()))
}

fn write_client_config(config: &ClientConfig) -> Result<(), String> {
  let path = paths::client_config_path()?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
  }
  let contents = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
  fs::write(&path, format!("{contents}\n")).map_err(|err| format!("failed to write {}: {err}", path.display()))
}
