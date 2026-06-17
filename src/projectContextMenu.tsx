import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Pin, SquarePen, X } from 'lucide-react';

export type ProjectMenuTarget = {
  id: number;
  path: string;
  name: string;
  created_at?: number;
  pinned?: boolean;
};

export type ProjectContextMenuState = {
  project: ProjectMenuTarget;
  x: number;
  y: number;
};

type ProjectContextMenuProps = {
  menu: ProjectContextMenuState | null;
  onClose: () => void;
  onPin: (project: ProjectMenuTarget) => void;
  onOpenDirectory: (project: ProjectMenuTarget) => void;
  onRename: (project: ProjectMenuTarget) => void;
  onRemove: (project: ProjectMenuTarget) => void;
};

export const ProjectContextMenu = React.memo(function ProjectContextMenu({
  menu,
  onClose,
  onPin,
  onOpenDirectory,
  onRename,
  onRemove,
}: ProjectContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const width = 220;
  const height = 168;
  const left = Math.min(menu.x, window.innerWidth - width - 8);
  const top = Math.min(menu.y, window.innerHeight - height - 8);

  const items = [
    {
      key: 'pin',
      label: menu.project.pinned ? '取消置顶项目' : '置顶项目',
      icon: Pin,
      onClick: () => onPin(menu.project),
    },
    {
      key: 'open',
      label: '打开目录',
      icon: FolderOpen,
      onClick: () => onOpenDirectory(menu.project),
    },
    {
      key: 'rename',
      label: '重命名项目',
      icon: SquarePen,
      onClick: () => onRename(menu.project),
    },
    {
      key: 'remove',
      label: '移除',
      icon: X,
      onClick: () => onRemove(menu.project),
    },
  ];

  return createPortal(
    <div
      ref={menuRef}
      className="project-context-menu"
      style={{ position: 'fixed', left, top, zIndex: 2500 }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            className="project-context-menu-item"
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            <Icon size={15} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
});
