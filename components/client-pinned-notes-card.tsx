"use client";

import { useState, useTransition } from "react";
import type { ClientPinnedNote } from "@/lib/types/database";

const MAX_LENGTH = 200;

type Props = {
  clientId: string;
  notes: ClientPinnedNote[];
  addAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
};

export function ClientPinnedNotesCard({
  clientId,
  notes,
  addAction,
  removeAction,
}: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
          {notes.map((n) => (
            <li
              key={n.id}
              className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm dark:border-amber-800 dark:bg-neutral-950"
            >
              <span className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-100">
                {n.text}
              </span>
              <button
                type="button"
                onClick={() => submitRemove(n.id)}
                disabled={pending}
                aria-label="Remove pinned note"
                className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
              >
                ✕
              </button>
            </li>
          ))}
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
          className="flex-1 min-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
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
