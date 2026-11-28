import { DraftSaver, type DraftState } from "./draft-saver";
import type { NoteDraftFields, NoteDraftKey, NoteDraftSaveResult, StoredNoteDraft } from "./types";

// One DraftSaver per draft key for the life of this browser tab (module state, never stored, gone on reload).
//
// THE ONE RULE (HON-130 design): a saver belongs to its registry ENTRY, and an entry lives exactly as long as its draft lifecycle (its generation)
// lives and the signed-in identity that created it stays the same. COMPONENTS NEVER CREATE, DISPOSE OR RESTART SAVERS: an editor attaches to an
// entry on mount and detaches on unmount, and detaching never ends anything. That single fact answers mount and unmount, a React Strict Mode
// replay (attach, detach, attach is a no-op), a section or client switch during an outage (the saver keeps the text and keeps retrying), and a
// remount (it re-attaches to the SAME saver and shows its newest text, not the page's older `drafts` prop).
//
// An entry ends only by: (a) its lifecycle ending (the real Save, Discard or a move: the saver mints a NEW generation and the entry goes on
// as the next lifecycle), (b) the identity changing (endIdentity(): sign-out, or a different practitioner/studio seen on any read), (c) unload.
// Autosave OFF creates no entry and no saver at all; the server never renders through this module (browser only).
export type DraftActions = {
  /**
   * WHO this saver belongs to (practitioner id + studio id, from the server session). The registry holds clinical text and retries in the
   * background, so it is partitioned by identity: a different identity never sees, and never sends, another identity's text.
   */
  scope: string;
  save: (input: { key: NoteDraftKey; fields: NoteDraftFields; expectedRevision: number; writer: string; scope: string; generation: string }) => Promise<NoteDraftSaveResult>;
  discard: (key: NoteDraftKey, scope: string, generation: string) => Promise<{ ok: boolean }>;
  /** Read the caller's own live draft of ONE key from the server (a move checks its destination here). `ok` false means it could not be checked. */
  peek: (key: NoteDraftKey, scope: string) => Promise<{ ok: boolean; draft: StoredNoteDraft | null }>;
};

export type DraftEntry = {
  key: NoteDraftKey;
  saver: DraftSaver;
  writer: string;
  /** The scope this saver was created under. Every send carries IT (never the page's current one), so a saver that outlives a sign-out cannot act as someone else. */
  scope: string;
  actions: DraftActions;
};

// BROWSER ONLY. Module state on the server is shared by every request of an instance, so the registry is never read or written while rendering on
// the server (a different practitioner's entry could otherwise be handed out): on the server acquireEntry returns an inert, unregistered entry.
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

/** Any identity or studio change ends EVERY entry first: timers cleared, queued text dropped, no send can follow. */
function enterScope(scope: string): void {
  if (currentScope !== null && currentScope !== scope) endIdentity();
  currentScope = scope;
}

function createEntry(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: DraftActions): DraftEntry {
  const entry: DraftEntry = { key, writer: crypto.randomUUID(), scope: actions.scope, actions, saver: undefined as unknown as DraftSaver };
  entry.saver = new DraftSaver({
    initialRevision: restored?.revision ?? 0,
    generation: restored?.generation,
    onState: () => undefined,
    send: (fields, expectedRevision, generation) =>
      entry.actions.save({ key, fields, expectedRevision, writer: entry.writer, scope: entry.scope, generation }),
  });
  if (restored) entry.saver.adopt(restored.fields);
  return entry;
}

/**
 * The entry for this key: attach to the existing one, or create it (continuing from the server's stored draft, if any). On the server it returns
 * a private, DISPOSED entry that is never stored, so a render can never hand one practitioner's entry to another.
 */
export function acquireEntry(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: DraftActions, onState: (s: DraftState) => void): DraftEntry {
  if (!inBrowser()) {
    const inert = createEntry(key, restored, actions);
    inert.saver.dispose();
    return inert;
  }
  enterScope(actions.scope);
  installUnloadGuard();
  let entry = entries.get(idOf(key));
  if (!entry) {
    entry = createEntry(key, restored, actions);
    entries.set(idOf(key), entry);
  }
  entry.actions = actions;
  entry.saver.setListener(onState);
  return entry;
}

/** The live entry for this key under this identity, without creating one (a read; the identity is compared here too). */
function peekEntry(key: NoteDraftKey, scope: string): DraftEntry | undefined {
  if (!inBrowser()) return undefined;
  enterScope(scope);
  return entries.get(idOf(key));
}

/**
 * What a (re)opened editor should start from. IF AN ENTRY EXISTS IT IS THE ONLY ANSWER (its newest text, acknowledged or not; null when its
 * lifecycle ended and nothing was typed since); the page's `drafts` prop is used only when this tab holds no entry for the key.
 */
export function latestDraft(key: NoteDraftKey, fromServer: StoredNoteDraft | null, scope: string): { fields: NoteDraftFields; revision: number; savedAt: string | null; unsaved: boolean } | null {
  const server = fromServer ? { fields: fromServer.fields, revision: fromServer.revision, savedAt: fromServer.savedAt as string | null, unsaved: false } : null;
  const entry = peekEntry(key, scope);
  if (!entry) return server;
  const unsaved = entry.saver.unsavedWork();
  if (unsaved) return { fields: unsaved.fields, revision: unsaved.revision, savedAt: null, unsaved: true };
  const latest = entry.saver.latestFields();
  if (!latest) return null;
  return { fields: latest, revision: entry.saver.currentRevision(), savedAt: entry.saver.snapshot().savedAt ?? server?.savedAt ?? null, unsaved: false };
}

/** The text this tab holds for a key (acknowledged or not), or null: used to see whether a move's destination is occupied. Compares identity. */
export function heldText(key: NoteDraftKey, scope: string): NoteDraftFields | null {
  return peekEntry(key, scope)?.saver.latestFields() ?? null;
}

/**
 * Start a NEW draft under `key` holding text that could not stay under its old key (Keep as new note). The destination is a NEW lifecycle: a new
 * generation and expected revision 0. It never overwrites: when the key already holds text the caller must have chosen (Append or Replace)
 * BEFORE calling, and `replaceWith` carries the chosen text.
 */
export function seedEntry(key: NoteDraftKey, fields: NoteDraftFields, actions: DraftActions, restored: StoredNoteDraft | null = null): void {
  if (!inBrowser()) return;
  // `restored` is the destination's own stored draft when the person chose to Append to or Replace it: the write then continues THAT lifecycle.
  const entry = acquireEntry(key, restored, actions, () => undefined);
  entry.saver.change(fields);
}

/**
 * End every entry: stop every timer and retry, discard queued text, make any response that is still on its way inert. Called by the SIGN-OUT
 * action before it asks the server to sign out, on an identity or studio change seen on any read, and by the tests. It is an EVENT, never a
 * component unmount: React replays effect cleanups in Strict Mode without remounting, which would dispose savers that are still in use.
 */
export function endIdentity(): void {
  for (const e of entries.values()) e.saver.dispose();
  entries.clear();
  currentScope = null;
}

/** Test and legacy name for endIdentity(). */
export const resetDraftRegistry = endIdentity;
