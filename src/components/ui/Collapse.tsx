import type { ReactNode } from "react";

/** Keeps content mounted so closing animates and drafts survive reopening. */
export function Collapse({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  return (
    <div id={id} aria-hidden={!open} inert={!open}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity,margin] duration-250 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, marginBlock: open ? undefined : 0 }}>
      <div className="min-h-0 min-w-0 overflow-clip">{children}</div>
    </div>
  );
}
