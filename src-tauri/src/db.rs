use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct DbPath(pub PathBuf);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRow {
  pub id: i64,
  pub path: String,
  pub name: String,
  pub created_at: i64,
  pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
  pub id: i64,
  pub project_id: i64,
  pub thread_id: String,
  pub mode: Option<String>,
  pub worktree_path: Option<String>,
  pub title: Option<String>,
  pub updated_at: Option<i64>,
  pub status: Option<String>,
  pub pinned: bool,
}

fn open_conn(db_path: &Path) -> Result<Connection, String> {
  Connection::open(db_path).map_err(|e| format!("open sqlite failed: {e}"))
}

pub fn init_db(db_path: &Path) -> Result<(), String> {
  let conn = open_conn(db_path)?;
  conn
    .execute_batch(
      r#"
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  mode TEXT,
  worktree_path TEXT,
  title TEXT,
  updated_at INTEGER,
  status TEXT,
  UNIQUE(project_id, thread_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
  ON sessions(project_id, updated_at DESC);
"#,
    )
    .map_err(|e| format!("init sqlite schema failed: {e}"))?;

  // Best-effort migrations for older DBs
  let _ = conn.execute("ALTER TABLE projects ADD COLUMN last_opened_at INTEGER", []);
  let _ = conn.execute("ALTER TABLE sessions ADD COLUMN mode TEXT", []);
  let _ = conn.execute("ALTER TABLE sessions ADD COLUMN worktree_path TEXT", []);
  let _ = conn.execute("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", []);
  let _ = conn.execute("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", []);

  Ok(())
}

pub fn rename_project(db: &DbPath, project_id: i64, name: String) -> Result<(), String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("项目名称不能为空".to_string());
  }
  let conn = open_conn(&db.0)?;
  conn
    .execute("UPDATE projects SET name=?2 WHERE id=?1", params![project_id, trimmed])
    .map_err(|e| format!("rename project failed: {e}"))?;
  Ok(())
}

pub fn set_project_pinned(db: &DbPath, project_id: i64, pinned: bool) -> Result<ProjectRow, String> {
  let conn = open_conn(&db.0)?;
  let pinned_value = if pinned { 1 } else { 0 };
  let updated = conn
    .execute(
      "UPDATE projects SET pinned=?2 WHERE id=?1",
      params![project_id, pinned_value],
    )
    .map_err(|e| format!("set project pinned failed: {e}"))?;
  if updated == 0 {
    return Err("project not found".to_string());
  }
  get_project_by_id(db, project_id)
}

pub fn remove_project(db: &DbPath, project_id: i64) -> Result<(), String> {
  let conn = open_conn(&db.0)?;
  conn
    .execute("DELETE FROM projects WHERE id=?1", params![project_id])
    .map_err(|e| format!("remove project failed: {e}"))?;
  Ok(())
}

fn get_project_by_id(db: &DbPath, project_id: i64) -> Result<ProjectRow, String> {
  let conn = open_conn(&db.0)?;
  conn
    .query_row(
      "SELECT id, path, name, created_at, pinned FROM projects WHERE id=?1",
      params![project_id],
      |row| map_project_row(row),
    )
    .map_err(|e| format!("project not found: {e}"))
}

fn map_project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
  Ok(ProjectRow {
    id: row.get(0)?,
    path: row.get(1)?,
    name: row.get(2)?,
    created_at: row.get(3)?,
    pinned: row.get::<_, i64>(4)? != 0,
  })
}

fn normalize_path(raw: &str) -> Result<String, String> {
  let p = Path::new(raw);
  if !p.is_absolute() {
    return Err("project path must be absolute".to_string());
  }
  Ok(p.to_string_lossy().to_string())
}

fn default_project_name(path: &str) -> String {
  Path::new(path)
    .file_name()
    .map(|s| s.to_string_lossy().to_string())
    .filter(|s| !s.trim().is_empty())
    .unwrap_or_else(|| path.to_string())
}

pub fn add_project(db: &DbPath, path: String, name: Option<String>, now: i64) -> Result<ProjectRow, String> {
  let path = normalize_path(&path)?;
  let p = Path::new(&path);
  if !p.exists() {
    return Err(format!("目录不存在: {path}"));
  }
  if !p.is_dir() {
    return Err(format!("路径不是文件夹: {path}"));
  }
  let display_name = name.clone().unwrap_or_else(|| default_project_name(&path));

  let conn = open_conn(&db.0)?;
  conn
    .execute(
      "INSERT OR IGNORE INTO projects(path, name, created_at) VALUES (?1, ?2, ?3)",
      params![path, display_name, now],
    )
    .map_err(|e| format!("insert project failed: {e}"))?;

  // If it already existed, update name only if caller provided an explicit name.
  if let Some(explicit) = name {
    conn
      .execute("UPDATE projects SET name=?2 WHERE path=?1", params![path, explicit])
      .map_err(|e| format!("update project name failed: {e}"))?;
  }

  get_project_by_path(db, &path)
}

pub fn list_projects(db: &DbPath) -> Result<Vec<ProjectRow>, String> {
  let conn = open_conn(&db.0)?;
  let mut stmt = conn
    .prepare(
      "SELECT id, path, name, created_at, pinned FROM projects ORDER BY pinned DESC, COALESCE(last_opened_at, created_at) DESC",
    )
    .map_err(|e| format!("prepare list projects failed: {e}"))?;
  let rows = stmt
    .query_map([], map_project_row)
    .map_err(|e| format!("query list projects failed: {e}"))?;
  Ok(rows.filter_map(Result::ok).collect())
}

pub fn get_project_by_path(db: &DbPath, path: &str) -> Result<ProjectRow, String> {
  let conn = open_conn(&db.0)?;
  conn
    .query_row(
      "SELECT id, path, name, created_at, pinned FROM projects WHERE path=?1",
      params![path],
      map_project_row,
    )
    .map_err(|e| format!("project not found: {e}"))
}

pub fn upsert_session(
  db: &DbPath,
  project_id: i64,
  thread_id: String,
  mode: Option<String>,
  worktree_path: Option<String>,
  title: Option<String>,
  updated_at: Option<i64>,
  status: Option<String>,
) -> Result<SessionRow, String> {
  let conn = open_conn(&db.0)?;
  conn
    .execute(
      r#"
INSERT INTO sessions(project_id, thread_id, mode, worktree_path, title, updated_at, status)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(project_id, thread_id) DO UPDATE SET
  mode=COALESCE(excluded.mode, sessions.mode),
  worktree_path=COALESCE(excluded.worktree_path, sessions.worktree_path),
  title=COALESCE(excluded.title, sessions.title),
  updated_at=COALESCE(excluded.updated_at, sessions.updated_at),
  status=COALESCE(excluded.status, sessions.status)
"#,
      params![project_id, thread_id, mode, worktree_path, title, updated_at, status],
    )
    .map_err(|e| format!("upsert session failed: {e}"))?;

  conn
    .query_row(
      "SELECT id, project_id, thread_id, mode, worktree_path, title, updated_at, status, pinned FROM sessions WHERE project_id=?1 AND thread_id=?2",
      params![project_id, thread_id],
      |row| {
        Ok(SessionRow {
          id: row.get(0)?,
          project_id: row.get(1)?,
          thread_id: row.get(2)?,
          mode: row.get(3)?,
          worktree_path: row.get(4)?,
          title: row.get(5)?,
          updated_at: row.get(6)?,
          status: row.get(7)?,
          pinned: row.get::<_, i64>(8)? != 0,
        })
      },
    )
    .map_err(|e| format!("read session after upsert failed: {e}"))
}

pub fn list_sessions_for_project(db: &DbPath, project_id: i64) -> Result<Vec<SessionRow>, String> {
  let conn = open_conn(&db.0)?;
  let mut stmt = conn
    .prepare(
      "SELECT id, project_id, thread_id, mode, worktree_path, title, updated_at, status, pinned FROM sessions WHERE project_id=?1 ORDER BY pinned DESC, COALESCE(updated_at, 0) DESC, id DESC",
    )
    .map_err(|e| format!("prepare list sessions failed: {e}"))?;
  let rows = stmt
    .query_map(params![project_id], |row| {
      Ok(SessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        thread_id: row.get(2)?,
        mode: row.get(3)?,
        worktree_path: row.get(4)?,
        title: row.get(5)?,
        updated_at: row.get(6)?,
        status: row.get(7)?,
        pinned: row.get::<_, i64>(8)? != 0,
      })
    })
    .map_err(|e| format!("query list sessions failed: {e}"))?;
  Ok(rows.filter_map(Result::ok).collect())
}

pub fn set_session_pinned(
  db: &DbPath,
  project_id: i64,
  thread_id: String,
  pinned: bool,
) -> Result<SessionRow, String> {
  let conn = open_conn(&db.0)?;
  let pinned_value = if pinned { 1 } else { 0 };
  let updated = conn
    .execute(
      "UPDATE sessions SET pinned=?3 WHERE project_id=?1 AND thread_id=?2",
      params![project_id, thread_id, pinned_value],
    )
    .map_err(|e| format!("set session pinned failed: {e}"))?;
  if updated == 0 {
    return Err("session not found".to_string());
  }
  conn
    .query_row(
      "SELECT id, project_id, thread_id, mode, worktree_path, title, updated_at, status, pinned FROM sessions WHERE project_id=?1 AND thread_id=?2",
      params![project_id, thread_id],
      |row| {
        Ok(SessionRow {
          id: row.get(0)?,
          project_id: row.get(1)?,
          thread_id: row.get(2)?,
          mode: row.get(3)?,
          worktree_path: row.get(4)?,
          title: row.get(5)?,
          updated_at: row.get(6)?,
          status: row.get(7)?,
          pinned: row.get::<_, i64>(8)? != 0,
        })
      },
    )
    .map_err(|e| format!("read session after pin failed: {e}"))
}

pub fn delete_session(db: &DbPath, project_id: i64, thread_id: String) -> Result<(), String> {
  let conn = open_conn(&db.0)?;
  conn
    .execute(
      "DELETE FROM sessions WHERE project_id=?1 AND thread_id=?2",
      params![project_id, thread_id],
    )
    .map_err(|e| format!("delete session failed: {e}"))?;
  Ok(())
}

pub fn touch_project(db: &DbPath, project_id: i64, now: i64) -> Result<(), String> {
  let conn = open_conn(&db.0)?;
  let _ = conn.execute("ALTER TABLE projects ADD COLUMN last_opened_at INTEGER", []);
  conn
    .execute("UPDATE projects SET last_opened_at=?2 WHERE id=?1", params![project_id, now])
    .map_err(|e| format!("touch project failed: {e}"))?;
  Ok(())
}

pub fn clear_session_worktree(db: &DbPath, project_id: i64, thread_id: String) -> Result<(), String> {
  let conn = open_conn(&db.0)?;
  conn
    .execute(
      "UPDATE sessions SET mode='local', worktree_path=NULL WHERE project_id=?1 AND thread_id=?2",
      params![project_id, thread_id],
    )
    .map_err(|e| format!("clear session worktree failed: {e}"))?;
  Ok(())
}

