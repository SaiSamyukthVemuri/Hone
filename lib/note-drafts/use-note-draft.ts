"use client";

import { useCallback, useEffect, useState } from "react";
import { acquireEntry, markNone, type DraftActions, type DraftEntry } from "./draft-registry";
import type { DraftState } from "./draft-saver";
import type { NoteDraftFields, NoteDraftKey, StoredNoteDraft } from "./types";

// Client hook: attaches this editor to the key's DraftSaver (see draft-registry.ts). Unmounting DETACHES, it never discards: a flush that
// fails (or conflicts, or is cleared) leaves the text held in the saver for the remount, and the failure is shown there. A flush is never
// treated as a save unless it says so.
const FLUSH_TIMEOUT_MS = 5000;

/** `enabled` false (autosave off for this studio): a private, unregistered saver that nothing sends from. The registry is never touched. */
export function useNoteDraft(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: DraftActions, enabled = true) {
  const [state, setState] = useState<DraftState>({ phase: "idle", savedAt: null, theirs: null });
  const [discardFailed, setDiscardFailed] = useState(false);
  const [entry] = useState<DraftEntry>(() => acquireEntry(key, restored, actions, () => undefined, enabled));
  const saver = entry.saver;
  entry.actions = actions;

  useEffect(() => {
    // (Re)attach: take over state updates and show the saver's real state (a held failure is visible again, not forgotten).
    saver.setListener((s) => {
      entry.floor = Math.max(entry.floor, saver.currentRevision());
      setState(s);
    });
    setState(saver.snapshot());
    const unsaved = saver.unsavedWork();
    if (unsaved && saver.snapshot().phase === "idle") saver.change(unsaved.fields); // text held by a detached saver goes out again
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
      // Section/client switch: detach and try to save what is pending, bounded by a timeout. Whatever is still unsaved after that STAYS in
      // the saver (and keeps retrying quietly); the remount re-attaches to it. Nothing is disposed.
      saver.setListener(() => undefined);
      void Promise.race([saver.flush(), new Promise<boolean>((r) => setTimeout(() => r(false), FLUSH_TIMEOUT_MS))]);
    };
  }, [saver, entry]);

  const change = useCallback(
    (fields: NoteDraftFields) => {
      // New text after a Save or Discard is a NEW draft: the registry must stop saying "this key has no draft", or a remount would drop it.
      entry.none = false;
      saver.change(fields);
    },
    [saver, entry],
  );
  return {
    state,
    discardFailed,
    change,
    flush: () => saver.flush(),
    retry: () => saver.retry(),
    keepMine: () => saver.keepMine(),
    keepAsNew: () => saver.keepAsNew(),
    useTheirs: () => saver.useTheirs(),
    /** The newest text of this key (acknowledged or not), for moving it to another key. */
    latest: () => saver.latestFields(),
    /** The real record was saved (its transaction already cleared the draft): stop sending and remember the draft is gone. */
    settle: () => {
      saver.settle();
      markNone(key, entry.actions.scope);
    },
    /**
     * Delete the stored draft. Stops sending first and waits for any request in flight, so a late save cannot recreate the draft. TRUE only when
     * the server confirmed the delete; on failure the queued text is kept and sending resumes, and `discardFailed` says so.
     */
    discard: async (): Promise<boolean> => {
      await saver.quiesce();
      let ok = false;
      try {
        ok = (await entry.actions.discard(key, entry.scope)).ok;
      } catch {
        ok = false;
      }
      if (ok) {
        saver.settle();
        markNone(key, entry.actions.scope);
        setDiscardFailed(false);
        return true;
      }
      saver.resume();
      setDiscardFailed(true);
      return false;
    },
  };
}
