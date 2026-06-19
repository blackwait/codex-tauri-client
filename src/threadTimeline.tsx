import React, { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Circle, FileText, Globe2, PencilLine, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react';

export type TimelineAttachment = {
  id: string;
  kind: 'image' | 'file';
  previewUrl?: string;
  path?: string;
  name: string;
};

export type TimelinePlanStep = {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
};

export type TimelineItem = {
  id: string;
  kind: 'agent' | 'user' | 'tool' | 'system' | 'error' | 'approval';
  title: string;
  body: string;
  planSteps?: TimelinePlanStep[];
  attachments?: TimelineAttachment[];
  subtype?: string;
  turnIndex?: number;
  completed?: boolean;
  command?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number | null;
};

type TurnTiming = { startedAt: number; completedAt?: number };

export type TimelineDisplayBlock =
  | { type: 'user'; item: TimelineItem }
  | {
      type: 'assistant-turn';
      turnIndex: number;
      tools: TimelineItem[];
      agents: TimelineItem[];
      timing?: TurnTiming;
    };

function toPretty(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
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
      return '思考';
    case 'mcpToolCall':
      return 'MCP 调用';
    case 'dynamicToolCall':
      return '工具调用';
    case 'webSearch':
      return '网页搜索';
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

function truncateCommand(cmd: string, max = 76): string {
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}...`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function userInputSummary(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item: any) => {
      if (item?.type === 'text' && typeof item.text === 'string') return item.text;
      if (item?.type === 'input_text' && typeof item.text === 'string') return item.text;
      if (item?.type === 'mention' && typeof item.name === 'string') return `@${item.name}`;
      if (item?.type === 'skill' && typeof item.name === 'string') return `$${item.name}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function userInputAttachments(content: unknown): TimelineAttachment[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((item: any) => {
      if (item?.type === 'image' && typeof item.url === 'string') {
        return {
          id: crypto.randomUUID(),
          kind: 'image' as const,
          previewUrl: item.url,
          name: 'image',
        };
      }
      if (item?.type === 'localImage' && typeof item.path === 'string') {
        return {
          id: crypto.randomUUID(),
          kind: 'image' as const,
          previewUrl: convertFileSrc(item.path),
          path: item.path,
          name: item.path.split(/[/\\]/).pop() ?? 'image',
        };
      }
      return null;
    })
    .filter(Boolean) as TimelineAttachment[];
}

export function itemDurationMs(item: TimelineItem, now = Date.now()): number | null {
  if (item.completed !== false) {
    if (typeof item.durationMs === 'number') return item.durationMs;
    if (item.startedAt != null && item.completedAt != null) return item.completedAt - item.startedAt;
  }
  if (item.startedAt != null) return Math.max(0, now - item.startedAt);
  if (typeof item.durationMs === 'number') return item.durationMs;
  return null;
}

export function itemDurationLabel(item: TimelineItem, now = Date.now()): string | null {
  const ms = itemDurationMs(item, now);
  return ms != null ? formatDurationMs(ms) : null;
}

export function mergeToolStarted(): Pick<TimelineItem, 'startedAt'> {
  return { startedAt: Date.now() };
}

export function mergeToolCompleted(
  item: Record<string, unknown>,
  existing?: Pick<TimelineItem, 'startedAt'>,
): Pick<TimelineItem, 'startedAt' | 'completedAt' | 'durationMs'> {
  const completedAt = Date.now();
  const serverMs = typeof item.durationMs === 'number' ? item.durationMs : null;
  const startedAt = existing?.startedAt ?? (serverMs != null ? completedAt - serverMs : completedAt);
  const durationMs = serverMs ?? completedAt - startedAt;
  return { startedAt, completedAt, durationMs };
}

function readDurationMs(item: Record<string, unknown>): number | null {
  return typeof item.durationMs === 'number' ? item.durationMs : null;
}

const HIDDEN_TOOL_SUBTYPES = new Set(['diff']);

const META_TOOL_SUBTYPES = new Set([
  'reasoning',
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'read',
  'search',
  'plan',
  'webSearch',
  'fileChange',
  'todoList',
]);

type ProcessKind = 'read' | 'search' | 'webSearch' | 'command' | 'mcp' | 'reasoning' | 'plan' | 'fileChange' | 'tool';

function processKind(tool: TimelineItem): ProcessKind {
  switch (tool.subtype) {
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'webSearch':
      return 'webSearch';
    case 'commandExecution':
      return 'command';
    case 'mcpToolCall':
      return 'mcp';
    case 'reasoning':
      return 'reasoning';
    case 'plan':
    case 'todoList':
      return 'plan';
    case 'fileChange':
      return 'fileChange';
    default:
      return 'tool';
  }
}

function processKindLabel(kind: ProcessKind) {
  switch (kind) {
    case 'read':
      return '读取文件';
    case 'search':
      return '搜索代码';
    case 'webSearch':
      return '搜索网页';
    case 'command':
      return '运行命令';
    case 'mcp':
      return '调用 MCP';
    case 'reasoning':
      return '思考';
    case 'plan':
      return '更新计划';
    case 'fileChange':
      return '修改文件';
    default:
      return '使用工具';
  }
}

function processRowTitle(kind: ProcessKind, running: boolean) {
  if (kind === 'read' || kind === 'search') return processVerb(kind, !running);
  if (running) return processKindLabel(kind).replace(/^运行/, '正在运行').replace(/^调用/, '正在调用');
  return processVerb(kind, true);
}

function processVerb(kind: ProcessKind, completed: boolean) {
  if (!completed) {
    switch (kind) {
      case 'read':
        return '正在读取';
      case 'search':
        return '正在搜索';
      case 'webSearch':
        return '正在搜索网页';
      case 'command':
        return '正在运行';
      case 'mcp':
        return '正在调用';
      case 'reasoning':
        return '正在思考';
      case 'plan':
        return '正在更新计划';
      case 'fileChange':
        return '正在修改';
      default:
        return '正在处理';
    }
  }
  switch (kind) {
    case 'read':
      return '已读取';
    case 'search':
      return '已搜索代码';
    case 'webSearch':
      return '已搜索网页';
    case 'command':
      return '已运行';
    case 'mcp':
      return '已调用 MCP';
    case 'reasoning':
      return '已思考';
    case 'plan':
      return '已更新计划';
    case 'fileChange':
      return '已修改';
    default:
      return '已处理';
  }
}

function ProcessIcon({ kind, running }: { kind: ProcessKind; running: boolean }) {
  const size = 14;
  const className = running ? 'process-row-icon running' : 'process-row-icon';
  switch (kind) {
    case 'read':
      return <FileText size={size} className={className} />;
    case 'search':
      return <Search size={size} className={className} />;
    case 'webSearch':
      return <Globe2 size={size} className={className} />;
    case 'command':
      return <SquareTerminal size={size} className={className} />;
    case 'mcp':
    case 'tool':
      return <Wrench size={size} className={className} />;
    case 'reasoning':
      return <Sparkles size={size} className={className} />;
    case 'plan':
      return <Circle size={size} className={className} />;
    case 'fileChange':
      return <PencilLine size={size} className={className} />;
  }
}

function toolDetail(tool: TimelineItem) {
  if (tool.subtype === 'todoList' && tool.planSteps?.length) {
    const active = activePlanStep(tool.planSteps);
    return active ? active.step : `${tool.planSteps.length} 个步骤`;
  }
  const body = tool.body?.trim() ?? '';
  if (tool.command) return truncateCommand(tool.command, 90);
  const firstLine = body.split('\n').find(Boolean);
  return firstLine ? truncateCommand(firstLine, 90) : tool.title;
}

function activePlanStep(steps: TimelinePlanStep[]) {
  return steps.find((step) => step.status === 'inProgress') ?? steps.find((step) => step.status === 'pending') ?? steps[steps.length - 1] ?? null;
}

function planStepIndex(steps: TimelinePlanStep[]) {
  const index = steps.findIndex((step) => step.status === 'inProgress');
  if (index >= 0) return index;
  const pendingIndex = steps.findIndex((step) => step.status === 'pending');
  if (pendingIndex >= 0) return pendingIndex;
  return Math.max(0, steps.length - 1);
}

function planStatusLabel(status: TimelinePlanStep['status']) {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'inProgress':
      return '执行中';
    default:
      return '待执行';
  }
}

function processSummary(tools: TimelineItem[], active: boolean, now: number) {
  const visible = tools.filter((tool) => META_TOOL_SUBTYPES.has(tool.subtype ?? ''));
  const running = visible.find((tool) => tool.completed === false);
  if (running) {
    const kind = processKind(running);
    const duration = itemDurationLabel(running, now);
    const detail = toolDetail(running);
    return `${processVerb(kind, false)}${duration ? ` ${duration}` : ''}${detail ? ` ${detail}` : ''}`;
  }

  const counts = new Map<ProcessKind, number>();
  for (const tool of visible) {
    const kind = processKind(tool);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 0) return active ? '正在思考' : '已处理';

  const parts: string[] = [];
  const readCount = counts.get('read') ?? 0;
  const searchCount = counts.get('search') ?? 0;
  const webCount = counts.get('webSearch') ?? 0;
  const commandCount = counts.get('command') ?? 0;
  const mcpCount = counts.get('mcp') ?? 0;
  const changeCount = counts.get('fileChange') ?? 0;
  const planCount = counts.get('plan') ?? 0;
  const reasoningCount = counts.get('reasoning') ?? 0;
  const otherCount = counts.get('tool') ?? 0;

  if (readCount) parts.push(`已读取 ${readCount} 个文件`);
  if (searchCount) parts.push('已搜索代码');
  if (webCount) parts.push('已搜索网页');
  if (commandCount) parts.push(`已运行 ${commandCount} 条命令`);
  if (mcpCount) parts.push(`已调用 ${mcpCount} 个 MCP 工具`);
  if (changeCount) parts.push('已修改文件');
  if (planCount) parts.push('已更新计划');
  if (reasoningCount && parts.length === 0) parts.push('已思考');
  if (otherCount) parts.push(`已使用 ${otherCount} 个工具`);

  return parts.join('并') || '已处理';
}

function mergeAgentItems(items: TimelineItem[]) {
  const merged: TimelineItem[] = [];
  for (const item of items) {
    const existing = merged.find(
      (candidate) =>
        candidate.body === item.body ||
        candidate.body.includes(item.body) ||
        item.body.includes(candidate.body),
    );
    if (!existing) {
      merged.push(item);
      continue;
    }
    if (item.body.length > existing.body.length) {
      existing.body = item.body;
    }
    existing.completed = existing.completed !== false && item.completed !== false;
  }
  return merged;
}

export function isThreadRenderable(event: TimelineItem) {
  return event.kind === 'user' || event.kind === 'agent' || event.kind === 'tool';
}

export function groupTimelineItems(
  items: TimelineItem[],
  turnTiming: Record<number, TurnTiming>,
): TimelineDisplayBlock[] {
  const blocks: TimelineDisplayBlock[] = [];
  const buckets = new Map<number, { tools: TimelineItem[]; agents: TimelineItem[] }>();

  const flushTurn = (turnIndex: number) => {
    const bucket = buckets.get(turnIndex);
    if (!bucket) return;
    const visibleTools = bucket.tools.filter((tool) => !HIDDEN_TOOL_SUBTYPES.has(tool.subtype ?? ''));
    if (visibleTools.length === 0 && bucket.agents.length === 0) {
      buckets.delete(turnIndex);
      return;
    }
    blocks.push({
      type: 'assistant-turn',
      turnIndex,
      tools: visibleTools,
      agents: mergeAgentItems(bucket.agents),
      timing: turnTiming[turnIndex],
    });
    buckets.delete(turnIndex);
  };

  for (const item of items) {
    if (item.kind === 'user') {
      for (const turnIndex of [...buckets.keys()].sort((a, b) => a - b)) flushTurn(turnIndex);
      blocks.push({ type: 'user', item });
      continue;
    }

    const turnIndex = item.turnIndex ?? 0;
    if (!buckets.has(turnIndex)) buckets.set(turnIndex, { tools: [], agents: [] });
    const bucket = buckets.get(turnIndex)!;

    if (item.kind === 'agent') {
      bucket.agents.push(item);
    } else if (item.kind === 'tool' && !HIDDEN_TOOL_SUBTYPES.has(item.subtype ?? '')) {
      bucket.tools.push(item);
    }
  }

  for (const turnIndex of [...buckets.keys()].sort((a, b) => a - b)) flushTurn(turnIndex);
  return blocks;
}

export function timelineItemFromThreadItem(item: any, turnIndex: number): TimelineItem | null {
  const type = item?.type as string | undefined;
  if (!type) return null;

  if (type === 'userMessage') {
    const text = userInputSummary(item?.content);
    const attachments = userInputAttachments(item?.content);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'user',
      title: '用户',
      body: text || toPretty(item),
      attachments,
      turnIndex,
      completed: true,
    };
  }

  if (type === 'agentMessage') {
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'agent',
      title: '助手',
      body: typeof item.text === 'string' ? item.text : toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.filter((s: unknown) => typeof s === 'string').join('\n\n') : '';
    const durationMs = readDurationMs(item);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'reasoning',
      title: '思考',
      body: summary,
      turnIndex,
      completed: true,
      durationMs,
    };
  }

  if (type === 'plan') {
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'plan',
      title: '计划',
      body: typeof item.text === 'string' ? item.text : toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'hookPrompt') {
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'plan',
      title: 'Hook 提示',
      body: toPretty(item.fragments ?? item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : 'command';
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    const durationMs = readDurationMs(item);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'commandExecution',
      title: '命令',
      command,
      body: output,
      turnIndex,
      completed: true,
      durationMs,
    };
  }

  if (type === 'fileChange') {
    const summary = formatFileChangeSummary(item.changes);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'fileChange',
      title: itemTitle('fileChange'),
      body: summary || toPretty(item.changes ?? item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    const args = item.arguments ? toPretty(item.arguments) : '';
    const durationMs = readDurationMs(item);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'mcpToolCall',
      title: `${server}/${tool}`,
      command: `${server}/${tool}`,
      body: args,
      turnIndex,
      completed: true,
      durationMs,
    };
  }

  if (type === 'dynamicToolCall') {
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    const args = item.arguments ? toPretty(item.arguments) : '';
    const durationMs = readDurationMs(item);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'dynamicToolCall',
      title: tool,
      command: tool,
      body: args,
      turnIndex,
      completed: true,
      durationMs,
    };
  }

  if (type === 'webSearch') {
    const query = typeof item.query === 'string' ? item.query : '';
    const action = typeof item.action === 'string' ? item.action : '';
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'webSearch',
      title: '网页搜索',
      body: [query, action].filter(Boolean).join('\n') || toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'imageView') {
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'read',
      title: '查看图片',
      body: typeof item.path === 'string' ? item.path : toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'imageGeneration') {
    const lines = [
      typeof item.revisedPrompt === 'string' && item.revisedPrompt ? `prompt: ${item.revisedPrompt}` : '',
      typeof item.savedPath === 'string' && item.savedPath ? `saved: ${item.savedPath}` : '',
      typeof item.result === 'string' && item.result ? item.result : '',
    ].filter(Boolean);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'dynamicToolCall',
      title: '图片生成',
      body: lines.join('\n') || toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'collabAgentToolCall') {
    const lines = [
      typeof item.tool === 'string' ? `tool: ${item.tool}` : '',
      typeof item.prompt === 'string' && item.prompt ? `prompt: ${item.prompt}` : '',
      item.receiverThreadIds ? `receivers: ${toPretty(item.receiverThreadIds)}` : '',
      item.agentsStates ? `states: ${toPretty(item.agentsStates)}` : '',
    ].filter(Boolean);
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'dynamicToolCall',
      title: '协作代理',
      body: lines.join('\n') || toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'plan',
      title: type === 'enteredReviewMode' ? '进入 Review 模式' : '退出 Review 模式',
      body: typeof item.review === 'string' ? item.review : toPretty(item),
      turnIndex,
      completed: true,
    };
  }

  if (type === 'contextCompaction') {
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'tool',
      subtype: 'plan',
      title: '上下文压缩',
      body: '当前会话发生了上下文压缩。',
      turnIndex,
      completed: true,
    };
  }

  return null;
}

export function timelineFromThreadRead(result: unknown): TimelineItem[] {
  const thread = (result as any)?.thread ?? (result as any);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const items: TimelineItem[] = [];

  let idx = 0;
  for (const turn of turns) {
    idx += 1;
    const turnItems = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of turnItems) {
      const mapped = timelineItemFromThreadItem(item, idx);
      if (mapped) items.push(mapped);
    }
  }

  return items;
}

function sanitizeMarkdown(value: string) {
  return value.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '').trim();
}

const MarkdownBlock = React.memo(function MarkdownBlock({ value }: { value: string }) {
  const sanitized = sanitizeMarkdown(value);
  if (!sanitized) return null;
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {sanitized}
      </ReactMarkdown>
    </div>
  );
});

const UserMessageRow = React.memo(function UserMessageRow({ event }: { event: TimelineItem }) {
  const [preview, setPreview] = useState<TimelineAttachment | null>(null);
  const imageAttachments = (event.attachments ?? []).filter((item) => item.kind === 'image' && item.previewUrl);
  return (
    <article className="chat-message chat-user">
      <div className="chat-user-bubble">
        {imageAttachments.length > 0 ? (
          <div className="chat-user-images">
            {imageAttachments.map((image) => (
              <button
                key={image.id}
                className="chat-user-image"
                type="button"
                title="双击放大图片"
                onDoubleClick={() => setPreview(image)}
              >
                <img src={image.previewUrl} alt={image.name} />
              </button>
            ))}
          </div>
        ) : null}
        {event.body ? <pre>{event.body}</pre> : null}
      </div>
      {preview?.previewUrl ? (
        <div className="image-preview-overlay" onClick={() => setPreview(null)}>
          <button className="image-preview-close" type="button" onClick={() => setPreview(null)}>
            关闭
          </button>
          <img
            className="image-preview-full"
            src={preview.previewUrl}
            alt={preview.name}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </article>
  );
});

const AssistantTurnRow = React.memo(function AssistantTurnRow({
  tools,
  agents,
  timing,
  active,
}: {
  tools: TimelineItem[];
  agents: TimelineItem[];
  timing?: TurnTiming;
  active?: boolean;
}) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const metaTools = tools.filter((tool) => META_TOOL_SUBTYPES.has(tool.subtype ?? ''));
  const hasMeta = metaTools.length > 0 || active;
  const toolsRunning = metaTools.some((tool) => tool.completed === false);
  const showMetaBody = metaOpen || (active && toolsRunning);

  useEffect(() => {
    if (!active && !toolsRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [active, toolsRunning]);

  const durationMs =
    timing?.completedAt && timing?.startedAt
      ? timing.completedAt - timing.startedAt
      : timing?.startedAt
        ? Date.now() - timing.startedAt
        : null;

  const isRunning = toolsRunning || active;
  const processedLabel = isRunning ? '正在执行' : '已完成';
  const durationLabel = durationMs != null ? formatDurationMs(durationMs) : null;
  const summaryLabel = processSummary(metaTools, Boolean(active), now);
  const activePlan = metaTools.find((tool) => tool.subtype === 'todoList' && tool.planSteps?.length);
  const activePlanSteps = activePlan?.planSteps ?? [];
  const activePlanIndex = activePlanSteps.length > 0 ? planStepIndex(activePlanSteps) : -1;
  const statusClassName = isRunning ? 'turn-status-badge running' : 'turn-status-badge completed';

  if (!hasMeta && agents.length === 0) return null;

  return (
    <article className="chat-message chat-agent">
      <div className="chat-agent-turn">
        {hasMeta ? (
          <div className={toolsRunning ? 'turn-meta running' : 'turn-meta'}>
            <button type="button" className="turn-meta-toggle" onClick={() => setMetaOpen((value) => !value)}>
              {activePlanSteps.length > 0 ? (
                <>
                  <span className={activePlanSteps[activePlanIndex]?.status === 'inProgress' ? 'turn-step-spinner running' : 'turn-step-spinner'} />
                  <span className={statusClassName}>{processedLabel}</span>
                  <span className="turn-meta-status">{`第 ${activePlanIndex + 1} / ${activePlanSteps.length} 步`}</span>
                  <span className="turn-meta-summary">{summaryLabel}</span>
                  {durationLabel ? <span className="turn-meta-duration">{durationLabel}</span> : null}
                </>
              ) : (
                <>
                  <span className={statusClassName}>{processedLabel}</span>
                  {durationLabel ? <span className="turn-meta-duration">{durationLabel}</span> : null}
                  <span className="turn-meta-summary">{summaryLabel}</span>
                </>
              )}
              <ChevronDown size={14} className={showMetaBody ? 'turn-chevron open' : 'turn-chevron'} />
            </button>
            {showMetaBody ? (
              <div className="turn-meta-body">
                {activePlanSteps.length > 0 ? (
                  <ol className="turn-plan-steps">
                    {activePlanSteps.map((step, index) => (
                      <li key={`${step.status}-${index}-${step.step}`} className={`turn-plan-step ${step.status}`}>
                        <span className={step.status === 'inProgress' ? 'turn-plan-step-dot running' : 'turn-plan-step-dot'} />
                        <span className="turn-plan-step-text">{step.step}</span>
                        <span className="turn-plan-step-status">{planStatusLabel(step.status)}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <ul className="process-list">
                  {metaTools.map((tool) => {
                    if (tool.subtype === 'todoList' && tool.planSteps?.length) return null;
                    const kind = processKind(tool);
                    const running = tool.completed === false;
                    const shimmer = running && (kind === 'command' || kind === 'reasoning');
                    const duration = itemDurationLabel(tool, now);
                    const body = tool.body?.trim();
                    return (
                      <li key={tool.id} className={running ? 'process-row running' : 'process-row'}>
                        <ProcessIcon kind={kind} running={running} />
                        <div className="process-row-main">
                          <div className="process-row-head">
                            <span className={shimmer ? 'process-row-title running-shimmer-text' : 'process-row-title'}>
                              {processRowTitle(kind, running)}
                            </span>
                            {duration ? (
                              <span className={shimmer ? 'process-row-duration running-shimmer-text' : 'process-row-duration'}>
                                {duration}
                              </span>
                            ) : null}
                          </div>
                          <div className={shimmer ? 'process-row-detail running-shimmer-text' : 'process-row-detail'}>{toolDetail(tool)}</div>
                          {body && !['reasoning', 'plan', 'todoList'].includes(tool.subtype ?? '') ? (
                            <pre className={shimmer ? 'process-row-output running-shimmer-text' : 'process-row-output'}>{body}</pre>
                          ) : null}
                          {body && ['reasoning', 'plan', 'todoList'].includes(tool.subtype ?? '') ? (
                            <p className={shimmer ? 'process-row-text running-shimmer-text' : 'process-row-text'}>{body}</p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {tools.filter((tool) => !META_TOOL_SUBTYPES.has(tool.subtype ?? '')).map((tool) => {
                  const duration = itemDurationLabel(tool, now);
                  return (
                    <p key={tool.id} className="turn-other-meta">
                      {tool.title}
                      {duration ? ` · ${duration}` : ''}
                      {tool.body?.trim() ? ` · ${tool.body.trim().split('\n')[0]}` : ''}
                    </p>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {agents.length > 0 ? (
          <div className="chat-agent-messages">
            {agents.map((agent) => (
              <div key={agent.id} className={`chat-agent-body ${agent.completed === false ? 'chat-streaming' : ''}`}>
                <MarkdownBlock value={agent.body} />
              </div>
            ))}
          </div>
        ) : active && toolsRunning ? (
          <ThinkingShimmer />
        ) : null}
      </div>
    </article>
  );
});

export const ThreadTimelineView = React.memo(function ThreadTimelineView({
  items,
  turnTiming,
  activeTurnIndex,
  waitingForReply,
}: {
  items: TimelineItem[];
  turnTiming: Record<number, TurnTiming>;
  activeTurnIndex: number;
  waitingForReply: boolean;
}) {
  const blocks = useMemo(() => groupTimelineItems(items, turnTiming), [items, turnTiming]);

  return (
    <>
      {blocks.map((block) => {
        if (block.type === 'user') {
          return <UserMessageRow key={block.item.id} event={block.item} />;
        }
        const active =
          waitingForReply &&
          block.turnIndex === activeTurnIndex &&
          ((block.agents[block.agents.length - 1]?.completed === false) || block.agents.length === 0);
        return (
          <AssistantTurnRow
            key={`turn-${block.turnIndex}-${block.agents[block.agents.length - 1]?.id ?? 'pending'}`}
            tools={block.tools}
            agents={block.agents}
            timing={block.timing}
            active={active}
          />
        );
      })}
    </>
  );
});

/** @deprecated Use ThreadTimelineView — kept for compatibility */
export const ThreadTimelineRow = React.memo(function ThreadTimelineRow({ event }: { event: TimelineItem }) {
  if (event.kind === 'user') return <UserMessageRow event={event} />;
  if (event.kind === 'agent') return <AssistantTurnRow tools={[]} agents={[event]} />;
  return null;
});

export function ThinkingShimmer() {
  return (
    <div className="thinking-shimmer" aria-label="思考中">
      <span className="thinking-shimmer-dot" />
      <span className="running-shimmer-text">Thinking</span>
    </div>
  );
}
