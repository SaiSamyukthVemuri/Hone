"use client";

import { useState, useTransition } from "react";
import type { ClientPinnedNote } from "@/lib/types/database";

const MAX_LENGTH = 200;

type Props = {
  clientId: string;
  notes: ClientPinnedNote[];
  addAction: (formData: FormData) => Promise<void>;
  editAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
};

export function ClientPinnedNotesCard({
  clientId,
  notes,
  addAction,
  editAction,
  removeAction,
}: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Inline edit: which note is open, its working text, and the text that was on
  // screen when it opened (the optimistic-concurrency token). Only one at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editOriginal, setEditOriginal] = useState("");

  function submitAdd() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_LENGTH) {
      setError(`Note must be ${MAX_LENGTH} characters or fewer.`);
      return;
    }
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("text", trimmed);
    setError(null);
    startTransition(async () => {
      try {
        await addAction(fd);
        setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to pin note.");
      }
    });
  }

  function startEdit(note: ClientPinnedNote) {
    setError(null);
    setEditingId(note.id);
    setEditText(note.text); // pre-fill current text
    setEditOriginal(note.text); // capture the on-screen text for the concurrency guard
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText("");
    setEditOriginal("");
    setError(null);
  }

  function submitEdit(noteId: string) {
    const trimmed = editText.trim();
    if (!trimmed) {
      setError("Note text is required.");
      return;
    }
    if (trimmed.length > MAX_LENGTH) {
      setError(`Note must be ${MAX_LENGTH} characters or fewer.`);
      return;
    }
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("note_id", noteId);
    fd.set("text", trimmed);
    fd.set("original_text", editOriginal); // optimistic-concurrency token
    setError(null);
    startTransition(async () => {
      try {
        await editAction(fd);
        setEditingId(null);
        setEditText("");
        setEditOriginal("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update note.");
      }
    });
  }

  function submitRemove(noteId: string) {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("note_id", noteId);
    setError(null);
    startTransition(async () => {
      try {
        await removeAction(fd);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove note.");
      }
    });
  }

  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50/60 p-5 dark:border-amber-800 dark:bg-amber-950/20">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-amber-900 dark:text-amber-200">
          Pinned notes
        </h2>
        <span className="text-xs text-amber-800/70 dark:text-amber-200/70">
          Visible on every appointment
        </span>
      </div>

      {notes.length === 0 ? (
        <p className="mt-3 text-sm text-amber-900/80 dark:text-amber-200/80">
          Pin a short note that should show on every appointment: allergies,
          treatment plan, anything worth remembering.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {notes.map((n) =>
            editingId === n.id ? (
              // Inline editor — full-width fields that wrap on narrow (iPhone)
              // widths so nothing overflows horizontally.
              <li
                key={n.id}
                className="flex flex-col gap-2 rounded-md border border-amber-300 bg-white px-3 py-2 dark:border-amber-700 dark:bg-neutral-950"
              >
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitEdit(n.id);
                    } else if (e.key === "Escape") {
                      cancelEdit();
                    }
                  }}
                  maxLength={MAX_LENGTH}
                  autoFocus
                  aria-label="Edit pinned note"
                  className="w-full min-w-0 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={pending}
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => submitEdit(n.id)}
                    disabled={pending || editText.trim().length === 0}
                    className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                  >
                    {pending ? "Saving…" : "Save"}
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={n.id}
                className="flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm dark:border-amber-800 dark:bg-neutral-950"
              >
                <span className="min-w-0 whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-100">
                  {n.text}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(n)}
                    disabled={pending}
                    aria-label="Edit pinned note"
                    className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => submitRemove(n.id)}
                    disabled={pending}
                    aria-label="Remove pinned note"
                    className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                  >
                    ✕
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-stretch gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAdd();
            }
          }}
          placeholder="e.g. Allergies: Penicillin. Prefers right side first."
          maxLength={MAX_LENGTH}
          className="flex-1 min-w-[12rem] rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button
          type="button"
          onClick={submitAdd}
          disabled={pending || text.trim().length === 0}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
}
