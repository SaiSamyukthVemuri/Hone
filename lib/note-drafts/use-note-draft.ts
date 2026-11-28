"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { acquireEntry, type DraftActions, type DraftEntry } from "./draft-registry";
import type { DraftState } from "./draft-saver";
import type { NoteDraftFields, NoteDraftKey, StoredNoteDraft } from "./types";

// Client hook: ATTACHES this editor to the key's registry entry (see draft-registry.ts). It never creates, disposes or restarts a saver.
// Unmounting DETACHES: a flush that fails (or conflicts, or is cleared) leaves the text held in the saver for the remount, and the failure is shown
// there. A React Strict Mode replay (mount, unmount, mount) is therefore a no-op. A flush is never treated as a save unless it says so.
const FLUSH_TIMEOUT_MS = 5000;
const MOVE_DISCARD_TIMEOUT_MS = 8000;

const IDLE: DraftState = { phase: "idle", savedAt: null, theirs: null };

/**
 * `enabled` false (autosave off for this studio or this page): NO entry and NO saver exist. The hook returns an inert API (state "idle", every
 * command a no-op) and never touches the registry, so a page without drafts cannot disturb another page's retained text.
 */
export function useNoteDraft(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: DraftActions, enabled = true) {
  const [state, setState] = useState<DraftState>(IDLE);
  const [discardFailed, setDiscardFailed] = useState(false);
  /** True while Keep as new note moves the text to another key: the editor is read-only so nothing is typed into a key that is being closed. */
  const [moving, setMoving] = useState(false);
  /** True while a Discard is out: the editor is read-only and edits are ignored, so text typed now can neither be queued nor wiped by the settle. */
  const [discarding, setDiscarding] = useState(false);
  const discardingRef = useRef(false);
  const discardRun = useRef<Promise<boolean> | null>(null);
  const [entry] = useState<DraftEntry | null>(() => (enabled ? acquireEntry(key, restored, actions, () => undefined) : null));
  if (entry) entry.actions = actions;
  const saver = entry?.saver ?? null;

  useEffect(() => {
    if (!entry || !saver) return;
    // (Re)attach: take over state updates and show the saver's real state (a held failure is visible again, not forgotten).
    saver.setListener((s) => setState(s));
    setState(saver.snapshot());
    const unsaved = saver.unsavedWork();
    if (unsaved && saver.snapshot().phase === "idle") saver.change(unsaved.fields); // text held by a detached saver goes out again
    const hide = () => {
      if (document.visibilityState === "hidden") void saver.flush();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
      // Detach and try to save what is pending, bounded by a timeout. Whatever is still unsaved after that STAYS in the saver (and keeps
      // retrying quietly); the remount re-attaches to it. Nothing is disposed.
      saver.setListener(() => undefined);
      void Promise.race([saver.flush(), new Promise<boolean>((r) => setTimeout(() => r(false), FLUSH_TIMEOUT_MS))]);
    };
  }, [saver, entry]);

  const change = useCallback(
    (fields: NoteDraftFields) => {
      if (discardingRef.current) return;
      saver?.change(fields);
    },
    [saver],
  );

  if (!entry || !saver) {
    return {
      state: IDLE,
      discardFailed: false,
      moving: false,
      discarding: false,
      change,
      hold: (_fields: NoteDraftFields) => undefined,
      flush: async () => true,
      retry: () => undefined,
      keepMine: () => undefined,
      keepAsNew: () => undefined,
      useTheirs: () => null as NoteDraftFields | null,
      latest: () => null as NoteDraftFields | null,
      /** The draft generation the real Save must name; null when autosave is off. */
      generation: () => null as string | null,
      moveOut: async () => null as NoteDraftFields | null,
      settle: () => undefined,
      discard: async () => true,
    };
  }

  return {
    state,
    discardFailed,
    moving,
    discarding,
    change,
    /** Edits on a superseded target: kept in the registry saver (survive an unmount), never sent, carried by Keep as new. */
    hold: (fields: NoteDraftFields) => {
      if (discardingRef.current) return;
      saver.hold(fields);
    },
    flush: () => saver.flush(),
    retry: () => saver.retry(),
    keepMine: () => saver.keepMine(),
    keepAsNew: () => saver.keepAsNew(),
    useTheirs: () => saver.useTheirs(),
    /** The newest text of this key (acknowledged or not), for moving it to another key. */
    latest: () => saver.latestFields(),
    /** The draft generation the real Save must name, so the SAME transaction ends exactly this draft. */
    generation: (): string | null => saver.currentGeneration(),
    /**
     * Move this key's text to ANOTHER key (Keep as new note): stop sending, end THIS lifecycle on the server (its generation; live rows only), then
     * settle. Returns the newest text, or null when there is none. A failed delete is ignored on purpose: the text is not lost (the caller seeds
     * the new key with it) and a live row can only linger until it expires.
     */
    moveOut: async (): Promise<NoteDraftFields | null> => {
      setMoving(true);
      try {
        await saver.quiesce();
        const generation = saver.currentGeneration();
        // The delete has no deadline of its own: bound it, and fall through to carrying the text if it does not answer.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            entry.actions.discard(key, entry.scope, generation),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, MOVE_DISCARD_TIMEOUT_MS);
            }),
          ]);
        } catch {
          // ignored, see above
        } finally {
          if (timer) clearTimeout(timer);
        }
        // Read the text AFTER the await and immediately before settle(): anything typed while the delete was out is held in the saver, and
        // settle() clears it, so reading earlier would seed the new form with stale text (silent loss).
        const fields = saver.latestFields();
        saver.settle();
        return fields;
      } finally {
        setMoving(false);
      }
    },
    /** The real record was saved (its transaction already ended the draft): stop sending; the next typing is a NEW lifecycle. */
    settle: () => {
      saver.settle();
    },
    /**
     * End the stored draft. Stops sending first and waits for any request in flight, so a late save cannot recreate the draft. TRUE only when
     * the server confirmed; on failure the queued text is kept and sending resumes, and `discardFailed` says so.
     */
    discard: (): Promise<boolean> => {
      // Re-entry: a second Discard while one is out gets THAT one's answer (same promise); it never starts a second request or an early unlock.
      if (discardRun.current) return discardRun.current;
      const run = (async (): Promise<boolean> => {
      discardingRef.current = true;
      setDiscarding(true);
      try {
        await saver.quiesce();
        let ok = false;
        try {
          ok = (await entry.actions.discard(key, entry.scope, saver.currentGeneration())).ok;
        } catch {
          ok = false;
        }
        if (ok) {
          saver.settle();
          setDiscardFailed(false);
          return true;
        }
        saver.resume();
        setDiscardFailed(true);
        return false;
      } finally {
        discardingRef.current = false;
        setDiscarding(false);
      }
      })();
      discardRun.current = run;
      void run.finally(() => {
        if (discardRun.current === run) discardRun.current = null;
      });
      return run;
    },
  };
}
