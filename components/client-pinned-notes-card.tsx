"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import type { ClientPinnedNote } from "@/lib/types/database";

export const MAX_LENGTH = 200;

/**
 * Pinned notes are single-line (Enter saves), but a pasted value can carry line
 * breaks a single-line <input> used to drop silently. Keep that behaviour: a
 * break becomes a space, so editing never introduces stored newlines.
 */
export function toSingleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

type FieldProps = {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onEscape?: () => void;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
};

/**
 * HON-9: the FULL pinned note stays readable while it is being edited or added.
 * A wrapping <textarea> that grows to fit its text replaces the old single-line
 * <input>, which scrolled a 200-character note sideways inside one line on a
 * phone. Keyboard behaviour is unchanged: Enter saves, Escape cancels, and no
 * newline can be typed or pasted (toSingleLine).
 */
export function PinnedNoteField({
  value,
  onChange,
  onEnter,
  onEscape,
  ariaLabel,
  placeholder,
  autoFocus,
  className = "",
}: FieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(toSingleLine(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape" && onEscape) {
            onEscape();
          }
        }}
        maxLength={MAX_LENGTH}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="w-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap break-words rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
      />
      <span className="self-end text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400" aria-live="polite">
        {value.length}/{MAX_LENGTH}
      </span>
    </div>
  );
}

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
              // Inline editor: full-width fields that wrap on narrow (iPhone)
              // widths so nothing overflows horizontally.
              <li
                key={n.id}
                className="flex flex-col gap-2 rounded-md border border-amber-300 bg-white px-3 py-2 dark:border-amber-700 dark:bg-neutral-950"
              >
                <PinnedNoteField
                  value={editText}
                  onChange={setEditText}
                  onEnter={() => submitEdit(n.id)}
                  onEscape={cancelEdit}
                  autoFocus
                  ariaLabel="Edit pinned note"
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
        <PinnedNoteField
          value={text}
          onChange={setText}
          onEnter={submitAdd}
          ariaLabel="New pinned note"
          placeholder="e.g. Allergies: Penicillin. Prefers right side first."
          className="flex-1 min-w-[12rem]"
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
