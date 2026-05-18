"use client";

import { useState, useTransition } from "react";
import type { ClientTag } from "@/lib/types/database";

type Props = {
  clientId: string;
  tags: ClientTag[];
  addAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
};

export function ClientTagsCard({ clientId, tags, addAction, removeAction }: Props) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submitAdd() {
    const trimmed = label.trim();
    if (!trimmed) return;
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("label", trimmed);
    setError(null);
    startTransition(async () => {
      try {
        await addAction(fd);
        setLabel("");
        setAdding(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add tag.");
      }
    });
  }

  function submitRemove(tagId: string) {
    if (!confirm("Remove this tag?")) return;
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("tag_id", tagId);
    setError(null);
    startTransition(async () => {
      try {
        await removeAction(fd);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove tag.");
      }
    });
  }

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Tags
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300"
          >
            + Add tag
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {tags.length === 0 && !adding && (
          <p className="text-sm text-neutral-500">
            No tags yet. Reusable notes like &ldquo;low pain tolerance&rdquo; or
            &ldquo;afternoon appointments preferred&rdquo; travel with this
            client across sessions.
          </p>
        )}
        {tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            onClick={() => submitRemove(tag.id)}
            disabled={pending}
            className="group inline-flex items-center gap-1.5 rounded-full border border-neutral-300 bg-neutral-50 px-3 py-1 text-xs font-medium text-neutral-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            aria-label={`Remove ${tag.label}`}
          >
            <span>{tag.label}</span>
            <span aria-hidden className="text-neutral-400 group-hover:text-red-500">
              ×
            </span>
          </button>
        ))}
      </div>
      {adding && (
        <div className="mt-3 flex flex-wrap items-stretch gap-2">
          <input
            autoFocus
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitAdd();
              }
              if (e.key === "Escape") {
                setAdding(false);
                setLabel("");
              }
            }}
            placeholder="e.g. low pain tolerance"
            maxLength={60}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            type="button"
            onClick={submitAdd}
            disabled={pending || !label.trim()}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setLabel("");
            }}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
}
