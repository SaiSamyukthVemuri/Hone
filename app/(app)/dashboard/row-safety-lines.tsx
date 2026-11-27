import type { ReactNode } from "react";
import { CLINICAL_UNAVAILABLE_HEADLINE } from "@/components/clinical-unavailable-notice";

type RowPin = { id: string; text: string };

/** The same full, newest-first list is used for editable and read-only rows. */
export function RowPinnedNotes<Pin extends RowPin>({ pinnedNotes, renderNote }: {
  pinnedNotes: readonly Pin[] | null;
  renderNote?: (note: Pin) => ReactNode;
}) {
  if (!pinnedNotes?.length) return null;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-md border-l-2 border-amber-300 bg-amber-50 px-2.5 py-1.5 dark:border-amber-700 dark:bg-amber-950/30">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">Pinned</span>
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {pinnedNotes.map(note => (
          <li key={note.id} className="min-w-0 whitespace-pre-wrap break-words text-xs text-amber-800 dark:text-amber-300">
            {renderNote ? renderNote(note) : note.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The lines that must stay visible on the CLOSED Today row (Insurance D-1 / E-1), whatever else the
 * compact row folds into its details: every pinned note in full, the failed-read marker, and the
 * caution/watch line. Non-interactive spans only, because the row body is a link. Each adds only its own
 * height to the row.
 */
export function RowSafetyLines({
  pinnedNotes,
  unavailable,
  caution,
  cautionSource,
  lastTreatment,
}: {
  pinnedNotes: ReadonlyArray<{ id: string; text: string }> | null;
  /** The Before-Today read for this row FAILED (not "nothing recorded"). */
  unavailable: boolean;
  /** The newest caution/watch text, already resolved by the caller from an answered read with history. */
  caution: string | null;
  /** Where that caution came from ("Notes from 3 Oct (the latest visit on 10 Nov has no notes)"), or null. */
  cautionSource?: string | null;
  /** The one-line previous-treatment summary (the prep authority's compactSummary), or null when none was proved. */
  lastTreatment?: string | null;
}) {
  return (
    <>
      <RowPinnedNotes pinnedNotes={pinnedNotes} />
      {/* Insurance E-1: when the Before-Today read FAILED the compact row says so, in the profile's own
          words. Without it the absent caution line reads as "no caution", a clinical absence nobody read.
          Same truthfulness rule as the profile's "Unavailable". Not gated on history or caution. */}
      {unavailable && (
        <span data-testid="today-row-unavailable" className="mt-1 block text-xs text-neutral-500">
          {CLINICAL_UNAVAILABLE_HEADLINE}
        </span>
      )}
      {/* HON-65 (Chloe, 4 Nov): "Last treatment" is the line a practitioner reads first, so it stays on the CLOSED row.
          Only the full chart (the toggle in the details) is collapsed. Plain text: the row body is a link. */}
      {lastTreatment && (
        <span
          data-testid="dashboard-memory-compact"
          className="mt-2 block whitespace-pre-wrap break-words group-has-[[data-prior-visible=true]]/visit:hidden text-sm text-neutral-600 dark:text-neutral-400"
        >
          <span className="font-medium text-neutral-500">Last treatment: </span>
          {lastTreatment}
        </span>
      )}
      {/* Insurance D-1: the caution/watch line, FULL text, wrapped, never inside the details. The caller
          passes null unless the read answered and there is history. */}
      {caution && (
        <span
          data-testid="today-row-caution"
          className="mt-1 block whitespace-pre-wrap break-words text-xs text-rose-900 dark:text-rose-200"
          title={caution}
        >
          Caution: {caution}
          {cautionSource && (
            <span data-testid="today-row-caution-source" className="mt-0.5 block text-[11px] text-neutral-500 dark:text-neutral-400">
              {cautionSource}
            </span>
          )}
        </span>
      )}
    </>
  );
}
