"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";

// Unsaved-changes guard for the Settings shell.
//
// A form registers itself as dirty (useUnsavedChangesGuard) while its fields
// differ from what was last saved. While anything is dirty the guard
//   (a) asks the browser to confirm closing or reloading the tab, and
//   (b) asks, in the app's own dialog, before an in-app link navigation leaves
//       the current page (never window.confirm: iOS Safari can suppress it).
// Nothing is stored: it only observes. A form marks itself clean when a save
// succeeds, so a successful save never prompts.
//
// Known limit, stated rather than hidden: the browser Back button is not
// intercepted (only tab close, reload and link clicks are).

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. If you leave, they will be lost.";

type Guard = {
  setDirty: (key: string, dirty: boolean) => void;
};

const NOOP: Guard = { setDirty: () => undefined };
const GuardContext = createContext<Guard>(NOOP);

/** True when a click on this anchor would leave the current page in-app. */
export function isLeavingNavigation(
  anchor: Pick<HTMLAnchorElement, "href" | "target" | "download">,
  current: Pick<Location, "origin" | "pathname" | "search">,
): boolean {
  if (anchor.download) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  let url: URL;
  try {
    url = new URL(anchor.href, current.origin);
  } catch {
    return false;
  }
  if (url.origin !== current.origin) return false;
  // Same page (a hash jump to another section) is not leaving.
  return url.pathname !== current.pathname || url.search !== current.search;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const dirtyKeys = useRef(new Set<string>());
  const router = useRouter();
  const [leaving, setLeaving] = useState<string | null>(null);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
  }, []);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirtyKeys.current.size === 0) return;
      e.preventDefault();
      // Required by some browsers to show the native prompt.
      e.returnValue = "";
    }
    function onClick(e: MouseEvent) {
      if (dirtyKeys.current.size === 0) return;
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (!isLeavingNavigation(anchor, window.location)) return;
      // Hold the navigation and ask. "Leave" navigates to the same target.
      e.preventDefault();
      e.stopPropagation();
      setLeaving(anchor.href);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture phase: runs before the framework's link handler.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  const value = useMemo<Guard>(() => ({ setDirty }), [setDirty]);
  function leave() {
    const href = leaving;
    setLeaving(null);
    if (!href) return;
    // Leaving discards the edits, so the guard must not block this navigation.
    dirtyKeys.current.clear();
    const url = new URL(href, window.location.origin);
    router.push(`${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <GuardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={leaving !== null}
        title="Leave without saving?"
        description={UNSAVED_CHANGES_MESSAGE}
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={leave}
        onCancel={() => setLeaving(null)}
      />
    </GuardContext.Provider>
  );
}

/**
 * Register a form with the guard. `dirty` is true while the form's fields differ
 * from the last saved values. Safe outside the provider (does nothing).
 */
export function useUnsavedChangesGuard(key: string, dirty: boolean): void {
  const { setDirty } = useContext(GuardContext);
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty, setDirty]);
}
