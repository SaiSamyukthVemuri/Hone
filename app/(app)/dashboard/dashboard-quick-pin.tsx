"use client";

import { useRef, useState, useTransition } from "react";
import { PinnedNoteField, pinnedNotePermissions } from "@/components/client-pinned-notes-card";
import type { ClientPinnedNote } from "@/lib/types/database";
import { addClientPinnedNoteAction, editClientPinnedNoteAction } from "../clients/[id]/pinned-notes-actions";
import { RowPinnedNotes } from "./row-safety-lines";

type DashboardPin = Pick<ClientPinnedNote, "id" | "text" | "created_by_practitioner_id">;
type Client = { clientId: string; clientName: string };

export function DashboardQuickPin({ clientId, clientName, pinnedNotes, viewer }: Client & {
  pinnedNotes: readonly DashboardPin[];
  viewer: { isOwner: boolean; practitionerId: string };
}) {
  return (
    <>
      <DashboardPinEditor clientId={clientId} clientName={clientName} />
      <RowPinnedNotes pinnedNotes={pinnedNotes} renderNote={note => pinnedNotePermissions(note, viewer).canEdit
        ? <DashboardPinEditor clientId={clientId} clientName={clientName} note={note} />
        : note.text}
      />
    </>
  );
}

function DashboardPinEditor({ clientId, clientName, note }: Client & { note?: DashboardPin }) {
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
        if (note) await editClientPinnedNoteAction(data);
        else await addClientPinnedNoteAction(data);
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
