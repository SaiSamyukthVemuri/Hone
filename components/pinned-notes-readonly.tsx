import type { ClientPinnedNote } from "@/lib/types/database";

// Read-only render of pinned notes. Used on the appointment detail page so
// the practitioner sees them before they start charting. Renders nothing
// when there are no notes (no empty state on the appointment page).
export function PinnedNotesReadonly({ notes }: { notes: ClientPinnedNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section className="rounded-lg border-l-4 border-amber-400 bg-amber-50 px-5 py-4 dark:border-amber-500 dark:bg-amber-950/30">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-900 dark:text-amber-200">
        Pinned notes
      </h2>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-amber-950 dark:text-amber-100">
        {notes.map((n) => (
          <li key={n.id} className="whitespace-pre-wrap">
            {n.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
