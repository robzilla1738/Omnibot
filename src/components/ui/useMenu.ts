import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";

function menuItems(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])')] : [];
}

/**
 * Keyboard behaviour for role="menu" popovers: focus the first item on open, arrow/Home/End
 * navigation, Escape to close, and focus returned to the element that opened the menu.
 */
export function useMenu<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const menuRef = useRef<T>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const root = menuRef.current;
      if (root && !root.contains(document.activeElement)) (menuItems(root)[0] ?? root).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const active = document.activeElement;
      const focusLost = !active || active === document.body || (menuRef.current?.contains(active) ?? false);
      const trigger = triggerRef.current ?? opener;
      if (trigger?.isConnected && focusLost) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (typing && event.key !== "Escape") return;
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
    switch (event.key) {
      case "ArrowDown": focusAt(index + 1); break;
      case "ArrowUp": focusAt(index < 0 ? items.length - 1 : index - 1); break;
      case "Home": focusAt(0); break;
      case "End": focusAt(items.length - 1); break;
      case "Escape": event.preventDefault(); event.stopPropagation(); onCloseRef.current(); break;
      case "Tab": onCloseRef.current(); break;
    }
  }, []);

  return { menuRef, triggerRef, onKeyDown };
}
