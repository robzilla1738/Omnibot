import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

type Notice = { id: number; message: string };

export interface NoticesApi {
  notifyError: (message: string) => void;
  /**
   * Runs an action, reporting failures in the shared toast instead of throwing.
   * `revert` undoes optimistic UI state when the action fails.
   */
  runAction: <T>(label: string, action: () => Promise<T>, options?: { revert?: () => void }) => Promise<T | undefined>;
}

const MAX_NOTICES = 3;

const fallback: NoticesApi = {
  notifyError: message => console.error(message),
  runAction: async (label, action, options) => {
    try { return await action(); } catch (error) { options?.revert?.(); console.error(`${label}: ${errorMessage(error)}`); return undefined; }
  },
};

const NoticesContext = createContext<NoticesApi>(fallback);

export function useNotices(): NoticesApi {
  return useContext(NoticesContext);
}

export function NoticesProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setNotices(list => list.filter(notice => notice.id !== id)), []);
  const notifyError = useCallback((message: string) => {
    setNotices(list => {
      if (list.some(notice => notice.message === message)) return list;
      return [...list, { id: nextId.current++, message }].slice(-MAX_NOTICES);
    });
  }, []);
  const runAction = useCallback(async <T,>(label: string, action: () => Promise<T>, options?: { revert?: () => void }) => {
    try {
      return await action();
    } catch (error) {
      options?.revert?.();
      notifyError(label ? `${label}: ${errorMessage(error)}` : errorMessage(error));
      return undefined;
    }
  }, [notifyError]);
  const api = useMemo<NoticesApi>(() => ({ notifyError, runAction }), [notifyError, runAction]);
  return (
    <NoticesContext.Provider value={api}>
      {children}
      {notices.length > 0 && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 w-[min(560px,calc(100vw-32px))]">
          {notices.map(notice => (
            <div key={notice.id} role="alert" className="motion-menu w-full flex items-start gap-3 rounded-xl bg-red-950 border border-red-400/30 px-4 py-3 text-sm text-red-200 shadow-2xl">
              <span className="flex-1 min-w-0 break-words select-text">{notice.message}</span>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(notice.id)} className="shrink-0 rounded-md p-0.5 text-red-200/80 hover:text-white"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </NoticesContext.Provider>
  );
}
