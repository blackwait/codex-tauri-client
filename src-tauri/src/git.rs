use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSnapshot {
  pub is_repo: bool,
  pub branch: Option<String>,
  pub status: String,
  pub diff_stat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChangedFile {
  pub path: String,
  pub index_status: String,
  pub worktree_status: String,
}

pub fn snapshot(cwd: String) -> Result<GitSnapshot, String> {
  let is_repo = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])
    .map(|out| out.trim() == "true")
    .unwrap_or(false);

  if !is_repo {
    return Ok(GitSnapshot {
      is_repo: false,
      branch: None,
      status: String::new(),
      diff_stat: String::new(),
    });
  }

  Ok(GitSnapshot {
    is_repo,
    branch: run_git(&cwd, &["branch", "--show-current"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    status: run_git(&cwd, &["status", "--short"]).unwrap_or_default(),
    diff_stat: run_git(&cwd, &["diff", "--stat"]).unwrap_or_default(),
  })
}

pub fn diff(cwd: String) -> Result<String, String> {
  run_git(&cwd, &["diff", "--", "."])
}

pub fn diff_staged(cwd: String) -> Result<String, String> {
  run_git(&cwd, &["diff", "--cached", "--", "."])
}

pub fn stage_all(cwd: String) -> Result<(), String> {
  run_git(&cwd, &["add", "-A", "--", "."]).map(|_| ())
}

pub fn unstage_all(cwd: String) -> Result<(), String> {
  run_git(&cwd, &["reset", "--", "."]).map(|_| ())
}

pub fn revert_all(cwd: String) -> Result<(), String> {
  run_git(&cwd, &["restore", "--worktree", "--", "."]).map(|_| ())
}

pub fn commit(cwd: String, message: String) -> Result<String, String> {
  let output = Command::new("git")
    .args(["commit", "-m", &message])
    .current_dir(cwd)
    .output()
    .map_err(|err| format!("failed to run git commit: {err}"))?;
  if output.status.success() {
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(out)
  } else {
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    Err(err)
  }
}

pub fn changed_files(cwd: String) -> Result<Vec<GitChangedFile>, String> {
  let output = run_git(&cwd, &["status", "--porcelain"])?;
  Ok(output
    .lines()
    .filter_map(parse_status_line)
    .collect::<Vec<GitChangedFile>>())
}

pub fn stage_path(cwd: String, path: String) -> Result<(), String> {
  run_git(&cwd, &["add", "--", &path]).map(|_| ())
}

pub fn unstage_path(cwd: String, path: String) -> Result<(), String> {
  run_git(&cwd, &["reset", "HEAD", "--", &path]).map(|_| ())
}

pub fn revert_path(cwd: String, path: String) -> Result<(), String> {
  run_git(&cwd, &["restore", "--worktree", "--", &path]).map(|_| ())
}

fn parse_status_line(line: &str) -> Option<GitChangedFile> {
  if line.len() < 3 {
    return None;
  }
  let index_status = line.get(0..1)?.trim().to_string();
  let worktree_status = line.get(1..2)?.trim().to_string();
  let path_raw = line.get(3..)?.trim();
  if path_raw.is_empty() {
    return None;
  }
  let path = if let Some((_, rhs)) = path_raw.split_once(" -> ") {
    rhs.to_string()
  } else {
    path_raw.to_string()
  };
  Some(GitChangedFile {
    path,
    index_status,
    worktree_status,
  })
}

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
  let output = Command::new("git")
    .args(args)
    .current_dir(cwd)
    .output()
    .map_err(|err| format!("failed to run git: {err}"))?;

  if output.status.success() {
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
  } else {
    Err(String::from_utf8_lossy(&output.stderr).to_string())
  }
}
