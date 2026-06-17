# Codex Tauri Client

A local desktop shell for OpenAI Codex built with Tauri, React, and Rust.

The app is designed to talk to the official `codex app-server` instead of
reimplementing the Codex agent. The current bridge uses the official default
transport: JSON-RPC style messages over stdio JSONL.

## Current Scope

- Start and stop `codex app-server` from the Tauri backend.
- Send `initialize` and `initialized`.
- Request `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and
  `turn/interrupt`.
- Stream app-server stdout JSON messages into the UI through Tauri events.
- Surface stderr and unparsed output in the conversation timeline.
- Provide first-pass project, thread, session, and feature-surface panels.
- Provide read-only helpers for Git status/diff, Codex config, and allowlisted
  terminal commands.
- Generate the installed Codex app-server TypeScript schema under
  `src/generated/codex-app-server`.

## Run

```bash
npm install
npm run tauri:dev
```

Plain browser preview is available with:

```bash
npm run dev
```

The browser preview cannot call Tauri commands, so it shows a preview-only
notice. Use `npm run tauri:dev` for the live Codex bridge.

## Verification

```bash
npm run build
cd src-tauri && cargo check
```

These are build and compile checks, not unit tests.

## Official Protocol Notes

OpenAI documents `codex app-server` as the interface used to power rich clients.
The protocol uses JSON-RPC 2.0 style messages with the `"jsonrpc":"2.0"` header
omitted on the wire.

Supported transports include:

- `stdio://` as the default JSONL transport.
- `ws://IP:PORT` as experimental WebSocket transport.
- `unix://` or `unix://PATH` for WebSocket over a Unix socket.

The Tauri client currently uses `stdio://` because it is the default and does
not expose a local port.

## Generated Protocol Surface

Generate bindings from the installed `codex` binary:

```bash
codex app-server generate-ts --out src/generated/codex-app-server
```

The generated schema confirms the current rich-client surface includes
`thread/start`, `thread/list`, `thread/read`, `turn/start`, `turn/steer`,
`turn/interrupt`, `review/start`, `command/exec`, `config/read`, config writes,
MCP status/resource/tool calls, skills, plugins, app list, file-system helpers,
and server-side approval requests.

Important server request methods for approval UI:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `applyPatchApproval`
- `execCommandApproval`

## Next Implementation Slices

- Replace loose `unknown` UI payloads with generated protocol types.
- Add robust request/response correlation so thread creation can queue and send
  the first turn after the real thread id is received.
- Add approval request UI once the exact notification shape is confirmed.
- Add Git review pane with staged/unstaged diff views.
- Add managed worktree creation and cleanup.
- Add MCP settings management by editing `~/.codex/config.toml`.
- Add browser preview and annotation surfaces.
