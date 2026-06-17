import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
// NOTE: rehype-highlight is expensive for long timelines; keep rendering lightweight.
import {
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  CircleStop,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquareText,
  Plus,
  Play,
  Puzzle,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Workflow,
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

type TimelineItem = {
  id: string;
  kind: 'agent' | 'tool' | 'system' | 'error' | 'approval';
  title: string;
  body: string;
  subtype?: string;
  turnIndex?: number;
};

const MarkdownBlock = React.memo(function MarkdownBlock({ value }: { value: string }) {
  return <pre className="event-mono">{value}</pre>;
});

type ChatComposerProps = {
  busy: boolean;
  codexInstalled: boolean;
  statusRunning: boolean;
  sessionMode: SessionMode;
  onSessionModeChange: (mode: SessionMode) => void;
  onSend: (text: string) => void | Promise<void>;
  onNewThread: () => void;
};

const ChatComposer = React.memo(function ChatComposer({
  busy,
  codexInstalled,
  statusRunning,
  sessionMode,
  onSessionModeChange,
  onSend,
  onNewThread,
}: ChatComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = async () => {
    const text = (inputRef.current?.value ?? '').trim();
    if (!text || busy || !codexInstalled) return;
    if (inputRef.current) inputRef.current.value = '';
    await onSend(text);
  };

  return (
    <div className="composer enterprise-composer">
      <button className="plus-button" onClick={onNewThread} disabled={busy || !codexInstalled}>
        <Plus size={18} />
      </button>
      <textarea
        ref={inputRef}
        rows={3}
        placeholder="输入任务，例如：检查 MCP 和 Skill 状态，并继续当前会话。"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-meta">
        <div className="session-mode-toggle">
          <button
            className={sessionMode === 'local' ? 'mode-btn active' : 'mode-btn'}
            onClick={() => onSessionModeChange('local')}
            type="button"
          >
            Local
          </button>
          <button
            className={sessionMode === 'worktree' ? 'mode-btn active' : 'mode-btn'}
            onClick={() => onSessionModeChange('worktree')}
            type="button"
          >
            Worktree
          </button>
        </div>
        <span className={statusRunning ? 'permission active' : 'permission'}>
          <ShieldCheck size={14} />
          {statusRunning ? '企业连接已启用' : '未连接（发送时自动连接）'}
        </span>
        <button className="send-button" onClick={() => void submit()} disabled={busy || !codexInstalled}>
          {busy ? <Loader2 size={17} /> : <ArrowUp size={17} />}
        </button>
      </div>
    </div>
  );
});

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
  approvalPolicy?: string;
  approvalsReviewer?: string;
  collaborationMode?: string;
  serviceTier?: string | null;
};

const defaultProject = '/Users/black/IdeaProjects/vibeCoding/codex-tauri-client';
const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const autoConnectMessage = '正在连接企业研发助手，连接完成后可直接发送任务。';

const staticConversations: Conversation[] = [
  { id: 'local-design', title: 'Codex 企业客户端设计', updated: '刚刚', unread: true, status: '规划' },
  { id: 'mcp-skill', title: 'MCP 与 Skill 保障链路', updated: '19 小时', status: '治理' },
  { id: 'history-demo', title: '历史会话与项目分组', updated: '1 天', status: '本地' },
  { id: 'review-pane', title: '评审面板与审批流', updated: '2 天', status: '待实现' },
];

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

function formatTime(seconds?: number) {
  if (!seconds) return '未知';
  const diff = Math.max(0, Date.now() / 1000 - seconds);
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
  if (envelope.method && envelope.id && envelope.params && !envelope.result) {
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
    approvalPolicy: typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : undefined,
    approvalsReviewer:
      typeof settings.approvalsReviewer === 'string'
        ? settings.approvalsReviewer
        : settings.approvalsReviewer
        ? String(settings.approvalsReviewer)
        : undefined,
    collaborationMode: typeof settings.collaborationMode === 'string' ? settings.collaborationMode : undefined,
    serviceTier: typeof settings.serviceTier === 'string' ? settings.serviceTier : null,
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
    approvalPolicy: typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : undefined,
    approvalsReviewer:
      typeof settings.approvalsReviewer === 'string'
        ? settings.approvalsReviewer
        : settings.approvalsReviewer
        ? String(settings.approvalsReviewer)
        : undefined,
    collaborationMode: typeof settings.collaborationMode === 'string' ? settings.collaborationMode : undefined,
    serviceTier: typeof settings.serviceTier === 'string' ? settings.serviceTier : null,
  };
}

function timelineFromThreadRead(result: unknown): TimelineItem[] {
  const thread = (result as any)?.thread ?? (result as any);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const items: TimelineItem[] = [];

  let idx = 0;
  for (const turn of turns) {
    idx += 1;
    items.push({ id: crypto.randomUUID(), kind: 'system', subtype: 'turn', title: `第 ${idx} 轮`, body: '', turnIndex: idx });
    const turnItems = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of turnItems) {
      const type = item?.type as string | undefined;
      if (type === 'userMessage') {
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = content
          .filter((c: any) => c?.type === 'text' && typeof c?.text === 'string')
          .map((c: any) => c.text)
          .join('\n');
        items.push({
          id: crypto.randomUUID(),
          kind: 'system',
          title: '用户',
          body: text || toPretty(item),
          turnIndex: idx,
        });
        continue;
      }
      if (type === 'agentMessage') {
        items.push({
          id: crypto.randomUUID(),
          kind: 'agent',
          title: '助手',
          body: typeof item?.text === 'string' ? item.text : toPretty(item),
          turnIndex: idx,
        });
        continue;
      }
      if (type === 'plan') {
        items.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          subtype: 'plan',
          title: '计划',
          body: typeof item?.text === 'string' ? item.text : toPretty(item),
          turnIndex: idx,
        });
        continue;
      }
      if (type === 'commandExecution') {
        const command = typeof item?.command === 'string' ? item.command : 'command';
        const output = typeof item?.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        items.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          subtype: 'commandExecution',
          title: `命令：${command}`,
          body: output || toPretty(item),
          turnIndex: idx,
        });
        continue;
      }
      if (type === 'fileChange') {
        const summary = formatFileChangeSummary(item?.changes);
        items.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          subtype: 'fileChange',
          title: '文件变更',
          body: summary || toPretty(item?.changes ?? item),
          turnIndex: idx,
        });
        continue;
      }

      if (type === 'mcpToolCall') {
        const server = typeof item?.server === 'string' ? item.server : 'mcp';
        const tool = typeof item?.tool === 'string' ? item.tool : 'tool';
        const status = typeof item?.status === 'string' ? ` · ${item.status}` : '';
        const args = item?.arguments ? `arguments:\n${toPretty(item.arguments)}\n\n` : '';
        const result = item?.result ? `result:\n${toPretty(item.result)}` : item?.error ? `error:\n${toPretty(item.error)}` : '';
        items.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          subtype: 'mcpToolCall',
          title: `MCP：${server}/${tool}${status}`,
          body: `${args}${result}`.trim() || toPretty(item),
          turnIndex: idx,
        });
        continue;
      }

      if (type === 'dynamicToolCall') {
        const tool = typeof item?.tool === 'string' ? item.tool : 'tool';
        const status = typeof item?.status === 'string' ? ` · ${item.status}` : '';
        const args = item?.arguments ? `arguments:\n${toPretty(item.arguments)}\n\n` : '';
        const success = typeof item?.success === 'boolean' ? `success: ${item.success}\n\n` : '';
        const contentItems = item?.contentItems ? `contentItems:\n${toPretty(item.contentItems)}\n\n` : '';
        const error = item?.error ? `error:\n${toPretty(item.error)}` : '';
        items.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          subtype: 'dynamicToolCall',
          title: `动态工具：${tool}${status}`,
          body: `${args}${success}${contentItems}${error}`.trim() || toPretty(item),
          turnIndex: idx,
        });
        continue;
      }

      if (type === 'reasoning') {
        items.push({
          id: crypto.randomUUID(),
          kind: 'tool',
          subtype: 'reasoning',
          title: '推理摘要',
          body: typeof item?.summary === 'string' ? item.summary : (typeof item?.text === 'string' ? item.text : toPretty(item)),
          turnIndex: idx,
        });
        continue;
      }

      items.push({
        id: crypto.randomUUID(),
        kind: 'system',
        title: type ? `事件：${type}` : '事件',
        body: toPretty(item),
      });
    }
  }

  return items.length > 0 ? items : [{ id: crypto.randomUUID(), kind: 'system', title: '会话已加载', body: toPretty(result) }];
}

export default function App() {
  const [status, setStatus] = useState<CodexStatus>({ running: false, initialized: false, transport: 'stdio-jsonl' });
  const [projectPath, setProjectPath] = useState(defaultProject);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [codexCheck, setCodexCheck] = useState<CodexCheckResult | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([
    { id: 'boot', kind: 'system', title: '准备就绪', body: autoConnectMessage },
  ]);
  const [conversations, setConversations] = useState<Conversation[]>(staticConversations);
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
  const [sessionMode, setSessionMode] = useState<SessionMode>('local');
  const pendingPromptRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingCreateSessionProjectIdRef = useRef<number | null>(null);
  const pendingSessionModeRef = useRef<SessionMode>('local');
  const threadIdRef = useRef<string | null>(null);
  const selectedProjectIdRef = useRef<number | null>(null);
  const projectPathRef = useRef(defaultProject);
  const projectsRef = useRef<Project[]>([]);
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
    execProcessIdRef.current = execProcessId;
  }, [execProcessId]);

  useEffect(() => {
    turnIndexRef.current = turnIndex;
  }, [turnIndex]);

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
  }, [timeline]);

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
        if (rows.length === 0) {
          const seeded = await invoke<Project>('project_add', { path: defaultProject, name: null, now: nowSeconds() });
          setProjects([seeded]);
          setSelectedProjectId(seeded.id);
          setProjectPath(seeded.path);
          const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: seeded.id });
          setSessions(nextSessions);
        } else {
          setProjects(rows);
          const first = rows[0];
          setSelectedProjectId(first.id);
          setProjectPath(first.path);
          const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: first.id });
          setSessions(nextSessions);
        }
      })
      .catch((error) => {
        setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'error', title: '读取项目列表失败', body: String(error) }]);
      });

    listen<CodexStatus>('codex:status', (event) => setStatus(event.payload)).then((unlisten) => unsubs.push(unlisten));
    listen<RpcEnvelope>('codex:message', (event) => {
      const envelope = event.payload;
      const method = envelope.method;
      const requestMethod = envelope.request_method;
      let skipAppend = false;

      const approvalMethod = envelope.method;
      if (approvalMethod && envelope.id !== undefined && envelope.params && !envelope.result && !envelope.error) {
        const approvalId = envelope.id;
        setPendingApprovals((current) => [
          ...current.filter((approval) => approval.id !== approvalId),
          { id: approvalId, method: approvalMethod, params: envelope.params },
        ]);
      }

      if (method === 'turn/started') {
        setTurnIndex((prev) => {
          const next = prev + 1;
          setTimeline((current) => [
            ...current,
            { id: crypto.randomUUID(), kind: 'system', subtype: 'turn', title: `第 ${next} 轮`, body: '思考中…', turnIndex: next },
          ]);
          return next;
        });
        setTurnState('thinking');
        return;
      }

      if (method === 'item/agentMessage/delta' && envelope.params) {
        const params = envelope.params as { itemId?: string; delta?: string };
        const delta = params.delta ?? '';
        if (delta) {
          setTimeline((current) => {
            const stream = streamingAgentRef.current;
            if (stream && stream.itemId === params.itemId) {
              return current.map((item) => (item.id === stream.timelineId ? { ...item, body: item.body + delta } : item));
            }
            const id = crypto.randomUUID();
            streamingAgentRef.current = { itemId: params.itemId ?? id, timelineId: id };
            return [...current, { id, kind: 'agent', title: '助手', body: delta, turnIndex: turnIndexRef.current }];
          });
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
            return [...current, { id: timelineId, kind: 'tool', subtype: 'plan', title: '计划', body: delta }];
          });
        }
        return;
      }

      if ((method === 'item/started' || method === 'item/completed') && envelope.params) {
        const item = asItem(envelope.params);
        if (item?.id && item?.type) {
          const itemId = String(item.id);
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
                  title: `命令：${typeof item.command === 'string' ? item.command : 'command'}`,
                  body: '',
                  turnIndex: turnIndexRef.current,
                },
              ]);
              return;
            }
            if (method === 'item/completed') {
              const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
              const tid = streamingToolRef.current.get(itemId);
              if (tid) {
                setTimeline((current) => current.map((evt) => (evt.id === tid ? { ...evt, body: output || evt.body || toPretty(item) } : evt)));
              } else {
                setTimeline((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    kind: 'tool',
                    subtype: 'commandExecution',
                    title: `命令：${typeof item.command === 'string' ? item.command : 'command'}`,
                    body: output || toPretty(item),
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
                { id: timelineId, kind: 'tool', subtype: 'mcpToolCall', title: `MCP：${server}/${tool}`, body: args, turnIndex: turnIndexRef.current },
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
                setTimeline((current) => current.map((evt) => (evt.id === tid ? { ...evt, title: `MCP：${server}/${tool}${statusText}`, body } : evt)));
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
                { id: timelineId, kind: 'tool', subtype: 'dynamicToolCall', title: `动态工具：${tool}`, body: args, turnIndex: turnIndexRef.current },
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
                setTimeline((current) => current.map((evt) => (evt.id === tid ? { ...evt, title: `动态工具：${tool}${statusText}`, body } : evt)));
              } else {
                setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'tool', subtype: 'dynamicToolCall', title: `动态工具：${tool}${statusText}`, body }]);
              }
              streamingToolRef.current.delete(itemId);
              return;
            }
          }
        }
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
          setTimeline((current) => [...current, { id: timelineId, kind: 'tool', subtype: 'reasoning', title: '推理摘要', body: '' }]);
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
            if (!timelineId) return [...current, { id: crypto.randomUUID(), kind: 'tool', subtype: 'reasoning', title: '推理摘要', body: delta }];
            return current.map((evt) => (evt.id === timelineId ? { ...evt, body: evt.body + delta } : evt));
          });
        }
        return;
      }

      if (method === 'item/reasoning/textDelta' && envelope.params) {
        const params = envelope.params as { itemId?: string; delta?: string };
        const itemId = params.itemId;
        const delta = params.delta ?? '';
        if (itemId && delta) {
          const key = `reasoningText:${itemId}`;
          setTimeline((current) => {
            const timelineId = streamingToolRef.current.get(key);
            if (!timelineId) {
              const id = crypto.randomUUID();
              streamingToolRef.current.set(key, id);
              return [...current, { id, kind: 'tool', subtype: 'reasoning', title: '推理（原始）', body: delta }];
            }
            return current.map((evt) => (evt.id === timelineId ? { ...evt, body: evt.body + delta } : evt));
          });
        }
        return;
      }

      if (method === 'turn/completed') {
        streamingAgentRef.current = null;
        streamingToolRef.current.clear();
        latestDiffTimelineIdRef.current = null;
        setTurnState('idle');
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
          pendingCreateSessionProjectIdRef.current = null;
          pendingSessionModeRef.current = 'local';
          const upsertLocal = () =>
            invoke('session_upsert', {
              projectId,
              threadId: createdId,
              mode,
              worktreePath: null,
              title: '新会话',
              updatedAt: nowSeconds(),
              status: mode,
            })
              .then(() => invoke<SessionRow[]>('sessions_for_project', { projectId }))
              .then((next) => setSessions(next));

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
                    title: '新会话 (worktree)',
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
        setTimeline(timelineFromThreadRead(envelope.result));
        setThreadGitInfo(extractThreadGitInfo(envelope.result));
        setThreadSettingsView(extractThreadSettings(envelope.result));
        skipAppend = true;

        const projectId = selectedProjectIdRef.current;
        const thread = (envelope.result as any)?.thread ?? (envelope.result as any);
        const tid = typeof thread?.id === 'string' ? thread.id : null;
        if (projectId && tid) {
          const title = (typeof thread?.name === 'string' && thread.name.trim()) ? thread.name : (typeof thread?.preview === 'string' ? thread.preview : null);
          const updatedAt = typeof thread?.updatedAt === 'number' ? thread.updatedAt : nowSeconds();
          invoke('session_upsert', {
            projectId,
            threadId: tid,
            mode: null,
            worktreePath: null,
            title: title || undefined,
            updatedAt,
            status: thread?.status ? String(thread.status) : undefined,
          })
            .then(() => invoke<SessionRow[]>('sessions_for_project', { projectId }))
            .then((next) => setSessions(next))
            .catch(() => {});
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
        setThreadId(nextThreadId);
        const pendingPrompt = pendingPromptRef.current;
        if (pendingPrompt) {
          pendingPromptRef.current = null;
          invoke<number>('codex_start_turn', { threadId: nextThreadId, text: pendingPrompt, cwd: projectPathRef.current || null })
            .then(() => {})
            .catch((error) => appendError('待发送消息提交失败', error));
        }
      }

      if (!skipAppend) {
        const item = classifyEnvelope(envelope);
        if (requestMethod !== 'thread/read') {
          setTimeline((current) => [...current, item]);
        }
      }
    }).then((unlisten) => unsubs.push(unlisten));
    listen<{ line: string }>('codex:stderr', (event) => {
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
    }).then((unlisten) => unsubs.push(unlisten));
    listen<{ line: string; error: string }>('codex:unparsed', (event) => {
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'error', title: '无法解析的服务输出', body: `${event.payload.error}\n${event.payload.line}` },
      ]);
    }).then((unlisten) => unsubs.push(unlisten));

    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      connectCodex(false)
        .then((connected) => {
          if (connected) return refreshEnterpriseCapabilities();
          return undefined;
        })
        .catch((error) => appendError('企业研发助手连接失败', error));
    }

    return () => {
      if (serviceLogFlushTimerRef.current != null) {
        window.clearTimeout(serviceLogFlushTimerRef.current);
        serviceLogFlushTimerRef.current = null;
      }
      unsubs.forEach((unlisten) => unlisten());
    };
  }, []);

  const activeConversation = useMemo(() => {
    if (!threadId) return conversations[0];
    return conversations.find((conversation) => conversation.id === threadId) ?? {
      id: threadId,
      title: '当前 Codex 会话',
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
    if (!(await ensureTauri('无法连接企业研发助手'))) return null;
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
    }
    if (!nextStatus.initialized) {
      await invoke<number>('codex_initialize', { clientName: 'codex_enterprise_client' });
      nextStatus = { ...nextStatus, running: true, initialized: true };
    }
    setStatus(nextStatus);
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
      invoke<number>('codex_list_threads', { cwd, searchTerm: null }),
      invoke<number>('codex_list_skills', { cwd, forceReload: false }),
      invoke<number>('codex_list_mcp_servers', { threadId: activeThreadId }),
    ]);
  }

  async function startThread() {
    setBusy(true);
    try {
      if (!(await connectCodex(false))) return;
      if (selectedProjectId) {
        pendingCreateSessionProjectIdRef.current = selectedProjectId;
        pendingSessionModeRef.current = sessionMode;
      }
      const requestId = await invoke<number>('codex_start_thread', { cwd: projectPath || null, model: null });
      setActiveNav('新对话');
      setTimeline((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'system', title: '新对话已准备', body: `正在为当前目录创建工作区对话。请求编号 ${requestId}` },
      ]);
    } catch (error) {
      appendError('创建会话失败', error);
    } finally {
      setBusy(false);
    }
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

  async function dispatchPromptText(text: string) {
    if (!text) return;
    setBusy(true);
    setTimeline((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'system', title: '用户', body: text },
    ]);
    try {
      if (!(await connectCodex(false))) return;
      if (!threadId) {
        pendingPromptRef.current = text;
        if (selectedProjectId) {
          pendingCreateSessionProjectIdRef.current = selectedProjectId;
          pendingSessionModeRef.current = sessionMode;
        }
        await invoke<number>('codex_start_thread', { cwd: projectPath || null, model: null });
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'system', title: '正在准备对话', body: '已创建会话，准备完成后会自动发送。' },
        ]);
        return;
      }
      await invoke<number>('codex_start_turn', { threadId, text, cwd: projectPath || null });
    } catch (error) {
      appendError('发送消息失败', error);
    } finally {
      setBusy(false);
    }
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

  async function sendPrompt(text: string) {
    if (!text) return;
    if (text.startsWith('/')) {
      await executeSlashCommand(text);
      return;
    }
    await dispatchPromptText(text);
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
    { label: '插件', icon: Puzzle },
    { label: '自动化', icon: CalendarClock },
  ];

  async function pickAndAddProject() {
    try {
      if (!(await ensureTauri('无法选择文件夹'))) return;
      const selection = await openDialog({ directory: true, multiple: false });
      const path = typeof selection === 'string' ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!path) return;
      const created = await invoke<Project>('project_add', { path, name: null, now: nowSeconds() });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
      setSelectedProjectId(created.id);
      setProjectPath(created.path);
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: created.id });
      setSessions(nextSessions);
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: 'system', title: '已添加项目', body: created.path }]);
    } catch (error) {
      appendError('添加项目失败', error);
    }
  }

  async function selectProject(project: Project) {
    setSelectedProjectId(project.id);
    setProjectPath(project.path);
    setThreadId(null);
    setTimeline([{ id: crypto.randomUUID(), kind: 'system', title: '已切换项目', body: project.path }]);
    try {
      await invoke('project_touch', { projectId: project.id, now: nowSeconds() });
      const nextProjects = await invoke<Project[]>('projects_list');
      setProjects(nextProjects);
      const nextSessions = await invoke<SessionRow[]>('sessions_for_project', { projectId: project.id });
      setSessions(nextSessions);
      await connectCodex(false);
      await invoke<number>('codex_list_threads', { cwd: project.path || null, searchTerm: null });
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

  async function startSessionUnderProject(project: Project) {
    setSelectedProjectId(project.id);
    setProjectPath(project.path);
    setBusy(true);
    try {
      if (!(await connectCodex(false))) return;
      pendingCreateSessionProjectIdRef.current = project.id;
      pendingSessionModeRef.current = sessionMode;
      await invoke<number>('codex_start_thread', { cwd: project.path || null, model: null });
    } catch (error) {
      appendError('新建会话失败', error);
    } finally {
      setBusy(false);
    }
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
      if (!threadId) {
        pendingPromptRef.current = fallbackPrompt;
        if (selectedProjectId) {
          pendingCreateSessionProjectIdRef.current = selectedProjectId;
          pendingSessionModeRef.current = sessionMode;
        }
        await invoke<number>('codex_start_thread', { cwd: projectPath || null, model: null });
        setTimeline((current) => [
          ...current,
          { id: crypto.randomUUID(), kind: 'system', title: '正在准备 Review 会话', body: '会话创建后将自动发送 review 请求。' },
        ]);
        return;
      }
      await invoke<number>('codex_start_turn', { threadId, text: fallbackPrompt, cwd: projectPath || null });
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

  const visibleTimeline = useMemo(() => {
    const limit = 80;
    if (timeline.length <= limit) return timeline;
    const hidden = timeline.length - limit;
    return [
      {
        id: 'timeline-truncated',
        kind: 'system' as const,
        title: '已折叠历史消息',
        body: `为提升性能，已隐藏更早的 ${hidden} 条事件（仅渲染最近 ${limit} 条）。`,
      },
      ...timeline.slice(-limit),
    ];
  }, [timeline]);

  const renderedTimeline = useMemo(
    () =>
      visibleTimeline.map((event) =>
        event.subtype === 'turn' ? (
          <div key={event.id} className="turn-divider">
            <span>{event.title}</span>
            <small>{turnState === 'thinking' ? '思考中…' : turnState === 'runningTools' ? '正在运行工具…' : ''}</small>
          </div>
        ) : (
          <article key={event.id} className={`event ${event.kind}`}>
            <div className="event-title">{event.title}</div>
            {event.kind === 'agent' || event.subtype === 'plan' || event.subtype === 'reasoning' ? (
              <MarkdownBlock value={event.body} />
            ) : event.kind === 'tool' ? (
              <pre className="event-mono">{event.body}</pre>
            ) : (
              <pre>{event.body}</pre>
            )}
          </article>
        ),
      ),
    [visibleTimeline, turnState],
  );

  return (
    <div className="app-shell enterprise-shell">
      <aside className="sidebar enterprise-sidebar">
        <div className="window-controls">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>

        <nav className="nav-stack">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                className={activeNav === item.label ? 'nav-item active' : 'nav-item'}
                onClick={() => {
                  setActiveNav(item.label);
                  setSettingsOpen(false);
                  if (item.label === '插件') refreshEnterpriseCapabilities();
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

        {activeNav === '插件' && (
          <section className="sidebar-section grow">
            <div className="sidebar-label">Skills</div>
            <InventoryList items={skills} emptyText="连接后刷新 Skill" />
            <div className="sidebar-label">MCP 服务器</div>
            <InventoryList items={mcpServers} emptyText="连接后刷新 MCP" />
            <button className="project-add" onClick={refreshEnterpriseCapabilities} disabled={busy}>
              <Workflow size={15} />
              刷新插件列表
            </button>
          </section>
        )}

        {activeNav !== '插件' && (
        <>
        <section className="sidebar-section">
          <div className="sidebar-label">项目</div>
          <button className="project-add" onClick={pickAndAddProject}>
            <FolderPlus size={15} />
            新建文件夹
          </button>
          <div className="project-list">
            {projects.map((project) => (
              <div key={project.id} className={project.id === selectedProjectId ? 'project-item selected' : 'project-item'}>
                <button className="project-main" onClick={() => selectProject(project)} title={project.path}>
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
                <button className="project-new-session" onClick={() => startSessionUnderProject(project)} title="新建会话">
                  <Plus size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="sidebar-section grow">
          <div className="sidebar-label">会话</div>
          <div className="thread-list">
            {filteredSessions.map((session) => (
              <div key={`${session.project_id}-${session.thread_id}`} className="session-row">
                <button
                  className={session.thread_id === threadId ? 'thread-item selected' : 'thread-item'}
                  onClick={() => openSession(session)}
                >
                  <span className="thread-title">{session.title || '未命名会话'}</span>
                  <span className="thread-meta">
                    {session.mode === 'worktree' ? 'worktree' : session.status || '历史'}
                    <span>{session.updated_at ? formatTime(session.updated_at) : '未知'}</span>
                  </span>
                </button>
                {session.mode === 'worktree' ? (
                  <button className="session-worktree" onClick={() => removeWorktree(session)} title="移除 worktree">
                    ×
                  </button>
                ) : (
                  <button className="session-worktree" onClick={() => enableWorktree(session)} title="为该会话创建 worktree">
                    WT
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
        </>
        )}

        <button className="settings-row" onClick={openSettings}>
          <Settings size={16} />
          设置
        </button>
      </aside>

      <main className="workspace enterprise-workspace">
        {codexCheck && !codexCheck.installed && (
          <div className="codex-banner">
            <strong>未检测到 Codex CLI</strong>
            <span>需要先安装 `codex` 并确保在 PATH 中可用，然后点击“连接”。</span>
            {codexCheck.error && <code>{codexCheck.error}</code>}
          </div>
        )}
        <header className="topbar enterprise-topbar">
          <div>
            <h1>{activeConversation?.title ?? '中国企业版 Codex 客户端'}</h1>
            <p>面向企业研发流程：对话、MCP、Skill、审批和历史会话都走官方 app-server 协议。</p>
          </div>
          <div className="topbar-actions">
            <button onClick={startCodex} disabled={busy || (codexCheck ? !codexCheck.installed : false)}>
              <Play size={16} /> {status.running ? '重连' : '连接'}
            </button>
            <button onClick={startThread} disabled={busy || (codexCheck ? !codexCheck.installed : false)}><Plus size={16} /> 新建会话</button>
            <button onClick={refreshEnterpriseCapabilities} disabled={busy}><Workflow size={16} /> 刷新保障项</button>
            <button onClick={() => { setDiffOpen((v) => !v); if (!diffOpen) refreshDiff(); }} disabled={busy}>
              Diff
            </button>
            <button onClick={startReview} disabled={busy || (codexCheck ? !codexCheck.installed : false)}>/review</button>
            <button
              onClick={() => {
                const next = window.prompt('输入新的会话名称');
                if (next) renameCurrentThread(next);
              }}
              disabled={!threadId}
            >
              重命名会话
            </button>
            <button onClick={forkCurrentThread} disabled={!threadId}>分叉会话</button>
            <button
              onClick={() => {
                const raw = window.prompt('回滚最近几轮？（>=1）', '1');
                if (!raw) return;
                const n = Number(raw);
                if (!Number.isFinite(n) || n < 1) return;
                rollbackCurrentThread(n);
              }}
              disabled={!threadId}
            >
              回滚
            </button>
            <button onClick={archiveCurrentThread} disabled={!threadId}>归档</button>
            <button onClick={unarchiveCurrentThread} disabled={!threadId}>取消归档</button>
            <button onClick={interrupt} disabled={!threadId}><CircleStop size={16} /> 中断</button>
          </div>
        </header>

        <section className="content-grid enterprise-grid">
          <div className="panel transcript chat-panel">
            <div className="panel-title">对话与执行过程</div>
            <div className="chat-scroll" ref={timelineScrollRef}>
              {renderedTimeline}
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
                        <button onClick={() => answerApproval(approval, false)}>拒绝</button>
                        <button onClick={() => answerApproval(approval, true)}>同意一次</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <ChatComposer
              busy={busy}
              codexInstalled={codexCheck ? codexCheck.installed : false}
              statusRunning={status.running}
              sessionMode={sessionMode}
              onSessionModeChange={setSessionMode}
              onSend={sendPrompt}
              onNewThread={startThread}
            />
          </div>

          <aside className="panel detail guard-panel">
            <div className="panel-title">核心能力保障</div>
            <div className="guard-card">
              <CheckCircle2 size={16} />
              <div>
                <strong>对话服务</strong>
                <span>{status.running ? '已连接官方 app-server' : '未连接'}</span>
              </div>
            </div>
            <div className="guard-card">
              <Sparkles size={16} />
              <div>
                <strong>Skill</strong>
                <span>{skills.length > 0 ? `${skills.length} 个可用` : '等待刷新'}</span>
              </div>
            </div>
            <div className="guard-card">
              <Puzzle size={16} />
              <div>
                <strong>MCP</strong>
                <span>{mcpServers.length > 0 ? `${mcpServers.length} 个服务器` : '等待刷新'}</span>
              </div>
            </div>
            <div className="guard-card">
              <ShieldCheck size={16} />
              <div>
                <strong>审批请求</strong>
                <span>{pendingApprovals.length > 0 ? `${pendingApprovals.length} 项待处理` : '无待处理项'}</span>
              </div>
            </div>

            <div className="panel-title secondary">Skill 列表</div>
            <InventoryList items={skills} emptyText="启动服务后刷新 Skill" />

            <div className="panel-title secondary">MCP 状态</div>
            <InventoryList items={mcpServers} emptyText="启动服务后刷新 MCP" />
            <div className="panel-title secondary">MCP 调试入口</div>
            <div className="terminal-box">
              <div className="terminal-row">
                <input
                  className="terminal-input"
                  value={mcpReadServer}
                  onChange={(e) => setMcpReadServer(e.target.value)}
                  placeholder="resource server"
                />
                <input
                  className="terminal-input"
                  value={mcpReadUri}
                  onChange={(e) => setMcpReadUri(e.target.value)}
                  placeholder="resource uri"
                />
              </div>
              <div className="terminal-actions">
                <button className="terminal-run" onClick={mcpReadResource} disabled={busy}>
                  读取资源
                </button>
              </div>
              <div className="terminal-row">
                <input
                  className="terminal-input"
                  value={mcpToolServer}
                  onChange={(e) => setMcpToolServer(e.target.value)}
                  placeholder="tool server"
                />
                <input
                  className="terminal-input"
                  value={mcpToolName}
                  onChange={(e) => setMcpToolName(e.target.value)}
                  placeholder="tool name"
                />
              </div>
              <textarea
                className="settings-editor"
                value={mcpToolArgs}
                onChange={(e) => setMcpToolArgs(e.target.value)}
                rows={4}
                spellCheck={false}
              />
              <div className="terminal-actions">
                <button className="terminal-run" onClick={mcpCallTool} disabled={busy || !threadId}>
                  调用工具
                </button>
              </div>
            </div>

            <div className="panel-title secondary">当前会话</div>
            <div className="status-line">会话 ID：{threadId ?? '未创建'}</div>
            <div className="status-line">传输：{status.transport}</div>
            <div className="status-line">初始化：{status.initialized ? '已完成' : '未完成'}</div>
            {status.last_error && <div className="status-line error-text">{status.last_error}</div>}

            <div className="panel-title secondary">会话目标（thread/goal）</div>
            <div className="terminal-box">
              <input
                className="terminal-input"
                value={goalObjective}
                onChange={(e) => setGoalObjective(e.target.value)}
                placeholder="objective"
              />
              <div className="terminal-row">
                <select className="terminal-input" value={goalStatus} onChange={(e) => setGoalStatus(e.target.value)}>
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="blocked">blocked</option>
                  <option value="usageLimited">usageLimited</option>
                  <option value="budgetLimited">budgetLimited</option>
                  <option value="complete">complete</option>
                </select>
                <input
                  className="terminal-input"
                  value={goalTokenBudget}
                  onChange={(e) => setGoalTokenBudget(e.target.value)}
                  placeholder="tokenBudget"
                />
              </div>
              <div className="terminal-actions">
                <button className="terminal-run" onClick={() => setCurrentThreadGoal()} disabled={!threadId}>设置</button>
                <button className="terminal-run" onClick={getCurrentThreadGoal} disabled={!threadId}>读取</button>
                <button className="terminal-run danger" onClick={clearCurrentThreadGoal} disabled={!threadId}>清空</button>
              </div>
            </div>

            <div className="panel-title secondary">会话元数据（thread/metadata）</div>
            <div className="terminal-box">
              <input
                className="terminal-input"
                value={metadataBranch}
                onChange={(e) => setMetadataBranch(e.target.value)}
                placeholder="git branch"
              />
              <label className="status-line">
                <input type="checkbox" checked={clearMetadataBranch} onChange={(e) => setClearMetadataBranch(e.target.checked)} />
                清空 branch（null）
              </label>
              <input
                className="terminal-input"
                value={metadataSha}
                onChange={(e) => setMetadataSha(e.target.value)}
                placeholder="git sha"
              />
              <label className="status-line">
                <input type="checkbox" checked={clearMetadataSha} onChange={(e) => setClearMetadataSha(e.target.checked)} />
                清空 sha（null）
              </label>
              <input
                className="terminal-input"
                value={metadataOrigin}
                onChange={(e) => setMetadataOrigin(e.target.value)}
                placeholder="git origin url"
              />
              <label className="status-line">
                <input type="checkbox" checked={clearMetadataOrigin} onChange={(e) => setClearMetadataOrigin(e.target.checked)} />
                清空 originUrl（null）
              </label>
              <div className="terminal-actions">
                <button className="terminal-run" onClick={() => updateCurrentThreadMetadataGit()} disabled={!threadId}>
                  更新 metadata
                </button>
              </div>
              <pre className="terminal-log">
                {threadGitInfo
                  ? `branch: ${threadGitInfo.branch ?? '(null)'}\nsha: ${threadGitInfo.sha ?? '(null)'}\norigin: ${threadGitInfo.originUrl ?? '(null)'}`
                  : '暂无 thread gitInfo'}
              </pre>
            </div>

            <div className="panel-title secondary">会话设置（thread/settings）</div>
            <div className="terminal-box">
              <pre className="terminal-log">{threadSettingsView ? JSON.stringify(threadSettingsView, null, 2) : '暂无 thread settings（等待 thread/settings/updated 或 thread/read 返回）'}</pre>
            </div>

            <div className="panel-title secondary">终端（只读）</div>
            <div className="terminal-box">
              <div className="terminal-row">
                <input className="terminal-input" value={terminalCommand} onChange={(e) => setTerminalCommand(e.target.value)} />
                <button className="terminal-run" onClick={runTerminalCommand} disabled={busy}>运行</button>
              </div>
              <pre className="terminal-log">{terminalLog || '可用命令：pwd / ls / git status --short / git branch --show-current'}</pre>
            </div>

            <div className="panel-title secondary">官方 command/exec</div>
            <div className="terminal-box">
              <div className="terminal-row">
                <label className="status-line">
                  <input type="checkbox" checked={execTty} onChange={(e) => setExecTty(e.target.checked)} />
                  启用 TTY
                </label>
                <input
                  className="terminal-input"
                  type="number"
                  min={1}
                  value={execCols}
                  onChange={(e) => setExecCols(Number(e.target.value) || 1)}
                  placeholder="cols"
                />
                <input
                  className="terminal-input"
                  type="number"
                  min={1}
                  value={execRows}
                  onChange={(e) => setExecRows(Number(e.target.value) || 1)}
                  placeholder="rows"
                />
                <button className="terminal-run" onClick={resizeExecCommand} disabled={!execRunning || !execProcessId || !execTty}>
                  调整尺寸
                </button>
              </div>
              <div className="terminal-row">
                <input
                  className="terminal-input"
                  value={execCommand}
                  onChange={(e) => setExecCommand(e.target.value)}
                  placeholder="例如：ls -la"
                />
                <button className="terminal-run" onClick={startExecCommand} disabled={busy || execRunning}>
                  运行
                </button>
              </div>
              <div className="terminal-row">
                <input
                  className="terminal-input"
                  value={execStdin}
                  onChange={(e) => setExecStdin(e.target.value)}
                  placeholder="stdin 文本（可选）"
                />
                <button className="terminal-run" onClick={() => writeExecStdin(false)} disabled={!execRunning || !execProcessId}>
                  写入
                </button>
                <button className="terminal-run" onClick={() => writeExecStdin(true)} disabled={!execRunning || !execProcessId}>
                  关闭 stdin
                </button>
                <button className="terminal-run danger" onClick={stopExecCommand} disabled={!execRunning || !execProcessId}>
                  终止
                </button>
              </div>
              <pre className="terminal-log">{execLog || '暂无 command/exec 输出'}</pre>
            </div>

            {diffOpen && (
              <>
                <div className="panel-title secondary">Diff（未提交）</div>
                <div className="terminal-box">
                  <pre className="terminal-log">{gitStatusShort || '工作区干净'}</pre>
                  <div className="terminal-actions">
                    <button className="terminal-run" onClick={refreshDiff} disabled={busy}>刷新 diff</button>
                    <button className="terminal-run" onClick={stageAllChanges} disabled={busy}>暂存全部</button>
                    <button className="terminal-run" onClick={unstageAllChanges} disabled={busy}>取消暂存</button>
                    <button className="terminal-run danger" onClick={revertAllChanges} disabled={busy}>回退工作区</button>
                    <button className="terminal-run" onClick={() => setDiffOpen(false)} disabled={busy}>关闭</button>
                  </div>
                  <div className="panel-title secondary">已暂存 Diff</div>
                  <pre className="terminal-log">{stagedDiffText || '无已暂存 diff'}</pre>
                  <div className="panel-title secondary">未暂存 Diff</div>
                  <pre className="terminal-log">{diffText || '无未暂存 diff'}</pre>
                  <div className="panel-title secondary">按文件操作</div>
                  <div className="file-actions">
                    {changedFiles.length === 0 ? (
                      <div className="empty-state">暂无变更文件</div>
                    ) : (
                      changedFiles.map((file) => {
                        const staged = file.index_status && file.index_status !== '?';
                        const untracked = file.index_status === '?' && file.worktree_status === '?';
                        return (
                          <div key={file.path} className="file-row">
                            <div className="file-main">
                              <code>{file.path}</code>
                              <small>index:{file.index_status || '-'} worktree:{file.worktree_status || '-'}</small>
                            </div>
                            <div className="file-row-actions">
                              <button className="terminal-run" onClick={() => stagePath(file.path)} disabled={busy}>
                                暂存
                              </button>
                              <button className="terminal-run" onClick={() => unstagePath(file.path)} disabled={busy || !staged}>
                                取消暂存
                              </button>
                              <button className="terminal-run danger" onClick={() => revertPath(file.path)} disabled={busy || untracked}>
                                回退
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="commit-row">
                    <input
                      className="terminal-input"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      placeholder="提交信息，例如：feat: 完善暂存与提交工作流"
                    />
                    <button className="terminal-run" onClick={commitAllChanges} disabled={busy || !commitMessage.trim()}>
                      提交
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
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
                <div className="panel-title secondary">技能（{skills.length}）</div>
                <InventoryList items={skills} emptyText="暂无 Skill" />
                <div className="panel-title secondary">MCP（{mcpServers.length}）</div>
                <InventoryList items={mcpServers} emptyText="暂无 MCP 服务器" />
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
