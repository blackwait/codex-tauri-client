# Codex Process Blocks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render Codex-style streaming process blocks in the chat timeline.

**Architecture:** Keep app-server transport unchanged. Normalize existing `TimelineItem` tool events into activity summaries in `threadTimeline.tsx`, and enrich `App.tsx` event mapping enough to distinguish reads, searches, web searches, commands, MCP calls, planning, and reasoning. Use CSS-only compact disclosure styling.

**Tech Stack:** React, TypeScript, lucide-react, existing Tauri app-server event stream.

---

### Task 1: Enrich Tool Event Metadata

**Files:**
- Modify: `src/App.tsx`

**Steps:**
1. Add helper functions to classify `dynamicToolCall` names into activity labels.
2. Preserve tool name in `command` and keep arguments/result in `body`.
3. Ensure started/completed events keep `turnIndex`, `startedAt`, `completedAt`, and `durationMs`.
4. Do not change backend protocol calls.

### Task 2: Build Process Block Summaries

**Files:**
- Modify: `src/threadTimeline.tsx`

**Steps:**
1. Add tool category helpers for read/search/web/command/mcp/reasoning/plan/file change.
2. Replace separate command-only disclosure with one process block.
3. Keep process block collapsed by default and auto-open while any contained tool is running.
4. Render each activity as a compact row with icon, title, detail, and optional duration.

### Task 3: Style Codex-Like Process Blocks

**Files:**
- Modify: `src/styles.css`

**Steps:**
1. Add subdued process block header and rows.
2. Keep text dense and readable in the existing dark/neutral theme.
3. Avoid nested card styling; use lightweight rows and disclosure bodies.

### Task 4: Verify

**Files:**
- Read: `src/threadTimeline.tsx`
- Read: `src/App.tsx`
- Read: `src/styles.css`

**Steps:**
1. Run `npm run build`.
2. Inspect diff for unrelated edits.
3. Do not run test commands unless explicitly approved.

