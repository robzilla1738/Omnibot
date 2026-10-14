import { useEffect, useState } from "react";
import { DesktopShell } from "./components/layout/DesktopShell";
import { getOmniSnapshot } from "./lib/omni-bridge";
import type { OmniSnapshot } from "./lib/types";

export function App() {
  const [snapshot, setSnapshot] = useState<OmniSnapshot | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    getOmniSnapshot()
      .then((res) => setSnapshot(res))
      .catch((err) =>
        setBootError(
          err instanceof Error
            ? err.message
            : "Could not reach Omni Bot local Rust backend"
        )
      );
  }, []);

  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    let lastUserInputAt = 0;

    const markUserInput = () => {
      lastUserInputAt = Date.now();
    };

    const onScroll = (e: Event) => {
      if (Date.now() - lastUserInputAt > 1500) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      el.classList.add("is-scrolling");
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        setTimeout(() => {
          el.classList.remove("is-scrolling");
          timers.delete(el);
        }, 750)
      );
    };

    window.addEventListener("wheel", markUserInput, { passive: true, capture: true });
    window.addEventListener("touchmove", markUserInput, { passive: true, capture: true });
    window.addEventListener("pointerdown", markUserInput, { passive: true, capture: true });
    window.addEventListener("keydown", markUserInput, { passive: true, capture: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("wheel", markUserInput, { capture: true });
      window.removeEventListener("touchmove", markUserInput, { capture: true });
      window.removeEventListener("pointerdown", markUserInput, { capture: true });
      window.removeEventListener("keydown", markUserInput, { capture: true });
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  if (bootError) {
    return (
      <div className="h-screen w-screen bg-[#121212] text-zinc-200 flex flex-col items-center justify-center p-6 text-center">
        <img
          src="/botfinity-gauntlet.png"
          alt="Botfinity"
          className="w-16 h-16 object-contain"
        />
        <h2 className="mt-4 text-base font-semibold text-white">
          Botfinity Local Daemon Offline
        </h2>
        <p className="mt-1.5 text-xs text-zinc-400 max-w-md">{bootError}</p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="h-screen w-screen bg-[#121212] flex flex-col items-center justify-center gap-3">
        <img
          src="/botfinity-gauntlet.png"
          alt="Botfinity"
          className="w-14 h-14 object-contain animate-pulse"
        />
        <span className="text-xs text-zinc-500">
          Starting Botfinity...
        </span>
      </div>
    );
  }

  return <DesktopShell initialSnapshot={snapshot} />;
}
