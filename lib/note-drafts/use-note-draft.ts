"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DraftSaver, type DraftState } from "./draft-saver";
import type { NoteDraftFields, NoteDraftKey, NoteDraftSaveResult, StoredNoteDraft } from "./types";

// Client hook: one DraftSaver per (client, kind, target) key. The component using it is keyed by that key, so a client or
// section switch remounts it; the old saver flushes (with a timeout) and its responses can only reach itself.
type Actions = {
  save: (input: { key: NoteDraftKey; fields: NoteDraftFields; expectedRevision: number; writer: string }) => Promise<NoteDraftSaveResult>;
  discard: (key: NoteDraftKey) => Promise<{ ok: boolean }>;
};

const FLUSH_TIMEOUT_MS = 5000;

export function useNoteDraft(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: Actions) {
  const [state, setState] = useState<DraftState>({ phase: "idle", savedAt: null, theirs: null });
  const writer = useRef<string>("");
  if (!writer.current) writer.current = crypto.randomUUID();
  const saverRef = useRef<DraftSaver | null>(null);
  const keyRef = useRef(key);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  if (!saverRef.current) {
    saverRef.current = new DraftSaver({
      initialRevision: restored?.revision ?? 0,
      onState: setState,
      send: (fields, expectedRevision) =>
        actionsRef.current.save({ key: keyRef.current, fields, expectedRevision, writer: writer.current }),
    });
  }
  const saver = saverRef.current;

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") void saver.flush();
    };
    const leave = (e: BeforeUnloadEvent) => {
      if (saver.hasUnsavedWork()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", leave);
      // Section/client switch: flush what is pending, bounded by a timeout; the saver keeps the text in memory meanwhile.
      void Promise.race([saver.flush(), new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS))]).then(() => saver.dispose());
    };
  }, [saver]);

  const change = useCallback((fields: NoteDraftFields) => saver.change(fields), [saver]);
  return {
    state,
    change,
    flush: () => saver.flush(),
    retry: () => saver.retry(),
    keepMine: () => saver.keepMine(),
    keepAsNew: () => saver.keepAsNew(),
    useTheirs: () => saver.useTheirs(),
    /** The real record was saved (its transaction already cleared the draft): stop sending. */
    settle: () => saver.settle(),
    discard: async () => {
      saver.settle();
      await actionsRef.current.discard(keyRef.current);
    },
  };
}
