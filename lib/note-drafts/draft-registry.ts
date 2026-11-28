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
  save: (input: { key: NoteDraftKey; fields: NoteDraftFields; expectedRevision: number; writer: string }) => Promise<NoteDraftSaveResult>;
  discard: (key: NoteDraftKey) => Promise<{ ok: boolean }>;
};

export type DraftEntry = {
  key: NoteDraftKey;
  saver: DraftSaver;
  writer: string;
  actions: DraftActions;
  /** True once the draft is known to be gone (real record saved, or discarded): the page's older `drafts` prop must not bring it back. */
  none: boolean;
  /** Highest revision seen for this key; a draft from the server with a higher revision is newer than a `none` mark. */
  floor: number;
};

const entries = new Map<string, DraftEntry>();
const idOf = (k: NoteDraftKey) => `${k.clientId}|${k.kind}|${k.target}`;

export function peekEntry(key: NoteDraftKey): DraftEntry | undefined {
  return entries.get(idOf(key));
}

/** The saver for this key, created on first use (continuing from the server's stored draft, if any). */
export function acquireEntry(key: NoteDraftKey, restored: StoredNoteDraft | null, actions: DraftActions, onState: (s: DraftState) => void): DraftEntry {
  let entry = entries.get(idOf(key));
  if (!entry) {
    const created: DraftEntry = {
      key,
      writer: crypto.randomUUID(),
      actions,
      none: false,
      floor: restored?.revision ?? 0,
      saver: undefined as unknown as DraftSaver,
    };
    created.saver = new DraftSaver({
      initialRevision: restored?.revision ?? 0,
      onState: () => undefined,
      send: (fields, expectedRevision) => created.actions.save({ key, fields, expectedRevision, writer: created.writer }),
    });
    if (restored) created.saver.adopt(restored.fields);
    entries.set(idOf(key), created);
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
export function latestDraft(key: NoteDraftKey, fromServer: StoredNoteDraft | null): { fields: NoteDraftFields; revision: number; savedAt: string | null; unsaved: boolean } | null {
  const entry = entries.get(idOf(key));
  const server = fromServer ? { fields: fromServer.fields, revision: fromServer.revision, savedAt: fromServer.savedAt as string | null, unsaved: false } : null;
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
export function markNone(key: NoteDraftKey): void {
  const entry = entries.get(idOf(key));
  if (entry) {
    entry.floor = Math.max(entry.floor, entry.saver.currentRevision());
    entry.none = true;
  }
}

/** Start a NEW key holding text that could not stay under its old key (a revision whose note was revised elsewhere). */
export function seedEntry(key: NoteDraftKey, fields: NoteDraftFields, actions: DraftActions): void {
  const entry = acquireEntry(key, null, actions, () => undefined);
  entry.none = false;
  entry.saver.change(fields);
}

/** Tests only. */
export function resetDraftRegistry(): void {
  for (const e of entries.values()) e.saver.dispose();
  entries.clear();
}
