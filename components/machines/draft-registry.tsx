"use client";

import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

// ONE REGISTRY OF UNSAVED MACHINE STATE PER BlockSetupForm (#1369, design note DESIGN-NOTE-UNSAVED-STATE-1369.md, Insurance final423).
//
// WHY: "unsaved" used to be the OR of five flags in four components, set by EDGE events with a "last sent" cache, and cleared by effect
// cleanups that also ran when a dependency (not the component) changed. Three consecutive Codex rounds lived there (4505116958 hold,
// 4505287597 guard, 4505408578 draft cleared by a saved-identity flip).
//
// THE MODEL: LEVEL, NOT EDGE.
//   * Every owner has its OWN id per instance (useId), never derived from content.
//   * It WRITES its current flags in a layout effect keyed on the VALUES (idempotent: an unchanged value changes nothing).
//   * It REMOVES its own key in a SEPARATE layout effect with [] dependencies, so only an unmount (or a StrictMode probe) removes it.
//   * `anyDraft` and `anyUnresolved` are DERIVED from the map. Nothing outside this module calls the host's draft or hold setters, and no
//     wrapper ever reports "false" on a child's behalf.
//   * The map is per host instance (a React state value), never module-level.
//
// UNMOUNTING AN OWNER MID-SAVE DROPS ITS HOLD AND ITS RETRY KEY (the key lives in the owner). That is why every control that can unmount
// the reading entry (machine and mode pickers, the host's Cancel, the host's Save) stays gated on `anyUnresolved`.

export type DraftFlags = { draft: boolean; unresolved: boolean };
export type DraftRegistryApi = {
  report: (id: string, flags: DraftFlags) => void;
  remove: (id: string) => void;
};
export type DraftRegistryView = { anyDraft: boolean; anyUnresolved: boolean };

const ApiContext = createContext<DraftRegistryApi | null>(null);
const ViewContext = createContext<DraftRegistryView>({ anyDraft: false, anyUnresolved: false });

type Entries = Readonly<Record<string, DraftFlags>>;

/** The host's registry. Returns the api (stable identity) and the derived view. */
export function useDraftRegistryState(): { api: DraftRegistryApi; view: DraftRegistryView } {
  const [entries, setEntries] = useState<Entries>({});
  const report = useCallback((id: string, flags: DraftFlags) => {
    setEntries((prev) => {
      const cur = prev[id];
      if (cur && cur.draft === flags.draft && cur.unresolved === flags.unresolved) return prev;
      return { ...prev, [id]: { draft: flags.draft, unresolved: flags.unresolved } };
    });
  }, []);
  const remove = useCallback((id: string) => {
    setEntries((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  const api = useMemo<DraftRegistryApi>(() => ({ report, remove }), [report, remove]);
  const values = Object.values(entries);
  const anyDraft = values.some((f) => f.draft);
  const anyUnresolved = values.some((f) => f.unresolved);
  const view = useMemo(() => ({ anyDraft, anyUnresolved }), [anyDraft, anyUnresolved]);
  return { api, view };
}

export function DraftRegistryProvider({
  api,
  view,
  children,
}: {
  api: DraftRegistryApi;
  view: DraftRegistryView;
  children?: ReactNode;
}) {
  return (
    <ApiContext.Provider value={api}>
      <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
    </ApiContext.Provider>
  );
}

/** A registry of its own, for a panel mounted without a host (tests, stories). */
export function LocalDraftRegistry({ children }: { children: ReactNode }) {
  const { api, view } = useDraftRegistryState();
  return (
    <DraftRegistryProvider api={api} view={view}>
      {children}
    </DraftRegistryProvider>
  );
}

/** Whether a registry is in scope. Constant for the life of an instance. */
export function useHasDraftRegistry(): boolean {
  return useContext(ApiContext) !== null;
}

/** The derived view: any owner holds an unsaved draft / an unresolved save. */
export function useDraftView(): DraftRegistryView {
  return useContext(ViewContext);
}

/**
 * Report this owner's CURRENT flags. The write effect depends on the VALUES; the removal effect depends on nothing, so it runs on
 * unmount only. With no registry in scope (a bare render) it does nothing. `api` may be passed by the registry's own host, which sits
 * above the provider it creates.
 */
export function useReportDraft(flags: DraftFlags, apiOverride?: DraftRegistryApi): void {
  const fromContext = useContext(ApiContext);
  const api = apiOverride ?? fromContext;
  const id = useId();
  const { draft, unresolved } = flags;
  useLayoutEffect(() => {
    api?.report(id, { draft, unresolved });
  }, [api, id, draft, unresolved]);
  useLayoutEffect(() => {
    return () => api?.remove(id);
    // Unmount only: the owner's id is fixed for its life, and the api is stable. A dependency here would remove on a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
