"use client";

import { useCallback, useRef, useState } from "react";
import {
  NOT_REMEMBERED_MESSAGE,
  strictChartingView,
  type ChartingView,
} from "@/lib/charting/view-preference";

type Save = (view: ChartingView) => Promise<{ ok: boolean }>;

/**
 * The view the person is looking at, and whether their last choice was remembered. Choosing changes the view
 * at once and in this tab regardless of the save; the save only decides whether a notice appears. It submits
 * no form and starts nothing else. A late reply from an older choice cannot overwrite the notice of a newer one.
 */
export function useChartingViewPreference(initial: ChartingView, save: Save) {
  const [view, setViewState] = useState<ChartingView>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const setView = useCallback(
    (next: ChartingView) => {
      if (strictChartingView(next) === null) return;
      setViewState(next);
      const ticket = ++latest.current;
      void (async () => {
        let ok = false;
        try {
          ok = (await save(next)).ok === true;
        } catch {
          ok = false;
        }
        if (ticket !== latest.current) return;
        setNotice(ok ? null : NOT_REMEMBERED_MESSAGE);
      })();
    },
    [save],
  );
  return { view, setView, notice };
}
