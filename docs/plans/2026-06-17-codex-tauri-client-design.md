# Codex Tauri Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Tauri desktop client that drives OpenAI Codex through `codex app-server` and exposes a chat, thread, diff, terminal, and settings experience close to the official app.

**Architecture:** The Tauri backend owns Codex process lifecycle, stdio JSON-RPC transport, thread/session state, and local integration points such as Git, terminal, and config files. The frontend owns layout, conversation rendering, diff views, and user interaction, while the backend emits normalized events from `codex app-server` into the UI.

**Tech Stack:** Tauri v2, Rust, React, TypeScript, Vite, `codex app-server`, JSON-RPC over stdio, Git CLI, system shell/pty.

---

### Task 1: Scaffold the desktop app shell

**Files:**
- Create: `vibeCoding/codex-tauri-client/package.json`
- Create: `vibeCoding/codex-tauri-client/tsconfig.json`
- Create: `vibeCoding/codex-tauri-client/vite.config.ts`
- Create: `vibeCoding/codex-tauri-client/index.html`
- Create: `vibeCoding/codex-tauri-client/src/main.tsx`
- Create: `vibeCoding/codex-tauri-client/src/App.tsx`
- Create: `vibeCoding/codex-tauri-client/src/styles.css`
- Create: `vibeCoding/codex-tauri-client/src-tauri/Cargo.toml`
- Create: `vibeCoding/codex-tauri-client/src-tauri/tauri.conf.json`
- Create: `vibeCoding/codex-tauri-client/src-tauri/build.rs`
- Create: `vibeCoding/codex-tauri-client/src-tauri/src/lib.rs`
- Create: `vibeCoding/codex-tauri-client/src-tauri/src/main.rs`

**Step 1: Write the shell files**
Set up Vite + React + Tauri with a single main window and a simple dark workbench layout.

**Step 2: Add a minimal app bootstrap**
Render the app header, sidebar, center thread area, and detail pane so the client can grow without a redesign.

**Step 3: Wire the Rust entrypoints**
Expose a small set of Tauri commands for later Codex process control and keep the project runnable.

### Task 2: Implement Codex app-server bridge

**Files:**
- Create: `vibeCoding/codex-tauri-client/src-tauri/src/codex_bridge.rs`
- Modify: `vibeCoding/codex-tauri-client/src-tauri/src/lib.rs`
- Modify: `vibeCoding/codex-tauri-client/src/App.tsx`

**Step 1: Add process lifecycle management**
Start `codex app-server` with stdio transport, capture stdout/stderr, and track connection state.

**Step 2: Parse and emit JSON-RPC events**
Normalize `initialize`, `thread/*`, `turn/*`, `item/*`, and error events into UI-friendly payloads.

**Step 3: Add start/reconnect/stop commands**
Let the UI start a session, reconnect to an existing session, and stop the server cleanly.

### Task 3: Build the conversation workspace UI

**Files:**
- Modify: `vibeCoding/codex-tauri-client/src/App.tsx`
- Modify: `vibeCoding/codex-tauri-client/src/styles.css`

**Step 1: Render project and thread navigation**
Show current project, thread list, and selected thread state.

**Step 2: Render the active turn stream**
Display agent messages, reasoning summaries, tool calls, file edits, and command output.

**Step 3: Add composer and action controls**
Support prompt entry, submit, interrupt, approve/deny, and thread controls.

### Task 4: Add local workspace integrations

**Files:**
- Create: `vibeCoding/codex-tauri-client/src-tauri/src/git.rs`
- Create: `vibeCoding/codex-tauri-client/src-tauri/src/terminal.rs`
- Create: `vibeCoding/codex-tauri-client/src-tauri/src/config.rs`
- Modify: `vibeCoding/codex-tauri-client/src-tauri/src/lib.rs`
- Modify: `vibeCoding/codex-tauri-client/src/App.tsx`

**Step 1: Add Git diff helpers**
Read branch, status, and diff metadata for the review pane.

**Step 2: Add terminal session hooks**
Expose a project-scoped shell/pty session for command output and status.

**Step 3: Add config editing helpers**
Read and update Codex config files needed for models, sandbox, approvals, and MCP.

### Task 5: Add official feature parity surfaces

**Files:**
- Modify: `vibeCoding/codex-tauri-client/src/App.tsx`
- Modify: `vibeCoding/codex-tauri-client/src/styles.css`
- Create: `vibeCoding/codex-tauri-client/src/components/*`

**Step 1: Add worktree mode and handoff UX**
Let the user choose local vs worktree and show which mode each thread uses.

**Step 2: Add review pane**
Support uncommitted diff review and line-level feedback.

**Step 3: Add browser, automation, and MCP entry points**
Surface the official features as launch points and settings panels rather than reimplementing private behavior.

### Task 6: Add verification and packaging flow

**Files:**
- Modify: `vibeCoding/codex-tauri-client/package.json`
- Modify: `vibeCoding/codex-tauri-client/src-tauri/Cargo.toml`
- Modify: `vibeCoding/codex-tauri-client/src-tauri/tauri.conf.json`

**Step 1: Add build scripts**
Make the project runnable with Vite and Tauri dev commands.

**Step 2: Add non-test verification commands**
Document the exact commands to confirm the bridge, UI, and packaging surfaces start correctly.

**Step 3: Package the app**
Prepare the app for local distribution once the core flows are stable.
