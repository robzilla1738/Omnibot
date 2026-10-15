import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableElements(root: HTMLElement): HTMLElement[] {
  // Elements opted out with tabindex="-1" (e.g. listbox options driven by aria-activedescendant) are not Tab stops.
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[inert]") && el.getClientRects().length > 0);
}

/**
 * Focus management shared by every modal surface: initial focus on open, Tab trapping,
 * Escape to dismiss, and focus restoration to whatever opened the dialog.
 */
export function useDialog({ open, onClose, dismissible = true, initialFocus }: {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      (initialFocus?.current ?? focusableElements(panel)[0] ?? panel).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const panel = panelRef.current;
      const active = document.activeElement;
      const focusLeftDialog = !active || active === document.body || (panel?.contains(active) ?? false);
      if (previous?.isConnected && focusLeftDialog) previous.focus({ preventScroll: true });
    };
  }, [open, initialFocus]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (dismissible) { event.preventDefault(); onCloseRef.current(); }
      return;
    }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const items = focusableElements(panel);
    if (items.length === 0) { event.preventDefault(); panel.focus(); return; }
    // Safari's native Tab order may skip buttons; keep every dialog stop reachable.
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = index + (event.shiftKey ? -1 : 1);
    if (next < 0) next = items.length - 1;
    event.preventDefault();
    items[next % items.length].focus();
  }, [dismissible]);

  return { panelRef, onKeyDown };
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name when no visible heading is referenced. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  overlayClassName?: string;
  className?: string;
  closedClassName?: string;
  openClassName?: string;
  /** Mounting into document.body keeps nested dialogs above their parent's stacking context. */
  portal?: boolean;
}

export function Dialog({
  open, onClose, children, label, labelledBy, describedBy, role = "dialog", dismissible = true, initialFocus,
  overlayClassName = "items-center justify-center p-6", className = "", openClassName = "scale-100 opacity-100 translate-y-0",
  closedClassName = "scale-[0.985] opacity-0 translate-y-1", portal = false,
}: DialogProps) {
  const { panelRef, onKeyDown } = useDialog({ open, onClose, dismissible, initialFocus });
  const node = (
    <div
      aria-hidden={!open}
      inert={!open}
      className={`fixed inset-0 z-50 flex select-none bg-black/65 backdrop-blur-md transition-opacity duration-250 spring-transition ${overlayClassName} ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      onClick={event => { event.stopPropagation(); if (dismissible) onClose(); }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal={open ? true : undefined}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={event => event.stopPropagation()}
        className={`outline-none transition-[opacity,scale,translate] duration-250 spring-transition ${className} ${open ? openClassName : closedClassName}`}
      >
        {children}
      </div>
    </div>
  );
  return portal ? createPortal(node, document.body) : node;
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, busy = false, onConfirm, onCancel }: ConfirmOptions & {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      labelledBy={titleId}
      describedBy={message ? messageId : undefined}
      dismissible={!busy}
      initialFocus={destructive ? cancelRef : confirmRef}
      portal
      overlayClassName="z-[70] items-center justify-center p-6"
      className="w-full max-w-[400px] rounded-[20px] bg-[#1a1a1a] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] p-5 space-y-4 select-text"
    >
      <h2 id={titleId} className="text-[15px] font-semibold text-white">{title}</h2>
      {message && <div id={messageId} className="text-[13px] leading-relaxed text-zinc-300 break-words">{message}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="px-4 py-2 rounded-full text-[13px] text-zinc-200 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-50">{cancelLabel}</button>
        <button ref={confirmRef} type="button" disabled={busy} onClick={onConfirm} className={`px-4 py-2 rounded-full text-[13px] font-medium disabled:opacity-50 ${destructive ? "bg-red-500 text-white hover:bg-red-400" : "bg-white text-black hover:bg-zinc-200"}`}>{confirmLabel}</button>
      </div>
    </Dialog>
  );
}

/** Promise-based confirmation: `if (!(await confirm({...}))) return;` with the returned element rendered once. */
export function useConfirm() {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (confirmed: boolean) => void }) | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => {
    setRequest(previous => { previous?.resolve(false); return { ...options, resolve }; });
  }), []);
  const settle = (confirmed: boolean) => { request?.resolve(confirmed); setRequest(null); };
  const confirmElement = request ? <ConfirmDialog open {...request} onConfirm={() => settle(true)} onCancel={() => settle(false)} /> : null;
  return { confirm, confirmElement };
}
