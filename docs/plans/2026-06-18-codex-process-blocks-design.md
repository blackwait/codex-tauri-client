# Codex Process Blocks Design

## Goal

Make the chat timeline stream assistant output while grouping tool activity into Codex-style collapsible process blocks.

## Confirmed Interaction

- Assistant text streams directly in the chat timeline.
- Process blocks are collapsed by default after completion.
- The currently running process block opens automatically.
- Expanding a process block shows concrete steps such as read files, code searches, web searches, commands, MCP calls, plans, and reasoning summaries.

## Approach

Reuse the existing `TimelineItem` event stream and `ThreadTimelineView` grouping. The app-server already emits `item/started`, `item/completed`, `item/*/delta`, and `turn/*` notifications; the frontend should summarize these into higher-level activity groups instead of rendering raw events.

## UI Shape

Each assistant turn can contain one process block before the assistant message. The header shows a concise status such as `正在搜索代码` or `已读取 3 个文件并已搜索代码`. The body uses a compact vertical list with an icon, status label, duration, and command/query/file detail. Command and tool outputs remain expandable inside the process block.

## Scope

In scope:

- `src/threadTimeline.tsx`
- `src/App.tsx`
- `src/styles.css`

Out of scope:

- New app-server protocol methods.
- Realtime audio.
- Full official Codex app automation or browser-control parity.
- Unit tests unless explicitly requested.

