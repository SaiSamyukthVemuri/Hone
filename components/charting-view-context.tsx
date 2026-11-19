"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChartingView } from "@/lib/charting/view-preference";

export type ChartingViewValue = { view: ChartingView; setView: (v: ChartingView) => void; notice: string | null };

export const ChartingViewContext = createContext<ChartingViewValue | null>(null);

/** The view being shown. Outside the switch (every other page, every test that mounts a bare form) it is Current. */
export function useChartingView(): ChartingView {
  return useContext(ChartingViewContext)?.view ?? "current";
}

/**
 * A numbered step heading that exists ONLY in New view. In Current view the caller renders nothing in its place, so
 * Current's markup is exactly what it always was. It is a heading and nothing else: it holds no state and no control.
 */
export function NewViewStep({ n, title }: { n: number; title: string }) {
  return (
    <h3
      data-testid={`new-view-step-${n}`}
      className="flex items-center gap-2 text-base font-semibold"
    >
      <span
        aria-hidden="true"
        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        {n}
      </span>
      {title}
    </h3>
  );
}

/**
 * The same heading for a SERVER-rendered page, which cannot read the view itself: it renders the step in New view and NOTHING in Current view,
 * so Current's markup is exactly what it always was. Like NewViewStep it holds no state and no control.
 */
export function NewViewOnlyStep({ n, title }: { n: number; title: string }) {
  return useChartingView() === "new" ? <NewViewStep n={n} title={title} /> : null;
}

export function ChartingViewProvider({ value, children }: { value: ChartingViewValue; children: ReactNode }) {
  return <ChartingViewContext.Provider value={value}>{children}</ChartingViewContext.Provider>;
}
