"use client";

/**
 * What the open editor(s) of this visit tell the New view's "This visit" card, and nothing else: the machine the form actually has selected, the areas
 * picked but not yet saved, and whether the form holds unsaved work or an error. DISPLAY ONLY.
 *
 * A form REPORTS here; this holds no value the form reads back, saves nothing, calls no action and submits nothing. With no provider mounted (every other
 * page, every bare form in a test) reporting is a no-op, so a form behaves exactly as it did.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type VisitDraftReport = {
  /** The machine selected on this form, e.g. "Apilus xCell Pur · 27.12 MHz", or null when none is. */
  machine: string | null;
  /** The areas picked on a NEW block that is not saved yet, already labelled. */
  draftAreas: string[];
  /** The form holds work that is not saved. */
  unsaved: boolean;
  /** The form is showing an error from its last attempt. */
  attention: boolean;
};

export type VisitDraftSummary = {
  machine: string | null;
  draftAreas: string[];
  unsaved: boolean;
  attention: boolean;
};

type Api = { report: (id: string, r: VisitDraftReport | null) => void; summary: VisitDraftSummary };
const Ctx = createContext<Api | null>(null);

export const EMPTY_VISIT_DRAFT: VisitDraftSummary = { machine: null, draftAreas: [], unsaved: false, attention: false };

export function summarizeReports(reports: Record<string, VisitDraftReport>): VisitDraftSummary {
  const list = Object.keys(reports)
    .sort()
    .map((k) => reports[k]);
  const areas: string[] = [];
  for (const r of list) for (const a of r.draftAreas) if (!areas.includes(a)) areas.push(a);
  return {
    machine: list.find((r) => r.machine)?.machine ?? null,
    draftAreas: areas,
    unsaved: list.some((r) => r.unsaved),
    attention: list.some((r) => r.attention),
  };
}

export function ChartingVisitDraftProvider({ children }: { children: ReactNode }) {
  const [reports, setReports] = useState<Record<string, VisitDraftReport>>({});
  const report = useCallback((id: string, r: VisitDraftReport | null) => {
    setReports((prev) => {
      if (r === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const old = prev[id];
      if (old && old.machine === r.machine && old.unsaved === r.unsaved && old.attention === r.attention && old.draftAreas.join("\u0001") === r.draftAreas.join("\u0001")) return prev;
      return { ...prev, [id]: r };
    });
  }, []);
  const summary = useMemo(() => summarizeReports(reports), [reports]);
  const api = useMemo(() => ({ report, summary }), [report, summary]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The form calls this with its current report; the entry is removed when the form unmounts. No-op without a provider. */
export function useReportVisitDraft(id: string, r: VisitDraftReport) {
  const api = useContext(Ctx);
  const report = api?.report;
  const key = JSON.stringify(r);
  useEffect(() => {
    report?.(id, JSON.parse(key) as VisitDraftReport);
  }, [report, id, key]);
  useEffect(() => () => report?.(id, null), [report, id]);
}

export function useVisitDraftSummary(): VisitDraftSummary {
  return useContext(Ctx)?.summary ?? EMPTY_VISIT_DRAFT;
}
