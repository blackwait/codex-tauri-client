import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  ChevronRight,
  Paperclip,
  Plug,
  Plus,
  Sparkles,
  Target,
} from 'lucide-react';
import { FloatingMenuPortal, isOutsideFloatingMenu, useFloatingAnchor } from './floatingMenu';

type ComposerAttachMenuProps = {
  disabled?: boolean;
  planMode: boolean;
  goalMode: boolean;
  onAddFiles: () => void;
  onNewThread: () => void;
  onPlanModeChange: (enabled: boolean) => void;
  onGoalModeChange: (enabled: boolean) => void;
  onOpenPlugins?: () => void;
};

export const ComposerAttachMenu = React.memo(function ComposerAttachMenu({
  disabled,
  planMode,
  goalMode,
  onAddFiles,
  onNewThread,
  onPlanModeChange,
  onGoalModeChange,
  onOpenPlugins,
}: ComposerAttachMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const { anchorRef, menuStyle } = useFloatingAnchor<HTMLButtonElement>(open, 'top-start');

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (isOutsideFloatingMenu(event.target as Node, [rootRef.current, anchorRef.current], [menuRef.current])) {
        setOpen(false);
        setShowCreate(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    setShowCreate(false);
  };

  return (
    <div className="composer-attach-menu" ref={rootRef}>
      <button
        ref={anchorRef}
        type="button"
        className="icon-btn"
        disabled={disabled}
        title="添加内容"
        onClick={() => {
          setOpen((value) => !value);
          setShowCreate(false);
        }}
      >
        <Plus size={14} />
      </button>

      <FloatingMenuPortal open={open} menuStyle={menuStyle} menuRef={menuRef} className="composer-attach-panel">
          <button
            type="button"
            className="composer-attach-item"
            onClick={() => {
              onAddFiles();
              close();
            }}
          >
            <Paperclip size={16} />
            <span>添加照片和文件</span>
          </button>

          <button type="button" className="composer-attach-item composer-attach-item-disabled" disabled>
            <Box size={16} />
            <span>附加 Cursor</span>
          </button>

          <div
            className="composer-attach-submenu"
            onMouseEnter={() => setShowCreate(true)}
            onMouseLeave={() => setShowCreate(false)}
          >
            <button type="button" className="composer-attach-item">
              <Plus size={16} />
              <span>创建</span>
              <ChevronRight size={14} />
            </button>
            {showCreate ? (
              <div className="composer-attach-subpanel">
                <button
                  type="button"
                  className="composer-attach-item"
                  onClick={() => {
                    onNewThread();
                    close();
                  }}
                >
                  <span>新建会话</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className="composer-attach-divider" />

          <label className="composer-attach-toggle">
            <span className="composer-attach-toggle-label">
              <Sparkles size={16} />
              计划模式
            </span>
            <input
              type="checkbox"
              checked={planMode}
              onChange={(event) => onPlanModeChange(event.target.checked)}
            />
          </label>

          <label className="composer-attach-toggle">
            <span className="composer-attach-toggle-label">
              <Target size={16} />
              追求目标
            </span>
            <input
              type="checkbox"
              checked={goalMode}
              onChange={(event) => onGoalModeChange(event.target.checked)}
            />
          </label>

          <div className="composer-attach-divider" />

          <button
            type="button"
            className="composer-attach-item"
            onClick={() => {
              onOpenPlugins?.();
              close();
            }}
          >
            <Plug size={16} />
            <span>插件</span>
            <ChevronRight size={14} />
          </button>
      </FloatingMenuPortal>
    </div>
  );
});
