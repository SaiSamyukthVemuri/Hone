"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One save-feedback rule for every Settings form (settings redesign, WS-B):
//   idle   -> nothing shown
//   saving -> "Saving..." while the request is in flight
//   saved  -> "Saved" for a few seconds, announced politely
//   error  -> the real message, persistent until the next edit or save, announced
// Forms keep their own saving logic and fields; this only presents the result.

export const SAVED_VISIBLE_MS = 3000;

export type SaveFeedbackState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function useSaveFeedback() {
  const [state, setState] = useState<SaveFeedbackState>({ kind: "idle" });
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const saving = useCallback(() => {
    clearTimer();
    setState({ kind: "saving" });
  }, []);
  const saved = useCallback(() => {
    clearTimer();
    setState({ kind: "saved" });
    timer.current = window.setTimeout(() => setState({ kind: "idle" }), SAVED_VISIBLE_MS);
  }, []);
  const failed = useCallback((message: string) => {
    clearTimer();
    setState({ kind: "error", message });
  }, []);
  const reset = useCallback(() => {
    clearTimer();
    setState({ kind: "idle" });
  }, []);

  return { state, saving, saved, failed, reset };
}

export function SaveStatus({ state }: { state: SaveFeedbackState }) {
  if (state.kind === "error") {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {state.message}
      </p>
    );
  }
  return (
    <p role="status" aria-live="polite" className="min-h-5 text-sm text-neutral-600 dark:text-neutral-400">
      {state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : ""}
    </p>
  );
}
