import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, SquareTerminal } from 'lucide-react';

export type TimelineItem = {
  id: string;
  kind: 'agent' | 'user' | 'tool' | 'system' | 'error' | 'approval';
  title: string;
  body: string;
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
      agent: TimelineItem | null;
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

function commandFromItem(item: TimelineItem): string {
  if (item.command) return item.command;
  if (item.title.startsWith('命令：')) return item.title.slice('命令：'.length).trim();
  return item.title;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
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
  'plan',
  'webSearch',
  'fileChange',
  'todoList',
]);

export function isThreadRenderable(event: TimelineItem) {
  return event.kind === 'user' || event.kind === 'agent' || event.kind === 'tool';
}

export function groupTimelineItems(
  items: TimelineItem[],
  turnTiming: Record<number, TurnTiming>,
): TimelineDisplayBlock[] {
  const blocks: TimelineDisplayBlock[] = [];
  const buckets = new Map<number, { tools: TimelineItem[]; agent: TimelineItem | null }>();

  const flushTurn = (turnIndex: number) => {
    const bucket = buckets.get(turnIndex);
    if (!bucket) return;
    const visibleTools = bucket.tools.filter((tool) => !HIDDEN_TOOL_SUBTYPES.has(tool.subtype ?? ''));
    if (visibleTools.length === 0 && !bucket.agent) {
      buckets.delete(turnIndex);
      return;
    }
    blocks.push({
      type: 'assistant-turn',
      turnIndex,
      tools: visibleTools,
      agent: bucket.agent,
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
    if (!buckets.has(turnIndex)) buckets.set(turnIndex, { tools: [], agent: null });
    const bucket = buckets.get(turnIndex)!;

    if (item.kind === 'agent') {
      bucket.agent = item;
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
    const content = Array.isArray(item?.content) ? item.content : [];
    const text = content
      .filter((c: any) => c?.type === 'text' && typeof c?.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
    return {
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      kind: 'user',
      title: '用户',
      body: text || toPretty(item),
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

const MarkdownBlock = React.memo(function MarkdownBlock({ value }: { value: string }) {
  return <pre className="event-mono">{value}</pre>;
});

const UserMessageRow = React.memo(function UserMessageRow({ event }: { event: TimelineItem }) {
  return (
    <article className="chat-message chat-user">
      <div className="chat-user-bubble">
        <pre>{event.body}</pre>
      </div>
    </article>
  );
});

const AssistantTurnRow = React.memo(function AssistantTurnRow({
  tools,
  agent,
  timing,
  active,
}: {
  tools: TimelineItem[];
  agent: TimelineItem | null;
  timing?: TurnTiming;
  active?: boolean;
}) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const metaTools = tools.filter((tool) => META_TOOL_SUBTYPES.has(tool.subtype ?? ''));
  const reasoningItems = metaTools.filter((tool) => tool.subtype === 'reasoning');
  const reasoningText = reasoningItems
    .map((tool) => tool.body.trim())
    .filter(Boolean)
    .join('\n\n');
  const planText = metaTools
    .filter((tool) => tool.subtype === 'plan')
    .map((tool) => tool.body.trim())
    .filter(Boolean)
    .join('\n\n');
  const commandItems = metaTools.filter((tool) =>
    ['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(tool.subtype ?? ''),
  );
  const otherMeta = metaTools.filter(
    (tool) =>
      !['reasoning', 'plan', 'commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(tool.subtype ?? ''),
  );

  const hasMeta = metaTools.length > 0 || active;
  const commandsRunning = commandItems.some((tool) => tool.completed === false);
  const showCommandsBody = commandsOpen || (active && commandsRunning);
  const toolsRunning = metaTools.some((tool) => tool.completed === false);
  const showMetaBody = metaOpen || (active && toolsRunning);

  useEffect(() => {
    if (!active && !toolsRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [active, toolsRunning]);

  const totalCommandMs = commandItems.reduce((sum, tool) => sum + (itemDurationMs(tool, now) ?? 0), 0);
  const firstRunningDuration = commandItems[0] ? itemDurationLabel(commandItems[0], now) : null;

  const durationMs =
    timing?.completedAt && timing?.startedAt
      ? timing.completedAt - timing.startedAt
      : timing?.startedAt
        ? Date.now() - timing.startedAt
        : null;

  const processedLabel =
    durationMs != null
      ? `已处理 ${formatDurationMs(durationMs)}`
      : toolsRunning || active
        ? '处理中…'
        : '已处理';

  if (!hasMeta && !agent) return null;

  return (
    <article className="chat-message chat-agent">
      <div className="chat-agent-turn">
        {hasMeta ? (
          <div className="turn-meta">
            <button type="button" className="turn-meta-toggle" onClick={() => setMetaOpen((value) => !value)}>
              <span>{processedLabel}</span>
              <ChevronDown size={14} className={metaOpen ? 'turn-chevron open' : 'turn-chevron'} />
            </button>
            {showMetaBody ? (
              <div className="turn-meta-body">
                {reasoningText ? (
                  <p className="turn-reasoning-text">
                    {reasoningItems.some((tool) => itemDurationLabel(tool, now)) ? (
                      <span className="turn-inline-duration">
                        思考 · {itemDurationLabel(reasoningItems[0], now)}
                        {' · '}
                      </span>
                    ) : null}
                    {reasoningText}
                  </p>
                ) : null}
                {planText ? <p className="turn-plan-text">{planText}</p> : null}
                {commandItems.length > 0 ? (
                  <div className="turn-commands">
                    <button type="button" className="turn-commands-toggle" onClick={() => setCommandsOpen((value) => !value)}>
                      <SquareTerminal size={14} />
                      <span>
                        {commandsRunning
                          ? `正在运行${firstRunningDuration ? ` · ${firstRunningDuration}` : ''} ${truncateCommand(commandFromItem(commandItems[0]), 40)}`
                          : `已运行 ${commandItems.length} 条命令${totalCommandMs > 0 ? ` · ${formatDurationMs(totalCommandMs)}` : ''}`}
                      </span>
                      <ChevronDown size={14} className={commandsOpen ? 'turn-chevron open' : 'turn-chevron'} />
                    </button>
                    {showCommandsBody ? (
                      <ul className="turn-command-list">
                        {commandItems.map((tool) => {
                          const duration = itemDurationLabel(tool, now);
                          return (
                          <li key={tool.id}>
                            <div className="turn-command-head">
                              <span className="turn-command-label">{tool.completed === false ? '正在运行' : '已运行'}</span>
                              {duration ? <span className="turn-command-duration">{duration}</span> : null}
                            </div>
                            <code>{truncateCommand(commandFromItem(tool))}</code>
                            {tool.body?.trim() ? <pre className="turn-command-output">{tool.body.trim()}</pre> : null}
                          </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {otherMeta.map((tool) => {
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

        {agent ? (
          <div className={`chat-agent-body ${agent.completed === false ? 'chat-streaming' : ''}`}>
            <MarkdownBlock value={agent.body} />
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
          (block.agent?.completed === false || !block.agent);
        return (
          <AssistantTurnRow
            key={`turn-${block.turnIndex}-${block.agent?.id ?? 'pending'}`}
            tools={block.tools}
            agent={block.agent}
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
  if (event.kind === 'agent') return <AssistantTurnRow tools={[]} agent={event} />;
  return null;
});

export function ThinkingShimmer() {
  return (
    <div className="thinking-shimmer" aria-label="思考中">
      <span className="thinking-shimmer-dot" />
      <span>Thinking</span>
    </div>
  );
}
