import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Hand, Settings, ShieldAlert, Terminal, type LucideIcon } from 'lucide-react';
import { FloatingMenuPortal, isOutsideFloatingMenu, useFloatingAnchor } from './floatingMenu';

export type PermissionModeId = 'auto' | 'guardian-approvals' | 'full-access' | 'custom';

export type PermissionSettings = {
  approvalPolicy: string | Record<string, unknown>;
  approvalsReviewer: string;
  sandboxPolicy: Record<string, unknown>;
};

export const PERMISSION_OPTIONS: Array<{
  id: PermissionModeId;
  shortLabel: string;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    id: 'auto',
    shortLabel: '请求批准',
    title: '请求批准',
    description: '编辑外部文件和使用互联网时始终询问',
    icon: Hand,
  },
  {
    id: 'guardian-approvals',
    shortLabel: '替我审批',
    title: '替我审批',
    description: '仅对检测到的风险操作请求批准',
    icon: Terminal,
  },
  {
    id: 'full-access',
    shortLabel: '完全访问',
    title: '完全访问权限',
    description: '可不受限制地访问互联网和您电脑上的任何文件',
    icon: ShieldAlert,
  },
  {
    id: 'custom',
    shortLabel: '自定义',
    title: '自定义 (config.toml)',
    description: '使用 config.toml 中定义的权限',
    icon: Settings,
  },
];

export function workspaceWritePolicy(cwd: string | null): Record<string, unknown> {
  return {
    type: 'workspaceWrite',
    writableRoots: cwd ? [cwd] : [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function permissionModeToSettings(mode: PermissionModeId, cwd: string | null): PermissionSettings | null {
  switch (mode) {
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: workspaceWritePolicy(cwd),
      };
    case 'guardian-approvals':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'guardian_subagent',
        sandboxPolicy: workspaceWritePolicy(cwd),
      };
    case 'full-access':
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    case 'custom':
      return null;
  }
}

export function detectPermissionMode(settings: {
  approvalPolicy?: unknown;
  approvalsReviewer?: string;
  sandboxPolicy?: { type?: string };
}): PermissionModeId {
  const sandboxType = settings.sandboxPolicy?.type;
  const approvalPolicy = settings.approvalPolicy;
  const reviewer = settings.approvalsReviewer;

  if (sandboxType === 'dangerFullAccess' && approvalPolicy === 'never') return 'full-access';
  if (approvalPolicy === 'on-request' && reviewer === 'guardian_subagent') return 'guardian-approvals';
  if (approvalPolicy === 'on-request' && reviewer === 'user') return 'auto';
  if (typeof approvalPolicy === 'object' && approvalPolicy !== null) return 'auto';
  return 'custom';
}

type PermissionsPickerProps = {
  mode: PermissionModeId;
  disabled?: boolean;
  onChange: (mode: PermissionModeId) => void;
  onOpenCustom?: () => void;
};

export const PermissionsPicker = React.memo(function PermissionsPicker({
  mode,
  disabled,
  onChange,
  onOpenCustom,
}: PermissionsPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const { anchorRef, menuStyle } = useFloatingAnchor<HTMLButtonElement>(open, 'top-start');
  const active = useMemo(() => PERMISSION_OPTIONS.find((item) => item.id === mode) ?? PERMISSION_OPTIONS[2], [mode]);
  const ActiveIcon = active.icon;
  const isFullAccess = mode === 'full-access';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (isOutsideFloatingMenu(event.target as Node, [rootRef.current, anchorRef.current], [menuRef.current])) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="permissions-picker" ref={rootRef}>
      <button
        ref={anchorRef}
        type="button"
        className={isFullAccess ? 'access-pill access-pill-warning permissions-trigger' : 'access-pill permissions-trigger'}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <ActiveIcon size={12} />
        <span>{active.shortLabel}</span>
        <ChevronDown size={12} />
      </button>

      <FloatingMenuPortal open={open} menuStyle={menuStyle} menuRef={menuRef} className="permissions-picker-panel">
        <div className="permissions-picker-header">
          <span>应如何批准 Codex 操作？</span>
          <button type="button" className="permissions-learn-more" onClick={() => onOpenCustom?.()}>
            了解更多
          </button>
        </div>
        {PERMISSION_OPTIONS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={item.id === mode ? 'permissions-picker-item active' : 'permissions-picker-item'}
              onClick={() => {
                if (item.id === 'custom') onOpenCustom?.();
                onChange(item.id);
                setOpen(false);
              }}
            >
              <Icon size={16} />
              <div className="permissions-picker-copy">
                <strong>{item.title}</strong>
                <span>{item.description}</span>
              </div>
              {item.id === mode ? <span className="model-picker-check">✓</span> : null}
            </button>
          );
        })}
      </FloatingMenuPortal>
    </div>
  );
});
