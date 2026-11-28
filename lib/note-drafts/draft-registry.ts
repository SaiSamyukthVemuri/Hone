import { DraftSaver, type DraftState } from "./draft-saver";
import type { NoteDraftFields, NoteDraftKey, NoteDraftSaveResult, StoredNoteDraft } from "./types";

// One DraftSaver per draft key for the life of this browser tab (module state, never stored, gone on reload).
//
// WHY A REGISTRY: a section or client switch unmounts the editor. If the server is unreachable at that moment the latest text has not been
// saved, and it must NOT be lost or treated as saved. Instead of tearing the saver down, the unmounted editor DETACHES: the saver keeps the
// text, its revision and its writer token, and keeps retrying in the background. A remount of the same key re-attaches to the SAME saver, so
// the returning editor shows the latest text and the real state (including the failure), and no second writer races it. It also answers
// "Cancel, then Add note again": the form reopens with the latest draft rather than the one the page was loaded with.
export type DraftActions = {
  /**
   * WHO this saver belongs to (practitioner id + studio id, from the server session). The registry holds clinical text and retries in the
   * background, so it is partitioned by identity: a different identity never sees, and never sends, another identity's text.
   */
  scope: string;
  save: (input: { key: NoteDraftKey; fields: NoteDraftFields; expectedRevision: number; writer: string; scope: string }) => Promise<NoteDraftSaveResult>;
  discard: (key: NoteDraftKey, scope: string) => Promise<{ ok: boolean }>;
};

export type DraftEntry = {
  key: NoteDraftKey;
  saver: DraftSaver;
  writer: string;
  /** The scope this saver was created under. Every send carries IT (never the page's current one), so a saver that outlives a sign-out cannot act as someone else. */
  scope: string;
  actions: DraftActions;
  /** True once the draft is known to be gone (real record saved, or discarded): the page's older `drafts` prop must not bring it back. */
  none: boolean;
  /** Highest revision seen for this key; a draft from the server with a higher revision is newer than a `none` mark. */
  floor: number;
};

// BROWSER ONLY. Module state on the server is shared by every request of an instance, so the registry is never read or written while rendering on
// the server (a different practitioner's entry could otherwise be handed out): on the server every call below returns a fresh, unregistered result.
const inBrowser = () => typeof window !== "undefined";
const entries = new Map<string, DraftEntry>();
let currentScope: string | null = null;
let unloadGuardInstalled = false;

/**
 * Closing or reloading the tab with unsent draft text asks first. It is owned by the REGISTRY, not by an editor, because a detached saver (the editor
 * was switched away while the server was unreachable) still holds text that exists nowhere else: the guard must live as long as any entry does.
 */
function installUnloadGuard(): void {
  if (unloadGuardInstalled || !inBrowser()) return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (e) => {
    for (const entry of entries.values()) {
      if (entry.saver.hasUnsavedWork()) {
        e.preventDefault();
        e.returnValue = "";
        return;
      }
    }
  });
}
const idOf = (k: NoteDraftKey) => `${currentScope}|${k.clientId}|${k.kind}|${k.target}`;

/** Any identity or studio change drops EVERY saver first: timers cleared, queued text discarded, no send can follow. */
function enterScope(scope: string): void {
  if (currentScope !== null && currentScope !== scope) resetDraftRegistry();
  currentScope = scope;
}

/** The saver for this key, created on first use (continuing from the server's stored draft, if any). */
export function acquireEntry(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: DraftActions, onState: (s: DraftState) => void, register = true): DraftEntry {
  // `register` false (autosave is off for this studio) or no browser (server render): a private saver that is never stored and so can never be shared.
  const shared = register && inBrowser();
  if (shared) {
    enterScope(actions.scope);
    installUnloadGuard();
  }
  let entry = shared ? entries.get(idOf(key)) : undefined;
  if (!entry) {
    const created: DraftEntry = {
      key,
      writer: crypto.randomUUID(),
      scope: actions.scope,
      actions,
      none: false,
      floor: restored?.revision ?? 0,
      saver: undefined as unknown as DraftSaver,
    };
    created.saver = new DraftSaver({
      initialRevision: restored?.revision ?? 0,
      onState: () => undefined,
      send: (fields, expectedRevision) => created.actions.save({ key, fields, expectedRevision, writer: created.writer, scope: created.scope }),
    });
    if (restored) created.saver.adopt(restored.fields);
    if (shared) entries.set(idOf(key), created);
    entry = created;
  }
  entry.actions = actions;
  entry.saver.setListener((s) => {
    entry.floor = Math.max(entry.floor, entry.saver.currentRevision());
    onState(s);
  });
  return entry;
}

/**
 * What a (re)opened editor should start from: the saver's latest text when this tab holds newer or unsaved work, else the server's stored draft.
 * Returns null for "no draft".
 */
export function latestDraft(key: NoteDraftKey, fromServer: StoredNoteDraft | null, scope: string): { fields: NoteDraftFields; revision: number; savedAt: string | null; unsaved: boolean } | null {
  const server = fromServer ? { fields: fromServer.fields, revision: fromServer.revision, savedAt: fromServer.savedAt as string | null, unsaved: false } : null;
  if (!inBrowser()) return server;
  enterScope(scope);
  const entry = entries.get(idOf(key));
  if (!entry) return server;
  const unsaved = entry.saver.unsavedWork();
  if (unsaved) return { fields: unsaved.fields, revision: unsaved.revision, savedAt: null, unsaved: true };
  if (entry.none) return server && server.revision > entry.floor ? server : null;
  const latest = entry.saver.latestFields();
  if (latest && entry.saver.currentRevision() >= (server?.revision ?? 0)) {
    return { fields: latest, revision: entry.saver.currentRevision(), savedAt: entry.saver.snapshot().savedAt ?? server?.savedAt ?? null, unsaved: false };
  }
  return server;
}

/** Mark the draft gone for this key (record saved or discarded). */
export function markNone(key: NoteDraftKey, scope: string): void {
  if (!inBrowser() || scope !== currentScope) return;
  const entry = entries.get(idOf(key));
  if (entry) {
    entry.floor = Math.max(entry.floor, entry.saver.currentRevision());
    entry.none = true;
  }
}

/** Start a NEW key holding text that could not stay under its old key (a revision whose note was revised elsewhere). */
export function seedEntry(key: NoteDraftKey, fields: NoteDraftFields, actions: DraftActions): void {
  if (!inBrowser()) return;
  const entry = acquireEntry(key, null, actions, () => undefined);
  entry.none = false;
  entry.saver.change(fields);
}

/**
 * Drop every saver: stop every timer and retry, discard queued text, make any response that is still on its way inert. Called on sign-out (the
 * signed-in shell unmounting), on an identity or studio change, and by the tests.
 */
export function resetDraftRegistry(): void {
  for (const e of entries.values()) e.saver.dispose();
  entries.clear();
  currentScope = null;
}
