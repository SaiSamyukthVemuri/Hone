"use client";

import { useRef, useState, useTransition } from "react";
import { PinnedNoteField, pinnedNotePermissions } from "@/components/client-pinned-notes-card";
import type { ClientPinnedNote } from "@/lib/types/database";
import { addClientPinnedNoteAction, editClientPinnedNoteAction } from "../clients/[id]/pinned-notes-actions";
import { RowPinnedNotes } from "./row-safety-lines";

type DashboardPin = Pick<ClientPinnedNote, "id" | "text" | "created_by_practitioner_id">;
type Client = { clientId: string; clientName: string };

/** A pin the save action handed back. It is drawn at once, then reconciled with the refreshed page tree by id. */
function isSavedPin(value: unknown): value is DashboardPin {
  const pin = value as Partial<DashboardPin> | null | undefined;
  return !!pin && typeof pin.id === "string" && typeof pin.text === "string";
}

export function DashboardQuickPin({ clientId, clientName, pinnedNotes, viewer }: Client & {
  pinnedNotes: readonly DashboardPin[];
  viewer: { isOwner: boolean; practitionerId: string };
}) {
  // WHY THE SAVED PIN IS KEPT HERE. The refreshed page tree that revalidatePath sends back after a save is the
  // slow path: while other work is in flight it can arrive late, or not at all, and a note the practitioner
  // has just saved must not depend on it. The action returns the saved pin, it is drawn from that value
  // straight away, and a later tree replaces it BY ID (never a duplicate). An entry is dropped once the page
  // data carries the same text for that id, so a later change from elsewhere is not masked.
  const [saved, setSaved] = useState<readonly DashboardPin[]>([]);
  const confirmed = saved.filter(pin => pinnedNotes.some(note => note.id === pin.id && note.text === pin.text));
  if (confirmed.length > 0) setSaved(saved.filter(pin => !confirmed.includes(pin)));

  const byId = new Map(saved.map(pin => [pin.id, pin]));
  const shown = [
    ...saved.filter(pin => !pinnedNotes.some(note => note.id === pin.id)),
    ...pinnedNotes.map(note => byId.get(note.id) ?? note),
  ];
  function remember(pin: DashboardPin) {
    setSaved(current => [pin, ...current.filter(existing => existing.id !== pin.id)]);
  }

  return (
    <>
      <DashboardPinEditor clientId={clientId} clientName={clientName} onSaved={remember} />
      <RowPinnedNotes pinnedNotes={shown} renderNote={note => pinnedNotePermissions(note, viewer).canEdit
        ? <DashboardPinEditor clientId={clientId} clientName={clientName} note={note} onSaved={remember} />
        : note.text}
      />
    </>
  );
}

function DashboardPinEditor({ clientId, clientName, note, onSaved }: Client & { note?: DashboardPin; onSaved: (pin: DashboardPin) => void }) {
  const [originalText, setOriginalText] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const saving = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);

  function open() {
    setOriginalText(note?.text ?? "");
    setText(note?.text ?? "");
    setError(false);
  }

  function close() {
    setOriginalText(null);
    setText("");
    setError(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  function save() {
    const value = text.trim();
    if (!value || originalText === null || saving.current) return;
    const data = new FormData();
    data.set("client_id", clientId);
    data.set("text", value);
    if (note) {
      data.set("note_id", note.id);
      data.set("original_text", originalText);
    }
    saving.current = true;
    setError(false);
    startTransition(async () => {
      try {
        const result: unknown = note ? await editClientPinnedNoteAction(data) : await addClientPinnedNoteAction(data);
        if (isSavedPin(result)) onSaved({ id: result.id, text: result.text, created_by_practitioner_id: result.created_by_practitioner_id ?? null });
        close();
      } catch {
        setError(true);
      } finally {
        saving.current = false;
      }
    });
  }

  return originalText !== null ? (
    <form className="w-full max-w-md" onSubmit={e => { e.preventDefault(); save(); }}>
      <fieldset disabled={pending}>
        <PinnedNoteField autoFocus value={text} onChange={setText} onEnter={save} onEscape={close}
          ariaLabel={`${note ? "Edit pinned note" : "Pinned note"} for ${clientName}`} placeholder="What should stay on this client’s dashboard?" />
        {error && <p role="alert" className="text-xs text-rose-700">{note ? "Couldn’t save changes. Refresh to check the current note." : "Couldn’t save the note. Try again."}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={pending || !text.trim()} className="min-h-11 text-xs font-semibold disabled:opacity-50">{pending ? "Saving…" : "Save pinned note"}</button>
          <button type="button" onClick={close} className="min-h-11 px-2 text-xs">Cancel</button>
        </div>
      </fieldset>
    </form>
  ) : note ? (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{note.text}</span>
      <button type="button" ref={trigger} onClick={open} aria-label={`Edit pinned note for ${clientName}: ${note.text}`}
        className="min-h-11 shrink-0 px-2 text-xs font-medium underline-offset-2 hover:underline">Edit</button>
    </div>
  ) : (
    <button type="button" ref={trigger} onClick={open} aria-label={`Add pinned note for ${clientName}`}
      className="min-h-11 text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300">
      + Add pinned note
    </button>
  );
}
