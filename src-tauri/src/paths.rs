use std::path::PathBuf;

pub fn home_dir() -> Result<PathBuf, String> {
  if let Ok(home) = std::env::var("HOME") {
    if !home.trim().is_empty() {
      return Ok(PathBuf::from(home));
    }
  }
  if let Ok(userprofile) = std::env::var("USERPROFILE") {
    if !userprofile.trim().is_empty() {
      return Ok(PathBuf::from(userprofile));
    }
  }
  Err("could not resolve home directory (HOME/USERPROFILE)".to_string())
}

pub fn codex_config_path() -> Result<PathBuf, String> {
  if let Ok(codex_home) = std::env::var("CODEX_HOME") {
    if !codex_home.trim().is_empty() {
      return Ok(PathBuf::from(codex_home).join("config.toml"));
    }
  }
  Ok(home_dir()?.join(".codex").join("config.toml"))
}

pub fn client_config_path() -> Result<PathBuf, String> {
  Ok(home_dir()?.join(".codex-tauri-client").join("config.json"))
}
