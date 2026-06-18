import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export type FloatingPlacement = 'top-end' | 'top-start';

export function useFloatingAnchor<T extends HTMLElement = HTMLElement>(
  open: boolean,
  placement: FloatingPlacement = 'top-end',
  menuRef?: RefObject<HTMLElement | null>,
  layoutKey?: unknown,
) {
  const anchorRef = useRef<T | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const node = anchorRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const menuWidth = menuRef?.current?.offsetWidth ?? 0;
      const next: CSSProperties = {
        position: 'fixed',
        zIndex: 2000,
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        left: 'auto',
        top: 'auto',
      };
      if (placement === 'top-end') {
        let right = Math.max(8, window.innerWidth - rect.right);
        if (menuWidth > 0) {
          const menuLeft = window.innerWidth - right - menuWidth;
          if (menuLeft < 8) {
            right = Math.max(8, window.innerWidth - menuWidth - 8);
          }
        }
        next.right = right;
      } else {
        let left = Math.max(8, rect.left);
        if (menuWidth > 0) {
          const menuRight = left + menuWidth;
          if (menuRight > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - menuWidth - 8);
          }
        }
        next.left = left;
        next.right = 'auto';
      }
      setMenuStyle(next);
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    const menuNode = menuRef?.current;
    const resizeObserver =
      menuNode && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(update)
        : undefined;
    resizeObserver?.observe(menuNode!);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      resizeObserver?.disconnect();
    };
  }, [open, placement, menuRef, layoutKey]);

  return { anchorRef, menuStyle };
}

type FloatingMenuPortalProps = {
  open: boolean;
  menuStyle: CSSProperties;
  menuRef?: RefObject<HTMLDivElement>;
  className?: string;
  children: ReactNode;
};

export function FloatingMenuPortal({ open, menuStyle, menuRef, className, children }: FloatingMenuPortalProps) {
  if (!open) return null;
  return createPortal(
    <div ref={menuRef} className={className} style={menuStyle}>
      {children}
    </div>,
    document.body,
  );
}

export function isOutsideFloatingMenu(
  target: Node,
  anchors: Array<HTMLElement | null | undefined>,
  menus: Array<HTMLElement | null | undefined>,
) {
  return !anchors.some((node) => node?.contains(target)) && !menus.some((node) => node?.contains(target));
}
