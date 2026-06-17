import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export type FloatingPlacement = 'top-end' | 'top-start';

export function useFloatingAnchor<T extends HTMLElement = HTMLElement>(
  open: boolean,
  placement: FloatingPlacement = 'top-end',
) {
  const anchorRef = useRef<T | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const node = anchorRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const next: CSSProperties = {
        position: 'fixed',
        zIndex: 2000,
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        left: 'auto',
        top: 'auto',
      };
      if (placement === 'top-end') {
        next.right = Math.max(8, window.innerWidth - rect.right);
      } else {
        next.left = Math.max(8, rect.left);
        next.right = 'auto';
      }
      setMenuStyle(next);
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, placement]);

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
