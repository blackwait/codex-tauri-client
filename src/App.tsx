import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
// NOTE: rehype-highlight is expensive for long timelines; keep rendering lightweight.
import {
  FALLBACK_MODELS,
  parseModelsFromList,
  type ModelOption,
} from './modelPicker';
import { buildTurnInput, ChatComposer, type ComposerAttachment, type ComposerSubmitPayload } from './chatComposer';
import { ProjectContextMenu, type ProjectContextMenuState, type ProjectMenuTarget } from './projectContextMenu';
import {
  detectPermissionMode,
  permissionModeToSettings,
  type PermissionModeId,
} from './permissionsPicker';
import {
  isThreadRenderable,
  mergeToolCompleted,
  mergeToolStarted,
  ThreadTimelineView,
  ThinkingShimmer,
  timelineFromThreadRead,
  type TimelineItem,
} from './threadTimeline';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  MessageSquareText,
  MoreHorizontal,
  Pin,
  Plus,
  Puzzle,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react';

type CodexStatus = {
  running: boolean;
  initialized: boolean;
  transport: string;
  last_error?: string | null;
};

type GitSnapshot = {
  is_repo: boolean;
  branch?: string | null;
  status: string;
  diff_stat: string;
};

type GitChangedFile = {
  path: string;
  index_status: string;
  worktree_status: string;
};

type RpcEnvelope = {
  id?: number;
  method?: string;
  request_method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
};

const APP_NAME = '鱼泡codex';

const MODEL_PREF_KEY = 'codex-tauri.model';
const EFFORT_PREF_KEY = 'codex-tauri.effort';
const PERMISSION_PREF_KEY = 'codex-tauri.permission-mode';

type AppServerItem = {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  changes?: unknown;
  [key: string]: unknown;
};

function asItem(params: unknown): AppServerItem | null {
  if (!params || typeof params !== 'object') return null;
  const direct = params as { item?: unknown };
  const candidate = (direct.item ?? params) as any;
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate as AppServerItem;
}

function itemTitle(itemType: string | undefined) {
  switch (itemType) {
    case 'commandExecution':
      return '命令执行';
    case 'fileChange':
      return '文件变更';
    case 'plan':
      return '计划';
    case 'reasoning':
      return '推理';
    case 'mcpToolCall':
      return 'MCP 调用';
    case 'dynamicToolCall':
      return '动态工具';
    default:
      return itemType ? `事件：${itemType}` : '事件';
  }
}

function formatFileChangeSummary(changes: unknown) {
  if (!changes) return '';
  if (Array.isArray(changes)) {
    const lines = changes
      .map((c: any) => {
        const path = typeof c?.path === 'string' ? c.path : typeof c?.file === 'string' ? c.file : null;
        const kind = typeof c?.kind === 'string' ? c.kind : typeof c?.type === 'string' ? c.type : null;
        const status = typeof c?.status === 'string' ? c.status : null;
        const parts = [path, kind, status].filter(Boolean);
        return parts.length > 0 ? `- ${parts.join(' · ')}` : null;
      })
      .filter(Boolean) as string[];
    return lines.join('\n');
  }
  return toPretty(changes);
}

function readConfigValue(contents: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^\\s*${escaped}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const match = contents.match(regex);
  return match?.[1]?.trim() ?? '';
}

function upsertConfigValue(contents: string, key: string, value: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^\\s*${escaped}\\s*=\\s*.*$`, 'm');
  const nextLine = `${key} = "${value}"`;
  if (regex.test(contents)) {
    return contents.replace(regex, nextLine);
  }
  const suffix = contents.endsWith('\n') || contents.length === 0 ? '' : '\n';
  return `${contents}${suffix}${nextLine}\n`;
}

type Conversation = {
  id: string;
  title: string;
  updated: string;
  unread?: boolean;
  status?: string;
};

type PendingApproval = {
  id: number;
  method: string;
  params: unknown;
};

type InventoryItem = {
  name: string;
  meta: string;
  ok: boolean;
};

type Project = {
  id: number;
  path: string;
  name: string;
  created_at: number;
  pinned?: boolean;
};

type SessionRow = {
  id: number;
  project_id: number;
  thread_id: string;
  mode?: string | null;
  worktree_path?: string | null;
  title?: string | null;
  updated_at?: number | null;
  status?: string | null;
  pinned?: boolean;
};

type CodexCheckResult = {
  installed: boolean;
  version?: string | null;
  error?: string | null;
};

type CodexConfigSnapshot = {
  path: string;
  exists: boolean;
  contents: string;
};

type SessionMode = 'local' | 'worktree';
type ThreadGitInfo = { sha: string | null; branch: string | null; originUrl: string | null };
type ThreadSettingsView = {
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: string | Record<string, unknown>;
  approvalsReviewer?: string;
  sandboxPolicy?: { type?: string };
  collaborationMode?: string;
  serviceTier?: string | null;
  effort?: string;
};

const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const autoConnectMessage = `正在连接${APP_NAME}，连接完成后可直接发送任务。`;
const addProjectHint = '点击左侧项目区域的「+」添加文件夹后，再开始新对话。';

function toPretty(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function getPayloadArray(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const payload = value as { data?: unknown };
  return Array.isArray(payload.data) ? payload.data : [];
}

const SERVER_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'applyPatchApproval',
  'execCommandApproval',
]);

const SILENT_TIMELINE_METHODS = new Set([
  'thread/list',
  'thread/resume',
  'thread/read',
  'skills/list',
  'mcpServerStatus/list',
  'model/list',
  'initialize',
  'thread/settings/update',
]);

const SILENT_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/tokenUsage/updated',
  'skills/changed',
]);

function isServerApprovalRequest(method: string | undefined): method is string {
  return typeof method === 'string' && SERVER_APPROVAL_METHODS.has(method);
}

function shouldAppendEnvelopeToTimeline(envelope: RpcEnvelope): boolean {
  const method = envelope.method;
  const requestMethod = envelope.request_method;
  if (envelope.error && requestMethod) return true;
  if (method) {
    if (SILENT_NOTIFICATION_METHODS.has(method)) return false;
    if (method.startsWith('item/')) return false;
    if (method.startsWith('turn/')) return false;
    if (method.startsWith('thread/')) return false;
    if (method.startsWith('command/')) return false;
    if (method.startsWith('skills/')) return false;
    if (method.startsWith('mcpServer')) return false;
  }
  const key = requestMethod ?? '';
  if (SILENT_TIMELINE_METHODS.has(key)) return false;
  if (
    key.startsWith('thread/') ||
    key.startsWith('turn/') ||
    key.startsWith('skills/') ||
    key.startsWith('mcpServer') ||
    key.startsWith('model/')
  ) {
    return false;
  }
  if (isServerApprovalRequest(method)) return false;
  return false;
}

function sandboxModeForThreadStart(sandboxPolicy: Record<string, unknown> | undefined): string | null {
  const type = sandboxPolicy?.type;
  if (type === 'dangerFullAccess') return 'danger-full-access';
  if (type === 'workspaceWrite') return 'workspace-write';
  if (type === 'readOnly') return 'read-only';
  return null;
}

function threadStartPermissionArgs(mode: PermissionModeId, cwd: string | null) {
  const settings = permissionModeToSettings(mode, cwd);
  if (!settings) return {};
  return {
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: settings.approvalsReviewer,
    sandbox: sandboxModeForThreadStart(settings.sandboxPolicy),
  };
}

async function applyThreadPermissionSettings(threadId: string, mode: PermissionModeId, cwd: string | null) {
  const settings = permissionModeToSettings(mode, cwd);
  if (!settings) return;
  try {
    await invoke('codex_update_thread_settings', { threadId, threadSettings: settings });
  } catch {
    // turn/start overrides still apply when thread settings update is unavailable
  }
}

function formatTime(seconds?: number | null) {
  if (!seconds) return '';
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时`;
  return `${Math.floor(diff / 86400)} 天`;
}

function classifyEnvelope(envelope: RpcEnvelope): TimelineItem {
  const key = envelope.method ?? envelope.request_method ?? (envelope.error ? '错误' : '响应');
  if (envelope.error) {
    return {
      id: crypto.randomUUID(),
      kind: 'error',
      title: `请求失败${envelope.id ? ` #${envelope.id}` : ''}`,
      body: toPretty(envelope.error),
    };
  }
  if (isServerApprovalRequest(envelope.method) && envelope.id && envelope.params && !envelope.result) {
    return {
      id: crypto.randomUUID(),
      kind: 'approval',
      title: `等待处理：${envelope.method}`,
      body: toPretty(envelope.params),
    };
  }
  if (key.includes('agentMessage')) {
    return {
      id: crypto.randomUUID(),
      kind: 'agent',
      title: '助手回复',
      body: toPretty(envelope.params ?? envelope.result),
    };
  }
  if (key.startsWith('item/') || key.startsWith('turn/') || key.startsWith('thread/')) {
    return {
      id: crypto.randomUUID(),
      kind: 'tool',
      title: translateMethod(key),
      body: toPretty(envelope.params ?? envelope.result),
    };
  }
  return {
    id: crypto.randomUUID(),
    kind: 'system',
    title: translateMethod(key),
    body: toPretty(envelope.result ?? envelope.params),
  };
}

function translateMethod(method: string) {
  const map: Record<string, string> = {
    'initialize': '初始化连接',
    'thread/start': '创建会话',
    'thread/list': '读取历史会话',
    'thread/resume': '恢复会话',
    'turn/start': '开始对话轮次',
    'turn/interrupt': '中断任务',
    'skills/list': '刷新 Skill',
    'mcpServerStatus/list': '刷新 MCP',
    'mcpServer/resource/read': '读取 MCP 资源',
    'mcpServer/tool/call': '调用 MCP 工具',
    'review/start': '启动官方 Review',
    'thread/name/set': '设置会话名称',
    'thread/archive': '归档会话',
    'thread/unarchive': '取消归档',
    'thread/fork': '分叉会话',
    'thread/rollback': '回滚会话',
    'thread/goal/set': '设置会话目标',
    'thread/goal/get': '读取会话目标',
    'thread/goal/clear': '清空会话目标',
    'thread/metadata/update': '更新会话元数据',
    'thread/settings/updated': '会话设置已更新',
    'command/exec': '执行命令',
    'command/exec/write': '写入命令标准输入',
    'command/exec/terminate': '终止执行命令',
    'command/exec/resize': '调整命令终端尺寸',
  };
  return map[method] ?? method;
}

function extractThreadIdFromNotification(method: string | undefined, params: unknown): string | null {
  if (!method || !params || typeof params !== 'object') return null;
  if (method === 'thread/started') {
    const thread = (params as { thread?: { id?: string } }).thread;
    return thread?.id ?? null;
  }
  return null;
}

function extractThreadId(envelope: RpcEnvelope): string | null {
  const result = envelope.result as { thread?: { id?: string }; threadId?: string } | undefined;
  const params = envelope.params as { thread?: { id?: string }; threadId?: string } | undefined;
  return result?.thread?.id ?? result?.threadId ?? params?.thread?.id ?? params?.threadId ?? null;
}

function extractConversationList(value: unknown): Conversation[] {
  return getPayloadArray(value)
    .map((item) => {
      const thread = item as {
        id?: string;
        name?: string | null;
        preview?: string;
        updatedAt?: number;
        status?: string;
      };
      if (!thread.id) return null;
      return {
        id: thread.id,
        title: thread.name || thread.preview || '未命名会话',
        updated: formatTime(thread.updatedAt),
        status: thread.status || '历史',
      };
    })
    .filter(Boolean) as Conversation[];
}

function extractSkillInventory(value: unknown): InventoryItem[] {
  return getPayloadArray(value).flatMap((entry) => {
    const group = entry as { cwd?: string; skills?: Array<{ name?: string; description?: string }>; errors?: unknown[] };
    const skills = group.skills ?? [];
    return skills.map((skill) => ({
      name: skill.name ?? '未命名 Skill',
      meta: group.cwd ?? skill.description ?? '本地 Skill',
      ok: true,
    }));
  });
}

function extractMcpInventory(value: unknown): InventoryItem[] {
  return getPayloadArray(value).map((item) => {
    const server = item as { name?: string; tools?: Record<string, unknown>; authStatus?: unknown };
    const tools = server.tools ? Object.keys(server.tools).length : 0;
    return {
      name: server.name ?? '未命名 MCP',
      meta: `${tools} 个工具 · ${toPretty(server.authStatus) || '认证状态未知'}`,
      ok: true,
    };
  });
}

function approvalResult(method: string, accept: boolean) {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: accept ? 'accept' : 'decline' };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: accept ? 'accept' : 'decline' };
  }
  if (method === 'item/permissions/requestApproval') {
    if (!accept) return null;
    return { permissions: {}, scope: 'turn' };
  }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return { decision: accept ? 'approved' : 'denied' };
  }
  return null;
}

function buildUserInputResponse(params: unknown) {
  if (!params || typeof params !== 'object') return { answers: {} };
  const questions = (params as { questions?: Array<{ id?: string; options?: Array<{ label?: string }> | null }> }).questions ?? [];
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const id = typeof question.id === 'string' ? question.id : null;
    if (!id) continue;
    const firstLabel = Array.isArray(question.options) ? question.options[0]?.label : null;
    answers[id] = { answers: [typeof firstLabel === 'string' && firstLabel ? firstLabel : '确认'] };
  }
  return { answers };
}

function buildMcpElicitationResponse(params: unknown, accept: boolean) {
  if (!accept) return { action: 'decline', content: null, _meta: null };
  const mode = (params as { mode?: string })?.mode;
  if (mode === 'url') {
    return { action: 'accept', content: null, _meta: null };
  }
  return { action: 'accept', content: {}, _meta: null };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function formatSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '新会话';
  if (normalized.length <= 15) return normalized;
  return `${normalized.slice(0, 15)}...`;
}

function sessionTitleFromInput(text: string, attachments: ComposerAttachment[]): string {
  const trimmed = text.trim();
  if (trimmed) return formatSessionTitle(trimmed);
  if (attachments.length > 0) return formatSessionTitle('图片消息');
  return '新会话';
}

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64Utf8(value: string) {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function extractThreadRows(value: unknown): Array<{ thread_id: string; title: string; updated_at?: number; status?: string }> {
  return getPayloadArray(value)
    .map((item) => {
      const thread = item as {
        id?: string;
        name?: string | null;
        preview?: string;
        updatedAt?: number;
        status?: string;
      };
      if (!thread.id) return null;
      return {
        thread_id: thread.id,
        title: thread.name || thread.preview || '未命名会话',
        updated_at: thread.updatedAt,
        status: thread.status,
      };
    })
    .filter(Boolean) as Array<{ thread_id: string; title: string; updated_at?: number; status?: string }>;
}

function extractThreadGitInfo(result: unknown): ThreadGitInfo | null {
  const thread = (result as any)?.thread ?? (result as any);
  const git = thread?.gitInfo;
  if (!git || typeof git !== 'object') return null;
  return {
    sha: typeof git.sha === 'string' ? git.sha : null,
    branch: typeof git.branch === 'string' ? git.branch : null,
    originUrl: typeof git.originUrl === 'string' ? git.originUrl : null,
  };
}

function extractThreadSettings(result: unknown): ThreadSettingsView | null {
  const thread = (result as any)?.thread ?? (result as any);
  const settings = thread?.threadSettings ?? thread?.settings;
  if (!settings || typeof settings !== 'object') return null;
  return {
    cwd: typeof settings.cwd === 'string' ? settings.cwd : undefined,
    model: typeof settings.model === 'string' ? settings.model : undefined,
    modelProvider: typeof settings.modelProvider === 'string' ? settings.modelProvider : undefined,
    approvalPolicy:
      typeof settings.approvalPolicy === 'string' || (settings.approvalPolicy && typeof settings.approvalPolicy === 'object')
        ? settings.approvalPolicy
        : undefined,
    approvalsReviewer:
      typeof settings.approvalsReviewer === 'string'
        ? settings.approvalsReviewer
        : settings.approvalsReviewer
        ? String(settings.approvalsReviewer)
        : undefined,
    sandboxPolicy:
      settings.sandboxPolicy && typeof settings.sandboxPolicy === 'object'
        ? { type: typeof settings.sandboxPolicy.type === 'string' ? settings.sandboxPolicy.type : undefined }
        : undefined,
    collaborationMode: typeof settings.collaborationMode === 'string' ? settings.collaborationMode : undefined,
    serviceTier: typeof settings.serviceTier === 'string' ? settings.serviceTier : null,
    effort: typeof settings.effort === 'string' ? settings.effort : undefined,
  };
}

function normalizeThreadSettings(params: unknown): ThreadSettingsView | null {
  if (!params || typeof params !== 'object') return null;
  const payload = params as any;
  const settings = payload.threadSettings ?? payload.settings;
  if (!settings || typeof settings !== 'object') return null;
  return {
    cwd: typeof settings.cwd === 'string' ? settings.cwd : undefined,
    model: typeof settings.model === 'string' ? settings.model : undefined,
    modelProvider: typeof settings.modelProvider === 'string' ? settings.modelProvider : undefined,
    approvalPolicy:
      typeof settings.approvalPolicy === 'string' || (settings.approvalPolicy && typeof settings.approvalPolicy === 'object')
        ? settings.approvalPolicy
        : undefined,
    approvalsReviewer:
      typeof settings.approvalsReviewer === 'string'
        ? settings.approvalsReviewer
        : settings.approvalsReviewer
        ? String(settings.approvalsReviewer)
        : undefined,
    sandboxPolicy:
      settings.sandboxPolicy && typeof settings.sandboxPolicy === 'object'
        ? { type: typeof settings.sandboxPolicy.type === 'string' ? settings.sandboxPolicy.type : undefined }
        : undefined,
    collaborationMode: typeof settings.collaborationMode === 'string' ? settings.collaborationMode : undefined,
    serviceTier: typeof settings.serviceTier === 'string' ? settings.serviceTier : null,
    effort: typeof settings.effort === 'string' ? settings.effort : undefined,
  };
}

function latestAgentFromCurrentTurn(result: unknown): string | null {
  const thread = (result as any)?.thread ?? (result as any);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn) return null;
  const turnItems = Array.isArray(lastTurn.items) ? lastTurn.items : [];
  for (let i = turnItems.length - 1; i >= 0; i -= 1) {
    const item = turnItems[i];
    if (item?.type !== 'agentMessage') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text) return text;
  }
  return null;
}

function isLatestTurnFinished(result: unknown): boolean {
  const thread = (result as { thread?: { turns?: Array<{ status?: string }> } })?.thread ?? result;
  const turns = Array.isArray((thread as { turns?: unknown[] })?.turns) ? (thread as { turns: Array<{ status?: string }> }).turns : [];
  const last = turns[turns.length - 1];
  const status = typeof last?.status === 'string' ? last.status : '';
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export default function App() {
  const [status, setStatus] = useState<CodexStatus>({ running: false, initialized: false, transport: 'stdio-jsonl' });
  const [projectPath, setProjectPath] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [codexCheck, setCodexCheck] = useState<CodexCheckResult | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [turnTiming, setTurnTiming] = useState<Record<number, { startedAt: number; completedAt?: number }>>({});
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [skills, setSkills] = useState<InventoryItem[]>([]);
  const [mcpServers, setMcpServers] = useState<InventoryItem[]>([]);
  const [mcpReadServer, setMcpReadServer] = useState('');
  const [mcpReadUri, setMcpReadUri] = useState('');
  const [mcpToolServer, setMcpToolServer] = useState('');
  const [mcpToolName, setMcpToolName] = useState('');
  const [mcpToolArgs, setMcpToolArgs] = useState('{}');
  const [execCommand, setExecCommand] = useState('pwd');
  const [execStdin, setExecStdin] = useState('');
  const [execLog, setExecLog] = useState('');
  const [execRunning, setExecRunning] = useState(false);
  const [execProcessId, setExecProcessId] = useState<string | null>(null);
  const [execTty, setExecTty] = useState(false);
  const [execCols, setExecCols] = useState(120);
  const [execRows, setExecRows] = useState(30);
  const [goalObjective, setGoalObjective] = useState('');
  const [goalStatus, setGoalStatus] = useState('active');
  const [goalTokenBudget, setGoalTokenBudget] = useState('');
  const [threadGitInfo, setThreadGitInfo] = useState<ThreadGitInfo | null>(null);
  const [threadSettingsView, setThreadSettingsView] = useState<ThreadSettingsView | null>(null);
  const [metadataSha, setMetadataSha] = useState('');
  const [metadataBranch, setMetadataBranch] = useState('');
  const [metadataOrigin, setMetadataOrigin] = useState('');
  const [clearMetadataSha, setClearMetadataSha] = useState(false);
  const [clearMetadataBranch, setClearMetadataBranch] = useState(false);
  const [clearMetadataOrigin, setClearMetadataOrigin] = useState(false);
  const [activeNav, setActiveNav] = useState('新对话');
  const [busy, setBusy] = useState(false);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [replyHint, setReplyHint] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const replySlowTimerRef = useRef<number | null>(null);
  const replyTimeoutTimerRef = useRef<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('pwd');
  const [terminalLog, setTerminalLog] = useState<string>('');
  const [diffText, setDiffText] = useState<string>('');
  const [stagedDiffText, setStagedDiffText] = useState<string>('');
  const [gitStatusShort, setGitStatusShort] = useState<string>('');
  const [changedFiles, setChangedFiles] = useState<GitChangedFile[]>([]);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [diffOpen, setDiffOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configSnapshot, setConfigSnapshot] = useState<CodexConfigSnapshot | null>(null);
  const [configDraft, setConfigDraft] = useState('');
  const [quickModel, setQuickModel] = useState('');
  const [quickApproval, setQuickApproval] = useState('');
  const [quickSandbox, setQuickSandbox] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [selectedModel, setSelectedModel] = useState(
    () => localStorage.getItem(MODEL_PREF_KEY) || FALLBACK_MODELS[0].model,
  );
  const [selectedEffort, setSelectedEffort] = useState(
    () => localStorage.getItem(EFFORT_PREF_KEY) || 'high',
  );
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>(
    () => (localStorage.getItem(PERMISSION_PREF_KEY) as PermissionModeId) || 'full-access',
  );
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const selectedModelRef = useRef(selectedModel);
  const selectedEffortRef = useRef(selectedEffort);
  const permissionModeRef = useRef(permissionMode);
  const [sessionMode, setSessionMode] = useState<SessionMode>('local');
  const pendingPromptRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingCreateSessionProjectIdRef = useRef<number | null>(null);
  const pendingSessionModeRef = useRef<SessionMode>('local');
  const pendingSessionTitleRef = useRef<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const threadWarmupRef = useRef<Promise<string | null> | null>(null);
  const draftSessionRef = useRef(true);
  const sessionHydrateRef = useRef(false);
  const waitingForReplyRef = useRef(false);
  const streamingTextRef = useRef('');
  const threadReadPollRef = useRef<number | null>(null);
  const replyPollTokenRef = useRef<string | null>(null);
  const selectedProjectIdRef = useRef<number | null>(null);
  const projectPathRef = useRef('');
  const projectsRef = useRef<Project[]>([]);
  const sessionsRef = useRef<SessionRow[]>([]);
  const streamingAgentRef = useRef<{ itemId: string; timelineId: string } | null>(null);
  const streamingToolRef = useRef<Map<string, string>>(new Map());
  const latestDiffTimelineIdRef = useRef<string | null>(null);
  const execPendingRequestIdRef = useRef<number | null>(null);
  const execProcessIdRef = useRef<string | null>(null);
  const serviceLogRef = useRef<string>('');
  const serviceLogFlushTimerRef = useRef<number | null>(null);
  const serviceLogPendingRef = useRef<string>('');
  const [turnIndex, setTurnIndex] = useState<number>(0);
  const turnIndexRef = useRef<number>(0);
  const [turnState, setTurnState] = useState<'idle' | 'thinking' | 'runningTools'>('idle');
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [sessionsListExpanded, setSessionsListExpanded] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() => new Set());
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);

  const commitAgentReplyRef = useRef<(body: string, finalize?: boolean) => void>(() => {});
  commitAgentReplyRef.current = (body: string, finalize = false) => {
    const text = body.trim();
    if (!text) return;
    setStreamingText(text);
    setTimeline((current) => {
      const stream = streamingAgentRef.current;
      if (stream) {
        const exists = current.some((evt) => evt.id === stream.timelineId);
        if (exists) {
          return current.map((evt) =>
            evt.id === stream.timelineId ? { ...evt, body: text, completed: true } : evt,
          );
        }
        return [
          ...current,
          {
            id: stream.timelineId,
            kind: 'agent' as const,
            title: '助手',
            body: text,
            turnIndex: turnIndexRef.current,
            completed: true,
          },
        ];
      }
      const duplicate = current.some((item) => item.kind === 'agent' && item.body === text);
      if (duplicate) return current;
      const id = crypto.randomUUID();
      streamingAgentRef.current = { itemId: id, timelineId: id };
      return [
        ...current,
        { id, kind: 'agent' as const, title: '助手', body: text, turnIndex: turnIndexRef.current, completed: true },
      ];
    });
    if (finalize) {
      streamingAgentRef.current = null;
      streamingToolRef.current.clear();
      latestDiffTimelineIdRef.current = null;
      setTurnState('idle');
      setWaitingForReply(false);
      setStreamingText('');
    }
  };

  async function syncPollAgentReply(threadId: string, pollToken: string) {
    const delays = [600, 1200, 2000, 3500, 5000, 8000, 12000, 20000, 30000];
    for (const delay of delays) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (replyPollTokenRef.current !== pollToken || !waitingForReplyRef.current) return;
      try {
        const result = await invoke<unknown>('codex_read_thread_sync', { threadId, includeTurns: true });
        const agentText = latestAgentFromCurrentTurn(result);
        if (agentText) {
          commitAgentReplyRef.current(agentText, isLatestTurnFinished(result));
          if (isLatestTurnFinished(result)) return;
        }
      } catch {
        // ignore transient read failures while the turn is still running
      }
    }
  }

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    selectedEffortRef.current = selectedEffort;
  }, [selectedEffort]);

  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);

  useEffect(() => {
    if (threadSettingsView) {
      setPermissionMode(
        detectPermissionMode({
          approvalPolicy: threadSettingsView.approvalPolicy,
          approvalsReviewer: threadSettingsView.approvalsReviewer,
          sandboxPolicy: threadSettingsView.sandboxPolicy,
        }),
      );
    }
    if (threadSettingsView?.model) setSelectedModel(threadSettingsView.model);
    if (threadSettingsView?.effort) setSelectedEffort(threadSettingsView.effort);
  }, [
    threadSettingsView?.approvalPolicy,
    threadSettingsView?.approvalsReviewer,
    threadSettingsView?.sandboxPolicy,
    threadSettingsView?.model,
    threadSettingsView?.effort,
  ]);

  useEffect(() => {
    localStorage.setItem(MODEL_PREF_KEY, selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    localStorage.setItem(EFFORT_PREF_KEY, selectedEffort);
  }, [selectedEffort]);

  useEffect(() => {
    localStorage.setItem(PERMISSION_PREF_KEY, permissionMode);
  }, [permissionMode]);

  async function refreshModelCatalog() {
    if (!isTauriRuntime) return;
    try {
      const result = await invoke<unknown>('codex_list_models_sync');
      const next = parseModelsFromList(result);
      setModelOptions(next);
      if (!next.some((item) => item.model === selectedModelRef.current)) {
        const fallback = next[0];
        if (fallback) setSelectedModel(fallback.model);
      }
    } catch {
      setModelOptions(FALLBACK_MODELS);
    }
  }

  function handleModelChange(model: string) {
    setSelectedModel(model);
    setQuickModel(model);
  }

  function handleEffortChange(effort: string) {
    setSelectedEffort(effort);
  }

  async function handlePermissionModeChange(mode: PermissionModeId) {
    setPermissionMode(mode);
    const settings = permissionModeToSettings(mode, projectPathRef.current || projectPath || null);
    if (!settings) return;
    const activeThreadId = threadIdRef.current;
    if (!activeThreadId || !isTauriRuntime) return;
    try {
      await invoke('codex_update_thread_settings', {
        threadId: activeThreadId,
        threadSettings: settings,
      });
    } catch {
      // Fall back to turn/start overrides when thread settings update is unavailable.
    }
  }

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    execProcessIdRef.current = execProcessId;
  }, [execProcessId]);

  useEffect(() => {
    waitingForReplyRef.current = waitingForReply;
  }, [waitingForReply]);

  useEffect(() => {
    streamingTextRef.current = streamingText;
  }, [streamingText]);

  useEffect(() => {
    turnIndexRef.current = turnIndex;
  }, [turnIndex]);

  useEffect(() => {
    if (replySlowTimerRef.current != null) {
      window.clearTimeout(replySlowTimerRef.current);
      replySlowTimerRef.current = null;
    }
    if (replyTimeoutTimerRef.current != null) {
      window.clearTimeout(replyTimeoutTimerRef.current);
      replyTimeoutTimerRef.current = null;
    }
    if (!waitingForReply) {
      setReplyHint(null);
      return;
    }
    setReplyHint(null);
    replySlowTimerRef.current = window.setTimeout(() => {
      setReplyHint('后台仍在处理，首轮通常需要 20–60 秒…');
    }, 30000);
    replyTimeoutTimerRef.current = window.setTimeout(() => {
      setReplyHint('已等待较久，后台可能卡住。可点击「中断」后重试。');
    }, 120000);
    return () => {
      if (replySlowTimerRef.current != null) {
        window.clearTimeout(replySlowTimerRef.current);
        replySlowTimerRef.current = null;
      }
      if (replyTimeoutTimerRef.current != null) {
        window.clearTimeout(replyTimeoutTimerRef.current);
        replyTimeoutTimerRef.current = null;
      }
    };
  }, [waitingForReply]);

  useEffect(() => {
    if (threadReadPollRef.current != null) {
      window.clearInterval(threadReadPollRef.current);
      threadReadPollRef.current = null;
    }
    if (!waitingForReply) return;
    threadReadPollRef.current = window.setInterval(() => {
      const tid = threadIdRef.current;
      if (!tid || !waitingForReplyRef.current) return;
      invoke<unknown>('codex_read_thread_sync', { threadId: tid, includeTurns: true })
        .then((result) => {
          const agentText = latestAgentFromCurrentTurn(result);
          if (agentText) {
            commitAgentReplyRef.current(agentText, isLatestTurnFinished(result));
          }
        })
        .catch(() => {});
    }, 2000);
    return () => {
      if (threadReadPollRef.current != null) {
        window.clearInterval(threadReadPollRef.current);
        threadReadPollRef.current = null;
      }
    };
  }, [waitingForReply]);

  useEffect(() => {
    if (!threadGitInfo) return;
    setMetadataSha(threadGitInfo.sha ?? '');
    setMetadataBranch(threadGitInfo.branch ?? '');
    setMetadataOrigin(threadGitInfo.originUrl ?? '');
  }, [threadGitInfo]);

  useEffect(() => {
    const node = timelineScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [timeline, waitingForReply, streamingText]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (!isTauriRuntime) {
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'system', title: '浏览器预览', body: '普通浏览器无法调用 Tauri 命令。运行 npm run tauri:dev 后，MCP、Skill 和对话链路会接入真实 Codex。' },
      ]);
      return () => {};
    }

    invoke<CodexCheckResult>('codex_check')
      .then((res) => setCodexCheck(res))
      .catch((error) => setCodexCheck({ installed: false, error: String(error) }));

    invoke<Project[]>('projects_list')
      .then(async (rows) => {
        setProjects(rows);
        if (rows.length === 0) {
          setSelectedProjectId(null);
          selectedProjectIdRef.current = null;
          setProjectPath('');
          projectPathRef.current = '';
          setSessions([]);
          return;
        }
        const first = rows[0];
        setSelectedProjectId(first.id);
        selectedProjectIdRef.current = first.id;
        setProjectPath(first.path);
        projectPathRef.current = first.path;
        setExpandedProjectIds(new Set([first.id]));
        const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: first.id });
        setSessions(nextSessions);
      })
      .catch((error) => {
        setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'error', title: '读取项目列表失败', body: String(error) }]);
      });

    const registerListeners = async () => {
      unsubs.push(await listen<CodexStatus>('codex:status', (event) => setStatus(event.payload)));
      unsubs.push(
        await listen<RpcEnvelope>('codex:message', (event) => {
      const envelope = event.payload;
      const method = envelope.method;
      const requestMethod = envelope.request_method;
      let skipAppend = false;

      const approvalMethod = envelope.method;
      if (isServerApprovalRequest(approvalMethod) && envelope.id !== undefined && envelope.params && !envelope.result && !envelope.error) {
        const approvalId = envelope.id;
        setPendingApprovals((current) => [
          ...current.filter((approval) => approval.id !== approvalId),
          { id: approvalId, method: approvalMethod, params: envelope.params },
        ]);
      }

      if (method === 'turn/started') {
        setTurnIndex((prev) => {
          const next = prev + 1;
          setTurnTiming((current) => ({ ...current, [next]: { startedAt: Date.now() } }));
          return next;
        });
        setStreamingText('');
        streamingAgentRef.current = null;
        streamingToolRef.current.clear();
        setTurnState('thinking');
        setWaitingForReply(true);
        return;
      }

      if (method === 'error' && envelope.params) {
        setWaitingForReply(false);
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'agent', title: '助手', body: `服务错误：${toPretty(envelope.params)}` },
        ]);
        return;
      }

      if (method === 'item/agentMessage/delta' && envelope.params) {
        const params = envelope.params as { itemId?: string; delta?: string };
        const delta = params.delta ?? '';
        if (delta) {
          const itemId = params.itemId ?? '';
          const stream = streamingAgentRef.current;
          if (!stream || (itemId && stream.itemId !== itemId)) {
            const timelineId = crypto.randomUUID();
            streamingAgentRef.current = { itemId: itemId || timelineId, timelineId };
            setStreamingText(delta);
            setTimeline((current) => [
              ...current,
              {
                id: timelineId,
                kind: 'agent',
                title: '助手',
                body: delta,
                turnIndex: turnIndexRef.current,
                completed: false,
              },
            ]);
          } else {
            setStreamingText((prev) => prev + delta);
            setTimeline((current) =>
              current.map((evt) =>
                evt.id === stream.timelineId ? { ...evt, body: evt.body + delta, completed: false } : evt,
              ),
            );
          }
        }
        return;
      }

      if (method === 'item/commandExecution/outputDelta' && envelope.params) {
        const params = envelope.params as { itemId?: string; delta?: string; stream?: string };
        const delta = params.delta ?? '';
        const itemId = params.itemId;
        if (delta && itemId) {
          const prefix = params.stream === 'stderr' ? '[stderr] ' : '';
          setTimeline((current) => {
            const timelineId = streamingToolRef.current.get(itemId);
            if (!timelineId) return current;
            return current.map((evt) => (evt.id === timelineId ? { ...evt, body: evt.body + prefix + delta } : evt));
          });
        }
        return;
      }

      if (method === 'command/exec/outputDelta' && envelope.params) {
        const params = envelope.params as { processId?: string; stream?: string; deltaBase64?: string };
        const processId = params.processId ?? '';
        const delta = params.deltaBase64 ? decodeBase64Utf8(params.deltaBase64) : '';
        if (delta) {
          const prefix = params.stream === 'stderr' ? '[stderr] ' : '';
          setExecLog((prev) => `${prev}${prefix}${delta}`);
          // Avoid appending timeline rows per chunk (hot path).
          void processId;
        }
        return;
      }

      if (method === 'item/plan/delta' && envelope.params) {
        const params = envelope.params as { itemId?: string; delta?: string };
        const delta = params.delta ?? '';
        const itemId = params.itemId;
        if (delta && itemId) {
          setTimeline((current) => {
            const existingId = streamingToolRef.current.get(itemId);
            if (existingId) {
              return current.map((evt) => (evt.id === existingId ? { ...evt, body: evt.body + delta } : evt));
            }
            const timelineId = crypto.randomUUID();
            streamingToolRef.current.set(itemId, timelineId);
            return [...current, { id: timelineId, kind: 'tool', subtype: 'plan', title: '计划', body: delta, turnIndex: turnIndexRef.current, completed: false, ...mergeToolStarted() }];
          });
        }
        return;
      }

      if ((method === 'item/started' || method === 'item/completed') && envelope.params) {
        const item = asItem(envelope.params);
        if (item?.id && item?.type) {
          const itemId = String(item.id);
          if (item.type === 'agentMessage' && method === 'item/completed') {
            const text = typeof item.text === 'string' ? item.text : '';
            const phase = typeof item.phase === 'string' ? item.phase : '';
            if (text) {
              commitAgentReplyRef.current(text, phase === 'final_answer');
            }
            return;
          }
          if (item.type === 'commandExecution') {
            if (method === 'item/started') {
              setTurnState('runningTools');
              const timelineId = crypto.randomUUID();
              streamingToolRef.current.set(itemId, timelineId);
              setTimeline((current) => [
                ...current,
                {
                  id: timelineId,
                  kind: 'tool',
                  subtype: 'commandExecution',
                  title: '命令',
                  command: typeof item.command === 'string' ? item.command : 'command',
                  body: '',
                  turnIndex: turnIndexRef.current,
                  completed: false,
                  ...mergeToolStarted(),
                },
              ]);
              return;
            }
            if (method === 'item/completed') {
              const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
              const tid = streamingToolRef.current.get(itemId);
              if (tid) {
                setTimeline((current) =>
                  current.map((evt) =>
                    evt.id === tid
                      ? {
                          ...evt,
                          body: output || evt.body || toPretty(item),
                          completed: true,
                          ...mergeToolCompleted(item as Record<string, unknown>, evt),
                        }
                      : evt,
                  ),
                );
              } else {
                setTimeline((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    kind: 'tool',
                    subtype: 'commandExecution',
                    title: '命令',
                    command: typeof item.command === 'string' ? item.command : 'command',
                    body: output || toPretty(item),
                    completed: true,
                    ...mergeToolCompleted(item as Record<string, unknown>),
                  },
                ]);
              }
              streamingToolRef.current.delete(itemId);
              return;
            }
          }

          if (item.type === 'reasoning') {
            if (method === 'item/started') {
              setTurnState('thinking');
              const timelineId = crypto.randomUUID();
              streamingToolRef.current.set(itemId, timelineId);
              setTimeline((current) => [
                ...current,
                {
                  id: timelineId,
                  kind: 'tool',
                  subtype: 'reasoning',
                  title: '思考',
                  body: '',
                  turnIndex: turnIndexRef.current,
                  completed: false,
                  ...mergeToolStarted(),
                },
              ]);
              return;
            }
            if (method === 'item/completed') {
              const summary = Array.isArray(item.summary)
                ? item.summary.filter((s: unknown) => typeof s === 'string').join('\n\n')
                : '';
              const tid = streamingToolRef.current.get(itemId);
              if (tid) {
                setTimeline((current) =>
                  current.map((evt) =>
                    evt.id === tid
                      ? {
                          ...evt,
                          body: summary || evt.body,
                          completed: true,
                          ...mergeToolCompleted(item as Record<string, unknown>, evt),
                        }
                      : evt,
                  ),
                );
              } else if (summary) {
                setTimeline((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    kind: 'tool',
                    subtype: 'reasoning',
                    title: '思考',
                    body: summary,
                    turnIndex: turnIndexRef.current,
                    completed: true,
                  },
                ]);
              }
              streamingToolRef.current.delete(itemId);
              return;
            }
          }

          if (item.type === 'plan') {
            if (method === 'item/started') {
              const timelineId = crypto.randomUUID();
              streamingToolRef.current.set(itemId, timelineId);
              setTimeline((current) => [
                ...current,
                {
                  id: timelineId,
                  kind: 'tool',
                  subtype: 'plan',
                  title: '计划',
                  body: typeof item.text === 'string' ? item.text : '',
                  turnIndex: turnIndexRef.current,
                  completed: false,
                  ...mergeToolStarted(),
                },
              ]);
              return;
            }
            if (method === 'item/completed') {
              const text = typeof item.text === 'string' ? item.text : '';
              const tid = streamingToolRef.current.get(itemId);
              if (tid) {
                setTimeline((current) =>
                  current.map((evt) =>
                    evt.id === tid
                      ? {
                          ...evt,
                          body: text || evt.body,
                          completed: true,
                          ...mergeToolCompleted(item as Record<string, unknown>, evt),
                        }
                      : evt,
                  ),
                );
              } else if (text) {
                setTimeline((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    kind: 'tool',
                    subtype: 'plan',
                    title: '计划',
                    body: text,
                    turnIndex: turnIndexRef.current,
                    completed: true,
                  },
                ]);
              }
              streamingToolRef.current.delete(itemId);
              return;
            }
          }

          if (item.type === 'fileChange' && method === 'item/completed') {
            const summary = formatFileChangeSummary(item.changes);
            setTimeline((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                kind: 'tool',
                subtype: 'fileChange',
                title: itemTitle('fileChange'),
                body: summary || toPretty(item.changes ?? item),
              },
            ]);
            return;
          }

          if (item.type === 'mcpToolCall') {
            if (method === 'item/started') {
              setTurnState('runningTools');
              const timelineId = crypto.randomUUID();
              streamingToolRef.current.set(itemId, timelineId);
              const server = typeof item.server === 'string' ? item.server : 'mcp';
              const tool = typeof item.tool === 'string' ? item.tool : 'tool';
              const args = item.arguments ? `arguments:\n${toPretty(item.arguments)}\n` : '';
              setTimeline((current) => [
                ...current,
                { id: timelineId, kind: 'tool', subtype: 'mcpToolCall', title: `MCP：${server}/${tool}`, command: `${server}/${tool}`, body: args, turnIndex: turnIndexRef.current, completed: false, ...mergeToolStarted() },
              ]);
              return;
            }
            if (method === 'item/completed') {
              const server = typeof item.server === 'string' ? item.server : 'mcp';
              const tool = typeof item.tool === 'string' ? item.tool : 'tool';
              const statusText = typeof item.status === 'string' ? ` · ${item.status}` : '';
              const args = item.arguments ? `arguments:\n${toPretty(item.arguments)}\n\n` : '';
              const result = item.result ? `result:\n${toPretty(item.result)}` : item.error ? `error:\n${toPretty(item.error)}` : '';
              const body = `${args}${result}`.trim() || toPretty(item);
              const tid = streamingToolRef.current.get(itemId);
              if (tid) {
                setTimeline((current) =>
                  current.map((evt) =>
                    evt.id === tid
                      ? {
                          ...evt,
                          title: `MCP：${server}/${tool}${statusText}`,
                          body,
                          completed: true,
                          ...mergeToolCompleted(item as Record<string, unknown>, evt),
                        }
                      : evt,
                  ),
                );
              } else {
                setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'tool', subtype: 'mcpToolCall', title: `MCP：${server}/${tool}${statusText}`, body }]);
              }
              streamingToolRef.current.delete(itemId);
              return;
            }
          }

          if (item.type === 'dynamicToolCall') {
            if (method === 'item/started') {
              setTurnState('runningTools');
              const timelineId = crypto.randomUUID();
              streamingToolRef.current.set(itemId, timelineId);
              const tool = typeof item.tool === 'string' ? item.tool : 'tool';
              const args = item.arguments ? `arguments:\n${toPretty(item.arguments)}\n` : '';
              setTimeline((current) => [
                ...current,
                { id: timelineId, kind: 'tool', subtype: 'dynamicToolCall', title: `动态工具：${tool}`, command: tool, body: args, turnIndex: turnIndexRef.current, completed: false, ...mergeToolStarted() },
              ]);
              return;
            }
            if (method === 'item/completed') {
              const tool = typeof item.tool === 'string' ? item.tool : 'tool';
              const statusText = typeof item.status === 'string' ? ` · ${item.status}` : '';
              const args = item.arguments ? `arguments:\n${toPretty(item.arguments)}\n\n` : '';
              const success = typeof item.success === 'boolean' ? `success: ${item.success}\n\n` : '';
              const contentItems = item.contentItems ? `contentItems:\n${toPretty(item.contentItems)}\n\n` : '';
              const error = item.error ? `error:\n${toPretty(item.error)}` : '';
              const body = `${args}${success}${contentItems}${error}`.trim() || toPretty(item);
              const tid = streamingToolRef.current.get(itemId);
              if (tid) {
                setTimeline((current) =>
                  current.map((evt) =>
                    evt.id === tid
                      ? {
                          ...evt,
                          title: `动态工具：${tool}${statusText}`,
                          body,
                          completed: true,
                          ...mergeToolCompleted(item as Record<string, unknown>, evt),
                        }
                      : evt,
                  ),
                );
              } else {
                setTimeline((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    kind: 'tool',
                    subtype: 'dynamicToolCall',
                    title: `动态工具：${tool}${statusText}`,
                    body,
                    completed: true,
                    ...mergeToolCompleted(item as Record<string, unknown>),
                  },
                ]);
              }
              streamingToolRef.current.delete(itemId);
              return;
            }
          }
        }
      }

      if (method === 'turn/plan/updated' && envelope.params) {
        const params = envelope.params as {
          explanation?: string | null;
          plan?: Array<{ step?: string; status?: string }>;
        };
        const steps = (params.plan ?? [])
          .map((step) => `- [${step.status ?? 'pending'}] ${step.step ?? ''}`.trim())
          .filter(Boolean)
          .join('\n');
        const body = [params.explanation ?? '', steps].filter(Boolean).join('\n\n');
        if (body) {
          setTimeline((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              kind: 'tool',
              subtype: 'todoList',
              title: '任务计划',
              body,
              turnIndex: turnIndexRef.current,
              completed: true,
            },
          ]);
        }
        return;
      }

      if (method === 'turn/diff/updated' && envelope.params) {
        const params = envelope.params as { diff?: string; patch?: string; unifiedDiff?: string };
        const diff = (typeof params.diff === 'string' && params.diff) || (typeof params.unifiedDiff === 'string' && params.unifiedDiff) || (typeof params.patch === 'string' && params.patch) || '';
        if (diff) {
          setDiffText(diff);
          setTimeline((current) => {
            const existing = latestDiffTimelineIdRef.current;
            if (existing) {
              return current.map((evt) => (evt.id === existing ? { ...evt, body: diff } : evt));
            }
            const id = crypto.randomUUID();
            latestDiffTimelineIdRef.current = id;
            return [...current, { id, kind: 'tool', subtype: 'diff', title: 'Diff 已更新', body: diff }];
          });
        }
        return;
      }

      if (method === 'item/reasoning/summaryPartAdded' && envelope.params) {
        const params = envelope.params as { itemId?: string; summaryIndex?: number };
        const itemId = params.itemId;
        if (itemId) {
          const key = `reasoning:${itemId}:${params.summaryIndex ?? 0}`;
          const timelineId = crypto.randomUUID();
          streamingToolRef.current.set(key, timelineId);
          setTimeline((current) => [...current, { id: timelineId, kind: 'tool', subtype: 'reasoning', title: '思考', body: '', turnIndex: turnIndexRef.current, completed: false, ...mergeToolStarted() }]);
        }
        return;
      }

      if (method === 'item/reasoning/summaryTextDelta' && envelope.params) {
        const params = envelope.params as { itemId?: string; delta?: string; summaryIndex?: number };
        const itemId = params.itemId;
        const delta = params.delta ?? '';
        if (itemId && delta) {
          const key = `reasoning:${itemId}:${params.summaryIndex ?? 0}`;
          setTimeline((current) => {
            const timelineId = streamingToolRef.current.get(key);
            if (!timelineId) {
              return [
                ...current,
                {
                  id: crypto.randomUUID(),
                  kind: 'tool',
                  subtype: 'reasoning',
                  title: '思考',
                  body: delta,
                  turnIndex: turnIndexRef.current,
                  completed: false,
                  ...mergeToolStarted(),
                },
              ];
            }
            return current.map((evt) =>
              evt.id === timelineId ? { ...evt, body: evt.body + delta, completed: false } : evt,
            );
          });
        }
        return;
      }

      if (method === 'item/reasoning/textDelta') {
        return;
      }

      if (method === 'turn/completed') {
        setTurnTiming((current) => {
          const turnIndex = turnIndexRef.current;
          const existing = current[turnIndex];
          if (!existing) return current;
          return { ...current, [turnIndex]: { ...existing, completedAt: Date.now() } };
        });
        const finalText = streamingTextRef.current.trim();
        if (finalText) {
          commitAgentReplyRef.current(finalText, true);
        } else {
          streamingAgentRef.current = null;
          streamingToolRef.current.clear();
          latestDiffTimelineIdRef.current = null;
          setTurnState('idle');
          setWaitingForReply(false);
          setStreamingText('');
        }
        return;
      }

      const notifyThreadId = extractThreadIdFromNotification(method, envelope.params);
      const responseThreadId = extractThreadId(envelope);
      const nextThreadId = notifyThreadId ?? responseThreadId;

      if (requestMethod === 'thread/list' && envelope.result) {
        const remoteThreads = extractConversationList(envelope.result);
        if (remoteThreads.length > 0) setConversations(remoteThreads);

        const projectId = selectedProjectIdRef.current;
        if (projectId) {
          const threadRows = extractThreadRows(envelope.result);
          Promise.all(
            threadRows.map((row) =>
              invoke('session_upsert', {
                projectId,
                threadId: row.thread_id,
                mode: null,
                worktreePath: null,
                title: row.title,
                updatedAt: row.updated_at ?? null,
                status: row.status ?? null,
              }),
            ),
          )
            .then(() => invoke<SessionRow[]>('sessions_for_project', { projectId }))
            .then((next) => setSessions(next))
            .catch((error) => appendError('同步会话列表失败', error));
        }
      }

      if (requestMethod === 'thread/start' && envelope.result) {
        const projectId = pendingCreateSessionProjectIdRef.current ?? selectedProjectIdRef.current;
        const createdId = responseThreadId;
        const mode = pendingSessionModeRef.current;
        if (projectId && createdId) {
          const sessionTitle = pendingSessionTitleRef.current || '新会话';
          pendingSessionTitleRef.current = null;
          pendingCreateSessionProjectIdRef.current = null;
          pendingSessionModeRef.current = 'local';
          const upsertLocal = () =>
            invoke('session_upsert', {
              projectId,
              threadId: createdId,
              mode,
              worktreePath: null,
              title: sessionTitle,
              updatedAt: nowSeconds(),
              status: mode,
            })
              .then(() => invoke<SessionRow[]>('sessions_for_project', { projectId }))
              .then((next) => {
                setSessions(next);
                setSessionsListExpanded(true);
              });

          if (mode === 'worktree') {
            const project = projectsRef.current.find((p) => p.id === projectId);
            if (project) {
              invoke<string>('worktree_create', { projectPath: project.path, sessionThreadId: createdId })
                .then((wtPath) =>
                  invoke('session_upsert', {
                    projectId,
                    threadId: createdId,
                    mode: 'worktree',
                    worktreePath: wtPath,
                    title: sessionTitle,
                    updatedAt: nowSeconds(),
                    status: 'worktree',
                  }),
                )
                .then(() => invoke<SessionRow[]>('sessions_for_project', { projectId }))
                .then((next) => {
                  setSessions(next);
                  setProjectPath((current) => {
                    const session = next.find((s) => s.thread_id === createdId);
                    return session?.worktree_path || current;
                  });
                })
                .catch((error) => {
                  appendError('Worktree 会话创建失败', error);
                  upsertLocal().catch(() => {});
                });
            } else {
              upsertLocal().catch((error) => appendError('保存新会话失败', error));
            }
          } else {
            upsertLocal().catch((error) => appendError('保存新会话失败', error));
          }
        }
      }

      if (requestMethod === 'skills/list' && envelope.result) {
        setSkills(extractSkillInventory(envelope.result));
      }
      if (requestMethod === 'mcpServerStatus/list' && envelope.result) {
        setMcpServers(extractMcpInventory(envelope.result));
      }

      if (requestMethod === 'thread/read' && envelope.result) {
        const chatMsgs = timelineFromThreadRead(envelope.result);

        if (waitingForReplyRef.current) {
          const agentText = latestAgentFromCurrentTurn(envelope.result);
          if (agentText) {
            commitAgentReplyRef.current(agentText, isLatestTurnFinished(envelope.result));
          }
          skipAppend = true;
        } else if (sessionHydrateRef.current) {
          setTimeline(chatMsgs);
          setThreadGitInfo(extractThreadGitInfo(envelope.result));
          setThreadSettingsView(extractThreadSettings(envelope.result));
          sessionHydrateRef.current = false;
          skipAppend = true;

          const projectId = selectedProjectIdRef.current;
          const thread = (envelope.result as any)?.thread ?? (envelope.result as any);
          const tid = typeof thread?.id === 'string' ? thread.id : null;
          if (projectId && tid) {
            const updatedAt = typeof thread?.updatedAt === 'number' ? thread.updatedAt : nowSeconds();
            invoke('session_upsert', {
              projectId,
              threadId: tid,
              mode: null,
              worktreePath: null,
              title: null,
              updatedAt,
              status: thread?.status ? String(thread.status) : undefined,
            })
              .then(() => invoke<SessionRow[]>('sessions_for_project', { projectId }))
              .then((next) => setSessions(next))
              .catch(() => {});
          }
        } else {
          skipAppend = true;
        }
      }

      if (method === 'thread/settings/updated' && envelope.params) {
        const settings = normalizeThreadSettings(envelope.params);
        if (settings) setThreadSettingsView(settings);
      }

      if (requestMethod === 'command/exec' && envelope.id === execPendingRequestIdRef.current && envelope.result) {
        const result = envelope.result as { exitCode?: number; stdout?: string; stderr?: string };
        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : '';
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
        const finalChunk = [stdout, stderr, `(exit ${exitCode})`].filter(Boolean).join('\n');
        if (finalChunk) setExecLog((prev) => `${prev}${prev ? '\n' : ''}${finalChunk}\n`);
        setExecRunning(false);
        setExecProcessId(null);
        execPendingRequestIdRef.current = null;
      }

      if (nextThreadId) {
        const isOurThreadStart = requestMethod === 'thread/start' && Boolean(envelope.result);
        if (!draftSessionRef.current || isOurThreadStart) {
          setThreadId(nextThreadId);
          threadIdRef.current = nextThreadId;
          if (isOurThreadStart) draftSessionRef.current = false;
        }
      }

      if (envelope.error && requestMethod === 'thread/start') {
        threadWarmupRef.current = null;
      }

      if (envelope.error && requestMethod === 'turn/start') {
        setWaitingForReply(false);
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'agent', title: '助手', body: `对话失败：${toPretty(envelope.error)}` },
        ]);
      }

        if (!skipAppend && shouldAppendEnvelopeToTimeline(envelope)) {
          const item = classifyEnvelope(envelope);
          setTimeline((current) => [...current, item]);
        }
        }),
      );
      unsubs.push(
        await listen<{ line: string }>('codex:stderr', (event) => {
      const line = event.payload.line;
      if (!line) return;
      const next = `${serviceLogPendingRef.current}${serviceLogPendingRef.current ? '\n' : ''}${line}`.split('\n').slice(-50).join('\n');
      serviceLogPendingRef.current = next;
      if (serviceLogFlushTimerRef.current != null) return;
      serviceLogFlushTimerRef.current = window.setTimeout(() => {
        serviceLogFlushTimerRef.current = null;
        const flushed = serviceLogPendingRef.current;
        if (!flushed || flushed === serviceLogRef.current) return;
        serviceLogRef.current = flushed;
        setTimeline((current) => {
          const id = 'service-log';
          const existingIdx = current.findIndex((it) => it.id === id);
          const item = { id, kind: 'system' as const, title: '服务日志（最近50行）', body: flushed };
          if (existingIdx === -1) return [...current, item];
          const copy = current.slice();
          copy[existingIdx] = item;
          return copy;
        });
        }, 250);
        }),
      );
      unsubs.push(
        await listen<{ line: string; error: string }>('codex:unparsed', (event) => {
          setTimeline((current) => [
            ...current,
            { id: crypto.randomUUID(), kind: 'error', title: '无法解析的服务输出', body: `${event.payload.error}\n${event.payload.line}` },
          ]);
        }),
      );

      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        connectCodex(false)
          .then(async (connected) => {
            if (!connected) return undefined;
            window.setTimeout(() => {
              refreshEnterpriseCapabilities().catch(() => {});
            }, 8000);
            return undefined;
          })
          .catch((error) => appendError(`${APP_NAME}连接失败`, error));
      }
    };
    void registerListeners();

    return () => {
      if (serviceLogFlushTimerRef.current != null) {
        window.clearTimeout(serviceLogFlushTimerRef.current);
        serviceLogFlushTimerRef.current = null;
      }
      if (replySlowTimerRef.current != null) {
        window.clearTimeout(replySlowTimerRef.current);
        replySlowTimerRef.current = null;
      }
      if (replyTimeoutTimerRef.current != null) {
        window.clearTimeout(replyTimeoutTimerRef.current);
        replyTimeoutTimerRef.current = null;
      }
      unsubs.forEach((unlisten) => unlisten());
    };
  }, []);

  const activeConversation = useMemo(() => {
    if (!threadId) return null;
    return conversations.find((conversation) => conversation.id === threadId) ?? {
      id: threadId,
      title: '当前会话',
      updated: '刚刚',
      status: '运行中',
    };
  }, [conversations, threadId]);

  function appendError(title: string, error: unknown) {
    setTimeline((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'error', title, body: String(error) },
    ]);
  }

  async function ensureTauri(action: string) {
    if (isTauriRuntime) return true;
    appendError(action, '请在 Tauri 原生窗口中使用该能力。');
    return false;
  }

  async function connectCodex(showMessage = true) {
    if (!(await ensureTauri(`无法连接${APP_NAME}`))) return null;
    const check = codexCheck ?? (await invoke<CodexCheckResult>('codex_check'));
    setCodexCheck(check);
    if (!check.installed) {
      appendError('Codex CLI 未安装', check.error || '请先安装 codex 并确保在 PATH 中可用。');
      return null;
    }
    const currentStatus = await invoke<CodexStatus>('codex_status');
    let nextStatus = currentStatus;
    if (!nextStatus.running) {
      nextStatus = await invoke<CodexStatus>('codex_start');
      setThreadId(null);
      threadIdRef.current = null;
      threadWarmupRef.current = null;
    }
    if (!nextStatus.initialized) {
      await invoke<number>('codex_initialize', { clientName: 'yupao_codex' });
      nextStatus = { ...nextStatus, running: true, initialized: true };
    }
    setStatus(nextStatus);
    void refreshModelCatalog();
    if (showMessage) {
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'system', title: '连接就绪', body: '可以直接输入任务并发送。' },
      ]);
    }
    return nextStatus;
  }

  async function startCodex() {
    setBusy(true);
    try {
      await connectCodex(true);
    } catch (error) {
      appendError('启动 Codex 服务失败', error);
    } finally {
      setBusy(false);
    }
  }

  async function stopCodex() {
    setBusy(true);
    try {
      if (!(await ensureTauri('无法停止 Codex 服务'))) return;
      const nextStatus = await invoke<CodexStatus>('codex_stop');
      setStatus(nextStatus);
      setThreadId(null);
      threadIdRef.current = null;
      threadWarmupRef.current = null;
    } catch (error) {
      appendError('Codex 服务停止失败', error);
    } finally {
      setBusy(false);
    }
  }

  async function refreshEnterpriseCapabilities() {
    if (!isTauriRuntime) return;
    if (!(await connectCodex(false))) return;
    const cwd = projectPathRef.current || null;
    const activeThreadId = threadIdRef.current;
    await Promise.allSettled([
      invoke<number>('codex_list_skills', { cwd, forceReload: false }),
      invoke<number>('codex_list_mcp_servers', { threadId: activeThreadId }),
      refreshModelCatalog(),
    ]);
  }

  function getFirstProject(): Project | null {
    return projectsRef.current[0] ?? null;
  }

  function promptAddProject() {
    appendError('请先添加项目', addProjectHint);
  }

  function bindSessionProject(project: Project) {
    setSelectedProjectId(project.id);
    selectedProjectIdRef.current = project.id;
    setProjectPath(project.path);
    projectPathRef.current = project.path;
    pendingCreateSessionProjectIdRef.current = project.id;
    setExpandedProjectIds((current) => new Set(current).add(project.id));
  }

  async function startThread() {
    const firstProject = getFirstProject();
    if (!firstProject) {
      promptAddProject();
      return;
    }
    prepareDraftSession(firstProject);
    try {
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: firstProject.id });
      setSessions(nextSessions);
    } catch (error) {
      appendError('读取会话列表失败', error);
    }
  }

  function prepareDraftSession(project: Project | null) {
    if (project) {
      bindSessionProject(project);
    } else {
      setSelectedProjectId(null);
      selectedProjectIdRef.current = null;
      setProjectPath('');
      projectPathRef.current = '';
      pendingCreateSessionProjectIdRef.current = null;
    }
    setThreadId(null);
    threadIdRef.current = null;
    threadWarmupRef.current = null;
    pendingCreateSessionProjectIdRef.current = project?.id ?? null;
    pendingSessionModeRef.current = sessionMode;
    draftSessionRef.current = true;
    sessionHydrateRef.current = false;
    setPendingApprovals([]);
    setTurnTiming({});
    setTimeline([]);
    setWaitingForReply(false);
    setStreamingText('');
    streamingAgentRef.current = null;
    setTurnState('idle');
    setActiveNav('新对话');
    setSessionsListExpanded(true);
    void connectCodex(false);
  }

  async function upsertSessionForThread(threadId: string, text: string, attachments: ComposerAttachment[]) {
    const projectId = pendingCreateSessionProjectIdRef.current ?? selectedProjectIdRef.current;
    if (!projectId) return;
    const title = sessionTitleFromInput(text, attachments);
    const existing = sessionsRef.current.find((session) => session.thread_id === threadId);
    await invoke('session_upsert', {
      projectId,
      threadId,
      mode: existing?.mode ?? (sessionMode === 'worktree' ? 'worktree' : 'local'),
      worktreePath: existing?.worktree_path ?? null,
      title,
      updatedAt: nowSeconds(),
      status: existing?.status ?? sessionMode,
    });
    const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId });
    setSessions(nextSessions);
    setSessionsListExpanded(true);
  }

  async function resumeConversation(conversation: Conversation) {
    if (!(await connectCodex(false))) return;
    setThreadId(conversation.id);
    setActiveNav('历史会话');
    try {
      await invoke<number>('codex_resume_thread', { threadId: conversation.id });
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'system', title: '已恢复历史会话', body: conversation.title },
      ]);
    } catch (error) {
      appendError('恢复会话失败', error);
    }
  }

  async function warmupThread() {
    if (threadIdRef.current) return threadIdRef.current;
    if (threadWarmupRef.current) return threadWarmupRef.current;
    const task = (async () => {
      if (selectedProjectIdRef.current) {
        pendingCreateSessionProjectIdRef.current = selectedProjectIdRef.current;
        pendingSessionModeRef.current = sessionMode;
      }
      const permArgs = threadStartPermissionArgs(
        permissionModeRef.current,
        projectPathRef.current || null,
      );
      const id = await invoke<string>('codex_start_thread_sync', {
        cwd: projectPathRef.current || null,
        model: selectedModelRef.current || null,
        approvalPolicy: permArgs.approvalPolicy ?? null,
        approvalsReviewer: permArgs.approvalsReviewer ?? null,
        sandbox: permArgs.sandbox ?? null,
      });
      setThreadId(id);
      threadIdRef.current = id;
      draftSessionRef.current = false;
      await applyThreadPermissionSettings(id, permissionModeRef.current, projectPathRef.current || null);
      return id;
    })();
    threadWarmupRef.current = task;
    try {
      return await task;
    } finally {
      threadWarmupRef.current = null;
    }
  }

  async function ensureThreadId(): Promise<string> {
    const existing = threadIdRef.current;
    if (existing) return existing;
    if (threadWarmupRef.current) {
      const warmed = await threadWarmupRef.current;
      if (warmed) return warmed;
    }
    if (selectedProjectId) {
      pendingCreateSessionProjectIdRef.current = selectedProjectId;
      pendingSessionModeRef.current = sessionMode;
    }
    const permArgs = threadStartPermissionArgs(
      permissionModeRef.current,
      projectPathRef.current || projectPath || null,
    );
    const id = await invoke<string>('codex_start_thread_sync', {
      cwd: projectPath || null,
      model: selectedModelRef.current || null,
      approvalPolicy: permArgs.approvalPolicy ?? null,
      approvalsReviewer: permArgs.approvalsReviewer ?? null,
      sandbox: permArgs.sandbox ?? null,
    });
    setThreadId(id);
    threadIdRef.current = id;
    draftSessionRef.current = false;
    await applyThreadPermissionSettings(id, permissionModeRef.current, projectPathRef.current || projectPath || null);
    return id;
  }

  async function dispatchPrompt(payload: ComposerSubmitPayload) {
    const { text, attachments, planMode: nextPlanMode, goalMode: nextGoalMode } = payload;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    if (!threadIdRef.current) {
      const targetId = pendingCreateSessionProjectIdRef.current ?? selectedProjectIdRef.current;
      const targetProject = targetId ? projectsRef.current.find((project) => project.id === targetId) ?? null : null;
      if (!targetProject) {
        const firstProject = getFirstProject();
        if (!firstProject) {
          promptAddProject();
          return;
        }
        bindSessionProject(firstProject);
      } else {
        bindSessionProject(targetProject);
      }
    }

    let promptText = trimmed;
    if (nextPlanMode) {
      promptText = `请按步骤给出计划并标注风险与验证方式：\n${promptText || '请先给出一个简洁执行计划，再开始执行。'}`;
    }

    const pollToken = crypto.randomUUID();
    replyPollTokenRef.current = pollToken;
    setBusy(true);
    setWaitingForReply(true);
    setStreamingText('');
    streamingAgentRef.current = null;

    const timelineBody =
      attachments.length > 0
        ? [trimmed, attachments.map((item) => `[${item.kind === 'image' ? '图片' : '文件'}] ${item.name}`).join('\n')]
            .filter(Boolean)
            .join('\n')
        : trimmed;

    pendingSessionTitleRef.current = sessionTitleFromInput(trimmed, attachments);

    setTimeline((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'user', title: '用户', body: timelineBody },
    ]);

    try {
      if (!(await connectCodex(false))) {
        replyPollTokenRef.current = null;
        setWaitingForReply(false);
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'agent', title: '助手', body: '连接失败，请确认 Codex CLI 已安装且可运行。' },
        ]);
        return;
      }

      const activeThreadId = await ensureThreadId();
      await upsertSessionForThread(activeThreadId, trimmed, attachments);

      if (nextGoalMode && goalObjective.trim()) {
        await invoke<number>('codex_set_thread_goal', {
          threadId: activeThreadId,
          objective: goalObjective.trim(),
          status: goalStatus.trim() || 'active',
          tokenBudget: goalTokenBudget.trim() ? Number(goalTokenBudget.trim()) : null,
        });
      }

      const permissionSettings = permissionModeToSettings(
        permissionModeRef.current,
        projectPath || null,
      );
      const turnInput = buildTurnInput(attachments, promptText);

      await invoke<number>('codex_start_turn', {
        threadId: activeThreadId,
        text: null,
        input: turnInput,
        cwd: projectPath || null,
        model: selectedModelRef.current || null,
        effort: selectedEffortRef.current || null,
        approvalPolicy: permissionSettings?.approvalPolicy ?? null,
        approvalsReviewer: permissionSettings?.approvalsReviewer ?? null,
        sandboxPolicy: permissionSettings?.sandboxPolicy ?? null,
      });
      void syncPollAgentReply(activeThreadId, pollToken);
    } catch (error) {
      replyPollTokenRef.current = null;
      threadWarmupRef.current = null;
      setWaitingForReply(false);
      setStreamingText('');
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'agent', title: '助手', body: `发送失败：${String(error)}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function dispatchPromptText(text: string) {
    await dispatchPrompt({ text, attachments: [], planMode: false, goalMode: false });
  }

  async function executeSlashCommand(raw: string) {
    const [cmd, ...args] = raw.slice(1).split(/\s+/);
    const argText = args.join(' ').trim();
    switch (cmd) {
      case 'help':
        setTimeline((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'system',
            title: 'Slash 命令',
            body: [
              '/help',
              '/status',
              '/clear',
              '/new',
              '/review',
              '/diff',
              '/thread-name <name>',
              '/thread-archive',
              '/thread-unarchive',
              '/thread-fork',
              '/thread-rollback <n>',
              '/goal-set <objective>',
              '/goal-get',
              '/goal-clear',
              '/meta-git <branch> [sha] [originUrl]',
              '/threads [search]',
              '/connect',
              '/interrupt',
              '/settings',
              '/skills',
              '/mcp',
              '/mcp-read <server> <uri>',
              '/mcp-call <server> <tool> [json]',
              '/exec <shell command>',
              '/exec-write <text>',
              '/exec-resize <cols> <rows>',
              '/exec-stop',
              '/git stage-all|unstage-all|revert-all',
              '/git stage <路径>',
              '/git unstage <路径>',
              '/git revert <路径>',
              '/git commit <提交信息>',
              '/plan [text]',
            ].join(' '),
          },
        ]);
        return;
      case 'status':
        setTimeline((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'system',
            title: '当前状态',
            body: `连接=${status.running ? '已连接' : '未连接'} 初始化=${status.initialized ? '已完成' : '未完成'} 会话=${threadId ?? '无'} 项目=${projectPath}`,
          },
        ]);
        return;
      case 'new':
        await startThread();
        return;
      case 'review':
        await startReview();
        return;
      case 'thread-name': {
        if (!argText) {
          appendError('thread-name 参数不足', '/thread-name <name>');
          return;
        }
        await renameCurrentThread(argText);
        return;
      }
      case 'thread-archive':
        await archiveCurrentThread();
        return;
      case 'thread-unarchive':
        await unarchiveCurrentThread();
        return;
      case 'thread-fork':
        await forkCurrentThread();
        return;
      case 'thread-rollback': {
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 1) {
          appendError('thread-rollback 参数不足', '/thread-rollback <n>');
          return;
        }
        await rollbackCurrentThread(n);
        return;
      }
      case 'goal-set':
        setGoalObjective(argText);
        await setCurrentThreadGoal(argText);
        return;
      case 'goal-get':
        await getCurrentThreadGoal();
        return;
      case 'goal-clear':
        await clearCurrentThreadGoal();
        return;
      case 'meta-git': {
        const branch = args[0]?.trim() ?? '';
        const sha = args[1]?.trim() ?? '';
        const originUrl = args.slice(2).join(' ').trim();
        if (!branch) {
          appendError('meta-git 参数不足', '/meta-git <branch> [sha] [originUrl]');
          return;
        }
        setMetadataBranch(branch);
        setMetadataSha(sha);
        setMetadataOrigin(originUrl);
        await updateCurrentThreadMetadataGit({ branch, sha, originUrl });
        return;
      }
      case 'diff':
        setDiffOpen(true);
        await refreshDiff();
        return;
      case 'threads':
        await connectCodex(false);
        await invoke<number>('codex_list_threads', { cwd: projectPath || null, searchTerm: argText || null });
        return;
      case 'connect':
        await startCodex();
        return;
      case 'interrupt':
        await interrupt();
        return;
      case 'settings':
        await openSettings();
        return;
      case 'clear':
        setTimeline([{ id: crypto.randomUUID(), kind: 'system', title: '已清空', body: 'timeline 已清空。' }]);
        return;
      case 'skills':
        await refreshEnterpriseCapabilities();
        setTimeline((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'system',
            title: `技能（${skills.length}）`,
            body: skills.length ? skills.map((s) => `- ${s.name}（${s.meta}）`).join('\n') : '暂无技能',
          },
        ]);
        return;
      case 'mcp':
        await refreshEnterpriseCapabilities();
        setTimeline((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'system',
            title: `MCP（${mcpServers.length}）`,
            body: mcpServers.length ? mcpServers.map((s) => `- ${s.name}（${s.meta}）`).join('\n') : '暂无 MCP 服务器',
          },
        ]);
        return;
      case 'mcp-read': {
        const server = args[0]?.trim();
        const uri = args.slice(1).join(' ').trim();
        if (!server || !uri) {
          appendError('mcp-read 参数不足', '/mcp-read <server> <uri>');
          return;
        }
        setMcpReadServer(server);
        setMcpReadUri(uri);
        await mcpReadResource();
        return;
      }
      case 'mcp-call': {
        const server = args[0]?.trim();
        const tool = args[1]?.trim();
        const rawJson = args.slice(2).join(' ').trim();
        if (!server || !tool) {
          appendError('mcp-call 参数不足', '/mcp-call <server> <tool> [json]');
          return;
        }
        setMcpToolServer(server);
        setMcpToolName(tool);
        if (rawJson) setMcpToolArgs(rawJson);
        await mcpCallTool();
        return;
      }
      case 'exec': {
        if (!argText) {
          appendError('exec 参数不足', '/exec <shell command>');
          return;
        }
        setExecCommand(argText);
        await startExecCommand();
        return;
      }
      case 'exec-write': {
        setExecStdin(argText);
        await writeExecStdin(false);
        return;
      }
      case 'exec-resize': {
        const cols = Number(args[0]);
        const rows = Number(args[1]);
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
          appendError('exec-resize 参数不足', '/exec-resize <cols> <rows>');
          return;
        }
        setExecCols(Math.max(1, Math.floor(cols)));
        setExecRows(Math.max(1, Math.floor(rows)));
        await resizeExecCommand();
        return;
      }
      case 'exec-stop':
        await stopExecCommand();
        return;
      case 'git': {
        const sub = (args[0] || '').trim();
        const rest = args.slice(1).join(' ').trim();
        if (!sub) {
          setTimeline((current) => [
            ...current,
            { id: crypto.randomUUID(), kind: 'system', title: 'Git Slash 用法', body: '/git stage-all|unstage-all|revert-all|stage <路径>|unstage <路径>|revert <路径>|commit <提交信息>' },
          ]);
          return;
        }
        if (sub === 'stage-all') {
          await stageAllChanges();
          return;
        }
        if (sub === 'unstage-all') {
          await unstageAllChanges();
          return;
        }
        if (sub === 'revert-all') {
          await revertAllChanges();
          return;
        }
        if (sub === 'stage') {
          if (!rest) {
            appendError('Git stage 缺少路径', raw);
            return;
          }
          await stagePath(rest);
          return;
        }
        if (sub === 'unstage') {
          if (!rest) {
            appendError('Git unstage 缺少路径', raw);
            return;
          }
          await unstagePath(rest);
          return;
        }
        if (sub === 'revert') {
          if (!rest) {
            appendError('Git revert 缺少路径', raw);
            return;
          }
          await revertPath(rest);
          return;
        }
        if (sub === 'commit') {
          if (!rest) {
            appendError('Git commit 缺少提交信息', raw);
            return;
          }
          try {
            if (!(await ensureTauri('无法提交代码'))) return;
            const out = await invoke<string>('git_commit', { cwd: projectPath, message: rest });
            await refreshDiff();
            setTimeline((current) => [
              ...current,
              { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: `$ git commit -m "${rest}"\n${out || 'OK'}` },
            ]);
          } catch (error) {
            appendError('提交失败', error);
          }
          return;
        }
        appendError('未知 git 子命令', raw);
        return;
      }
      case 'plan': {
        const body = argText || '请先给出一个简洁执行计划，再开始执行。';
        await dispatchPromptText(`请按步骤给出计划并标注风险与验证方式：\n${body}`);
        return;
      }
      default:
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'error', title: '未知 Slash 命令', body: raw },
        ]);
    }
  }

  async function sendPrompt(payload: ComposerSubmitPayload) {
    const text = payload.text.trim();
    if (text.startsWith('/') && payload.attachments.length === 0) {
      await executeSlashCommand(text);
      return;
    }
    await dispatchPrompt(payload);
  }

  async function interrupt() {
    if (!threadId) return;
    try {
      if (!(await ensureTauri('无法中断任务'))) return;
      await invoke<number>('codex_interrupt_turn', { threadId });
    } catch (error) {
      appendError('中断失败', error);
    }
  }

  async function answerApproval(approval: PendingApproval, accept: boolean) {
    try {
      if (!(await ensureTauri('无法处理审批'))) return;
      let result: unknown = approvalResult(approval.method, accept);
      if (!result && approval.method === 'item/tool/requestUserInput' && accept) {
        result = buildUserInputResponse(approval.params);
      }
      if (!result && approval.method === 'mcpServer/elicitation/request') {
        result = buildMcpElicitationResponse(approval.params, accept);
      }
      if (result) {
        await invoke('codex_respond_to_server_request', {
          id: approval.id,
          result,
        });
      } else {
        await invoke('codex_reject_server_request', {
          id: approval.id,
          message: accept ? '当前客户端尚未支持该审批类型的确认结构' : '用户拒绝该请求',
        });
      }
      setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'approval', title: accept && result ? '已同意审批' : '已拒绝审批', body: approval.method },
      ]);
    } catch (error) {
      appendError('审批处理失败', error);
    }
  }

  const navItems = [
    { label: '新对话', icon: MessageSquareText },
    { label: '搜索', icon: Search },
    { label: '插件', icon: Puzzle, disabled: true },
    { label: '自动化', icon: CalendarClock, disabled: true },
  ];

  async function pickAndAddProject() {
    try {
      if (!(await ensureTauri('无法选择文件夹'))) return;
      const selection = await openDialog({
        directory: true,
        multiple: false,
        title: '选择项目文件夹',
      });
      const path = typeof selection === 'string' ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!path) return;

      const existing = projectsRef.current.find((project) => project.path === path);
      if (existing) {
        await selectProject(existing);
        return;
      }

      const created = await invoke<Project>('project_add', { path, name: null, now: nowSeconds() });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
      setSelectedProjectId(created.id);
      setProjectPath(created.path);
      projectPathRef.current = created.path;
      selectedProjectIdRef.current = created.id;
      setSessionsListExpanded(true);
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: created.id });
      setSessions(nextSessions);
      await invoke('project_touch', { projectId: created.id, now: nowSeconds() });
    } catch (error) {
      appendError('添加项目失败', error);
    }
  }

  function toggleProjectExpanded(projectId: number) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  async function selectProject(project: Project) {
    setSelectedProjectId(project.id);
    selectedProjectIdRef.current = project.id;
    setProjectPath(project.path);
    projectPathRef.current = project.path;
    setExpandedProjectIds((current) => new Set(current).add(project.id));
    draftSessionRef.current = true;
    sessionHydrateRef.current = false;
    setThreadId(null);
    threadIdRef.current = null;
    threadWarmupRef.current = null;
    pendingCreateSessionProjectIdRef.current = null;
    setPendingApprovals([]);
    setTurnTiming({});
    setTimeline([]);
    setSessionsListExpanded(false);
    try {
      await invoke('project_touch', { projectId: project.id, now: nowSeconds() });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: project.id });
      setSessions(nextSessions);
      await connectCodex(false);
    } catch (error) {
      appendError('切换项目失败', error);
    }
  }

  async function beginRenameProject(project: Project) {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  }

  async function submitRenameProject() {
    const projectId = editingProjectId;
    const name = editingProjectName.trim();
    if (!projectId) return;
    if (!name) {
      setEditingProjectId(null);
      return;
    }
    try {
      await invoke('project_rename', { projectId, name });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
    } catch (error) {
      appendError('重命名项目失败', error);
    } finally {
      setEditingProjectId(null);
    }
  }

  function openProjectContextMenu(event: React.MouseEvent, project: Project) {
    event.preventDefault();
    event.stopPropagation();
    setProjectContextMenu({ project, x: event.clientX, y: event.clientY });
  }

  async function togglePinProject(project: ProjectMenuTarget) {
    try {
      if (!(await ensureTauri('无法置顶项目'))) return;
      await invoke('project_set_pinned', {
        projectId: project.id,
        pinned: !project.pinned,
      });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
    } catch (error) {
      appendError('置顶项目失败', error);
    }
  }

  async function openProjectDirectory(project: ProjectMenuTarget) {
    try {
      if (!(await ensureTauri('无法打开目录'))) return;
      await invoke('open_path', { path: project.path });
    } catch (error) {
      appendError('打开目录失败', error);
    }
  }

  function renameProjectFromMenu(project: ProjectMenuTarget) {
    const existing = projectsRef.current.find((item) => item.id === project.id);
    if (existing) beginRenameProject(existing);
  }

  async function removeProjectFromApp(project: ProjectMenuTarget) {
    try {
      if (!(await ensureTauri('无法移除项目'))) return;
      await invoke('project_remove', { projectId: project.id });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        next.delete(project.id);
        return next;
      });
      if (selectedProjectIdRef.current === project.id) {
        const fallback = nextProjects[0] ?? null;
        if (fallback) {
          await selectProject(fallback);
        } else {
          setSelectedProjectId(null);
          selectedProjectIdRef.current = null;
          setProjectPath('');
          projectPathRef.current = '';
          prepareDraftSession(null);
        }
      }
    } catch (error) {
      appendError('移除项目失败', error);
    }
  }

  function startSessionUnderProject(project: Project) {
    prepareDraftSession(project);
  }

  async function removeWorktree(session: SessionRow) {
    const project = projectsRef.current.find((p) => p.id === session.project_id);
    if (!project || !session.worktree_path) return;
    try {
      await invoke('worktree_remove', { projectPath: project.path, worktreePath: session.worktree_path });
      await invoke('session_upsert', {
        projectId: session.project_id,
        threadId: session.thread_id,
        mode: 'local',
        worktreePath: null,
        title: session.title || null,
        updatedAt: session.updated_at ?? null,
        status: 'local',
      });
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: session.project_id });
      setSessions(nextSessions);
      if (threadId === session.thread_id) {
        setProjectPath(project.path);
      }
    } catch (error) {
      appendError('移除 worktree 失败', error);
    }
  }

  async function openSettings() {
    setSettingsOpen(true);
    setActiveNav('设置');
    try {
      const snapshot = await invoke<CodexConfigSnapshot>('codex_read_config');
      setConfigSnapshot(snapshot);
      setConfigDraft(snapshot.contents);
      setQuickModel(readConfigValue(snapshot.contents, 'model'));
      setQuickApproval(readConfigValue(snapshot.contents, 'approval_policy'));
      setQuickSandbox(readConfigValue(snapshot.contents, 'sandbox'));
      await refreshEnterpriseCapabilities();
    } catch (error) {
      appendError('读取配置失败', error);
    }
  }

  async function saveSettings() {
    try {
      const snapshot = await invoke<CodexConfigSnapshot>('codex_write_config', { contents: configDraft });
      setConfigSnapshot(snapshot);
      setConfigDraft(snapshot.contents);
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '配置已保存', body: snapshot.path }]);
    } catch (error) {
      appendError('保存配置失败', error);
    }
  }

  function applyQuickSettingsToDraft() {
    let next = configDraft;
    if (quickModel.trim()) next = upsertConfigValue(next, 'model', quickModel.trim());
    if (quickApproval.trim()) next = upsertConfigValue(next, 'approval_policy', quickApproval.trim());
    if (quickSandbox.trim()) next = upsertConfigValue(next, 'sandbox', quickSandbox.trim());
    setConfigDraft(next);
  }

  async function enableWorktree(session: SessionRow) {
    const project = projects.find((p) => p.id === session.project_id);
    if (!project) return;
    try {
      if (!(await ensureTauri('无法创建 worktree'))) return;
      const path = await invoke<string>('worktree_create', { projectPath: project.path, sessionThreadId: session.thread_id });
      await invoke('session_upsert', {
        projectId: session.project_id,
        threadId: session.thread_id,
        mode: 'worktree',
        worktreePath: path,
        title: session.title || null,
        updatedAt: session.updated_at ?? null,
        status: session.status || null,
      });
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: session.project_id });
      setSessions(nextSessions);
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Worktree 已创建', body: path }]);
    } catch (error) {
      appendError('创建 worktree 失败', error);
    }
  }

  async function openSession(session: SessionRow) {
    const project = projectsRef.current.find((p) => p.id === session.project_id);
    if (project) {
      setSelectedProjectId(project.id);
      setProjectPath(session.worktree_path || project.path);
      setSessionMode(session.mode === 'worktree' ? 'worktree' : 'local');
      invoke('project_touch', { projectId: project.id, now: nowSeconds() }).catch(() => {});
    }
    draftSessionRef.current = false;
    sessionHydrateRef.current = true;
    setThreadId(session.thread_id);
    setActiveNav('历史会话');
    setBusy(true);
    try {
      await connectCodex(false);
      await invoke<number>('codex_resume_thread', { threadId: session.thread_id });
      await invoke<number>('codex_read_thread', { threadId: session.thread_id, includeTurns: true });
    } catch (error) {
      appendError('打开会话失败', error);
    } finally {
      setBusy(false);
    }
  }

  async function togglePinSession(session: SessionRow) {
    try {
      if (!(await ensureTauri('无法置顶会话'))) return;
      await invoke('session_set_pinned', {
        projectId: session.project_id,
        threadId: session.thread_id,
        pinned: !session.pinned,
      });
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: session.project_id });
      setSessions(nextSessions);
    } catch (error) {
      appendError('置顶会话失败', error);
    }
  }

  async function deleteSession(session: SessionRow) {
    try {
      if (!(await ensureTauri('无法删除会话'))) return;
      await invoke('session_delete', {
        projectId: session.project_id,
        threadId: session.thread_id,
      });
      if (threadIdRef.current === session.thread_id) {
        const project = projectsRef.current.find((p) => p.id === session.project_id) ?? null;
        prepareDraftSession(project);
      }
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: session.project_id });
      setSessions(nextSessions);
    } catch (error) {
      appendError('删除会话失败', error);
    }
  }

  async function runTerminalCommand() {
    const cmd = terminalCommand.trim();
    if (!cmd) return;
    try {
      if (!(await ensureTauri('无法运行终端命令'))) return;
      const cwd = projectPath;
      const out = await invoke<{ status: number; stdout: string; stderr: string }>('terminal_run_readonly', { cwd, command: cmd });
      const chunk = [
        `$ ${cmd}`,
        out.stdout?.trimEnd() || '',
        out.stderr?.trimEnd() || '',
        out.status !== 0 ? `(exit ${out.status})` : '',
      ]
        .filter(Boolean)
        .join('\n');
      setTerminalLog((prev) => (prev ? `${prev}\n\n${chunk}` : chunk));
    } catch (error) {
      appendError('终端命令执行失败', error);
    }
  }

  async function refreshDiff() {
    try {
      if (!(await ensureTauri('无法读取 diff'))) return;
      const cwd = projectPath;
      const [snapshot, diff, staged] = await Promise.all([
        invoke<GitSnapshot>('git_snapshot', { cwd }),
        invoke<string>('git_diff', { cwd }),
        invoke<string>('git_diff_staged', { cwd }),
      ]);
      setGitStatusShort(snapshot.status || '');
      setDiffText(diff || '');
      setStagedDiffText(staged || '');
      const files = await invoke<GitChangedFile[]>('git_changed_files', { cwd });
      setChangedFiles(files);
    } catch (error) {
      appendError('读取 diff 失败', error);
    }
  }

  async function stageAllChanges() {
    try {
      if (!(await ensureTauri('无法暂存变更'))) return;
      await invoke('git_stage_all', { cwd: projectPath });
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: '已暂存全部变更（git add -A）' }]);
    } catch (error) {
      appendError('暂存失败', error);
    }
  }

  async function unstageAllChanges() {
    try {
      if (!(await ensureTauri('无法取消暂存'))) return;
      await invoke('git_unstage_all', { cwd: projectPath });
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: '已取消全部暂存（git reset -- .）' }]);
    } catch (error) {
      appendError('取消暂存失败', error);
    }
  }

  async function revertAllChanges() {
    try {
      if (!(await ensureTauri('无法回退工作区变更'))) return;
      await invoke('git_revert_all', { cwd: projectPath });
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: '已回退工作区跟踪文件变更（git restore --worktree）' }]);
    } catch (error) {
      appendError('回退失败', error);
    }
  }

  async function commitAllChanges() {
    const msg = commitMessage.trim();
    if (!msg) return;
    try {
      if (!(await ensureTauri('无法提交代码'))) return;
      await invoke('git_commit', { cwd: projectPath, message: msg });
      setCommitMessage('');
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: `已提交：${msg}` }]);
    } catch (error) {
      appendError('提交失败', error);
    }
  }

  async function stagePath(path: string) {
    try {
      if (!(await ensureTauri('无法暂存文件'))) return;
      await invoke('git_stage_path', { cwd: projectPath, path });
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: `已暂存：${path}` }]);
    } catch (error) {
      appendError(`暂存文件失败: ${path}`, error);
    }
  }

  async function unstagePath(path: string) {
    try {
      if (!(await ensureTauri('无法取消暂存文件'))) return;
      await invoke('git_unstage_path', { cwd: projectPath, path });
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: `已取消暂存：${path}` }]);
    } catch (error) {
      appendError(`取消暂存失败: ${path}`, error);
    }
  }

  async function revertPath(path: string) {
    try {
      if (!(await ensureTauri('无法回退文件'))) return;
      await invoke('git_revert_path', { cwd: projectPath, path });
      await refreshDiff();
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Git', body: `已回退：${path}` }]);
    } catch (error) {
      appendError(`回退文件失败: ${path}`, error);
    }
  }

  async function startReview() {
    try {
      if (!(await connectCodex(false))) return;
      if (threadId) {
        await invoke<number>('codex_start_review_uncommitted', { threadId });
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'system', title: '官方 Review', body: '已发起 review/start（uncommittedChanges）。' },
        ]);
        return;
      }
      const fallbackPrompt = '请对当前项目未提交改动做一次 code review（找 P0/P1 风险，给出可执行修改建议）。';
      await dispatchPromptText(fallbackPrompt);
    } catch (error) {
      appendError('启动 review 失败', error);
    }
  }

  async function renameCurrentThread(name: string) {
    const nextName = name.trim();
    if (!threadId || !nextName) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_set_thread_name', { threadId, name: nextName });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话', body: `已重命名为：${nextName}` }]);
    } catch (error) {
      appendError('会话重命名失败', error);
    }
  }

  async function archiveCurrentThread() {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_archive_thread', { threadId });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话', body: `已归档：${threadId}` }]);
    } catch (error) {
      appendError('会话归档失败', error);
    }
  }

  async function unarchiveCurrentThread() {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_unarchive_thread', { threadId });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话', body: `已取消归档：${threadId}` }]);
    } catch (error) {
      appendError('取消归档失败', error);
    }
  }

  async function forkCurrentThread() {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_fork_thread', { threadId, cwd: projectPath || null });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话', body: `已提交分叉请求：${threadId}` }]);
    } catch (error) {
      appendError('分叉会话失败', error);
    }
  }

  async function rollbackCurrentThread(numTurns: number) {
    if (!threadId || !Number.isFinite(numTurns) || numTurns < 1) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_rollback_thread', { threadId, numTurns: Math.floor(numTurns) });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话', body: `已回滚最近 ${Math.floor(numTurns)} 轮` }]);
    } catch (error) {
      appendError('回滚会话失败', error);
    }
  }

  async function setCurrentThreadGoal(objectiveOverride?: string) {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      const objective = (objectiveOverride ?? goalObjective).trim() || null;
      const status = goalStatus.trim() || null;
      const tokenBudget = goalTokenBudget.trim() ? Number(goalTokenBudget.trim()) : null;
      await invoke<number>('codex_set_thread_goal', {
        threadId,
        objective,
        status,
        tokenBudget: tokenBudget && Number.isFinite(tokenBudget) ? Math.floor(tokenBudget) : null,
      });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话目标', body: '已设置 thread/goal' }]);
    } catch (error) {
      appendError('设置会话目标失败', error);
    }
  }

  async function getCurrentThreadGoal() {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_get_thread_goal', { threadId });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话目标', body: '已请求读取 thread/goal' }]);
    } catch (error) {
      appendError('读取会话目标失败', error);
    }
  }

  async function clearCurrentThreadGoal() {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_clear_thread_goal', { threadId });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话目标', body: '已清空 thread/goal' }]);
    } catch (error) {
      appendError('清空会话目标失败', error);
    }
  }

  async function updateCurrentThreadMetadataGit(overrides?: { sha?: string; branch?: string; originUrl?: string }) {
    if (!threadId) return;
    try {
      if (!(await connectCodex(false))) return;
      const nextSha = overrides?.sha ?? metadataSha;
      const nextBranch = overrides?.branch ?? metadataBranch;
      const nextOrigin = overrides?.originUrl ?? metadataOrigin;
      await invoke<number>('codex_update_thread_metadata_git', {
        threadId,
        sha: clearMetadataSha ? null : nextSha.trim() || null,
        branch: clearMetadataBranch ? null : nextBranch.trim() || null,
        originUrl: clearMetadataOrigin ? null : nextOrigin.trim() || null,
        clearSha: clearMetadataSha,
        clearBranch: clearMetadataBranch,
        clearOriginUrl: clearMetadataOrigin,
      });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '会话元数据', body: '已提交 thread/metadata/update' }]);
      setThreadGitInfo({
        sha: clearMetadataSha ? null : nextSha.trim() || null,
        branch: clearMetadataBranch ? null : nextBranch.trim() || null,
        originUrl: clearMetadataOrigin ? null : nextOrigin.trim() || null,
      });
    } catch (error) {
      appendError('更新会话元数据失败', error);
    }
  }

  async function startExecCommand() {
    const cmd = execCommand.trim();
    if (!cmd) return;
    try {
      if (!(await connectCodex(false))) return;
      const processId = crypto.randomUUID();
      const commandArgv = ['zsh', '-lc', cmd];
      const requestId = await invoke<number>('codex_command_exec', {
        processId,
        command: commandArgv,
        cwd: projectPath || null,
        tty: execTty,
        cols: execTty ? execCols : null,
        rows: execTty ? execRows : null,
      });
      execPendingRequestIdRef.current = requestId;
      setExecRunning(true);
      setExecProcessId(processId);
      setExecLog((prev) => `${prev}${prev ? '\n' : ''}$ ${cmd}\n`);
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'tool', title: 'Exec', body: `$ ${cmd}` }]);
    } catch (error) {
      appendError('执行命令失败', error);
    }
  }

  async function writeExecStdin(closeStdin = false) {
    const processId = execProcessIdRef.current;
    if (!processId) return;
    try {
      const payload = execStdin ? encodeBase64Utf8(execStdin) : null;
      await invoke<number>('codex_command_exec_write', {
        processId,
        deltaBase64: payload,
        closeStdin,
      });
      if (execStdin) setExecStdin('');
    } catch (error) {
      appendError('写入 stdin 失败', error);
    }
  }

  async function stopExecCommand() {
    const processId = execProcessIdRef.current;
    if (!processId) return;
    try {
      await invoke<number>('codex_command_exec_terminate', { processId });
      setExecRunning(false);
      setExecProcessId(null);
      execPendingRequestIdRef.current = null;
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Exec', body: `已终止：${processId}` }]);
    } catch (error) {
      appendError('终止命令失败', error);
    }
  }

  async function resizeExecCommand() {
    const processId = execProcessIdRef.current;
    if (!processId || !execRunning) return;
    try {
      await invoke<number>('codex_command_exec_resize', {
        processId,
        cols: Math.max(1, Math.floor(execCols)),
        rows: Math.max(1, Math.floor(execRows)),
      });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'Exec', body: `已调整尺寸 ${execCols}x${execRows}` }]);
    } catch (error) {
      appendError('调整终端尺寸失败', error);
    }
  }

  async function mcpReadResource() {
    const server = mcpReadServer.trim();
    const uri = mcpReadUri.trim();
    if (!server || !uri) {
      appendError('MCP 资源读取参数缺失', '请填写 server 和 uri');
      return;
    }
    try {
      if (!(await connectCodex(false))) return;
      await invoke<number>('codex_mcp_read_resource', { threadId, server, uri });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'MCP', body: `读取资源：${server} ${uri}` }]);
    } catch (error) {
      appendError('读取 MCP 资源失败', error);
    }
  }

  async function mcpCallTool() {
    const server = mcpToolServer.trim();
    const tool = mcpToolName.trim();
    if (!threadId) {
      appendError('调用 MCP 工具失败', '请先创建或打开一个会话。');
      return;
    }
    if (!server || !tool) {
      appendError('MCP 工具调用参数缺失', '请填写 server 和 tool');
      return;
    }
    try {
      if (!(await connectCodex(false))) return;
      const raw = mcpToolArgs.trim();
      const args = raw ? JSON.parse(raw) : {};
      await invoke<number>('codex_mcp_call_tool', { threadId, server, tool, arguments: args });
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: 'MCP', body: `调用工具：${server}/${tool}` }]);
    } catch (error) {
      appendError('调用 MCP 工具失败', error);
    }
  }

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title || '').toLowerCase().includes(q) || s.thread_id.toLowerCase().includes(q));
  }, [sessions, searchQuery]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const projectSessions = useMemo(() => {
    if (!selectedProjectId) return [];
    return filteredSessions
      .filter((session) => session.project_id === selectedProjectId)
      .sort((a, b) => {
        const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pinDiff !== 0) return pinDiff;
        return (b.updated_at ?? 0) - (a.updated_at ?? 0);
      });
  }, [filteredSessions, selectedProjectId]);

  const visibleProjectSessions = useMemo(() => {
    if (sessionsListExpanded) return projectSessions;
    return projectSessions.slice(0, 5);
  }, [projectSessions, sessionsListExpanded]);

  const draftMode = !threadId && !!selectedProject;

  const threadTimeline = useMemo(() => timeline.filter(isThreadRenderable), [timeline]);

  const visibleTimeline = useMemo(() => {
    const limit = 200;
    if (threadTimeline.length <= limit) return threadTimeline;
    return threadTimeline.slice(-limit);
  }, [threadTimeline]);

  const showThinkingShimmer = useMemo(() => {
    if (!waitingForReply) return false;
    const hasInProgress = visibleTimeline.some(
      (evt) => evt.turnIndex === turnIndex && evt.completed === false,
    );
    return !hasInProgress && turnState === 'thinking';
  }, [waitingForReply, visibleTimeline, turnState, turnIndex]);

  const activeThreadTitle = useMemo(() => {
    if (threadId) {
      const session = sessions.find((item) => item.thread_id === threadId);
      if (session?.title?.trim()) return session.title.trim();
    }
    return activeConversation?.title ?? '新对话';
  }, [threadId, sessions, activeConversation]);

  const renderedTimeline = useMemo(
    () => (
      <ThreadTimelineView
        items={visibleTimeline}
        turnTiming={turnTiming}
        activeTurnIndex={turnIndex}
        waitingForReply={waitingForReply}
      />
    ),
    [visibleTimeline, turnTiming, turnIndex, waitingForReply],
  );

  const showProjectHero = draftMode && visibleTimeline.length === 0 && !waitingForReply && !showThinkingShimmer;

  return (
    <div className="app-shell codex-shell">
      <aside className="sidebar codex-sidebar">
        <nav className="nav-stack">
          {navItems.map((item) => {
            const Icon = item.icon;
            const disabled = Boolean(item.disabled);
            return (
              <button
                key={item.label}
                type="button"
                className={[
                  'nav-item',
                  activeNav === item.label && !disabled ? 'active' : '',
                  disabled ? 'is-disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={disabled}
                title={disabled ? '功能开发中' : undefined}
                onClick={() => {
                  if (disabled) return;
                  setActiveNav(item.label);
                  setSettingsOpen(false);
                  if (item.label === '新对话') void startThread();
                }}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {activeNav === '搜索' && (
          <section className="sidebar-section">
            <div className="sidebar-label">搜索会话</div>
            <input
              className="project-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="输入关键字（标题/ID）"
            />
          </section>
        )}

        <section className="sidebar-section project-section">
          <div className="sidebar-section-header">
            <span className="sidebar-label">项目</span>
            <div className="sidebar-header-actions">
              <button className="sidebar-icon-btn" type="button" title="更多" onClick={openSettings}>
                <MoreHorizontal size={15} />
              </button>
              <button className="sidebar-icon-btn" type="button" title="添加文件夹" onClick={() => void pickAndAddProject()}>
                <FolderPlus size={15} />
              </button>
            </div>
          </div>

          {projects.length === 0 ? (
            <div className="project-empty">
              <FolderOpen size={15} />
              <span>暂无对话</span>
            </div>
          ) : (
            <div className="project-list">
              {projects.map((project) => {
                const isActive = project.id === selectedProjectId;
                const isExpanded = expandedProjectIds.has(project.id);
                return (
                  <div
                    key={project.id}
                    className={isActive ? 'project-group selected' : 'project-group'}
                    onContextMenu={(event) => openProjectContextMenu(event, project)}
                  >
                    <div className="project-group-header">
                      <button
                        className="project-chevron-btn"
                        type="button"
                        title={isExpanded ? '收起会话' : '展开会话'}
                        onClick={() => {
                          if (isActive) {
                            toggleProjectExpanded(project.id);
                            return;
                          }
                          void selectProject(project);
                        }}
                      >
                        {isActive && isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <button
                        className="project-folder-btn"
                        type="button"
                        onClick={() => {
                          if (isActive && isExpanded) {
                            toggleProjectExpanded(project.id);
                            return;
                          }
                          void selectProject(project);
                        }}
                        title={project.path}
                      >
                        <FolderOpen size={15} />
                        {editingProjectId === project.id ? (
                          <input
                            className="project-rename"
                            value={editingProjectName}
                            onChange={(e) => setEditingProjectName(e.target.value)}
                            onBlur={() => submitRenameProject()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitRenameProject();
                              if (e.key === 'Escape') setEditingProjectId(null);
                            }}
                            autoFocus
                          />
                        ) : (
                          <span onDoubleClick={() => beginRenameProject(project)}>{project.name}</span>
                        )}
                      </button>
                      <div className="project-group-actions">
                        <button
                          className="sidebar-icon-btn"
                          type="button"
                          title="新建会话"
                          onClick={() => startSessionUnderProject(project)}
                        >
                          <SquarePen size={15} />
                        </button>
                      </div>
                    </div>

                    {isActive && isExpanded ? (
                      <div className="project-sessions">
                        {projectSessions.length === 0 ? (
                          <div className="project-session-empty">
                            <FolderOpen size={14} />
                            <span>暂无对话</span>
                          </div>
                        ) : (
                          <>
                            {visibleProjectSessions.map((session) => (
                              <div
                                key={`${session.project_id}-${session.thread_id}`}
                                className={
                                  session.thread_id === threadId
                                    ? `project-session-row selected${session.pinned ? ' pinned' : ''}`
                                    : `project-session-row${session.pinned ? ' pinned' : ''}`
                                }
                              >
                                <button
                                  type="button"
                                  className="project-session-item"
                                  onClick={() => void openSession(session)}
                                >
                                  <span className="project-session-title">{session.title || '未命名会话'}</span>
                                  <span className="project-session-time">{formatTime(session.updated_at) || '刚刚'}</span>
                                </button>
                                <div className="project-session-actions">
                                  <button
                                    type="button"
                                    className={session.pinned ? 'session-action-btn active' : 'session-action-btn'}
                                    title={session.pinned ? '取消置顶' : '置顶对话'}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void togglePinSession(session);
                                    }}
                                  >
                                    <Pin size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="session-action-btn"
                                    title="删除对话"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void deleteSession(session);
                                    }}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                            ))}
                            {projectSessions.length > 5 && !sessionsListExpanded ? (
                              <button className="project-expand" type="button" onClick={() => setSessionsListExpanded(true)}>
                                展开显示
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="sidebar-section grow">
          <div className="sidebar-label">对话</div>
          {!threadId ? <div className="chat-empty-label">暂无聊天</div> : null}
        </section>

        <button className="settings-row" onClick={openSettings}>
          <Settings size={16} />
          设置
        </button>
      </aside>

      <ProjectContextMenu
        menu={projectContextMenu}
        onClose={() => setProjectContextMenu(null)}
        onPin={(project) => void togglePinProject(project)}
        onOpenDirectory={(project) => void openProjectDirectory(project)}
        onRename={renameProjectFromMenu}
        onRemove={(project) => void removeProjectFromApp(project)}
      />

      <main className="workspace codex-main">
        {codexCheck && !codexCheck.installed && (
          <div className="codex-banner">
            <strong>未检测到 Codex CLI</strong>
            <span>需要先安装 `codex` 并确保在 PATH 中可用，然后在设置中连接。</span>
            {codexCheck.error && <code>{codexCheck.error}</code>}
          </div>
        )}
        {threadId && !showProjectHero ? (
          <header className="thread-header">
            <h1>{activeThreadTitle}</h1>
          </header>
        ) : null}

        <section className="thread-body">
          <div className="thread-chat">
            <div className={`chat-scroll ${showProjectHero ? 'chat-scroll-hero' : ''}`} ref={timelineScrollRef}>
              {showProjectHero ? (
                <div className="project-hero">我们应该在{selectedProject?.name ?? '项目'}中做些什么？</div>
              ) : null}
              {!showProjectHero && visibleTimeline.length === 0 && !waitingForReply ? (
                <div className="rail-empty">开始一个新对话，或从左侧选择历史会话。</div>
              ) : null}
              {renderedTimeline}
              {showThinkingShimmer ? <ThinkingShimmer /> : null}
              {replyHint && waitingForReply ? <div className="composer-hint">{replyHint}</div> : null}
              {pendingApprovals.length > 0 && (
                <div className="approval-stack">
                  {pendingApprovals.map((approval) => (
                    <div key={approval.id} className="approval-card">
                      <div>
                        <strong>需要人工确认</strong>
                        <small>{approval.method}</small>
                      </div>
                      <pre>{toPretty(approval.params)}</pre>
                      <div className="approval-actions">
                        <button onClick={() => answerApproval(approval, false)} type="button">拒绝</button>
                        <button onClick={() => answerApproval(approval, true)} type="button">同意一次</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <ChatComposer
              busy={busy}
              waitingForReply={waitingForReply}
              streamingText={streamingText}
              replyHint={replyHint}
              connected={status.running}
              projectName={selectedProject?.name ?? null}
              draftMode={draftMode}
              models={modelOptions}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              permissionMode={permissionMode}
              planMode={planMode}
              goalMode={goalMode}
              onModelChange={handleModelChange}
              onEffortChange={handleEffortChange}
              onPermissionModeChange={(mode) => void handlePermissionModeChange(mode)}
              onPlanModeChange={setPlanMode}
              onGoalModeChange={setGoalMode}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenPlugins={() => setSettingsOpen(true)}
              onSend={sendPrompt}
              onNewThread={startThread}
            />
          </div>
        </section>

        {settingsOpen && (
          <div className="settings-overlay">
            <div className="settings-panel">
              <div className="settings-header">
                <h2>设置</h2>
                <button className="settings-close" onClick={() => setSettingsOpen(false)}>关闭</button>
              </div>
              <p className="settings-path">{configSnapshot?.path ?? '加载中…'}</p>
              <div className="quick-settings">
                <div className="quick-field">
                  <label>模型（model）</label>
                  <input className="terminal-input" list="model-presets" value={quickModel} onChange={(e) => setQuickModel(e.target.value)} placeholder="例如：gpt-5-codex" />
                  <datalist id="model-presets">
                    <option value="gpt-5-codex" />
                    <option value="gpt-5" />
                    <option value="gpt-4.1" />
                  </datalist>
                </div>
                <div className="quick-field">
                  <label>审批策略（approval_policy）</label>
                  <select className="terminal-input" value={quickApproval} onChange={(e) => setQuickApproval(e.target.value)}>
                    <option value="">(保持不变)</option>
                    <option value="on-request">on-request</option>
                    <option value="auto">auto</option>
                  </select>
                </div>
                <div className="quick-field">
                  <label>沙箱（sandbox）</label>
                  <select className="terminal-input" value={quickSandbox} onChange={(e) => setQuickSandbox(e.target.value)}>
                    <option value="">(保持不变)</option>
                    <option value="workspace-write">workspace-write</option>
                    <option value="workspace-read">workspace-read</option>
                    <option value="off">off</option>
                  </select>
                </div>
                <button onClick={applyQuickSettingsToDraft}>应用快捷配置到草稿</button>
              </div>
              <textarea
                className="settings-editor"
                value={configDraft}
                onChange={(e) => setConfigDraft(e.target.value)}
                rows={18}
                spellCheck={false}
              />
              <div className="settings-actions">
                <button onClick={saveSettings} disabled={!configDraft.trim()}>保存 config.toml</button>
                <button onClick={openSettings} disabled={busy}>重新加载</button>
                <button onClick={refreshEnterpriseCapabilities} disabled={busy}>刷新 Skills / MCP</button>
              </div>
              <div className="settings-inventory">
                <div className="rail-section-title">技能（{skills.length}）</div>
                <InventoryList items={skills} emptyText="暂无 Skill" />
                <div className="rail-section-title">MCP（{mcpServers.length}）</div>
                <InventoryList items={mcpServers} emptyText="暂无 MCP 服务器" />
              </div>

              <div className="dev-tools-section">
                <h3>会话与开发工具</h3>
                <div className="settings-actions">
                  <button onClick={() => setSessionMode('local')} type="button">Local 模式</button>
                  <button onClick={() => setSessionMode('worktree')} type="button">Worktree 模式</button>
                  <button onClick={startReview} disabled={busy || (codexCheck ? !codexCheck.installed : false)} type="button">/review</button>
                  <button onClick={() => { setDiffOpen(true); void refreshDiff(); }} disabled={busy} type="button">Diff</button>
                  <button
                    onClick={() => {
                      const next = window.prompt('输入新的会话名称');
                      if (next) renameCurrentThread(next);
                    }}
                    disabled={!threadId}
                    type="button"
                  >
                    重命名
                  </button>
                  <button onClick={forkCurrentThread} disabled={!threadId} type="button">分叉</button>
                  <button onClick={archiveCurrentThread} disabled={!threadId} type="button">归档</button>
                </div>
                <div className="status-line">会话 ID：{threadId ?? '未创建'}</div>
                <div className="status-line">传输：{status.transport}</div>
                <div className="status-line">初始化：{status.initialized ? '已完成' : '未完成'}</div>

                <div className="rail-section-title">MCP 调试</div>
                <div className="terminal-box">
                  <div className="terminal-row">
                    <input className="terminal-input" value={mcpReadServer} onChange={(e) => setMcpReadServer(e.target.value)} placeholder="resource server" />
                    <input className="terminal-input" value={mcpReadUri} onChange={(e) => setMcpReadUri(e.target.value)} placeholder="resource uri" />
                  </div>
                  <div className="terminal-actions">
                    <button className="terminal-run" onClick={mcpReadResource} disabled={busy} type="button">读取资源</button>
                  </div>
                  <div className="terminal-row">
                    <input className="terminal-input" value={mcpToolServer} onChange={(e) => setMcpToolServer(e.target.value)} placeholder="tool server" />
                    <input className="terminal-input" value={mcpToolName} onChange={(e) => setMcpToolName(e.target.value)} placeholder="tool name" />
                  </div>
                  <textarea className="settings-editor" value={mcpToolArgs} onChange={(e) => setMcpToolArgs(e.target.value)} rows={4} spellCheck={false} />
                  <div className="terminal-actions">
                    <button className="terminal-run" onClick={mcpCallTool} disabled={busy || !threadId} type="button">调用工具</button>
                  </div>
                </div>

                <div className="rail-section-title">终端（只读）</div>
                <div className="terminal-box">
                  <div className="terminal-row">
                    <input className="terminal-input" value={terminalCommand} onChange={(e) => setTerminalCommand(e.target.value)} />
                    <button className="terminal-run" onClick={runTerminalCommand} disabled={busy} type="button">运行</button>
                  </div>
                  <pre className="terminal-log">{terminalLog || '可用命令：pwd / ls / git status --short / git branch --show-current'}</pre>
                </div>

                {diffOpen ? (
                  <>
                    <div className="rail-section-title">Git Diff</div>
                    <div className="terminal-box">
                      <pre className="terminal-log">{gitStatusShort || '工作区干净'}</pre>
                      <div className="terminal-actions">
                        <button className="terminal-run" onClick={refreshDiff} disabled={busy} type="button">刷新</button>
                        <button className="terminal-run" onClick={stageAllChanges} disabled={busy} type="button">暂存全部</button>
                        <button className="terminal-run" onClick={unstageAllChanges} disabled={busy} type="button">取消暂存</button>
                        <button className="terminal-run" onClick={() => setDiffOpen(false)} disabled={busy} type="button">关闭</button>
                      </div>
                      <pre className="terminal-log">{stagedDiffText || diffText || '无 diff'}</pre>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function InventoryList({ items, emptyText }: { items: InventoryItem[]; emptyText: string }) {
  if (items.length === 0) return <div className="empty-state">{emptyText}</div>;
  return (
    <div className="inventory-list">
      {items.slice(0, 8).map((item) => (
        <div key={`${item.name}-${item.meta}`} className="inventory-item">
          <span>{item.name}</span>
          <small>{item.meta}</small>
        </div>
      ))}
    </div>
  );
}
