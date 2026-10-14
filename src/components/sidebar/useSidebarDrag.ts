import { useRef, useState, type PointerEvent, type MouseEvent } from "react";

type Drag = { kind: "item" | "section"; section: string; id: string };
type Target = { id: string; after: boolean };

/** Pointer capture works in both WebKit/Tauri and the browser, without native file dragging. */
export function useSidebarDrag(onDrop: (source: Drag, target: Target) => void) {
  const gesture = useRef<(Drag & { x: number; y: number; active: boolean }) | null>(null);
  const target = useRef<Target | null>(null);
  const suppressClick = useRef(false);
  const [source, setSource] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const reset = () => { gesture.current = null; target.current = null; setSource(null); setOver(null); };

  const bind = (drag: Drag) => ({
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0 || event.pointerType === "touch") return;
      suppressClick.current = false;
      gesture.current = { ...drag, x: event.clientX, y: event.clientY, active: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const current = gesture.current;
      if (!current) return;
      if (!current.active && Math.hypot(event.clientX-current.x, event.clientY-current.y) < 6) return;
      event.preventDefault();
      if (!current.active) { current.active = true; setSource(drag); }
      const at = document.elementFromPoint(event.clientX, event.clientY);
      const element = at?.closest<HTMLElement>(current.kind === "item" ? "[data-sidebar-item]" : "[data-sidebar-section]");
      const id = current.kind === "item" ? element?.dataset.sidebarItem : element?.dataset.sidebarSection;
      const section = element?.closest<HTMLElement>("[data-sidebar-section]")?.dataset.sidebarSection;
      if (element && id && id !== current.id && (current.kind === "section" || section === current.section)) {
        const bounds = element.getBoundingClientRect();
        target.current = { id, after: event.clientY > bounds.top + bounds.height / 2 };
        setOver(id);
      } else { target.current = null; setOver(null); }
      const scroller = event.currentTarget.closest<HTMLElement>("[data-sidebar-scroll]");
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (event.clientY < bounds.top + 40) scroller.scrollTop -= 12;
        else if (event.clientY > bounds.bottom - 60) scroller.scrollTop += 12;
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const current = gesture.current;
      if (current?.active) {
        suppressClick.current = true;
        if (target.current) onDrop(current, target.current);
      }
      reset();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() { suppressClick.current = !!gesture.current?.active; reset(); },
    onLostPointerCapture() { if (gesture.current) reset(); },
    onClickCapture(event: MouseEvent<HTMLButtonElement>) {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
    },
  });
  return { bind, source, over };
}

export function reorderAt(ids: string[], source: string, target: string, after: boolean) {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  return next;
}
